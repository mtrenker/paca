// A disposable API behind the fake OIDC provider (fakes.mjs), for #21: never part of the image. It
// models what docs/design/api-access.md requires of a real one: it accepts only access tokens the
// provider issued to Paca's client (audience), unexpired, with the scope each route needs, and
// answers as the token's subject. The provider issues and rotates the tokens through `issue` and
// `refresh`. Everything is in memory and synthetic. Tests call `handle` in process; the preview and
// the container smoke test serve it from fakes.mjs under /example-api/v1/.
import { randomBytes } from "node:crypto";

export const API_PATH = "/example-api/v1/";

const token = (prefix) => `${prefix}-${randomBytes(18).toString("base64url")}`;
const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

/**
 * @param {object} options
 * @param {string} options.audience the client the provider issues tokens to: Paca's
 * @param {number} [options.accessSeconds] access token lifetime
 * @param {() => number} [options.now] epoch ms, so tests can let tokens expire
 */
export function createFakeApi({ audience, accessSeconds = 300, now = () => Date.now() }) {
	const access = new Map();
	const refresh = new Map();
	const notes = new Map();
	/** What tests switch on, and every request the API saw (method, path, subject, If-Match; never a token). */
	const faults = { refuseRefresh: false, grantedScope: undefined, refreshDelayMs: 0, writeStatus: undefined };
	const seen = [];

	/** The provider's token answer for a sign-in or refresh: an access token for `audience`, and a rotating refresh token when `offline_access` was asked for. */
	function issue({ sub, username, scope }) {
		const granted = faults.grantedScope ?? scope;
		const at = token("at");
		access.set(at, { sub, username, scope: granted, aud: audience, exp: now() + accessSeconds * 1000 });
		const answer = { access_token: at, token_type: "Bearer", expires_in: accessSeconds, scope: granted };
		if (scope.split(" ").includes("offline_access")) {
			const rt = token("rt");
			refresh.set(rt, { sub, username, scope });
			answer.refresh_token = rt;
		}
		return answer;
	}

	/** A refresh: the old refresh token is used up either way. Undefined when refused. */
	async function renew(refreshToken) {
		if (faults.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, faults.refreshDelayMs));
		const held = refresh.get(refreshToken);
		refresh.delete(refreshToken);
		if (!held || faults.refuseRefresh) return undefined;
		return issue(held);
	}

	/** A note with its version: a strong ETag in the JSON body, as the API answers it. */
	const versioned = (id, text, version = 1) => ({ id, text, version, etag: `"note-${id}-v${version}"` });
	/** Another client changing a note, so the version the user approved is out of date. */
	function changeElsewhere(sub, id, text) {
		const note = notes.get(sub)?.find((n) => n.id === id);
		if (note) Object.assign(note, versioned(id, text, note.version + 1));
	}

	/** The API: the caller's own account and notes, nothing else. Editing a note needs its version in If-Match. */
	async function handle(request) {
		const path = new URL(request.url).pathname.slice(API_PATH.length);
		const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
		const grant = bearer && access.get(bearer);
		seen.push({ method: request.method, path, sub: grant?.sub, ifMatch: request.headers.get("if-match") });
		if (!grant || grant.exp <= now() || grant.aud !== audience) return json(401, { error: "invalid_token" }, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
		const scopes = grant.scope.split(" ");
		if (!notes.has(grant.sub)) notes.set(grant.sub, [versioned(1, `Welcome, ${grant.username}. This note lives in the fake Example API.`)]);
		const mine = notes.get(grant.sub);
		if (request.method === "GET" && path === "me") return json(200, { subject: grant.sub, username: grant.username });
		if (request.method === "GET" && path === "notes") {
			if (!scopes.includes("notes.read")) return json(403, { error: "insufficient_scope" });
			return json(200, { notes: mine });
		}
		if (request.method === "POST" && path === "notes") {
			if (!scopes.includes("notes.write")) return json(403, { error: "insufficient_scope" });
			const body = await request.json().catch(() => undefined);
			if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 500) return json(400, { error: "A note needs 1 to 500 characters." });
			// A test's refusal writes nothing; its server error writes and then fails, so the outcome is unknown.
			if (faults.writeStatus >= 400 && faults.writeStatus < 500) return json(faults.writeStatus, { error: "refused" });
			const note = versioned(mine.length + 1, body.text);
			mine.push(note);
			if (faults.writeStatus >= 500) return json(faults.writeStatus, { error: "failed after writing" });
			return json(201, note);
		}
		const edit = /^notes\/(\d+)$/.exec(path);
		if (request.method === "PATCH" && edit) {
			if (!scopes.includes("notes.write")) return json(403, { error: "insufficient_scope" });
			const note = mine.find((n) => n.id === Number(edit[1]));
			if (!note) return json(404, { error: "no such note" });
			const condition = request.headers.get("if-match");
			if (condition === null) return json(428, { error: "If-Match is required" });
			if (condition !== note.etag) return json(412, { error: "the note changed", current: note });
			const body = await request.json().catch(() => undefined);
			if (typeof body?.text !== "string" || !body.text.trim() || body.text.length > 500) return json(400, { error: "A note needs 1 to 500 characters." });
			Object.assign(note, versioned(note.id, body.text, note.version + 1));
			return json(200, note);
		}
		// For the redirect refusal: a bearer token must never follow this.
		if (path === "moved") return new Response(null, { status: 302, headers: { Location: "https://elsewhere.invalid/steal" } });
		return json(404, { error: "not found" });
	}

	return { issue, renew, handle, changeElsewhere, faults, seen, access, refresh, notes };
}

/** Serves a fetch-style answer to a node http(s) request. */
export async function toNode(req, res, respond) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
	const response = await respond(new Request(new URL(req.url, "https://localhost").href, { method: req.method, headers: req.headers, body }));
	res.writeHead(response.status, Object.fromEntries(response.headers));
	res.end(Buffer.from(await response.arrayBuffer()));
}
