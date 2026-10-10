// An API called with the sign-in's access token, end to end over HTTP (#21): the example extension
// (test/fixtures/extension-downstream) as a local extension, the faux model, a stub sign-in whose
// tokens come from the fake Example API (test/container/fake-api.mjs), answered in process. Covers
// two users, sign-out on another device, a restart with a surviving cookie, and approvals with
// missing credentials, failed and unknown outcomes and no second send. See docs/design/api-access.md.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { API_PATH, createFakeApi } from "../../../test/container/fake-api.mjs";
import { createApiAccess, RefreshRefused } from "../src/api-access.ts";
import { createSessions } from "../src/auth.ts";
import { loadLocalExtensions } from "../src/local-extensions.ts";
import { createApp } from "../src/server.ts";
import { openUsers } from "../src/users.ts";
import { call, fauxModel, idle, newId, stateOf, tempDir, text } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ISSUER = "https://id.example.test/";
const PUBLIC = "https://paca.example.test";
const SCOPE = "openid profile offline_access notes.read notes.write";
const API = { name: "notes", label: "Example API", url: `https://api.example.test${API_PATH}`, scopes: ["notes.read", "notes.write"], extensions: ["example-notes"] };
const CONFIGURED = [
	{ id: "martin", subject: "sub-martin", operator: true, apis: ["notes"] },
	{ id: "alex", subject: "sub-alex", operator: false, apis: ["notes"] },
	{ id: "sam", subject: "sub-sam", operator: false },
];

