import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createSessions, SESSION_COOKIE } from "../src/auth.ts";
import { createApp, createStateFeed } from "../src/server.ts";

const ISSUER = "https://id.example.test/application/o/paca/";
const PUBLIC = "https://paca.example.test:8443";
const MARTIN = { iss: ISSUER, sub: "martin-subject", preferred_username: "martin" };
const ALEX = { iss: ISSUER, sub: "alex-subject", preferred_username: "alex" };

let base;
let server;
// Every call a user's conversation receives, as [user, call, ...args].
let calls;
const key = randomBytes(32);
let nextClaims = MARTIN;

/** A stub user: their own conversation stub and their own page state. */
function stubUser(id) {
	return {
		paca: {
			ask: async (text, requestId) => (calls.push([id, "ask", text, requestId]), { id: 1, duplicate: false }),
			stop: () => calls.push([id, "stop"]),
			approveDraft: async (...args) => (calls.push([id, "approve", ...args]), args[0] === "done" ? { refused: "created" } : args[0] === "gone" ? { refused: "unavailable" } : { status: "created", url: "https://github.com/o/r/issues/1" }),
			dismissDraft: async (...args) => (calls.push([id, "dismiss", ...args]), { status: "dismissed" }),
		},
		state: createStateFeed(() => ({ running: false, turns: [{ id: "1", question: `${id}'s question`, steps: [], answer: `kept for ${id}`, notices: [], drafts: [] }] }), 1),
		info: { model: "test/model", scope: `1 Projects`, scopeDetail: `${id}-repo` },
	};
}
const users = new Map([
	[MARTIN.sub, stubUser("martin")],
	[ALEX.sub, stubUser("alex")],
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
const ask = (auth, headers = {}, body = { text: "What needs attention?", requestId: "request-0001" }) => post(auth, "/api/messages", body, headers);

async function firstState(auth) {
	const controller = new AbortController();
	const response = await fetch(`${base}/api/events`, { headers: { cookie: auth.cookie }, signal: controller.signal });
	const { value } = await response.body.getReader().read();
	controller.abort();
	const frame = new TextDecoder().decode(value);
	assert.match(frame, /^event: state\ndata: /);
	return JSON.parse(frame.split("data: ")[1]);
}

describe("identity", () => {
	it("sends visitors without a session to sign in and refuses the API", async () => {
		const page = await fetch(`${base}/`, { redirect: "manual" });
		assert.equal(page.status, 302);
		assert.equal(page.headers.get("location"), "/auth/login");
		assert.equal((await fetch(`${base}/api/events`)).status, 401);
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
	it("refuses POSTs from another origin or without the CSRF token", async () => {
		const auth = await signedIn();
		const before = calls.length;
		assert.equal((await ask(auth, { origin: "https://evil.example.test" })).status, 403);
		assert.equal((await ask(auth, { "x-csrf-token": "wrong" })).status, 403);
		assert.equal((await ask({ ...auth, csrf: "" })).status, 403);
		assert.equal(calls.length, before);
	});

	it("accepts a bounded question with a request id", async () => {
		const auth = await signedIn();
		assert.equal((await ask(auth)).status, 202);
		assert.deepEqual(calls.at(-1), ["martin", "ask", "What needs attention?", "request-0001"]);
		assert.equal((await ask(auth, {}, { text: "x".repeat(4001), requestId: "request-0002" })).status, 400);
		assert.equal((await ask(auth, {}, { text: "hi" })).status, 400);
		const huge = await fetch(`${base}/api/messages`, {
			method: "POST",
			headers: { cookie: auth.cookie, origin: new URL(PUBLIC).origin, "x-csrf-token": auth.csrf },
			body: "x".repeat(20_000),
		});
		assert.equal(huge.status, 413);
	});

	it("starts every event stream from the current snapshot", async () => {
		assert.equal((await firstState(await signedIn())).turns[0].answer, "kept for martin");
	});
});

describe("two users", () => {
	it("gives each user only their own session info, stream and conversation", async () => {
		const martin = await signedIn(MARTIN);
		const alex = await signedIn(ALEX);
		assert.notEqual(martin.csrf, alex.csrf);
		assert.equal((await (await fetch(`${base}/api/session`, { headers: { cookie: alex.cookie } })).json()).scopeDetail, "alex-repo");
		assert.equal((await firstState(alex)).turns[0].answer, "kept for alex");
		assert.equal((await firstState(martin)).turns[0].answer, "kept for martin");

		assert.equal((await ask(alex, {}, { text: "Alex asks", requestId: "request-alex" })).status, 202);
		assert.equal((await post(alex, "/api/stop", {})).status, 202);
		assert.deepEqual(calls.slice(-2), [["alex", "ask", "Alex asks", "request-alex"], ["alex", "stop"]]);
	});

	it("routes approvals to the signed-in user's own drafts and refuses another user's CSRF token", async () => {
		const martin = await signedIn(MARTIN);
		const alex = await signedIn(ALEX);
		assert.equal((await post(alex, "/api/drafts/approve", { id: "d1" })).status, 200);
		assert.deepEqual(calls.at(-1), ["alex", "approve", "d1"]);
		const before = calls.length;
		assert.equal((await post({ cookie: alex.cookie, csrf: martin.csrf }, "/api/drafts/approve", { id: "d1" })).status, 403);
		assert.equal(calls.length, before);
	});
});

describe("draft decisions", () => {
	it("refuses decisions without a session, from another origin or without the CSRF token", async () => {
		const auth = await signedIn();
		const before = calls.length;
		assert.equal((await post({ cookie: "", csrf: "" }, "/api/drafts/approve", { id: "d1" })).status, 401);
		assert.equal((await post(auth, "/api/drafts/approve", { id: "d1" }, { origin: "https://evil.example.test" })).status, 403);
		assert.equal((await post(auth, "/api/drafts/approve", { id: "d1" }, { "x-csrf-token": "wrong" })).status, 403);
		assert.equal(calls.length, before);
	});

	it("passes only the draft id, never replacement content", async () => {
		const auth = await signedIn();
		const response = await post(auth, "/api/drafts/approve", { id: "d1", title: "Something else", body: "injected", repository: "x/y" });
		assert.equal(response.status, 200);
		assert.deepEqual(calls.at(-1), ["martin", "approve", "d1"]);
		assert.equal((await post(auth, "/api/drafts/dismiss", { id: "d2" })).status, 200);
		assert.deepEqual(calls.at(-1), ["martin", "dismiss", "d2"]);
		assert.equal((await post(auth, "/api/drafts/approve", { id: "done" })).status, 409);
		assert.equal((await post(auth, "/api/drafts/approve", { id: "gone" })).status, 409);
		assert.equal((await post(auth, "/api/drafts/approve", {})).status, 400);
	});
});
