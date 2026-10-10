// Calling configured APIs as the signed-in user (#21), with the access token of their Paca sign-in.
// One grant per user, from their latest sign-in, held in this process's memory only; extensions get
// `request`, the page gets each API's state, logs get codes. The contract, with the lifetime of a
// grant, is docs/design/api-access.md.
import type { ApiStatus } from "@paca/contracts";
import { ApiError, type ApiMethod, type ApiState, type JsonValue, type UserApi } from "@paca/extension";
import type { ApiConfig } from "./config.ts";

/** A grant never outlives the sign-in that made it: the session cookie's lifetime (auth.ts). */
export const GRANT_MS = 12 * 60 * 60 * 1000;
/** Refresh before use when the access token expires within this. */
const REFRESH_EARLY_MS = 60 * 1000;
const ANSWER_MAX = 512 * 1024;
/**
 * One strong entity tag (RFC 9110, 8.8.3): a quoted string of visible ASCII without `"`. No `W/`,
 * no `*`, no list, so a conditional write can only name the exact version the user approved.
 */
const STRONG_ETAG = /^"[\x21\x23-\x7e]{0,254}"$/;

/** What the issuer granted at sign-in or a refresh: never shown, logged or passed on. */
export interface Grant {
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms; undefined when the issuer did not say. */
	expiresAt?: number;
	/** The granted scopes, when the issuer said. */
	scope?: string;
	/** From the verified ID token, when the answer had one. */
	subject?: string;
}

/** A refresh the issuer answered with a refusal, as opposed to one that never reached it. */
export class RefreshRefused extends Error {}

interface Held {
	grant: Grant;
	/** When the sign-in's session ends; the grant ends with it. */
	until: number;
}

/** One user's grant. `generation` changes whenever it is replaced or forgotten, so a late refresh is dropped. */
interface Slot {
	held?: Held;
	generation: number;
	refreshing?: Promise<Held>;
}

/** The APIs one user may call, for the routes and the extensions. */
export interface UserAccess {
	/** Each allowed API with its state now, for the page. */
	status(): ApiStatus[];
	/** Keeps the grant of a sign-in by this user, replacing an earlier one. */
	signedIn(grant: Grant): void;
	/** Forgets the grant now, for every device and session of the user. */
	signedOut(): void;
	/** The APIs this user and that extension are both allowed. */
	forExtension(extension: string): Record<string, UserApi>;
}

export interface ApiAccessOptions {
	apis: Record<string, ApiConfig>;
	/** Paca's own issuer: a fresh grant for a refresh token; throws RefreshRefused when refused. */
	refresh: (refreshToken: string) => Promise<Grant>;
	fetch?: typeof fetch;
	now?: () => number;
	log?: Pick<Console, "warn">;
}

/** Whether a grant covers `scopes`. No scope answer means everything asked for (RFC 6749, 5.1). */
function covers(grant: Grant, scopes: readonly string[]) {
	if (grant.scope === undefined) return true;
	const granted = new Set(grant.scope.split(" "));
	return scopes.every((s) => granted.has(s));
}

/**
 * The URL for `path` below `base`, or undefined. Only a plain path: no scheme or host, no `//`, no
 * dot segments, no backslashes, no encoded dot, slash or backslash, and the result must keep the
 * base's origin and path prefix.
 */
export function resolveBelow(base: string, path: string): URL | undefined {
	if (typeof path !== "string" || !path.startsWith("/") || path.includes("//") || path.includes("\\") || path.includes("#") || /%(2e|2f|5c)/i.test(path)) return undefined;
	if (path.split("?")[0].split("/").some((s) => s === "." || s === "..")) return undefined;
	const root = new URL(base);
	const url = new URL(root.pathname.replace(/\/$/, "") + path, root.origin);
	return url.origin === root.origin && url.pathname.startsWith(root.pathname) ? url : undefined;
}

