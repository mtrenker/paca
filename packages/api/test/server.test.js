import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createSessions, SESSION_COOKIE } from "../src/auth.ts";
import { createFeed } from "../src/feed.ts";
import { createApp } from "../src/server.ts";

const ISSUER = "https://id.example.test/application/o/paca/";
const PUBLIC = "https://paca.example.test:8443";
const MARTIN = { iss: ISSUER, sub: "martin-subject", preferred_username: "martin" };
const ALEX = { iss: ISSUER, sub: "alex-subject", preferred_username: "alex" };

let base;
let server;
// Every call a user's sessions receive, as [user, call, ...args].
let calls;
const key = randomBytes(32);
let nextClaims = MARTIN;

const MARTIN_SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ALEX_SESSION = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const BUSY_SESSION = "11111111-2222-4333-8444-555555555555";

/** A stub user with one saved session: answers like the real host, and records every call. */
function stubUser(name, own) {
	const known = (id) => id === own || id === BUSY_SESSION;
	const state = createFeed(() => ({ running: false, turns: [{ id: "1", question: `${name}'s question`, steps: [], answer: `kept for ${name}`, notices: [], drafts: [] }] }), 1);
	const record = (call, ...args) => calls.push([name, call, ...args]);
	return {
		sessions: {
			list: createFeed(() => [{ id: own, title: `${name}'s session`, running: false, waiting: 1, lastActivity: "2026-10-07T00:00:00Z" }], 1),
			start: (id, text, requestId) => (record("start", id, text, requestId), id === own ? { refused: "exists" } : { duplicate: false }),
			ask: (id, text, requestId) => (record("ask", id, text, requestId), !known(id) ? { refused: "not-found" } : id === BUSY_SESSION ? { refused: "busy" } : { duplicate: false }),
			stop: (id) => (record("stop", id), known(id) ? {} : { refused: "not-found" }),
			remove: async (id) => {
				record("remove", id);
				if (!known(id)) return { refused: "not-found" };
				if (id === BUSY_SESSION) return { refused: "busy" };
				state.end();
				return { deleted: true };
			},
			approveDraft: async (id, draftId) => (record("approve", id, draftId), !known(id) || draftId === "missing" ? { refused: "not-found" } : draftId === "done" ? { refused: "created" } : draftId === "gone" ? { refused: "unavailable" } : { status: "created", url: "https://github.com/o/r/issues/1" }),
			dismissDraft: (id, draftId) => (record("dismiss", id, draftId), known(id) ? { status: "dismissed" } : { refused: "not-found" }),
			watch: async (id) => (record("watch", id), id === own ? state : undefined),
		},
		info: { model: "test/model", scope: `1 Projects`, scopeDetail: `${name}-repo` },
	};
}
const users = new Map([
	[MARTIN.sub, stubUser("martin", MARTIN_SESSION)],
	[ALEX.sub, stubUser("alex", ALEX_SESSION)],
]);
const sessions = createSessions({ key, issuer: ISSUER, allows: (sub) => users.has(sub) });

