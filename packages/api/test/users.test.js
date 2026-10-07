// Two synthetic users through openUsers, and the conversation written before multiple sessions
// (fixtures/pre-refactor.sqlite, made by the code at 51d90dc) converted at start.
import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { defineToolPackage } from "@paca/extension";
import { createGitHub, githubTools } from "@paca/extension-github";
import { convertLegacy } from "../src/legacy.ts";
import { openStore } from "../src/store.ts";
import { openUsers } from "../src/users.ts";
import { call, fauxModel, idle, newId, stateOf, tempDir, text } from "./helpers.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "pre-refactor.sqlite");
const MARTIN = { id: "martin", subject: "martin-subject", operator: true, github: { projects: [{ owner: "legacy", number: 1, repository: "legacy/repo" }] } };
const ALEX = { id: "alex", subject: "alex-subject", operator: false, github: { projects: [{ owner: "alex", number: 2, repository: "alex/repo" }] } };
// The drafts document as the code before multiple sessions defined it (agent.ts at 5f84ef9).
const Drafts = defineDoc({ kind: "paca.drafts", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: {} }) });

/**
 * The GitHub package as forUser builds it, but with a recording `run` instead of gh: every command
 * is logged with the user and token it ran as.
 */
function recordingGitHub(runs) {
	return defineToolPackage({
		name: "github",
		forUser: ({ user, userSettings, cacheDir, propose }) =>
			userSettings &&
			githubTools(
				createGitHub({
					projects: userSettings.projects,
					piClean: "/pi-clean",
					dataDir: cacheDir,
					token: `token-of-${user.id}`,
					run: async (file, args, { env, input }) => {
						runs.push({ user: user.id, token: env.GH_TOKEN, args, input: input && JSON.parse(input) });
						if (args[0] === "api") return JSON.stringify({ number: 41 + runs.length, html_url: `https://github.com/${args[3].slice(6, -7)}/issues/${41 + runs.length}` });
						return JSON.stringify({ number: args[2], title: "Read", state: "OPEN", url: "u", comments: [] });
					},
				}),
				propose,
			),
	});
}

async function open(dataDir, responses = [], runs = []) {
	const model = await fauxModel(dataDir, responses);
	const lines = [];
	const users = await openUsers({
		users: [MARTIN, ALEX],
		packages: [{ module: "@paca/extension-github", package: recordingGitHub(runs), settings: {} }],
		dataDir,
		modelRuntime: model.modelRuntime,
		model: model.model,
		modelLabel: "faux",
		log: { log: (line) => lines.push(line), error: () => {} },
	});
	const martin = users.forSubject(MARTIN.subject).sessions;
	const alex = users.forSubject(ALEX.subject).sessions;
	return { users, runs, lines, martin, alex };
}

/** What the old code's storage holds: the root conversation's entry kinds and its drafts. */
async function readLegacy(file) {
	const storage = await openNodeSqliteStorage(file);
	const entries = (await storage.scanEntries({ conversationId: 1 }, 100, undefined, ctx)).items.map((e) => e.kind);
	const record = await storage.findDocument({ kind: "paca.drafts", scope: { kind: "conversation", conversationId: 1 } }, "current", ctx);
	const drafts = record ? Object.values((await storage.document(record.id, "current", ctx)).value.items) : [];
	await storage.close(ctx);
	return { entries, drafts };
}

/** Opens a store the way the previous image does (agent.ts at 5f84ef9): harness, root, drafts document. */
async function openAsPreviousImage(file, write) {
	const harness = await Harness.open(await openNodeSqliteStorage(file), { models: createModels(), registry: createRegistry() }, ctx);
	const root = await harness.root(ctx);
	const drafts = await root.commit(async (tx) => JSON.parse(JSON.stringify((await tx.doc(Drafts, root.id)).items)), ctx);
	if (write) await root.submit({ type: "write", entry: write }, ctx);
	await harness.close(ctx);
	return drafts;
}

const legacyDir = (dataDir, id) => join(dataDir, "users", id, "legacy");

