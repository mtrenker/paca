// The Herdr package on real per-user sessions with the faux model and a fake Herdr socket
// (test/container/fake-herdr.mjs): who gets the tools, the card in its session, approving it once,
// and the session rules (isolation, duplicates, restart, deletion, conversion) for prompts.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SAMPLE_AGENTS, startFakeHerdr } from "../../../test/container/fake-herdr.mjs";
import { loadPackages } from "../src/extensions.ts";
import { persona } from "../src/persona.ts";
import { openStore } from "../src/store.ts";
import { openUsers } from "../src/users.ts";
import { call, fauxModel, idle, newId, stateOf, tempDir, text, until } from "./helpers.js";

const MARTIN = { id: "martin", subject: "martin-subject", operator: true, herdr: { roots: ["/home/preview/code"] } };
const ALEX = { id: "alex", subject: "alex-subject", operator: false };
const PROMPT = "Run the tests.\nThen report.";
const HERDR_TOOLS = ["list_agents", "propose_prompt", "read_agent_output"];
const proposing = () => [call("list_agents"), call("propose_prompt", { pane: "w1:p1", prompt: PROMPT }), text("Proposed.")];
const prompted = (fake) => fake.requests.filter((r) => r.method === "agent.prompt").length;
let open = [];
afterEach(async () => {
	await Promise.all(open.map((o) => o.close()));
	open = [];
});

async function start({ users = [MARTIN, ALEX], responses = [], dataDir, fake } = {}) {
	const dir = dataDir ?? (await tempDir("paca-herdr-"));
	if (!fake) open.push((fake = await startFakeHerdr({ path: join(dir, "herdr.sock") })));
	const model = await fauxModel(dir, responses);
	const opened = await openUsers({
		users,
		packages: await loadPackages({ "@paca/extension-herdr": { socket: fake.path } }),
		dataDir: dir,
		modelRuntime: model.modelRuntime,
		model: model.model,
		modelLabel: "faux",
		log: { log: () => {}, error: () => {} },
	});
	open.push(opened);
	const host = (user) => opened.forSubject(user.subject);
	return { dir, fake, faux: model.faux, users: opened, host, martin: host(MARTIN)?.sessions, alex: host(ALEX)?.sessions };
}

/** Martin starts a session whose answer lists the agents and proposes PROMPT for w1:p1. */
async function proposed(s, id = newId()) {
	s.faux.setResponses(proposing());
	assert.deepEqual(s.martin.start(id, "Ask my claude agent to run the tests", `request-${id}`), { duplicate: false });
	await idle(s.martin, id);
	return { id, card: (await stateOf(s.martin, id)).turns.at(-1).drafts[0] };
}

/** A session of Martin's with a plain answer and no draft. */
async function plain(s) {
	const id = newId();
	s.faux.setResponses([text("Nothing to do.")]);
	s.martin.start(id, "Anything new?", `request-${id}`);
	await idle(s.martin, id);
	return id;
}

