// Two synthetic users on real per-user harnesses, and the single-user state written before
// multi-user support (fixtures/pre-refactor.sqlite, made by the code at 51d90dc).
import assert from "node:assert/strict";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineToolPackage } from "@paca/extension";
import { createGitHub, githubTools } from "@paca/extension-github";
import { openUsers } from "../src/users.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "pre-refactor.sqlite");
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/**
 * The GitHub package as forUser builds it, but with a recording `run` instead of gh: every
 * command is logged with the user and token it ran as.
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
						runs.push({ user: user.id, token: env.GH_TOKEN, args });
						if (args[0] === "api") return JSON.stringify({ number: 41 + runs.length, html_url: `https://github.com/${args[3].slice(6, -7)}/issues/${41 + runs.length}`, input });
						return JSON.stringify({ number: args[2], title: "Read", state: "OPEN", url: "u", comments: [] });
					},
				}),
				propose,
			),
	});
}

const MARTIN = { id: "martin", subject: "martin-subject", operator: true, github: { projects: [{ owner: "legacy", number: 1, repository: "legacy/repo" }] } };
const ALEX = { id: "alex", subject: "alex-subject", operator: false, github: { projects: [{ owner: "alex", number: 2, repository: "alex/repo" }] } };

async function open(dataDir, responses) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const model = faux.getModel();
	const runs = [];
	const users = await openUsers({
		users: [MARTIN, ALEX],
		packages: [{ module: "@paca/extension-github", package: recordingGitHub(runs), settings: {} }],
		dataDir,
		models,
		model: { provider: model.provider, modelId: model.id },
		modelLabel: "faux",
		log: { log: () => {} },
	});
	const state = async (subject) => {
		await new Promise((resolve) => setTimeout(resolve, 250)); // the feed sends at most every 120 ms
		return users.forSubject(subject).state.current();
	};
	return { users, runs, state, martin: users.forSubject(MARTIN.subject), alex: users.forSubject(ALEX.subject) };
}

describe("pre-refactor data", () => {
	it("stays with the operator: transcript, drafts and outcomes; nobody else sees or decides them", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "paca-users-"));
		await copyFile(FIXTURE, join(dataDir, "paca.sqlite"));
		const { users, runs, state, martin, alex } = await open(dataDir, []);

		const mine = await state(MARTIN.subject);
		assert.deepEqual(mine.turns.map((t) => t.question), ["What needs attention?", "Draft the first issue", "Draft the second issue"]);
		assert.equal(mine.turns[0].steps[0].label, "Read legacy/repo#1");
		const [created] = mine.turns[1].drafts;
		const [proposed] = mine.turns[2].drafts;
		assert.deepEqual([created.status, created.url], ["created", "https://github.com/legacy/repo/issues/41"]);
		assert.deepEqual([proposed.status, proposed.title, proposed.body], ["proposed", "Still proposed", "Exact legacy body."]);
		assert.deepEqual([proposed.action, proposed.target], ["github.create_issue", "legacy/repo"]);

		assert.deepEqual((await state(ALEX.subject)).turns, []);
		assert.deepEqual(await alex.paca.approveDraft(proposed.id), { refused: "not-found" });
		assert.deepEqual(await alex.paca.dismissDraft(proposed.id), { refused: "not-found" });

		// The legacy draft has no action field; approving it creates exactly its stored content, once.
		const results = await Promise.all([martin.paca.approveDraft(proposed.id), martin.paca.approveDraft(proposed.id)]);
		assert.equal(results.filter((r) => r.status === "created").length, 1);
		assert.equal(runs.length, 1);
		assert.deepEqual([runs[0].user, runs[0].token, runs[0].args.slice(0, 4)], ["martin", "token-of-martin", ["api", "--method", "POST", "repos/legacy/repo/issues"]]);
		assert.deepEqual(await martin.paca.approveDraft(created.id), { refused: "created" });
		await users.close();
	});
});

describe("two users", () => {
	it("keeps conversations, streams, drafts, approvals and tool access apart", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "paca-users-"));
		const { users, runs, state, martin, alex } = await open(dataDir, [
			call("read_issue", { repository: "legacy/repo", number: 1 }),
			call("draft_issue", { repository: "alex/repo", title: "Alex's draft", body: "Only Alex decides." }),
			fauxAssistantMessage("Done."),
		]);
		await (await alex.paca.ask("Read Martin's issue and draft mine", "alex-request-1")).settled;

		const alexState = await state(ALEX.subject);
		assert.deepEqual(alexState.turns.map((t) => t.question), ["Read Martin's issue and draft mine"]);
		// Alex's tools are bound to Alex's scope: Martin's repository is refused without running gh.
		assert.deepEqual(alexState.turns[0].steps.map((s) => [s.label, s.status]), [["Read legacy/repo#1", "unavailable"], ["Drafted an issue for alex/repo", "done"]]);
		assert.equal(runs.length, 0);
		const [draft] = alexState.turns[0].drafts;

		assert.deepEqual((await state(MARTIN.subject)).turns, []);
		assert.deepEqual(await martin.paca.approveDraft(draft.id), { refused: "not-found" });
		assert.deepEqual(await alex.paca.approveDraft(draft.id), { status: "created", url: "https://github.com/alex/repo/issues/42" });
		assert.deepEqual(runs.map((r) => [r.user, r.token]), [["alex", "token-of-alex"]]);

		// Each user's run is their own: Martin is not busy while Alex answers, and stores are separate files.
		assert.equal(martin.paca.busy(), false);
		assert.notEqual(martin.paca.harness, alex.paca.harness);
		await users.close();
	});
});