describe("an API called with the sign-in's access token", () => {
	const key = randomBytes(32);
	const fake = createFakeApi({ audience: "paca" });
	const lines = [];
	const log = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(String(l)) };
	let dataDir;
	let model;
	let paca;

	/** Paca as one process: its users, in-memory API access and HTTP server. A restart is close() and start() again. */
	async function start() {
		const apiAccess = createApiAccess({
			apis: { notes: API },
			refresh: async (token) => {
				const answer = await fake.renew(token);
				if (!answer) throw new RefreshRefused("invalid_grant");
				return { accessToken: answer.access_token, refreshToken: answer.refresh_token, expiresAt: Date.now() + answer.expires_in * 1000, scope: answer.scope };
			},
			fetch: (url, init) => fake.handle(new Request(url, init)),
			log,
		});
		const local = await loadLocalExtensions({ dataDir, users: CONFIGURED, installed: [], log });
		const users = await openUsers({ users: CONFIGURED, packages: [], local, dataDir, modelRuntime: model.modelRuntime, model: model.model, modelLabel: "faux", apiAccess, log });
		let next;
		const server = createApp({
			config: { publicUrl: PUBLIC, publicOrigin: PUBLIC },
			sessions: createSessions({ key, issuer: ISSUER, allows: (sub) => users.forSubject(sub) !== undefined }),
			oidc: { begin: async () => ({ url: `${ISSUER}authorize`, transaction: { state: "s", nonce: "n", verifier: "v" } }), finish: async () => next },
			users,
			web: { public: join(ROOT, "packages", "web", "public"), script: join(ROOT, "packages", "web", "public") },
			log,
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${server.address().port}`;
		const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		/** A device of `sub`: a fresh sign-in, whose tokens the fake provider issued for it. */
		const signIn = async (sub, scope = SCOPE, { expiresIn } = {}) => {
			const answer = fake.issue({ sub, username: `${sub.slice(4)} (synthetic)`, scope });
			next = { claims: { iss: ISSUER, sub }, grant: { accessToken: answer.access_token, refreshToken: answer.refresh_token, expiresAt: Date.now() + (expiresIn ?? answer.expires_in) * 1000, scope: answer.scope, subject: sub } };
			const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
			const cookie = cookieOf(await fetch(`${base}/auth/callback?code=c&state=s`, { redirect: "manual", headers: { cookie: cookieOf(login) } }));
			return device(cookie);
		};
		/** A browser holding `cookie`, which can outlive the process that set it. */
		const device = async (cookie) => {
			const session = async () => (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
			const { csrf } = await session();
			const post = async (path, body = {}) => {
				const r = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: PUBLIC, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
				const answer = await r.text();
				bodies.push(answer);
				return [r.status, JSON.parse(answer)];
			};
			return { cookie, session, post, notes: () => post("/api/ext/example-notes/notes") };
		};
		const close = async () => {
			server.close();
			await users.close();
		};
		return { users, signIn, device, close };
	}

	/** Every answer the page got, to check no token is among them. */
	const bodies = [];
	const noTokens = () => {
		const tokens = [...fake.access.keys(), ...fake.refresh.keys()];
		for (const text of [...bodies, ...lines]) for (const token of tokens) assert.ok(!text.includes(token), "a token reached a response or a log line");
	};

	before(async () => {
		dataDir = await tempDir("paca-data-");
		await cp(join(ROOT, "test", "fixtures", "extension-downstream"), join(dataDir, "local-extensions", "example-notes"), { recursive: true });
		model = await fauxModel(dataDir);
		paca = await start();
	});
	after(async () => {
		await paca.close();
		noTokens();
	});

	it("keeps each user's own access and lets the example read as them only", async () => {
		const martin = await paca.signIn("sub-martin");
		const alex = await paca.signIn("sub-alex");
		assert.deepEqual((await martin.session()).apis, [{ name: "notes", label: "Example API", state: "ready" }]);
		const [, mine] = await martin.notes();
		const [, theirs] = await alex.notes();
		assert.equal(mine.username, "martin (synthetic)");
		assert.equal(theirs.username, "alex (synthetic)");
		assert.match(mine.notes[0].text, /Welcome, martin/);
		// A user not allowed the API has no example tools, page or operation.
		const sam = await paca.signIn("sub-sam");
		assert.deepEqual((await sam.session()).apis, []);
		assert.equal((await sam.notes())[0], 404);
		noTokens();
	});

	it("asks a device whose cookie outlived the access to sign in again: sign-out elsewhere, then a restart", async () => {
		const phone = await paca.signIn("sub-martin");
		const laptop = await paca.signIn("sub-martin");
		assert.equal((await phone.notes())[1].username, "martin (synthetic)", "the latest sign-in's grant serves every device");
		await phone.post("/auth/logout");
		assert.equal((await laptop.session()).apis[0].state, "sign-in", "sign-out ends API access on every device");
		assert.deepEqual((await laptop.notes())[1], { label: "Example API", problem: "Sign in to Paca again so this can use Example API.", signIn: true });
		const alex = await paca.signIn("sub-alex");
		assert.equal((await alex.notes())[1].username, "alex (synthetic)", "another user is not signed out");

		const signedIn = await paca.signIn("sub-martin");
		await paca.close();
		paca = await start();
		const after = await paca.device(signedIn.cookie);
		assert.equal((await after.session()).name !== undefined, true, "the cookie still signs in");
		assert.equal((await after.session()).apis[0].state, "sign-in", "no grant survives a restart");
		assert.equal((await after.notes())[1].signIn, true);
		const again = await paca.signIn("sub-martin");
		assert.equal((await again.notes())[1].username, "martin (synthetic)");
		noTokens();
	});

	it("marks the API not granted when the sign-in lacks its scopes", async () => {
		const narrow = await paca.signIn("sub-alex", "openid profile notes.read");
		assert.equal((await narrow.session()).apis[0].state, "not-granted");
		assert.equal((await narrow.notes())[1].problem, "Your Paca sign-in does not include access to Example API.");
		assert.match(lines.join("\n"), /user alex: sign-in did not grant notes \(notes\.write\)/);
		await paca.signIn("sub-alex");
	});

	describe("approvals", () => {
		const posts = () => fake.seen.filter((r) => r.method === "POST").length;
		/** A note the faux model proposes in a new session of martin's, with its draft. */
		async function proposed(note) {
			model.faux.setResponses([call("propose_note", { note }), text("Proposed.")]);
			const { sessions } = paca.users.forSubject("sub-martin");
			const id = newId();
			sessions.start(id, `Add a note: ${note}`, `request-${id}`);
			await idle(sessions, id);
			const [draft] = (await stateOf(sessions, id)).turns.flatMap((t) => t.drafts);
			return { id, draft };
		}
		const approve = (device, { id, draft }) => device.post(`/api/sessions/${id}/drafts/approve`, { id: draft.id });

		it("keeps a proposal waiting while credentials are missing, then writes it once", async () => {
			const device = await paca.signIn("sub-martin");
			const proposal = await proposed("Buy oat milk");
			assert.deepEqual([proposal.draft.action, proposal.draft.target, proposal.draft.title, proposal.draft.body, proposal.draft.status], ["example-notes.add_note", "Example API", "New note", "Buy oat milk", "proposed"]);
			const before = posts();
			paca.users.forSubject("sub-martin").apis.signedOut(); // as a sign-out on another device does
			const [status, answer] = await approve(device, proposal);
			assert.equal(status, 409);
			assert.deepEqual(answer, { error: "Sign in to Paca again so this can use Example API. Then approve it, or dismiss it.", status: "proposed" });
			assert.equal((await stateOf(paca.users.forSubject("sub-martin").sessions, proposal.id)).turns.flatMap((t) => t.drafts)[0].status, "proposed");
			assert.equal(posts(), before, "nothing was sent");

			const again = await paca.signIn("sub-martin");
			const results = await Promise.all([approve(again, proposal), approve(device, proposal), approve(again, proposal)]);
			assert.deepEqual(results.map(([s]) => s).sort(), [200, 409, 409]);
			assert.equal(posts(), before + 1, "written once, even with simultaneous approvals");
			assert.deepEqual(fake.notes.get("sub-martin").map((n) => n.text).slice(-1), ["Buy oat milk"]);
			assert.equal((await approve(again, proposal))[0], 409);
			assert.equal(posts(), before + 1);
		});

		it("keeps a proposal waiting in the last minute of an access token that cannot be renewed", async () => {
			const proposal = await proposed("Near expiry");
			// A sign-in without offline_access whose access token has 30 seconds left.
			const device = await paca.signIn("sub-martin", "openid profile notes.read notes.write", { expiresIn: 30 });
			const before = posts();
			const [status, answer] = await approve(device, proposal);
			assert.deepEqual([status, answer.status], [409, "proposed"]);
			assert.equal((await stateOf(paca.users.forSubject("sub-martin").sessions, proposal.id)).turns.flatMap((t) => t.drafts)[0].status, "proposed");
			assert.equal(posts(), before);
			const again = await paca.signIn("sub-martin");
			assert.deepEqual(await approve(again, proposal), [200, { status: "created" }]);
		});

		it("never sends an unknown write again, and records a refusal as failed", async () => {
			const device = await paca.signIn("sub-martin");
			const unknown = await proposed("Maybe written");
			fake.faults.writeStatus = 503;
			const before = posts();
			assert.deepEqual(await approve(device, unknown), [200, { status: "unknown" }]);
			fake.faults.writeStatus = undefined;
			assert.equal((await approve(device, unknown))[0], 409);
			assert.equal(posts(), before + 1);

			const refused = await proposed("Refused");
			fake.faults.writeStatus = 403;
			assert.deepEqual(await approve(device, refused), [200, { status: "failed" }]);
			fake.faults.writeStatus = undefined;
			const [draft] = (await stateOf(paca.users.forSubject("sub-martin").sessions, refused.id)).turns.flatMap((t) => t.drafts);
			assert.equal(draft.error, "Example API refused it (403)");
		});

		it("fails a write whose access ended after the approval was claimed, sending nothing", async () => {
			await paca.signIn("sub-martin");
			const { sessions, apis } = paca.users.forSubject("sub-martin");
			const write = sessions.packages.find((p) => p.name === "example-notes").tools.writes.add_note;
			const before = posts();
			apis.signedOut();
			assert.deepEqual(await write.execute({ action: "add_note", target: "Example API", title: "New note", body: "Late" }), { status: "failed", error: "Sign in to Paca again so your extensions can use Example API." });
			assert.equal(posts(), before);
		});

		it("takes a page's exact proposal and writes it as the user who approves it", async () => {
			const alex = await paca.signIn("sub-alex");
			const [status, admitted] = await alex.post(`/api/sessions/${newId()}/proposals`, { requestId: "page-note-1", package: "example-notes", action: "add_note", input: { note: "From the page" }, start: true });
			assert.equal(status, 200);
			assert.deepEqual(await alex.post(`/api/sessions/${admitted.session}/drafts/approve`, { id: admitted.draft }), [200, { status: "created" }]);
			assert.deepEqual(fake.notes.get("sub-alex").map((n) => n.text).slice(-1), ["From the page"]);
			assert.ok(!fake.notes.get("sub-martin").some((n) => n.text === "From the page"));
			// Martin cannot approve alex's draft: it is not in his store.
			const martin = await paca.signIn("sub-martin");
			assert.equal((await martin.post(`/api/sessions/${admitted.session}/drafts/approve`, { id: admitted.draft }))[0], 404);
			noTokens();
		});
	});
});
