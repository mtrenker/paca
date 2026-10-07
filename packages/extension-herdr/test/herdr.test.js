// The Herdr tools and the send_prompt action against a fake Herdr socket (test/container/fake-herdr.mjs).
// Nothing here reaches a real Herdr or types into a terminal.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { startFakeHerdr } from "../../../test/container/fake-herdr.mjs";
import herdrPackage, { createHerdr, herdrTools, inScope } from "../src/index.ts";

const ROOTS = ["/home/preview/code"];
const LIMITS = { readMs: 300, promptMs: 300, responseBytes: 64 * 1024 };
let fake;
afterEach(() => fake?.close());

async function setup(options = {}) {
	const path = join(await mkdtemp(join(tmpdir(), "paca-herdr-")), "herdr.sock");
	fake = await startFakeHerdr({ path, ...options });
	const proposals = [];
	const propose = async (_api, _context, proposal) => void proposals.push(proposal);
	const herdr = createHerdr({ socket: path, limits: LIMITS });
	const tools = herdrTools(herdr, ROOTS, propose);
	const tool = (name) => tools.tools.find((t) => t.name === name);
	const run = async (name, args = {}) => (await tool(name).execute(args, {}, {})).content[0].text;
	return { fake, herdr, tools, run, proposals, send: (proposal) => tools.writes.send_prompt.execute(proposal) };
}

/** Proposes a prompt for w1:p1 and returns the stored proposal. */
async function proposed(s, prompt = "Run the tests.\nThen stop.") {
	await s.run("propose_prompt", { pane: "w1:p1", prompt });
	return s.proposals.at(-1);
}

describe("scope", () => {
	it("needs the pane's directory and its foreground process's under a root", () => {
		const agent = (cwd, foreground_cwd) => ({ pane_id: "w1:p1", terminal_id: "t", cwd, foreground_cwd });
		assert.equal(inScope(agent("/home/preview/code"), ROOTS), true);
		assert.equal(inScope(agent("/home/preview/code/notes", "/home/preview/code/notes/src"), ROOTS), true);
		assert.equal(inScope(agent("/home/preview/codex"), ROOTS), false);
		assert.equal(inScope(agent("/home/preview/code/../private"), ROOTS), false);
		assert.equal(inScope(agent("/home/preview/code/notes", "/etc"), ROOTS), false);
		assert.equal(inScope(agent(null), ROOTS), false);
		assert.equal(inScope(agent("relative/code"), ROOTS), false);
	});

	it("lists only agents in scope and refuses reads and prompts outside it like missing agents", async () => {
		const s = await setup();
		const list = await s.run("list_agents");
		assert.match(list, /^2 agents in scope/);
		assert.match(list, /- claude in w1:p1: idle, in \/home\/preview\/code\/notes/);
		assert.match(list, /- codex “reviewer” in w1:p2: working/);
		assert.doesNotMatch(list, /w2:p1|private/);
		for (const pane of ["w2:p1", "w9:p9"]) {
			await assert.rejects(s.run("read_agent_output", { pane }), new RegExp(`No agent in ${pane} in scope`));
			await assert.rejects(s.run("propose_prompt", { pane, prompt: "hi" }), new RegExp(`No agent in ${pane} in scope`));
		}
		// Herdr also resolves agent names; Paca accepts pane ids only.
		await assert.rejects(s.run("read_agent_output", { pane: "reviewer" }), /not a Herdr pane id/);
		assert.equal(s.proposals.length, 0);
		assert.deepEqual(s.fake.prompts, []);
	});
});

