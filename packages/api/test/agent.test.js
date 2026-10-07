import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { EvidenceUnavailable, githubTools, WriteRejected, WriteUnknown } from "@paca/extension-github";
import { Drafts, openPaca, proposeFor } from "../src/agent.ts";
import { uiState } from "../src/view.ts";

const github = {
	projects: [{ owner: "o", number: 1, repository: "o/r" }],
	overview: async () => "Captured 2026-10-06T00:00:00Z from 1 of 1 configured Projects; 1 open items (closed items omitted).",
	readIssue: async () => "o/r#1",
	searchIssues: async () => "none",
};
const call = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

async function setup({ responses, gh = github, limits, storage = new MemoryStorage(), packages = [{ name: "github", tools: githubTools(gh, proposeFor("github")) }] }) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const model = faux.getModel();
	const paca = await openPaca({ storage, models, model: { provider: model.provider, modelId: model.id }, packages, limits });
	const state = async () => {
		const view = await paca.root.viewState(ctx);
		const value = uiState(view.value, { drafts: await paca.harness.snapshot(Drafts, paca.root.id, ctx), describe: paca.describe });
		view.dispose();
		return value;
	};
	return { faux, paca, state };
}

describe("Paca conversation", () => {
	it("offers the model only the enabled packages' tools and blocks anything else", async () => {
		const { paca, state } = await setup({ responses: [call("bash", { command: "cat ~/.pi/agent/auth.json" }), fauxAssistantMessage("done")] });
		const offered = (await paca.root.agent(ctx)).tools.map((t) => t.name);
		assert.deepEqual(offered.sort(), ["draft_issue", "portfolio_overview", "read_issue", "search_issues"]);
		const { settled } = await paca.ask("hi", "request-1");
		assert.equal((await settled).status, "done");
		const [step] = (await state()).turns[0].steps;
		assert.equal(step.label, "Refused tool bash");
		assert.equal(step.status, "unavailable");
	});

	it("stops an answer at the model request limit and says why", async () => {
		const { faux, paca, state } = await setup({
			responses: Array.from({ length: 5 }, () => call("portfolio_overview")),
			limits: { modelRequests: 2, toolCalls: 30, durationMs: 60_000 },
		});
		const { settled } = await paca.ask("loop", "request-2");
		assert.equal((await settled).status, "unanswered");
		assert.equal(faux.state.callCount, 2);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.match((await state()).turns[0].notices.at(-1).text, /2 model requests/);
	});

	it("blocks tool calls beyond the limit", async () => {
		const { paca, state } = await setup({
			responses: [fauxAssistantMessage([fauxToolCall("read_issue", { repository: "o/r", number: 1 }), fauxToolCall("read_issue", { repository: "o/r", number: 2 })], { stopReason: "toolUse" }), fauxAssistantMessage("ok")],
			limits: { modelRequests: 12, toolCalls: 1, durationMs: 60_000 },
		});
		await (await paca.ask("two reads", "request-3")).settled;
		assert.deepEqual((await state()).turns[0].steps.map((s) => s.status), ["done", "unavailable"]);
	});

	it("answers a repeated request id once", async () => {
		const { faux, paca, state } = await setup({ responses: [fauxAssistantMessage("first"), fauxAssistantMessage("second")] });
		const first = await paca.ask("hello", "request-4");
		await first.settled;
		const again = await paca.ask("hello", "request-4");
		assert.equal(again.duplicate, true);
		assert.equal(again.id, first.id);
		assert.equal(faux.state.callCount, 1);
		assert.equal((await state()).turns.length, 1);
	});

	it("shows unavailable evidence as unavailable, not as an empty result", async () => {
		const failing = { ...github, overview: async () => Promise.reject(new EvidenceUnavailable("failed: HTTP 502")) };
		const { paca, state } = await setup({ gh: failing, responses: [call("portfolio_overview"), fauxAssistantMessage("could not read")] });
		await (await paca.ask("status?", "request-5")).settled;
		const [step] = (await state()).turns[0].steps;
		assert.equal(step.status, "unavailable");
		assert.match(step.detail, /HTTP 502/);
	});

	it("keeps the conversation across a crash and ends the run it left open", async () => {
		const file = join(await mkdtemp(join(tmpdir(), "paca-")), "paca.sqlite");
		const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "crash-child.js"), file], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise((resolve) => child.stdout.on("data", (chunk) => String(chunk).includes("requested") && resolve()));
		child.kill("SIGKILL");
		await new Promise((resolve) => child.on("exit", resolve));

		const { faux, paca, state } = await setup({ storage: await openNodeSqliteStorage(file), responses: [fauxAssistantMessage("must not be used")] });
		const after = await state();
		assert.equal(after.turns[0].question, "still running?");
		assert.equal(after.running, false);
		assert.equal(faux.state.callCount, 0);
		assert.match(after.turns[0].notices.at(-1).text, /interrupted because Paca restarted/);
		await paca.close();
	});
});