export function createApiAccess({ apis, refresh: refreshGrant, fetch: send = fetch, now = () => Date.now(), log = console }: ApiAccessOptions) {
	const slots = new Map<string, Slot>();
	const slotOf = (user: string) => {
		let slot = slots.get(user);
		if (!slot) slots.set(user, (slot = { generation: 0 }));
		return slot;
	};
	const forget = (slot: Slot) => {
		slot.held = undefined;
		slot.refreshing = undefined;
		slot.generation += 1;
	};
	const signIn = (api: ApiConfig) => new ApiError("sign-in", `Sign in to Paca again so your extensions can use ${api.label}.`, false);

	/**
	 * A fresh grant, one refresh at a time per user. Refused: the grant ends. Unreachable: this request
	 * fails and the grant stays. Replaced or forgotten meanwhile: the result is dropped. Asked for with a
	 * grant that is no longer the user's (a read's late 401 after another request renewed it, or a new
	 * sign-in): the current grant is used as it is, since that refresh token may be used up.
	 */
	function refresh(api: ApiConfig, user: string, slot: Slot, held: Held): Promise<Held> {
		if (slot.refreshing) return slot.refreshing;
		if (slot.held !== held) return usable(api, user, slot);
		const generation = slot.generation;
		const running = (async () => {
			const token = held.grant.refreshToken;
			if (!token) {
				forget(slot);
				throw signIn(api);
			}
			let grant: Grant;
			try {
				grant = await refreshGrant(token);
			} catch (error) {
				if (slot.generation !== generation) throw signIn(api);
				if (error instanceof RefreshRefused) {
					log.warn(`paca: user ${user}: refresh refused (${error.message}); API access needs a new sign-in`);
					forget(slot);
					throw signIn(api);
				}
				throw new ApiError("refresh", `Paca could not renew your access to ${api.label}. Try again.`, false);
			}
			if (slot.generation !== generation || slot.held !== held) {
				if (!slot.held) throw signIn(api);
				return slot.held;
			}
			const narrowed = Object.values(apis).some((a) => covers(held.grant, a.scopes) && !covers(grant, a.scopes));
			if ((grant.subject !== undefined && grant.subject !== held.grant.subject) || narrowed) {
				log.warn(`paca: user ${user}: a refresh changed the subject or narrowed the scopes; API access needs a new sign-in`);
				forget(slot);
				throw signIn(api);
			}
			const next: Held = { grant: { ...grant, refreshToken: grant.refreshToken ?? token, subject: held.grant.subject }, until: held.until };
			slot.held = next;
			return next;
		})();
		slot.refreshing = running;
		const done = () => slot.refreshing === running && (slot.refreshing = undefined);
		running.then(done, done);
		return running;
	}

	/** Whether the access token expires within REFRESH_EARLY_MS: renewed before use, or the end of a grant without a refresh token. */
	const due = (held: Held) => held.grant.expiresAt !== undefined && held.grant.expiresAt - REFRESH_EARLY_MS <= now();

	/** The user's grant, refreshed first when its access token is about to expire. */
	async function usable(api: ApiConfig, user: string, slot: Slot): Promise<Held> {
		const held = slot.held;
		if (!held) throw signIn(api);
		if (held.until <= now()) {
			forget(slot);
			throw signIn(api);
		}
		if (slot.refreshing) return slot.refreshing;
		if (due(held)) return refresh(api, user, slot, held);
		return held;
	}

	function stateOf(api: ApiConfig, slot: Slot): ApiState {
		const held = slot.held;
		if (!held || held.until <= now()) return "sign-in";
		// Without a refresh token the grant ends when a request would renew it (`usable`), so a write
		// action's `ready` refuses the approval then, instead of letting it be claimed and fail.
		if (due(held) && !held.grant.refreshToken) return "sign-in";
		return covers(held.grant, api.scopes) ? "ready" : "not-granted";
	}

	async function call(api: ApiConfig, url: URL, held: Held, method: ApiMethod, body: JsonValue | undefined, signal: AbortSignal | undefined, ifMatch?: string) {
		let response: Response;
		try {
			response = await send(url, {
				method,
				// Paca's headers only: the extension's single say is a checked If-Match.
				headers: {
					Authorization: `Bearer ${held.grant.accessToken}`,
					Accept: "application/json",
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
					...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				redirect: "manual",
				signal,
			});
		} catch {
			throw new ApiError("unreachable", `${api.label} could not be reached.`, true);
		}
		// Never followed: the token would go to a second URL.
		if ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") {
			await response.body?.cancel().catch(() => {});
			throw new ApiError("redirect", `${api.label} answered with a redirect, which Paca does not follow.`, true);
		}
		const text = await readCapped(response).catch(() => undefined);
		if (text === undefined) throw new ApiError("answer", `${api.label} answered too much, or the answer broke off.`, true);
		if (text === "" || !/json/i.test(response.headers.get("content-type") ?? "")) return { status: response.status, body: text === "" ? null : text };
		try {
			return { status: response.status, body: JSON.parse(text) as unknown };
		} catch {
			throw new ApiError("answer", `${api.label} answered with unreadable JSON.`, true);
		}
	}

	function userApi(user: string, api: ApiConfig): UserApi {
		const slot = slotOf(user);
		return {
			name: api.name,
			label: api.label,
			state: () => stateOf(api, slot),
			async request(path, { method = "GET", body, signal, ifMatch } = {}) {
				const url = resolveBelow(api.url, path);
				if (!url) throw new ApiError("destination", `Paca only sends requests below ${api.label}'s configured address.`, false);
				if (ifMatch !== undefined && (method === "GET" || typeof ifMatch !== "string" || !STRONG_ETAG.test(ifMatch))) {
					throw new ApiError("if-match", `Paca sends If-Match only on a write, as one quoted strong version such as "v42".`, false);
				}
				let held = await usable(api, user, slot);
				if (!covers(held.grant, api.scopes)) throw new ApiError("not-granted", `Your Paca sign-in does not include access to ${api.label}.`, false);
				const answer = await call(api, url, held, method, body, signal, ifMatch);
				// A read may renew and ask once more; a write never goes twice, also not after a 412.
				if (method !== "GET" || answer.status !== 401 || !held.grant.refreshToken) return answer;
				held = await refresh(api, user, slot, held);
				if (!covers(held.grant, api.scopes)) throw new ApiError("not-granted", `Your Paca sign-in does not include access to ${api.label}.`, false);
				return call(api, url, held, method, body, signal);
			},
		};
	}

	return {
		/** One user's view: only the APIs their config entry lists. `subject` is their Paca subject. */
		forUser(user: string, subject: string, allowed: readonly string[]): UserAccess {
			const mine = allowed.map((name) => apis[name]).filter(Boolean);
			const slot = slotOf(user);
			return {
				status: () => mine.map((api) => ({ name: api.name, label: api.label, state: stateOf(api, slot) })),
				signedIn(grant) {
					// The ID token named this user's subject (auth.ts); a grant for anyone else is not kept.
					if (grant.subject !== subject) return;
					forget(slot);
					slot.held = { grant, until: now() + GRANT_MS };
					const missing = mine.filter((api) => !covers(grant, api.scopes));
					if (missing.length) log.warn(`paca: user ${user}: sign-in did not grant ${missing.map((a) => `${a.name} (${a.scopes.filter((s) => !new Set(grant.scope?.split(" ")).has(s)).join(" ")})`).join(", ")}`);
				},
				signedOut: () => forget(slot),
				forExtension: (extension) => Object.fromEntries(mine.filter((api) => api.extensions.includes(extension)).map((api) => [api.name, userApi(user, api)])),
			};
		},
	};
}

export type ApiAccess = ReturnType<typeof createApiAccess>;

/** Reads at most ANSWER_MAX bytes of the body as text; undefined when it is longer. */
async function readCapped(response: Response): Promise<string | undefined> {
	if (!response.body) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		size += chunk.length;
		if (size > ANSWER_MAX) {
			await response.body.cancel().catch(() => {});
			return undefined;
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
