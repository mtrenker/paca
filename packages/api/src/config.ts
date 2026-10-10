// Private runtime configuration. Lives outside Git (default .data/config.json); see README.
// A config written before multi-user support (oidc.allowedSubject, github, piClean) still loads: it
// becomes one operator user with the server's gh login, as it always had.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DATA_DIR = resolve(process.env.PACA_DATA_DIR ?? join(import.meta.dirname, "..", "..", "..", ".data"));

/** A user admitted by the host. Keys other than these are settings for the tool package of that name. */
export interface UserConfig {
	id: string;
	/** OIDC subject; the issuer is the configured provider's. */
	subject: string;
	/** Owns the conversation written before multi-user support (`<data>/paca.sqlite`). At most one user. */
	operator: boolean;
	/** The APIs this user's extensions may call as them, by name. */
	apis?: string[];
	[packageName: string]: unknown;
}

export interface Config {
	publicUrl: string;
	publicOrigin: string;
	port: number;
	host: string;
	/** `scopes`: asked for at sign-in after "openid profile", such as "offline_access" for refresh tokens. */
	oidc: { issuer: string; clientId: string; scopes: string[] };
	model?: string;
	/** Enabled tool packages by npm package name, with each package's settings. */
	extensions: Record<string, unknown>;
	/** Enabled packages whose frontend is off: their cards show text, their tools still work. */
	disableFrontends: string[];
	/** APIs extensions call with the user's sign-in access token, by name (docs/design/api-access.md). */
	apis: Record<string, ApiConfig>;
	users: UserConfig[];
}

/** One API behind Paca's own identity provider: where it is, the scopes it needs and which extensions call it. */
export interface ApiConfig {
	name: string;
	label: string;
	/** https: base URL ending in "/"; requests go only below it. */
	url: string;
	/** Asked for at sign-in; a sign-in granted fewer cannot use this API. */
	scopes: string[];
	/** Extension names that may call it, for the users allowed it. */
	extensions: string[];
}

export const GITHUB_PACKAGE = "@paca/extension-github";
const USER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PACKAGE_NAME = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/;
const API_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** An OAuth scope token (RFC 6749, 3.3). */
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const scopeList = (value: unknown): value is string[] => Array.isArray(value) && value.every((s) => typeof s === "string" && SCOPE.test(s));

export async function loadConfig({ needWeb = true } = {}): Promise<Config> {
	const path = process.env.PACA_CONFIG ?? join(DATA_DIR, "config.json");
	const raw = JSON.parse(await readFile(path, "utf8"));
	const fail = (message: string): never => {
		throw new Error(`${path}: ${message}`);
	};

	let users: UserConfig[];
	let extensions: Record<string, unknown>;
	if (raw.users === undefined) {
		if (raw.oidc?.allowedSubject === undefined && needWeb) fail("oidc.allowedSubject is required");
		users = [{ id: "operator", subject: raw.oidc?.allowedSubject ?? "unknown", operator: true, github: { projects: raw.github?.projects, serverLogin: true } }];
		extensions = raw.extensions ?? { [GITHUB_PACKAGE]: { piClean: raw.piClean } };
	} else {
		if (raw.oidc?.allowedSubject !== undefined) fail("use users instead of oidc.allowedSubject, not both");
		if (raw.github !== undefined || raw.piClean !== undefined) fail(`with users, GitHub settings go in users[].github and extensions["${GITHUB_PACKAGE}"]`);
		if (!Array.isArray(raw.users) || raw.users.length === 0) fail("users must list at least one user");
		users = raw.users.map((u: Record<string, unknown>) => ({ ...u, operator: u.operator === true }) as UserConfig);
		if (typeof raw.extensions !== "object" || raw.extensions === null || Array.isArray(raw.extensions)) fail("extensions must name each enabled tool package with its settings, for example { \"@paca/extension-github\": { ... } }");
		extensions = raw.extensions;
	}
	for (const name of Object.keys(extensions)) if (!PACKAGE_NAME.test(name)) fail(`extensions: ${JSON.stringify(name)} is not an npm package name`);
	const disableFrontends = raw.disableFrontends ?? [];
	if (!Array.isArray(disableFrontends) || !disableFrontends.every((name) => typeof name === "string" && Object.hasOwn(extensions, name))) {
		fail("disableFrontends must list packages enabled under extensions");
	}
	const apis = readApis(raw.apis, fail);
	const scopes = raw.oidc?.scopes ?? [];
	if (!scopeList(scopes)) fail("oidc.scopes must list OAuth scopes, such as [\"offline_access\"]");
	const ids = new Set<string>();
	const subjects = new Set<string>();
	for (const u of users) {
		if (typeof u.id !== "string" || !USER_ID.test(u.id)) fail(`users: id ${JSON.stringify(u.id)} must be lowercase letters, digits and dashes`);
		if (typeof u.subject !== "string" || !u.subject) fail(`users "${u.id}": subject is required`);
		if (ids.has(u.id)) fail(`users: id "${u.id}" appears twice`);
		if (subjects.has(u.subject)) fail(`users: subject of "${u.id}" appears twice`);
		ids.add(u.id);
		subjects.add(u.subject);
		const allowed = u.apis ?? [];
		if (!Array.isArray(allowed) || !allowed.every((name) => typeof name === "string" && Object.hasOwn(apis, name)) || new Set(allowed).size !== allowed.length) {
			fail(`users "${u.id}": apis must list configured APIs by name`);
		}
	}
	if (users.filter((u) => u.operator).length > 1) fail("users: only one user can be the operator");

	const config = { ...raw, oidc: { ...raw.oidc, scopes }, users, extensions, disableFrontends, apis } as Config;
	if (needWeb) {
		const url = new URL(raw.publicUrl ?? fail("publicUrl is required"));
		if (url.protocol !== "https:" && !isLoopbackHttp(url)) fail("publicUrl must be https (or http://localhost for a local preview)");
		if (process.env.PACA_PORT) config.port = Number(process.env.PACA_PORT);
		if (!Number.isInteger(config.port)) fail("port is required");
		for (const key of ["issuer", "clientId"] as const) {
			if (typeof raw.oidc?.[key] !== "string" || !raw.oidc[key]) fail(`oidc.${key} is required`);
		}
		if (!process.env.PACA_OIDC_CLIENT_SECRET) throw new Error("PACA_OIDC_CLIENT_SECRET is not set; see Configure in the README");
		config.publicOrigin = url.origin;
	}
	// Loopback unless PACA_HOST says otherwise; the container image sets 0.0.0.0 (see docs/container.md).
	config.host = process.env.PACA_HOST || "127.0.0.1";
	return config;
}

