// Package operations over HTTP: the reads behind extension pages. Each user reaches only their own
// operations, through the usual Origin and CSRF checks, with a time limit and a size cap.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { OperationError } from "@paca/extension";
import { createSessions } from "../src/auth.ts";
import { createFeed } from "../src/feed.ts";
import { createApp } from "../src/server.ts";

const ISSUER = "https://id.example.test/";
const PUBLIC = "https://paca.example.test";
const info = (name) => ({ name, entry: `/ext/${name}/dist/index.js`, styles: [], cards: [], pages: { home: { title: "Home" } } });

describe("package operations", () => {
	let base;
	let server;
	let next;
	const calls = [];
	const lines = [];

	/** A user whose `probe` operations record every call; `frontend` says whether their page lists it. */
	function stubUser(id, frontend = true) {
		const record = (op, answer) => async (input, signal) => (calls.push([id, op, input, signal instanceof AbortSignal]), answer(input, signal));
		const operations = {
			whoami: record("whoami", async () => ({ user: id })),
			echo: record("echo", async (input) => input),
			refuse: record("refuse", async () => {
				throw new OperationError(404, "That repository is not in your GitHub scope.");
			}),
			crash: record("crash", async () => {
				throw new Error("secret detail");
			}),
			slow: record("slow", (_input, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("too late")))),
			huge: record("huge", async () => ({ text: "x".repeat(512 * 1024) })),
			// Not async: an operation may check its input and throw before it returns a promise.
			sync_refuse: () => {
				throw new OperationError(400, "Bad input.");
			},
			sync_crash: () => {
				throw new Error("sync bug");
			},
		};
		return {
			id,
			sessions: { list: createFeed(() => [], 1) },
			info: { model: "m", scope: "s", scopeDetail: "", extensions: frontend ? [info("probe")] : [] },
			operation: (pkg, op) => (pkg === "probe" && Object.hasOwn(operations, op) ? operations[op] : undefined),
		};
	}
	const users = new Map([["martin", stubUser("martin")], ["alex", stubUser("alex")], ["off", stubUser("off", false)]]);

	before(async () => {
		const sessions = createSessions({ key: randomBytes(32), issuer: ISSUER, allows: (sub) => users.has(sub) });
		server = createApp({
			config: { publicUrl: PUBLIC, publicOrigin: PUBLIC },
			sessions,
			oidc: { begin: async () => ({ url: `${ISSUER}authorize`, transaction: { state: "s", nonce: "n", verifier: "v" } }), finish: async () => next },
			users: { forSubject: (sub) => users.get(sub) },
			web: { public: join(import.meta.dirname, "..", "..", "web", "public"), script: join(import.meta.dirname, "..", "..", "web", "public") },
			operationTimeoutMs: 100,
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
	const call = (auth, op, body = {}, headers = {}) =>
		fetch(`${base}/api/ext/probe/${op}`, { method: "POST", headers: { cookie: auth.cookie, origin: PUBLIC, "x-csrf-token": auth.csrf, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
	const answer = async (response) => [response.status, await response.json()];

	it("answers each user from their own operations, with the input as given and an abort signal", async () => {
		const [martin, alex] = [await signIn("martin"), await signIn("alex")];
		calls.length = 0;
		assert.deepEqual(await answer(await call(martin, "whoami")), [200, { user: "martin" }]);
		assert.deepEqual(await answer(await call(alex, "whoami")), [200, { user: "alex" }]);
		assert.deepEqual(await answer(await call(martin, "echo", { query: "x", n: 1 })), [200, { query: "x", n: 1 }]);
		assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["martin", "whoami"], ["alex", "whoami"], ["martin", "echo"]]);
		assert.ok(calls.every((c) => c[3]));
	});

	it("refuses a wrong Origin or CSRF token before the operation runs", async () => {
		const martin = await signIn("martin");
		calls.length = 0;
		assert.equal((await call(martin, "whoami", {}, { origin: "https://elsewhere.test" })).status, 403);
		assert.equal((await call(martin, "whoami", {}, { "x-csrf-token": "wrong" })).status, 403);
		assert.equal((await fetch(`${base}/api/ext/probe/whoami`, { method: "POST", headers: { origin: PUBLIC }, body: "{}" })).status, 401);
		assert.deepEqual(calls, []);
	});

	it("answers 404 for an unknown package or operation, and for a package the user's page does not list", async () => {
		const [martin, off] = [await signIn("martin"), await signIn("off")];
		calls.length = 0;
		for (const path of ["/api/ext/probe/missing", "/api/ext/other/whoami", "/api/ext/probe/constructor", "/api/ext/probe/__proto__", "/api/ext/Probe/whoami"]) {
			const response = await fetch(`${base}${path}`, { method: "POST", headers: { cookie: martin.cookie, origin: PUBLIC, "x-csrf-token": martin.csrf }, body: "{}" });
			assert.equal(response.status, 404, path);
		}
		assert.equal((await call(off, "whoami")).status, 404);
		assert.deepEqual(calls, []);
		assert.equal((await fetch(`${base}/api/ext/probe/whoami`, { headers: { cookie: martin.cookie } })).status, 404, "GET is not an operation");
	});

	it("needs a JSON object of at most 16 KiB", async () => {
		const martin = await signIn("martin");
		assert.equal((await call(martin, "echo", "[1]")).status, 400);
		assert.equal((await call(martin, "echo", "null")).status, 400);
		assert.equal((await call(martin, "echo", "{")).status, 400);
		assert.equal((await call(martin, "echo", { text: "x".repeat(16 * 1024) })).status, 413);
	});

	it("answers an operation that throws before returning a promise, and keeps serving", async () => {
		const martin = await signIn("martin");
		lines.length = 0;
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			assert.deepEqual(await answer(await call(martin, "sync_refuse")), [400, { error: "Bad input." }]);
			assert.deepEqual(await answer(await call(martin, "sync_crash")), [500, { error: "Something went wrong on the server." }]);
			// The response's close aborts the operation's signal; nothing may be left unhandled.
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(unhandled, []);
			assert.deepEqual(await answer(await call(martin, "whoami")), [200, { user: "martin" }]);
			assert.deepEqual(lines, ["paca: extension probe op sync_crash failed for user martin: sync bug"]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("shows an OperationError as given, hides a crash, and logs one line for a crash, a timeout or too much", async () => {
		const martin = await signIn("martin");
		lines.length = 0;
		assert.deepEqual(await answer(await call(martin, "refuse")), [404, { error: "That repository is not in your GitHub scope." }]);
		assert.deepEqual(lines, []);
		assert.deepEqual(await answer(await call(martin, "crash")), [500, { error: "Something went wrong on the server." }]);
		assert.deepEqual(await answer(await call(martin, "slow")), [504, { error: "The extension took too long. Try again." }]);
		assert.deepEqual(await answer(await call(martin, "huge")), [502, { error: "The extension answered too much." }]);
		assert.deepEqual(lines, [
			"paca: extension probe op crash failed for user martin: secret detail",
			"paca: extension probe op slow took longer than 0.1 s for user martin",
			`paca: extension probe op huge answered ${JSON.stringify({ text: "x".repeat(512 * 1024) }).length} bytes for user martin`,
		]);
	});
});
