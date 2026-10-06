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
import { openPaca } from "../src/agent.js";
import { EvidenceUnavailable } from "../src/github.js";
import { uiState } from "../src/view.js";

const github = {
	projects: [{ owner: "o", number: 1, repository: "o/r" }],
	overview: async () => "Captured 2026-10-06T00:00:00Z from 1 of 1 configured Projects; 1 open items (closed items omitted).",
	readIssue: async () => "o/r#1",
	searchIssues: async () => "none",
};
const call = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

async function setup({ responses, gh = github, limits, storage = new MemoryStorage() }) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const model = faux.getModel();
	const paca = await openPaca({ storage, models, model: { provider: model.provider, modelId: model.id }, github: gh, limits });
	const state = async () => {
		const view = await paca.root.viewState(ctx);
		const value = uiState(view.value);
		view.dispose();
		return value;
	};
	return { faux, paca, state };
}

describe("Paca conversation", () => {
	it("offers the model only Paca's read tools and blocks anything else", async () => {
		const { paca, state } = await setup({ responses: [call("bash", { command: "cat ~/.pi/agent/auth.json" }), fauxAssistantMessage("done")] });
		const offered = (await paca.root.agent(ctx)).tools.map((t) => t.name);
		assert.deepEqual(offered.sort(), ["portfolio_overview", "read_issue", "search_issues"]);
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