before(async () => {
	calls = [];
	server = createApp({
		config: { publicUrl: PUBLIC, publicOrigin: new URL(PUBLIC).origin },
		sessions,
		oidc: {
			begin: async () => ({ url: `${ISSUER}authorize?state=s`, transaction: { state: "s", nonce: "n", verifier: "v" } }),
			finish: async () => nextClaims,
		},
		users: { forSubject: (sub) => users.get(sub) },
		web: { public: join(import.meta.dirname, "..", "..", "web", "public"), script: join(import.meta.dirname, "..", "..", "web", "public") },
		log: { warn: () => {}, error: () => {} },
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const cookieOf = (response) => response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function signIn(claims = MARTIN) {
	nextClaims = claims;
	const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
	return fetch(`${base}/auth/callback?code=c&state=s`, { redirect: "manual", headers: { cookie: cookieOf(login) } });
}

async function signedIn(claims = MARTIN) {
	const cookie = cookieOf(await signIn(claims));
	const { csrf } = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
	return { cookie, csrf };
}

const post = (auth, path, body, headers = {}) =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { cookie: auth.cookie, origin: new URL(PUBLIC).origin, "x-csrf-token": auth.csrf, "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
const ask = (auth, headers = {}, body = { text: "What needs attention?", requestId: "request-0001" }) => post(auth, `/api/sessions/${MARTIN_SESSION}/messages`, body, headers);

/** The events a stream sends until `count` arrived or it ends, as [event, data]. */
async function events(auth, query = "", count = 2) {
	const controller = new AbortController();
	const response = await fetch(`${base}/api/events${query}`, { headers: { cookie: auth.cookie }, signal: controller.signal });
	if (response.status !== 200) return { status: response.status };
	const reader = response.body.getReader();
	const received = [];
	let buffer = "";
	while (received.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += new TextDecoder().decode(value);
		let end;
		while ((end = buffer.indexOf("\n\n")) >= 0) {
			const [event, data] = buffer.slice(0, end).split("\n").map((l) => l.slice(l.indexOf(": ") + 2));
			received.push([event, JSON.parse(data)]);
			buffer = buffer.slice(end + 2);
		}
	}
	controller.abort();
	return { status: 200, received };
}

describe("identity", () => {
	it("sends visitors without a session to sign in and refuses the API", async () => {
		const page = await fetch(`${base}/`, { redirect: "manual" });
		assert.equal(page.status, 302);
		assert.equal(page.headers.get("location"), "/auth/login");
		assert.equal((await fetch(`${base}/api/events`)).status, 401);
		assert.equal((await fetch(`${base}/api/events?session=${MARTIN_SESSION}`)).status, 401);
		assert.equal((await fetch(`${base}/api/session`)).status, 401);
	});

	it("refuses an identity that is not a configured user without creating a session", async () => {
		const response = await signIn({ ...MARTIN, sub: "someone-else" });
		assert.equal(response.status, 403);
		assert.ok(!response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes("Max-Age=0")));
	});

	it("refuses the right subject from another issuer", async () => {
		assert.equal((await signIn({ ...MARTIN, iss: "https://other.example.test/" })).status, 403);
	});

	it("refuses a callback without the login transaction", async () => {
		const response = await fetch(`${base}/auth/callback?code=c&state=s`, { redirect: "manual" });
		assert.equal(response.status, 400);
	});

	it("admits a configured user with a secure host-only cookie", async () => {
		const response = await signIn();
		assert.equal(response.status, 303);
		const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
		assert.match(cookie, /HttpOnly/);
		assert.match(cookie, /Secure/);
		assert.match(cookie, /SameSite=Lax/);
		assert.equal((await fetch(`${base}/`, { headers: { cookie: cookieOf(response) } })).status, 200);
	});

	it("rejects forged, expired and no longer configured sessions", async () => {
		const forged = createSessions({ key: randomBytes(32), issuer: ISSUER, allows: () => true });
		const expired = createSessions({ key, issuer: ISSUER, allows: () => true, now: () => Date.now() - 13 * 3600_000 });
		const removed = createSessions({ key, issuer: ISSUER, allows: () => true });
		for (const [s, sub] of [[forged, MARTIN.sub], [expired, MARTIN.sub], [removed, "previous-subject"]]) {
			const cookie = s.start({ ...MARTIN, sub })[0].split(";")[0];
			assert.equal((await fetch(`${base}/api/session`, { headers: { cookie } })).status, 401);
		}
	});
});

describe("requests", () => {
	it("refuses POSTs from another origin or without the CSRF token, on every session route", async () => {
		const auth = await signedIn();
		const before = calls.length;
		const routes = [["/api/sessions", { id: "8f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", text: "hi", requestId: "request-0009" }], ...["messages", "stop", "delete", "drafts/approve", "drafts/dismiss"].map((a) => [`/api/sessions/${MARTIN_SESSION}/${a}`, { id: "d1", text: "hi", requestId: "request-0009" }])];
		for (const [path, body] of routes) {
			assert.equal((await post(auth, path, body, { origin: "https://evil.example.test" })).status, 403, path);
			assert.equal((await post(auth, path, body, { "x-csrf-token": "wrong" })).status, 403, path);
			assert.equal((await post({ ...auth, csrf: "" }, path, body)).status, 403, path);
		}
		assert.equal(calls.length, before);
	});

	it("starts a session only with a lowercase UUID v4 and a bounded question", async () => {
		const auth = await signedIn();
		const id = "8f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
		const response = await post(auth, "/api/sessions", { id, text: " Start here ", requestId: "request-0003" });
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { id, duplicate: false });
		assert.deepEqual(calls.at(-1), ["martin", "start", id, "Start here", "request-0003"]);
		const before = calls.length;
		for (const bad of ["legacy", "../x", "8F1C2A3B-4D5E-4F60-8A7B-9C0D1E2F3A4B", "8f1c2a3b-4d5e-1f60-8a7b-9c0d1e2f3a4b", `${id}/../../x`, 42, undefined]) {
			assert.equal((await post(auth, "/api/sessions", { id: bad, text: "hi", requestId: "request-0004" })).status, 400, String(bad));
		}
		assert.equal((await post(auth, "/api/sessions", { id, text: "x".repeat(4001), requestId: "request-0004" })).status, 400);
		assert.equal((await post(auth, "/api/sessions", { id, text: "hi" })).status, 400);
		assert.equal(calls.length, before);
		assert.equal((await post(auth, "/api/sessions", { id: MARTIN_SESSION, text: "hi", requestId: "request-0005" })).status, 409);
	});

	it("accepts a bounded question to a saved session and refuses one to a busy session", async () => {
		const auth = await signedIn();
		assert.equal((await ask(auth)).status, 202);
		assert.deepEqual(calls.at(-1), ["martin", "ask", MARTIN_SESSION, "What needs attention?", "request-0001"]);
		assert.equal((await ask(auth, {}, { text: "x".repeat(4001), requestId: "request-0002" })).status, 400);
		assert.equal((await ask(auth, {}, { text: "hi" })).status, 400);
		assert.equal((await post(auth, `/api/sessions/${BUSY_SESSION}/messages`, { text: "hi", requestId: "request-0006" })).status, 409);
		assert.equal((await post(auth, `/api/sessions/${BUSY_SESSION}/delete`, {})).status, 409);
		const huge = await fetch(`${base}/api/sessions/${MARTIN_SESSION}/messages`, {
			method: "POST",
			headers: { cookie: auth.cookie, origin: new URL(PUBLIC).origin, "x-csrf-token": auth.csrf },
			body: "x".repeat(20_000),
		});
		assert.equal(huge.status, 413);
	});

	it("answers 404 for an unknown session id and never turns a path into a lookup", async () => {
		const auth = await signedIn();
		const unknown = "9e1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
		for (const action of ["messages", "stop", "delete", "drafts/approve", "drafts/dismiss"]) {
			assert.equal((await post(auth, `/api/sessions/${unknown}/${action}`, { id: "d1", text: "hi", requestId: "request-0007" })).status, 404, action);
		}
		const before = calls.length;
		assert.equal((await post(auth, "/api/sessions/legacy/stop", {})).status, 404);
		assert.equal((await post(auth, "/api/sessions/..%2F..%2Fx/stop", {})).status, 404);
		assert.equal((await events(auth, "?session=..%2Fx")).status, 404);
		assert.equal(calls.length, before);
		assert.equal((await events(auth, `?session=${unknown}`)).status, 404);
	});

	it("tells a page from before the update to reload, and calls nothing", async () => {
		const auth = await signedIn();
		const before = calls.length;
		for (const path of ["/api/messages", "/api/stop", "/api/drafts/approve", "/api/drafts/dismiss"]) {
			const response = await post(auth, path, { id: "d1", text: "hi", requestId: "request-0008" });
			assert.equal(response.status, 410, path);
			assert.match((await response.json()).error, /Reload the page/);
		}
		assert.equal(calls.length, before);
	});

	it("starts every stream from a snapshot of the list and of the open session", async () => {
		const auth = await signedIn();
		const list = await events(auth, "", 1);
		assert.deepEqual(list.received.map(([event, data]) => [event, data[0].title]), [["sessions", "martin's session"]]);
		const open = await events(auth, `?session=${MARTIN_SESSION}`);
		assert.deepEqual(open.received.map(([event]) => event), ["sessions", "state"]);
		assert.equal(open.received[1][1].turns[0].answer, "kept for martin");
	});
});

describe("two users", () => {
	it("gives each user only their own session info, list, sessions and drafts", async () => {
		const martin = await signedIn(MARTIN);
		const alex = await signedIn(ALEX);
		assert.notEqual(martin.csrf, alex.csrf);
		assert.equal((await (await fetch(`${base}/api/session`, { headers: { cookie: alex.cookie } })).json()).scopeDetail, "alex-repo");
		assert.equal((await events(alex, "", 1)).received[0][1][0].title, "alex's session");
		assert.equal((await events(alex, `?session=${ALEX_SESSION}`)).received[1][1].turns[0].answer, "kept for alex");

		// Martin's requests naming Alex's session reach only Martin's sessions, which do not know it.
		const before = calls.length;
		assert.equal((await events(martin, `?session=${ALEX_SESSION}`)).status, 404);
		for (const action of ["messages", "stop", "delete", "drafts/approve", "drafts/dismiss"]) {
			assert.equal((await post(martin, `/api/sessions/${ALEX_SESSION}/${action}`, { id: "d1", text: "hi", requestId: "request-0010" })).status, 404, action);
		}
		assert.ok(calls.slice(before).every(([user]) => user === "martin"));
		assert.equal((await post({ cookie: alex.cookie, csrf: martin.csrf }, `/api/sessions/${ALEX_SESSION}/drafts/approve`, { id: "d1" })).status, 403);
		assert.equal((await post(alex, `/api/sessions/${ALEX_SESSION}/stop`, {})).status, 202);
		assert.deepEqual(calls.at(-1), ["alex", "stop", ALEX_SESSION]);
	});
});

describe("draft decisions", () => {
	it("refuses decisions without a session, from another origin or without the CSRF token", async () => {
		const auth = await signedIn();
		const path = `/api/sessions/${MARTIN_SESSION}/drafts/approve`;
		const before = calls.length;
		assert.equal((await post({ cookie: "", csrf: "" }, path, { id: "d1" })).status, 401);
		assert.equal((await post(auth, path, { id: "d1" }, { origin: "https://evil.example.test" })).status, 403);
		assert.equal((await post(auth, path, { id: "d1" }, { "x-csrf-token": "wrong" })).status, 403);
		assert.equal(calls.length, before);
	});

	it("passes only the session and draft ids, never replacement content", async () => {
		const auth = await signedIn();
		const path = (action) => `/api/sessions/${MARTIN_SESSION}/drafts/${action}`;
		const response = await post(auth, path("approve"), { id: "d1", title: "Something else", body: "injected", repository: "x/y" });
		assert.equal(response.status, 200);
		assert.deepEqual(calls.at(-1), ["martin", "approve", MARTIN_SESSION, "d1"]);
		assert.equal((await post(auth, path("dismiss"), { id: "d2" })).status, 200);
		assert.deepEqual(calls.at(-1), ["martin", "dismiss", MARTIN_SESSION, "d2"]);
		assert.deepEqual([(await post(auth, path("approve"), { id: "done" })).status, (await post(auth, path("approve"), { id: "gone" })).status], [409, 409]);
		assert.equal((await post(auth, path("approve"), { id: "missing" })).status, 404);
		assert.equal((await post(auth, path("approve"), {})).status, 400);
	});
});

describe("deleting", () => {
	it("deletes the session and ends its open stream with gone", async () => {
		const auth = await signedIn(ALEX);
		const streaming = events(auth, `?session=${ALEX_SESSION}`, 3);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal((await post(auth, `/api/sessions/${ALEX_SESSION}/delete`, {})).status, 200);
		assert.deepEqual((await streaming).received.map(([event]) => event), ["sessions", "state", "gone"]);
	});
});
