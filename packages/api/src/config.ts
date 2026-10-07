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
	/** Owns the data written before multi-user support (`<data>/paca.sqlite`). At most one user. */
	operator: boolean;
	[packageName: string]: unknown;
}

export interface Config {
	publicUrl: string;
	publicOrigin: string;
	port: number;
	host: string;
	oidc: { issuer: string; clientId: string };
	model?: string;
	/** Enabled tool packages by npm package name, with each package's settings. */
	extensions: Record<string, unknown>;
	users: UserConfig[];
}

export const GITHUB_PACKAGE = "@paca/extension-github";
const USER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PACKAGE_NAME = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/;

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
	const ids = new Set<string>();
	const subjects = new Set<string>();
	for (const u of users) {
		if (typeof u.id !== "string" || !USER_ID.test(u.id)) fail(`users: id ${JSON.stringify(u.id)} must be lowercase letters, digits and dashes`);
		if (typeof u.subject !== "string" || !u.subject) fail(`users "${u.id}": subject is required`);
		if (ids.has(u.id)) fail(`users: id "${u.id}" appears twice`);
		if (subjects.has(u.subject)) fail(`users: subject of "${u.id}" appears twice`);
		ids.add(u.id);
		subjects.add(u.subject);
	}
	if (users.filter((u) => u.operator).length > 1) fail("users: only one user can be the operator");

	const config = { ...raw, users, extensions } as Config;
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

/** Browsers treat http://localhost as secure, so a local preview keeps Secure cookies without TLS. */
function isLoopbackHttp(url: URL) {
	return url.protocol === "http:" && url.hostname === "localhost";
}

/** Where a user's conversation lives. The operator keeps the pre-multi-user location. */
export function userDataDir(dataDir: string, user: UserConfig) {
	return user.operator ? dataDir : join(dataDir, "users", user.id);
}