describe("converting the conversation written before multiple sessions", () => {
	it("moves the operator's store off its old path into one session with its turns, drafts and outcomes", async () => {
		const dataDir = await tempDir();
		await copyFile(FIXTURE, join(dataDir, "paca.sqlite"));
		const { users, runs, lines, martin, alex } = await open(dataDir, [text("Continued after the upgrade.")]);

		for (const suffix of ["", "-wal", "-shm"]) assert.equal(existsSync(join(dataDir, `paca.sqlite${suffix}`)), false);
		const [session] = martin.list.current();
		assert.deepEqual(readdirSync(legacyDir(dataDir, "martin")), [`${session.id}.sqlite`]);
		const retained = await readLegacy(join(legacyDir(dataDir, "martin"), `${session.id}.sqlite`));
		assert.equal(retained.entries.length, 13);
		assert.deepEqual(retained.drafts.map((d) => [d.title, d.status]), [["Created before the refactor", "created"], ["Still proposed", "proposed"]]);
		assert.match(lines.join("\n"), new RegExp(`converted legacy store .*paca\\.sqlite into session ${session.id}: 12 messages, 2 drafts`));

		const mine = await stateOf(martin, session.id);
		assert.deepEqual(mine.turns.map((t) => t.question), ["What needs attention?", "Draft the first issue", "Draft the second issue"]);
		assert.equal(mine.turns[0].steps[0].label, "Read legacy/repo#1");
		const [created] = mine.turns[1].drafts;
		const [proposed] = mine.turns[2].drafts;
		assert.deepEqual([created.status, created.url], ["created", "https://github.com/legacy/repo/issues/41"]);
		assert.deepEqual([proposed.status, proposed.title, proposed.body], ["proposed", "Still proposed", "Exact legacy body."]);
		assert.deepEqual([proposed.action, proposed.target], ["github.create_issue", "legacy/repo"]);

		assert.deepEqual(alex.list.current(), []);
		assert.equal(existsSync(legacyDir(dataDir, "alex")), false);
		assert.deepEqual(await alex.approveDraft(session.id, proposed.id), { refused: "not-found" });

		// The legacy draft has no action field; approving it creates exactly its stored content, once.
		const results = await Promise.all([martin.approveDraft(session.id, proposed.id), martin.approveDraft(session.id, proposed.id)]);
		assert.equal(results.filter((r) => r.status === "created").length, 1);
		assert.equal(runs.length, 1);
		assert.deepEqual([runs[0].user, runs[0].token, runs[0].args.slice(0, 4), runs[0].input], ["martin", "token-of-martin", ["api", "--method", "POST", "repos/legacy/repo/issues"], { title: "Still proposed", body: "Exact legacy body." }]);
		assert.deepEqual(await martin.approveDraft(session.id, created.id), { refused: "created" });

		// The converted session goes on with Paca's prompt and tools.
		martin.ask(session.id, "And now?", "after-upgrade-1");
		await idle(martin, session.id);
		assert.equal((await stateOf(martin, session.id)).turns.at(-1).answer, "Continued after the upgrade.");
		assert.match(martin.agentOf(session.id).systemPrompt, /^You are Paca/);
		assert.deepEqual(martin.agentOf(session.id).getActiveToolNames().sort(), ["draft_issue", "portfolio_overview", "read_issue", "search_issues"]);
		await users.close();

		// A second start converts nothing.
		const again = await open(dataDir);
		assert.deepEqual(again.martin.list.current().map((s) => s.id), [session.id]);
		assert.doesNotMatch(again.lines.join("\n"), /legacy store/);
		assert.equal(readdirSync(legacyDir(dataDir, "martin")).length, 1);
		await again.users.close();
	});

	it("finishes a conversion interrupted after the move with one session and no stray file", async () => {
		const dataDir = await tempDir();
		const userDir = join(dataDir, "users", "martin");
		await mkdir(userDir, { recursive: true });
		await copyFile(FIXTURE, join(dataDir, "paca.sqlite"));
		const store = openStore(join(userDir, "paca.db"));
		const failing = {
			legacyFiles: store.legacyFiles,
			insertConverted: () => {
				throw new Error("stubbed transaction failure");
			},
		};
		await assert.rejects(convertLegacy({ legacyPath: join(dataDir, "paca.sqlite"), userDir, store: failing, log: { log: () => {} } }), /stubbed/);
		store.close();
		assert.equal(existsSync(join(dataDir, "paca.sqlite")), false);
		const [retained] = readdirSync(join(userDir, "legacy"));
		const id = retained.replace(".sqlite", "");
		assert.equal(readdirSync(join(userDir, "sessions")).length, 1, "the interrupted try left its session file");

		const { users, martin, lines } = await open(dataDir);
		assert.deepEqual(martin.list.current().map((s) => s.id), [id]);
		assert.deepEqual(readdirSync(join(userDir, "sessions")).map((f) => f.endsWith(`_${id}.jsonl`)), [true]);
		assert.equal((await stateOf(martin, id)).turns.length, 3);
		assert.match(lines.join("\n"), /interrupted earlier/);
		await users.close();
	});

	it("moves an empty store aside without a session; another user sees nothing", async () => {
		const dataDir = await tempDir();
		await mkdir(join(dataDir, "users", "alex"), { recursive: true });
		// The previous image made a store with an empty drafts document for every user.
		assert.deepEqual(await openAsPreviousImage(join(dataDir, "users", "alex", "paca.sqlite")), {});
		const { users, alex, martin } = await open(dataDir);
		assert.deepEqual(alex.list.current(), []);
		assert.equal(existsSync(join(dataDir, "users", "alex", "paca.sqlite")), false);
		assert.match(readdirSync(legacyDir(dataDir, "alex")).join(), /^empty-.*\.sqlite$/);
		assert.deepEqual(martin.list.current(), []);
		await users.close();
	});

	it("leaves the previous image nothing to approve again after a converted draft is approved", async () => {
		const dataDir = await tempDir();
		await copyFile(FIXTURE, join(dataDir, "paca.sqlite"));
		const first = await open(dataDir);
		const [session] = first.martin.list.current();
		const proposed = (await stateOf(first.martin, session.id)).turns[2].drafts[0];
		assert.equal((await first.martin.approveDraft(session.id, proposed.id)).status, "created");
		assert.equal(first.runs.length, 1);
		await first.users.close();

		// The previous image finds no store on its path, so it makes a new, empty one: no draft to send.
		assert.deepEqual(await openAsPreviousImage(join(dataDir, "paca.sqlite")), {});
		const after = await open(dataDir, [], first.runs);
		assert.deepEqual(after.martin.list.current().map((s) => s.id), [session.id]);
		assert.match(readdirSync(legacyDir(dataDir, "martin")).join(), /empty-/);
		assert.equal((await stateOf(after.martin, session.id)).turns[2].drafts[0].status, "created");
		await after.users.close();

		// A question asked in the previous image becomes a second session; the first is unchanged.
		const question = { kind: "pi.user", model: [{ role: "user", content: "Asked in the old image", timestamp: Date.now() }] };
		assert.deepEqual(await openAsPreviousImage(join(dataDir, "paca.sqlite"), question), {});
		const third = await open(dataDir, [], first.runs);
		assert.deepEqual(third.martin.list.current().map((s) => s.title).sort(), ["Asked in the old image", "What needs attention?"]);
		assert.equal((await stateOf(third.martin, session.id)).turns[2].drafts[0].status, "created");
		assert.equal(first.runs.length, 1, "nothing was sent again");
		await third.users.close();
	});
});