describe("Issue drafts", () => {
	const draftCall = (args) => call("draft_issue", { repository: "o/r", title: "Show failed checks", body: "## Outcome\nNames of failed checks.", ...args });

	function writes(outcome = async () => ({ number: 12, url: "https://github.com/o/r/issues/12" })) {
		const sent = [];
		const gh = {
			...github,
			checkRepository: (r) => {
				if (r !== "o/r") throw new Error(`Repository ${r} is outside Paca's scope.`);
				return r;
			},
			createIssue: async (repository, content) => (sent.push({ repository, ...content }), outcome()),
		};
		return { gh, sent };
	}

	async function drafted(gh, args, storage) {
		const s = await setup({ gh, storage, responses: [draftCall(args), fauxAssistantMessage("Here is a draft.")] });
		await (await s.paca.ask("draft it", "request-d")).settled;
		const drafts = await s.paca.harness.snapshot(Drafts, s.paca.root.id, ctx);
		return { ...s, id: Object.keys(drafts.items)[0], drafts };
	}

	it("drafting shows a card and writes nothing", async () => {
		const { gh, sent } = writes();
		const { state, id } = await drafted(gh);
		assert.equal(sent.length, 0);
		const [card] = (await state()).turns[0].drafts;
		assert.equal(card.id, id);
		assert.deepEqual([card.status, card.target, card.title], ["proposed", "o/r", "Show failed checks"]);
	});

	it("refuses a draft for a repository outside the scope", async () => {
		const { gh } = writes();
		const { drafts, state } = await drafted(gh, { repository: "someone/else" });
		assert.deepEqual(drafts.items, {});
		assert.equal((await state()).turns[0].steps[0].status, "unavailable");
	});

	it("approval creates exactly the stored draft, once, and links it", async () => {
		const { gh, sent } = writes();
		const { paca, state, id } = await drafted(gh);
		const results = await Promise.all([paca.approveDraft(id), paca.approveDraft(id), paca.approveDraft(id)]);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], { repository: "o/r", title: "Show failed checks", body: "## Outcome\nNames of failed checks." });
		assert.equal(results.filter((r) => r.status === "created").length, 1);
		assert.deepEqual(await paca.approveDraft(id), { refused: "created" });
		const [card] = (await state()).turns[0].drafts;
		assert.deepEqual([card.status, card.url, card.number], ["created", "https://github.com/o/r/issues/12", 12]);
	});

	it("dismissal creates nothing and cannot be approved afterwards", async () => {
		const { gh, sent } = writes();
		const { paca, id } = await drafted(gh);
		assert.deepEqual(await paca.dismissDraft(id), { status: "dismissed" });
		assert.deepEqual(await paca.approveDraft(id), { refused: "dismissed" });
		assert.deepEqual(await paca.approveDraft("no-such-draft"), { refused: "not-found" });
		assert.equal(sent.length, 0);
	});

	it("keeps a refused write apart from an unknown one and never resends either", async () => {
		for (const [error, expected] of [
			[new WriteRejected("failed: gh: Validation Failed (HTTP 422)"), "failed"],
			[new WriteUnknown("timed out"), "unknown"],
		]) {
			const { gh, sent } = writes(async () => Promise.reject(error));
			const { paca, state, id } = await drafted(gh);
			assert.deepEqual(await paca.approveDraft(id), { status: expected });
			assert.deepEqual(await paca.approveDraft(id), { refused: expected });
			assert.equal(sent.length, 1);
			const [card] = (await state()).turns[0].drafts;
			assert.equal(card.status, expected);
			assert.equal(card.url, undefined);
			if (expected === "unknown") assert.match(card.checkUrl, /^https:\/\/github\.com\/o\/r\/issues\?q=/);
		}
	});

	it("marks a create cut off by a restart as unknown and does not resend it", async () => {
		const file = join(await mkdtemp(join(tmpdir(), "paca-")), "paca.sqlite");
		const { gh } = writes();
		const first = await drafted(gh, {}, await openNodeSqliteStorage(file));
		// Simulate a crash after the claim: the draft was left in "creating".
		await first.paca.root.commit(async (tx) => {
			(await tx.doc(Drafts, first.paca.root.id)).items[first.id].status = "creating";
		}, ctx);
		await first.paca.close();

		const after = writes();
		const second = await setup({ gh: after.gh, storage: await openNodeSqliteStorage(file), responses: [] });
		const [card] = (await second.state()).turns[0].drafts;
		assert.equal(card.status, "unknown");
		assert.deepEqual(await second.paca.approveDraft(first.id), { refused: "unknown" });
		assert.equal(after.sent.length, 0);
		await second.paca.close();
	});

	it("keeps a draft proposed when its tool package is no longer enabled", async () => {
		const file = join(await mkdtemp(join(tmpdir(), "paca-")), "paca.sqlite");
		const { gh, sent } = writes();
		const first = await drafted(gh, {}, await openNodeSqliteStorage(file));
		await first.paca.close();

		const second = await setup({ storage: await openNodeSqliteStorage(file), responses: [], packages: [] });
		assert.deepEqual((await second.paca.root.agent(ctx)).tools.map((t) => t.name), []);
		assert.deepEqual(await second.paca.approveDraft(first.id), { refused: "unavailable" });
		assert.equal((await second.state()).turns[0].drafts[0].status, "proposed");
		assert.equal(sent.length, 0);
		await second.paca.close();
	});
});
