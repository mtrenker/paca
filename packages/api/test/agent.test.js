// One session's answer: only Paca's tools and prompt, the per-answer limits, repeated requests,
// and a restart in the middle of an answer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { EvidenceUnavailable } from "@paca/extension-github";
import { openAgent } from "../src/agent.ts";
import { call, fauxModel, held, idle, newId, openUser, stateOf, stubGitHub, tempDir, text } from "./helpers.js";

const ALL_TOOLS = ["draft_issue", "portfolio_overview", "read_issue", "search_issues"];

async function answered({ responses, limits, gh, question = "hi" }) {
	const dir = await tempDir();
	const model = await fauxModel(dir, responses);
	const user = await openUser({ dir, model, limits, gh });
	const id = newId();
	user.sessions.start(id, question, "request-1");
	await idle(user.sessions, id);
	return { ...user, dir, model, id, state: await stateOf(user.sessions, id) };
}

describe("one session's answer", () => {
	it("offers only the enabled packages' tools and Paca's prompt, and discovers nothing on disk", async () => {
		const dir = await tempDir();
		// Decoys Pi would load if discovery were on: context files, a skill, an extension adding a tool, settings.
		const home = join(dir, "home");
		process.env.HOME = home;
		for (const agentDir of [join(dir, "pi"), join(home, ".pi", "agent")]) {
			await mkdir(join(agentDir, "skills", "decoy"), { recursive: true });
			await mkdir(join(agentDir, "extensions"), { recursive: true });
			await writeFile(join(agentDir, "AGENTS.md"), "DECOY CONTEXT FILE");
			await writeFile(join(agentDir, "skills", "decoy", "SKILL.md"), "---\nname: decoy\ndescription: DECOY SKILL\n---\nDECOY SKILL BODY");
			await writeFile(join(agentDir, "extensions", "decoy.js"), "export default (pi) => pi.registerTool({ name: 'decoy_tool', label: 'x', description: 'x', parameters: {}, execute: async () => ({ content: [], details: {} }) });");
			await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["bash"], cacheWarming: "always" }));
		}
		const model = await fauxModel(dir, [call("bash", { command: "cat ~/.pi/agent/auth.json" }), text("done")]);
		const { sessions } = await openUser({ dir, model });
		const id = newId();
		sessions.start(id, "hi", "request-1");
		await idle(sessions, id);
		const agent = sessions.agentOf(id);
		assert.deepEqual(agent.getActiveToolNames().sort(), ALL_TOOLS);
		assert.match(agent.systemPrompt, /^You are Paca, an assistant for the GitHub issues/);
		assert.match(agent.systemPrompt, /GitHub scope \(nothing else can be read\):\n- o\/r \(Project o\/1\)/);
		assert.doesNotMatch(agent.systemPrompt, /DECOY|coding assistant|bash/i);
		const [step] = (await stateOf(sessions, id)).turns[0].steps;
		assert.deepEqual([step.label, step.status], ["Refused tool bash", "unavailable"]);
		assert.equal(existsSync(join(home, ".pi", "agent", "sessions")), false);
	});

	it("stops an answer at the model request limit, before the request is sent, and says why", async () => {
		const { model, state } = await answered({ responses: Array.from({ length: 5 }, () => call("portfolio_overview")), limits: { modelRequests: 2, toolCalls: 30, durationMs: 60_000 } });
		assert.equal(model.faux.state.callCount, 2);
		assert.equal(state.running, false);
		assert.match(state.turns[0].notices.at(-1).text, /Stopped after 2 model requests/);
	});

	it("counts compaction summaries as model requests, and sends none while no answer runs", async () => {
		const dir = await tempDir();
		const model = await fauxModel(dir, Array.from({ length: 12 }, (_, i) => fauxAssistantMessage(`answer ${i} ${"lorem ipsum ".repeat(4000)}`)));
		let run = { requests: 0, tools: 0, stop: (reason) => (run.stopReason = reason) };
		const session = await openAgent({ dir, sessionManager: SessionManager.inMemory(dir), modelRuntime: model.modelRuntime, model: model.model, packages: [], limits: { modelRequests: 30, toolCalls: 30, durationMs: 60_000 }, run: () => run });
		for (let i = 0; i < 8; i++) await session.prompt(`question ${i} ${"dolor sit ".repeat(4000)}`, { expandPromptTemplates: false });
		const sent = model.faux.state.callCount;
		await session.compact();
		// The summary reached the provider, and every request the provider saw was counted.
		assert.equal(model.faux.state.callCount, sent + 1);
		assert.equal(run.requests, model.faux.state.callCount);
		run = undefined;
		await assert.rejects(session.compact());
		assert.equal(model.faux.state.callCount, sent + 1);
		session.dispose();
	});

	it("blocks tool calls beyond the limit", async () => {
		const both = fauxAssistantMessage([fauxToolCall("read_issue", { repository: "o/r", number: 1 }), fauxToolCall("read_issue", { repository: "o/r", number: 2 })], { stopReason: "toolUse" });
		const { state } = await answered({ responses: [both, text("ok")], limits: { modelRequests: 12, toolCalls: 1, durationMs: 60_000 } });
		assert.deepEqual(state.turns[0].steps.map((s) => s.status), ["done", "unavailable"]);
	});

	it("stops an answer at the time limit", async () => {
		const answer = held();
		const { state } = await answered({ responses: [answer.respond], limits: { modelRequests: 12, toolCalls: 30, durationMs: 100 } });
		assert.equal(state.running, false);
		assert.match(state.turns[0].notices.at(-1).text, /Stopped after .* minutes/);
	});

	it("answers a repeated or concurrent request id once", async () => {
		const dir = await tempDir();
		const model = await fauxModel(dir, [text("first"), text("second")]);
		const { sessions } = await openUser({ dir, model });
		const id = newId();
		const results = [sessions.start(id, "hello", "request-4"), sessions.start(id, "hello", "request-4")];
		assert.deepEqual(results, [{ duplicate: false }, { duplicate: true }]);
		await idle(sessions, id);
		assert.deepEqual(sessions.ask(id, "hello", "request-4"), { duplicate: true });
		assert.deepEqual(sessions.ask(id, "again", "request-5"), { duplicate: false });
		await idle(sessions, id);
		assert.deepEqual(sessions.ask(id, "again", "request-5"), { duplicate: true });
		assert.equal(model.faux.state.callCount, 2);
		assert.deepEqual((await stateOf(sessions, id)).turns.map((t) => t.question), ["hello", "again"]);
	});

	it("shows unavailable evidence as unavailable, not as an empty result", async () => {
		const { gh } = stubGitHub();
		gh.overview = async () => Promise.reject(new EvidenceUnavailable("failed: HTTP 502"));
		const { state } = await answered({ gh, responses: [call("portfolio_overview"), text("could not read")] });
		const [step] = state.turns[0].steps;
		assert.equal(step.status, "unavailable");
		assert.match(step.detail, /HTTP 502/);
	});

	it("keeps a session across a crash mid-answer and says once that the answer was interrupted", async () => {
		const dir = await tempDir();
		const id = newId();
		const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "crash-child.js"), dir, id], { stdio: ["ignore", "pipe", "inherit"] });
		await new Promise((resolve) => child.stdout.on("data", (chunk) => String(chunk).includes("requested") && resolve()));
		child.kill("SIGKILL");
		await new Promise((resolve) => child.on("exit", resolve));

		for (let start = 0; start < 2; start++) {
			const model = await fauxModel(dir, [text("must not be used")]);
			const { sessions } = await openUser({ dir, model });
			const after = await stateOf(sessions, id);
			assert.equal(after.turns[0].question, "still running?");
			assert.equal(after.running, false);
			assert.equal(model.faux.state.callCount, 0);
			assert.deepEqual(after.turns[0].notices.map((n) => n.text), ["This answer was interrupted because Paca restarted. Ask again to continue."]);
			await sessions.close();
		}
	});
});