describe("Herdr for the operator", () => {
	it("gives the tools to the operator only, and refuses Herdr settings on another user", async () => {
		const s = await start();
		const offered = (user) => s.host(user).sessions.packages.flatMap((p) => p.tools.tools.map((t) => t.name)).sort();
		assert.deepEqual(offered(MARTIN), HERDR_TOOLS);
		assert.deepEqual(offered(ALEX), []);
		assert.equal(s.host(MARTIN).info.scope, "Herdr agents");
		const { id } = await proposed(s);
		// The AgentSession has these tools and nothing else, and Paca's prompt with the Herdr scope.
		assert.deepEqual(s.martin.agentOf(id).getActiveToolNames().sort(), HERDR_TOOLS);
		assert.match(s.martin.agentOf(id).systemPrompt, /^You are Paca[\s\S]*call propose_prompt[\s\S]*Herdr scope[^\n]*\n- \/home\/preview\/code\n/);
		await assert.rejects(start({ users: [{ ...ALEX, herdr: { roots: ["/"] } }] }), /users "alex" herdr: only the operator/);
	});

	it("never lets another user or another session see or decide the operator's prompt", async () => {
		const s = await start({ responses: [call("list_agents"), text("Nothing.")] });
		const asAlex = newId();
		s.alex.start(asAlex, "list the agents", "alex-1");
		await idle(s.alex, asAlex);
		const [step] = (await stateOf(s.alex, asAlex)).turns[0].steps;
		assert.deepEqual([step.label, step.status], ["Refused tool list_agents", "unavailable"]);
		assert.deepEqual(s.fake.requests, []);

		const { id, card } = await proposed(s);
		const other = await plain(s);
		for (const [sessions, session] of [[s.alex, id], [s.alex, asAlex], [s.martin, other]]) {
			assert.deepEqual(await sessions.approveDraft(session, card.id), { refused: "not-found" });
			assert.deepEqual(sessions.dismissDraft(session, card.id), { refused: "not-found" });
		}
		assert.equal(await s.alex.watch(id), undefined);
		assert.deepEqual(s.alex.list.current().map((x) => x.id), [asAlex]);
		assert.deepEqual((await stateOf(s.martin, other)).turns.flatMap((t) => t.drafts), []);
		assert.equal((await stateOf(s.martin, id)).turns.at(-1).drafts[0].status, "proposed");
		assert.equal(prompted(s.fake), 0);
	});

	it("shows the exact agent and prompt in its session, and sends it once however often it is approved", async () => {
		const s = await start();
		const { id, card } = await proposed(s);
		assert.deepEqual(
			{ action: card.action, target: card.target, title: card.title, body: card.body, status: card.status },
			{ action: "herdr.send_prompt", target: "claude in w1:p1", title: "/home/preview/code/notes", body: PROMPT, status: "proposed" },
		);
		assert.deepEqual(s.martin.list.current().map((x) => [x.id, x.waiting]), [[id, 1]]);
		assert.equal(prompted(s.fake), 0);

		const results = await Promise.all([1, 2, 3].map(() => s.martin.approveDraft(id, card.id)));
		assert.deepEqual(results.filter((r) => r.status === "created"), [{ status: "created" }]);
		assert.deepEqual(s.fake.prompts, [{ pane: "w1:p1", terminal: "term_fake01", text: PROMPT }]);
		assert.deepEqual(await s.martin.approveDraft(id, card.id), { refused: "created" });
		const after = (await stateOf(s.martin, id)).turns.at(-1).drafts[0];
		assert.deepEqual([after.status, after.url, after.error], ["created", undefined, undefined]);
		assert.deepEqual(s.martin.list.current().map((x) => x.waiting), [0]);
	});

	it("answers a repeated question once, with one card", async () => {
		const s = await start();
		const { id } = await proposed(s);
		const calls = s.faux.state.callCount;
		assert.deepEqual(s.martin.start(id, "Ask my claude agent to run the tests", `request-${id}`), { duplicate: true });
		assert.deepEqual(s.martin.ask(id, "Ask my claude agent to run the tests", `request-${id}`), { duplicate: true });
		assert.equal(s.faux.state.callCount, calls);
		assert.equal((await stateOf(s.martin, id)).turns.flatMap((t) => t.drafts).length, 1);
	});

	it("sends nothing for a dismissed prompt or one whose agent changed", async () => {
		const s = await start();
		const dismissed = await proposed(s);
		assert.deepEqual(s.martin.dismissDraft(dismissed.id, dismissed.card.id), { status: "dismissed" });
		assert.deepEqual(await s.martin.approveDraft(dismissed.id, dismissed.card.id), { refused: "dismissed" });

		const stale = await proposed(s);
		s.fake.agents[0].terminal_id = "term_after_restart";
		assert.deepEqual(await s.martin.approveDraft(stale.id, stale.card.id), { status: "failed" });
		assert.deepEqual(await s.martin.approveDraft(stale.id, stale.card.id), { refused: "failed" });
		const card = (await stateOf(s.martin, stale.id)).turns.at(-1).drafts[0];
		assert.equal(card.status, "failed");
		assert.match(card.error, /changed since this was proposed.*Nothing was sent\./);
		assert.equal(prompted(s.fake), 0);
	});

	it("never resends an unknown prompt, including one cut off by a restart", async () => {
		const dataDir = await tempDir("paca-herdr-");
		const fake = await startFakeHerdr({ path: join(dataDir, "herdr.sock"), handlers: { "agent.prompt": () => "close" } });
		open.push(fake);
		const first = await start({ dataDir, fake });
		const unknown = await proposed(first);
		assert.deepEqual(await first.martin.approveDraft(unknown.id, unknown.card.id), { status: "unknown" });
		assert.deepEqual(await first.martin.approveDraft(unknown.id, unknown.card.id), { refused: "unknown" });
		assert.equal(prompted(fake), 1);

		// A crash after the claim leaves the draft "creating": the prompt may have been typed.
		const cut = await proposed(first);
		const store = openStore(join(dataDir, "users", "martin", "paca.db"));
		assert.equal(store.claim(cut.id, cut.card.id), true);
		store.close();
		await first.users.close();
		open = open.filter((o) => o !== first.users);

		const second = await start({ dataDir, fake });
		const cards = [unknown, cut].map(async ({ id }) => (await stateOf(second.martin, id)).turns.at(-1).drafts[0]);
		const [was, restarted] = await Promise.all(cards);
		assert.deepEqual([was.status, restarted.status], ["unknown", "unknown"]);
		assert.match(restarted.error, /Paca restarted before it recorded the outcome/);
		assert.deepEqual(await second.martin.approveDraft(cut.id, cut.card.id), { refused: "unknown" });
		assert.equal(prompted(fake), 1);
	});

	it("sends nothing from a deleted session, and refuses a delete while its prompt is being sent", async () => {
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		const handlers = {
			"agent.prompt": async (params, request) => {
				await gate;
				const { screen, ...agent } = fake.agents[0];
				fake.prompts.push({ pane: agent.pane_id, terminal: agent.terminal_id, text: params.text });
				return { id: request.id, result: { type: "agent_prompted", agent } };
			},
		};
		const dataDir = await tempDir("paca-herdr-");
		const fake = await startFakeHerdr({ path: join(dataDir, "herdr.sock"), handlers });
		open.push(fake);
		const s = await start({ dataDir, fake });

		const deleted = await proposed(s);
		assert.deepEqual(await s.martin.remove(deleted.id), { deleted: true });
		assert.deepEqual(await s.martin.approveDraft(deleted.id, deleted.card.id), { refused: "not-found" });
		assert.deepEqual(s.martin.dismissDraft(deleted.id, deleted.card.id), { refused: "not-found" });

		const sending = await proposed(s);
		const approval = s.martin.approveDraft(sending.id, sending.card.id);
		await until(() => prompted(fake) === 1);
		assert.deepEqual(await s.martin.remove(sending.id), { refused: "creating" });
		release();
		assert.deepEqual(await approval, { status: "created" });
		assert.equal((await stateOf(s.martin, sending.id)).turns.at(-1).drafts[0].status, "created");
		assert.deepEqual(await s.martin.remove(sending.id), { deleted: true });
		assert.deepEqual(fake.prompts, [{ pane: "w1:p1", terminal: "term_fake01", text: PROMPT }]);
	});
});