/** The `apis` block, checked: names, labels, an https URL without credentials, query or fragment, scopes and extensions. */
function readApis(raw: unknown, fail: (message: string) => never): Record<string, ApiConfig> {
	if (raw === undefined) return {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("apis must map names to API settings");
	const out: Record<string, ApiConfig> = {};
	for (const [name, value] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
		const at = `apis "${name}"`;
		if (!API_NAME.test(name)) fail(`${at}: names are lowercase letters, digits and dashes`);
		const { label, url, scopes, extensions } = value ?? {};
		if (typeof label !== "string" || !label.trim() || label.length > 40) fail(`${at}: label needs 1 to 40 characters`);
		const parsed = typeof url === "string" && URL.canParse(url) ? new URL(url) : undefined;
		if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || url !== parsed.href || !parsed.pathname.endsWith("/")) {
			fail(`${at}: url must be an https URL ending in "/", without credentials, query or fragment, written as the URL parser writes it`);
		}
		if (!scopeList(scopes)) fail(`${at}: scopes must list the OAuth scopes it needs`);
		if (!Array.isArray(extensions) || !extensions.every((e) => typeof e === "string" && /^[a-z][a-z0-9-]*$/.test(e))) fail(`${at}: extensions must list the extension names that may call it`);
		out[name] = { name, label: label as string, url: url as string, scopes: [...(scopes as string[])], extensions: [...(extensions as string[])] };
	}
	return out;
}

/** The scopes sign-in asks for: Paca's own, then each API's, once each. */
export function signInScopes(config: Pick<Config, "oidc" | "apis">) {
	return [...new Set(["openid", "profile", ...config.oidc.scopes, ...Object.values(config.apis).flatMap((a) => a.scopes)])];
}

/** Browsers treat http://localhost as secure, so a local preview keeps Secure cookies without TLS. */
function isLoopbackHttp(url: URL) {
	return url.protocol === "http:" && url.hostname === "localhost";
}

/** Where a user's store, sessions and caches live; the operator's too. */
export function userDataDir(dataDir: string, user: UserConfig) {
	return join(dataDir, "users", user.id);
}

/**
 * Where the code before multiple sessions kept a user's one conversation (a Durable store). Start-up
 * converts a store found here and moves it away (legacy.ts), so the previous image finds none.
 */
export function legacyStorePath(dataDir: string, user: UserConfig) {
	return user.operator ? join(dataDir, "paca.sqlite") : join(dataDir, "users", user.id, "paca.sqlite");
}
