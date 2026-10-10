// POST /api/sessions/<id>/proposals over HTTP: the checks before a page proposal reaches the
// user's sessions, its own body bound, and how each outcome reads to the page.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createSessions } from "../src/auth.ts";
import { createFeed } from "../src/feed.ts";
import { createApp } from "../src/server.ts";

const ISSUER = "https://id.example.test/";
const PUBLIC = "https://paca.example.test";
const GITHUB = { name: "github", entry: "/ext/github/dist/index.js", styles: [], cards: ["issue"], pages: { home: { title: "GitHub" } }, nav: { label: "GitHub", page: "home" } };
const SESSION = randomUUID();

describe("the page proposal route", () => {
	let base;
	let server;
	let next;
	const calls = [];
	const lines = [];
	/** What the stub's sessions answer, by the proposal's title. */
	const outcomes = {
		ok: { session: SESSION, draft: "page:x", duplicate: false },
		scope: { refused: "operation", status: 404, error: "That repository is not in your GitHub scope." },
		crash: { refused: "failed", error: "secret detail" },
		missing: { refused: "not-found" },
		deleting: { refused: "deleting" },
		conflict: { refused: "conflict" },
		action: { refused: "not-proposable" },
	};
	const stubUser = (id, extensions) => ({
		id,
		sessions: {
			list: createFeed(() => [], 1),
			ask: () => ({ duplicate: false }),
			proposeFromPage: async (session, request) => (calls.push([id, session, request]), outcomes[request.input.title] ?? outcomes.ok),
		},
		info: { model: "m", scope: "s", scopeDetail: "", extensions },
	});
	const users = new Map([["martin", stubUser("martin", [GITHUB])], ["off", stubUser("off", [])]]);

	before(async () => {
		server = createApp({
			config: { publicUrl: PUBLIC, publicOrigin: PUBLIC },
			sessions: createSessions({ key: randomBytes(32), issuer: ISSUER, allows: (sub) => users.has(sub) }),
			oidc: { begin: async () => ({ url: `${ISSUER}authorize`, transaction: { state: "s", nonce: "n", verifier: "v" } }), finish: async () => ({ claims: next }) },
			users: { forSubject: (sub) => users.get(sub) },
			web: { public: join(import.meta.dirname, "..", "..", "web", "public"), script: join(import.meta.dirname, "..", "..", "web", "public") },
			log: { warn: (l) => lines.push(l), error: (l) => lines.push(l) },
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${server.address().port}`;
	});
	after(() => server.close());

	const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	async function signIn(sub) {
		next = { iss: ISSUER, sub };
		const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
		const cookie = cookieOf(await fetch(`${base}/auth/callback?code=c&state=s`, { redirect: "manual", headers: { cookie: cookieOf(login) } }));
		const { csrf } = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
		return { cookie, csrf };
	}
	const body = (extra = {}) => ({ requestId: "page-request-1", package: "github", action: "create_issue", input: { repository: "o/r", title: "ok", body: "b" }, ...extra });
	const send = (auth, payload, { id = SESSION, path = "proposals", headers = {} } = {}) =>
		fetch(`${base}/api/sessions/${id}/${path}`, { method: "POST", headers: { cookie: auth.cookie, origin: PUBLIC, "x-csrf-token": auth.csrf, "content-type": "application/json", ...headers }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
	const answer = async (response) => [response.status, await response.json()];

	it("passes a proposal on with its ids, start and the nav label for a new session's title", async () => {
		const martin = await signIn("martin");
		calls.length = 0;
		assert.deepEqual(await answer(await send(martin, body({ start: true }))), [200, outcomes.ok]);
		assert.deepEqual(calls, [["martin", SESSION, { requestId: "page-request-1", package: "github", action: "create_issue", input: { repository: "o/r", title: "ok", body: "b" }, start: true, label: "GitHub" }]]);
	});

	it("refuses a wrong Origin or CSRF token, a session id that is not a UUID, and a malformed body before the sessions see it", async () => {
		const martin = await signIn("martin");
		calls.length = 0;
		assert.equal((await send(martin, body(), { headers: { origin: "https://elsewhere.test" } })).status, 403);
		assert.equal((await send(martin, body(), { headers: { "x-csrf-token": "wrong" } })).status, 403);
		assert.equal((await send(martin, body(), { id: "../legacy" })).status, 404);
		assert.deepEqual(await answer(await send(martin, body(), { id: "not-a-uuid" })), [404, { error: "That session does not exist." }]);
		assert.deepEqual(await answer(await send(martin, body(), { id: SESSION.toUpperCase() })), [404, { error: "That session does not exist." }]);
		assert.equal((await send(martin, body({ requestId: "short" }))).status, 400);
		assert.equal((await send(martin, body({ requestId: "has spaces in it" }))).status, 400);
		assert.equal((await send(martin, body({ input: [1] }))).status, 400);
		assert.equal((await send(martin, body({ start: "yes" }))).status, 400);
		assert.deepEqual(calls, []);
	});

	it("answers 404 for a package the user's page does not list: unknown, frontend off, or Herdr", async () => {
		const [martin, off] = [await signIn("martin"), await signIn("off")];
		calls.length = 0;
		for (const pkg of ["other", "herdr", "constructor", 7]) assert.deepEqual(await answer(await send(martin, body({ package: pkg }))), [404, { error: "That can't be proposed here." }], String(pkg));
		assert.deepEqual(await answer(await send(off, body())), [404, { error: "That can't be proposed here." }]);
		assert.deepEqual(calls, []);
	});

	it("takes up to 128 KiB on this route only", async () => {
		const martin = await signIn("martin");
		const sized = (bytes) => {
			const json = JSON.stringify(body({ input: { repository: "o/r", title: "ok", body: "" } }));
			return json.replace('"body":""', `"body":"${"x".repeat(bytes - json.length)}"`);
		};
		assert.equal(sized(128 * 1024).length, 128 * 1024);
		assert.equal((await send(martin, sized(128 * 1024))).status, 200);
		assert.equal((await send(martin, sized(128 * 1024 + 1))).status, 413);
		assert.equal((await send(martin, { text: "x".repeat(17 * 1024), requestId: "request-0001" }, { path: "messages" })).status, 413);
	});

	it("words each refusal for the page, and logs a builder crash as one line without showing it", async () => {
		const martin = await signIn("martin");
		lines.length = 0;
		const as = (title) => body({ input: { repository: "o/r", title, body: "b" } });
		assert.deepEqual(await answer(await send(martin, as("scope"))), [404, { error: "That repository is not in your GitHub scope." }]);
		assert.deepEqual(await answer(await send(martin, as("missing"))), [404, { error: "That session does not exist." }]);
		assert.deepEqual(await answer(await send(martin, as("deleting"))), [409, { error: "That session is being deleted." }]);
		assert.deepEqual(await answer(await send(martin, as("conflict"))), [409, { error: "That request was already used for a different proposal." }]);
		assert.deepEqual(await answer(await send(martin, as("action"))), [404, { error: "That can't be proposed here." }]);
		assert.deepEqual(lines, []);
		assert.deepEqual(await answer(await send(martin, as("crash"))), [500, { error: "Something went wrong on the server." }]);
		assert.deepEqual(lines, ["paca: extension github proposal create_issue failed for user martin: secret detail"]);
	});
});