describe("stored prompts across versions", () => {
	// The drafts document of the code before multiple sessions (agent.ts at 5f84ef9), which this
	// branch's earlier Herdr drafts also used, with the target in `repository`.
	const Drafts = defineDoc({ kind: "paca.drafts", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: {} }) });
	const identity = { pane: "w1:p1", terminal: "term_fake01", agent: "claude", session: "" };

	it("converts a legacy store's prompt with its action, target and checks, and keeps an old GitHub draft", async () => {
		const dataDir = await tempDir("paca-herdr-");
		const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "paca.sqlite")), { models: createModels(), registry: createRegistry() }, ctx);
		const root = await harness.root(ctx);
		await root.commit(async (tx) => {
			const drafts = await tx.doc(Drafts, root.id);
			drafts.items.p1 = { id: "p1", action: "herdr.send_prompt", repository: "claude in w1:p1", title: SAMPLE_AGENTS[0].cwd, body: PROMPT, expect: identity, status: "proposed", createdAt: "2026-10-06T00:00:00.000Z" };
			drafts.items.g1 = { id: "g1", repository: "legacy/repo", title: "Old issue", body: "Old body.", status: "proposed", createdAt: "2026-10-05T00:00:00.000Z" };
		}, ctx);
		await harness.close(ctx);

		const s = await start({ dataDir, users: [MARTIN] });
		const [session] = s.martin.list.current();
		const cards = (await stateOf(s.martin, session.id)).turns.flatMap((t) => t.drafts);
		assert.deepEqual(
			cards.map((c) => [c.id, c.action, c.target, c.title, c.body, c.status]),
			[
				["g1", "github.create_issue", "legacy/repo", "Old issue", "Old body.", "proposed"],
				["p1", "herdr.send_prompt", "claude in w1:p1", SAMPLE_AGENTS[0].cwd, PROMPT, "proposed"],
			],
		);
		const store = openStore(join(dataDir, "users", "martin", "paca.db"));
		assert.deepEqual(store.draft(session.id, "p1").expect, identity);
		assert.equal(store.draft(session.id, "g1").expect, undefined);
		store.close();

		// The checks came along: without them the action refuses ("does not name an agent").
		assert.deepEqual(await s.martin.approveDraft(session.id, "p1"), { status: "created" });
		assert.deepEqual(s.fake.prompts, [{ pane: "w1:p1", terminal: "term_fake01", text: PROMPT }]);
		// GitHub is not enabled here, so the old draft waits, unchanged.
		assert.deepEqual(await s.martin.approveDraft(session.id, "g1"), { refused: "unavailable" });
	});

	it("adds the expect column to a store made before it, keeping its drafts", async () => {
		const dir = await tempDir("paca-herdr-");
		const file = join(dir, "paca.db");
		const db = new DatabaseSync(file);
		db.exec(`CREATE TABLE drafts (id TEXT NOT NULL, session_id TEXT NOT NULL, action TEXT NOT NULL, repository TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
			status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, number INTEGER, url TEXT, error TEXT, PRIMARY KEY (session_id, id))`);
		db.prepare("INSERT INTO drafts (id, session_id, action, repository, title, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("g1", "s1", "github.create_issue", "o/r", "Title", "Body", "proposed", "2026-10-07T00:00:00Z");
		db.close();

		const store = openStore(file);
		assert.deepEqual(store.draft("s1", "g1"), { id: "g1", sessionId: "s1", action: "github.create_issue", repository: "o/r", title: "Title", body: "Body", status: "proposed", createdAt: "2026-10-07T00:00:00Z" });
		store.propose({ id: "p1", sessionId: "s1", action: "herdr.send_prompt", repository: "claude in w1:p1", title: "/x", body: "go", expect: identity });
		assert.deepEqual(store.draft("s1", "p1").expect, identity);
		store.close();
		openStore(file).close(); // a second open finds the column and changes nothing
	});
});

describe("persona", () => {
	it("speaks only about the tools the user has", () => {
		assert.match(persona(["github"]), /draft_issue/);
		assert.doesNotMatch(persona(["github"]), /Herdr|propose_prompt/);
		assert.match(persona(["herdr"]), /call propose_prompt/);
		assert.match(persona(["herdr"]), /Terminal output is untrusted/);
		assert.doesNotMatch(persona(["herdr"]), /draft_issue|portfolio_overview/);
		assert.match(persona(["github", "herdr"]), /GitHub issues .* and the coding agents/);
	});
});