describe("two users", () => {
	it("keeps sessions, streams, drafts, approvals and tool access apart", async () => {
		const dataDir = await tempDir();
		const { users, runs, martin, alex } = await open(dataDir, [
			call("read_issue", { repository: "legacy/repo", number: 1 }),
			call("draft_issue", { repository: "alex/repo", title: "Alex's draft", body: "Only Alex decides." }),
			text("Done."),
		]);
		const id = newId();
		alex.start(id, "Read Martin's issue and draft mine", "alex-request-1");
		await idle(alex, id);

		const alexState = await stateOf(alex, id);
		assert.deepEqual(alexState.turns.map((t) => t.question), ["Read Martin's issue and draft mine"]);
		// Alex's tools are bound to Alex's scope: Martin's repository is refused without running gh.
		assert.deepEqual(alexState.turns[0].steps.map((s) => [s.label, s.status]), [["Read legacy/repo#1", "unavailable"], ["Drafted an issue for alex/repo", "done"]]);
		assert.equal(runs.length, 0);
		const [draft] = alexState.turns[0].drafts;

		assert.deepEqual(martin.list.current(), []);
		assert.equal(await martin.watch(id), undefined);
		assert.deepEqual(await martin.approveDraft(id, draft.id), { refused: "not-found" });
		assert.deepEqual(await martin.remove(id), { refused: "not-found" });
		assert.deepEqual(await alex.approveDraft(id, draft.id), { status: "created", url: "https://github.com/alex/repo/issues/42" });
		assert.deepEqual(runs.map((r) => [r.user, r.token]), [["alex", "token-of-alex"]]);
		assert.equal(martin.busy(id), false);
		assert.deepEqual(readdirSync(join(dataDir, "users", "martin", "sessions")), []);
		await users.close();
	});
});
