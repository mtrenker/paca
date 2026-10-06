import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createSessions, SESSION_COOKIE } from "../src/auth.js";
import { createApp, createStateFeed } from "../src/server.js";

const ISSUER = "https://id.example.test/application/o/paca/";
const PUBLIC = "https://paca.example.test:8443";
const MARTIN = { iss: ISSUER, sub: "martin-subject", preferred_username: "martin" };

let base;
let server;
let asked;
let feed;
const key = randomBytes(32);
const sessions = createSessions({ key, issuer: ISSUER, allowedSubject: MARTIN.sub });
let nextClaims = MARTIN;

before(async () => {
	asked = [];
	feed = createStateFeed(() => ({ running: false, turns: [{ id: "1", question: "earlier", steps: [], answer: "kept", notices: [] }] }), 1);
	server = createApp({
		config: { publicUrl: PUBLIC, publicOrigin: new URL(PUBLIC).origin },
		sessions,
		oidc: {
			begin: async () => ({ url: `${ISSUER}authorize?state=s`, transaction: { state: "s", nonce: "n", verifier: "v" } }),
			finish: async () => nextClaims,
		},
		paca: { ask: async (text, requestId) => (asked.push({ text, requestId }), { id: 1, duplicate: false }), stop: () => {} },
		state: feed,
		info: { model: "test/model", repositories: ["o/r"], projects: 1 },
		publicDir: join(import.meta.dirname, "..", "public"),
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

async function signedIn() {
	const cookie = cookieOf(await signIn());
	const { csrf } = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
	return { cookie, csrf };
}

const ask = (auth, headers = {}, body = { text: "What needs attention?", requestId: "request-0001" }) =>
	fetch(`${base}/api/messages`, {
		method: "POST",
		headers: { cookie: auth.cookie, origin: new URL(PUBLIC).origin, "x-csrf-token": auth.csrf, "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

describe("identity", () => {
	it("sends visitors without a session to sign in and refuses the API", async () => {
		const page = await fetch(`${base}/`, { redirect: "manual" });
		assert.equal(page.status, 302);
		assert.equal(page.headers.get("location"), "/auth/login");
		assert.equal((await fetch(`${base}/api/events`)).status, 401);
		assert.equal((await fetch(`${base}/api/session`)).status, 401);
	});

	it("refuses a second identity without creating a session", async () => {
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

	it("admits the allowed identity with a secure host-only cookie", async () => {
		const response = await signIn();
		assert.equal(response.status, 303);
		const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
		assert.match(cookie, /HttpOnly/);
		assert.match(cookie, /Secure/);
		assert.match(cookie, /SameSite=Lax/);
		assert.equal((await fetch(`${base}/`, { headers: { cookie: cookieOf(response) } })).status, 200);
	});

	it("rejects forged, expired and no longer allowed sessions", async () => {
		const forged = createSessions({ key: randomBytes(32), issuer: ISSUER, allowedSubject: MARTIN.sub });
		const expired = createSessions({ key, issuer: ISSUER, allowedSubject: MARTIN.sub, now: () => Date.now() - 13 * 3600_000 });
		const revoked = createSessions({ key, issuer: ISSUER, allowedSubject: "previous-subject" });
		for (const s of [forged, expired, revoked]) {
			const cookie = s.start({ ...MARTIN, sub: s === revoked ? "previous-subject" : MARTIN.sub })[0].split(";")[0];
			assert.equal((await fetch(`${base}/api/session`, { headers: { cookie } })).status, 401);
		}
	});
});

describe("requests", () => {
	it("refuses POSTs from another origin or without the CSRF token", async () => {
		const auth = await signedIn();
		assert.equal((await ask(auth, { origin: "https://evil.example.test" })).status, 403);
		assert.equal((await ask(auth, { "x-csrf-token": "wrong" })).status, 403);
		assert.equal((await ask({ ...auth, csrf: "" })).status, 403);
		assert.equal(asked.length, 0);
	});

	it("accepts a bounded question with a request id", async () => {
		const auth = await signedIn();
		assert.equal((await ask(auth)).status, 202);
		assert.deepEqual(asked.at(-1), { text: "What needs attention?", requestId: "request-0001" });
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
		const auth = await signedIn();
		const controller = new AbortController();
		const response = await fetch(`${base}/api/events`, { headers: { cookie: auth.cookie }, signal: controller.signal });
		const reader = response.body.getReader();
		const { value } = await reader.read();
		controller.abort();
		const frame = new TextDecoder().decode(value);
		assert.match(frame, /^event: state\ndata: /);
		assert.equal(JSON.parse(frame.split("data: ")[1]).turns[0].answer, "kept");
	});
});