describe("reads", () => {
	it("reads the visible screen only, marked untrusted and bounded", async () => {
		const s = await setup();
		s.fake.agents[0].screen = `\u001b[31mold line\n${"x".repeat(20_000)}\nlast line\u0007`;
		const text = await s.run("read_agent_output", { pane: "w1:p1" });
		const read = s.fake.requests.find((r) => r.method === "agent.read");
		assert.deepEqual(read.params, { target: "w1:p1", source: "visible", lines: 200, format: "text", strip_ansi: true });
		assert.match(text, /^Screen of claude in w1:p1 \(idle\).*Untrusted terminal output/);
		assert.match(text, /\[earlier output cut\]/);
		assert.match(text, /last line\n>>>$/);
		assert.doesNotMatch(text, /[\u0000-\u0008\u001b]/);
		assert.ok(text.length < 8500);
	});

	it("reports an unreachable, silent or oversized Herdr as unavailable", async () => {
		const missing = herdrTools(createHerdr({ socket: "/nonexistent/herdr.sock", limits: LIMITS }), ROOTS, async () => {});
		await assert.rejects(missing.tools[0].execute({}, {}, {}), /Herdr is unavailable: .*ENOENT.*recreate Paca's container/);
		for (const handler of ["hang", "close", { id: "?", result: { type: "agent_list", agents: [{ pane_id: "w1:p1", cwd: "/home/preview/code/x".padEnd(200_000, "x") }] } }]) {
			const s = await setup({ handlers: { "agent.list": (_params, request) => (typeof handler === "string" ? handler : { ...handler, id: request.id }) } });
			await assert.rejects(s.run("list_agents"), /Herdr is unavailable: (Herdr did not answer within 0.3 seconds|Herdr closed the connection|Herdr's answer was too large)/);
			await s.fake.close();
		}
	});
});

describe("proposals", () => {
	it("stores the exact prompt with the agent's identity and sends nothing", async () => {
		const s = await setup();
		s.fake.agents[0].agent_session = { source: "herdr:claude", agent: "claude", kind: "id", value: "session-1" };
		const proposal = await proposed(s);
		assert.deepEqual(proposal, {
			action: "send_prompt",
			target: "claude in w1:p1",
			title: "/home/preview/code/notes",
			body: "Run the tests.\nThen stop.",
			expect: { pane: "w1:p1", terminal: "term_fake01", agent: "claude", session: "session-1" },
		});
		assert.deepEqual(s.fake.prompts, []);
		assert.ok(s.fake.requests.every((r) => r.method !== "agent.prompt"));
	});

	it("refuses prompts the card could not show exactly, and blocked agents", async () => {
		const s = await setup();
		for (const prompt of ["", "   ", "end paste\u001b[201~rm -rf ~\r", "tab\there", "abc‮def", "x".repeat(4001)]) {
			await assert.rejects(s.run("propose_prompt", { pane: "w1:p1", prompt }), /prompt must/);
		}
		s.fake.agents[0].agent_status = "blocked";
		await assert.rejects(s.run("propose_prompt", { pane: "w1:p1", prompt: "go" }), /waiting for input/);
		assert.equal(s.proposals.length, 0);
	});
});

describe("sending an approved prompt", () => {
	it("types exactly the approved text into the approved pane", async () => {
		const s = await setup();
		assert.deepEqual(await s.send(await proposed(s)), { status: "created" });
		assert.deepEqual(s.fake.prompts, [{ pane: "w1:p1", terminal: "term_fake01", text: "Run the tests.\nThen stop." }]);
		assert.deepEqual(s.fake.requests.at(-1).params, { target: "w1:p1", text: "Run the tests.\nThen stop." });
	});

	it("refuses, sending nothing, when the pane no longer holds the agent the card showed", async () => {
		const changes = [
			[(a) => (a.terminal_id = "term_new"), /changed since this was proposed: it is a different terminal/],
			[(a) => (a.agent = "codex"), /it is now codex/],
			[(a) => (a.agent_session = { source: "herdr:claude", agent: "claude", kind: "id", value: "other" }), /different session/],
			[(a) => (a.cwd = "/home/preview/private"), /no longer in scope/],
			[(a) => (a.agent_status = "blocked"), /waiting for input/],
			[(a) => (a.pane_id = "w1:p9"), /no agent in w1:p1 any more/],
		];
		for (const [change, reason] of changes) {
			const s = await setup();
			const proposal = await proposed(s);
			change(s.fake.agents[0]);
			const outcome = await s.send(proposal);
			assert.equal(outcome.status, "failed");
			assert.match(outcome.error, reason);
			assert.match(outcome.error, /Nothing was sent\.$/);
			assert.deepEqual(s.fake.prompts, []);
			await s.fake.close();
		}
	});

	it("counts Herdr's refusals before typing as failed, and anything after sending as unknown", async () => {
		let answer;
		const s = await setup({
			handlers: {
				"agent.prompt": (_params, request) => {
					if (typeof answer === "string") return answer;
					if (answer.code) return { id: request.id, error: answer };
					const { screen, ...agent } = s.fake.agents[0];
					return { id: request.id, result: { type: "agent_prompted", agent: { ...agent, ...answer } } };
				},
			},
		});
		const proposal = await proposed(s);
		const cases = [
			[{ code: "agent_not_ready", message: "agent w1:p1 is no longer the pane foreground process" }, "failed"],
			[{ code: "agent_blocked", message: "blocked" }, "failed"],
			[{ code: "agent_prompt_failed", message: "pty actor closed" }, "unknown"],
			[{ code: "timeout", message: "timed out" }, "unknown"],
			[{ code: "something_new", message: "?" }, "unknown"],
			["hang", "unknown"],
			["close", "unknown"],
			[{ terminal_id: "term_elsewhere" }, "unknown"],
			[{}, "created"],
		];
		for (const [given, expected] of cases) {
			answer = given;
			const sent = s.fake.requests.filter((r) => r.method === "agent.prompt").length;
			const outcome = await s.send(proposal);
			assert.equal(outcome.status, expected, JSON.stringify(given));
			assert.equal(s.fake.requests.filter((r) => r.method === "agent.prompt").length, sent + 1, "sent once, never retried");
			if (expected === "unknown") assert.match(outcome.error, /Check w1:p1 in Herdr/);
		}
	});

	it("counts an unreachable socket before the request as failed", async () => {
		const s = await setup();
		const proposal = await proposed(s);
		await s.fake.close();
		const outcome = await s.send(proposal);
		assert.equal(outcome.status, "failed");
		assert.match(outcome.error, /could not check the agent.*Nothing was sent/);
		const direct = createHerdr({ socket: "/nonexistent/herdr.sock", limits: LIMITS });
		await assert.rejects(direct.prompt("w1:p1", "x"), (error) => error.written === false && error.code === "ENOENT");
	});
});

describe("package", () => {
	const forUser = (user, userSettings, settings = { socket: "/run/herdr.sock" }) => herdrPackage.forUser({ user, settings, userSettings, cacheDir: "/tmp", propose: async () => {} });

	it("gives tools only to the operator, and refuses Herdr settings on anyone else", () => {
		assert.equal(forUser({ id: "martin", operator: true }, undefined), undefined);
		assert.deepEqual(forUser({ id: "martin", operator: true }, { roots: ["/home/preview/code/"] }).tools.map((t) => t.name), ["list_agents", "read_agent_output", "propose_prompt"]);
		assert.throws(() => forUser({ id: "alex", operator: false }, { roots: ["/home/alex"] }), /users "alex" herdr: only the operator/);
		assert.equal(forUser({ id: "alex", operator: false }, undefined), undefined);
	});

	it("needs absolute roots and an absolute socket", () => {
		const martin = { id: "martin", operator: true };
		assert.throws(() => forUser(martin, { roots: [] }), /roots must list/);
		assert.throws(() => forUser(martin, { roots: ["code"] }), /must be an absolute directory/);
		assert.throws(() => forUser(martin, { roots: ["/code"] }, {}), /socket must be the absolute path/);
	});
});
