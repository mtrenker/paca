// The Herdr package on real per-user harnesses with the faux model and a fake Herdr socket
// (test/container/fake-herdr.mjs): who gets the tools, the card, and approving it once.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startFakeHerdr } from "../../../test/container/fake-herdr.mjs";
import { Drafts } from "../src/agent.ts";
import { persona } from "../src/persona.ts";
import { loadPackages } from "../src/extensions.ts";
import { openUsers } from "../src/users.ts";

const call = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const MARTIN = { id: "martin", subject: "martin-subject", operator: true, herdr: { roots: ["/home/preview/code"] } };
const ALEX = { id: "alex", subject: "alex-subject", operator: false };
const PROMPT = "Run the tests.\nThen report.";
let open = [];
afterEach(async () => {
	await Promise.all(open.map((o) => o.close()));
	open = [];
});

async function start({ users = [MARTIN, ALEX], responses = [], dataDir, fake } = {}) {
	const dir = dataDir ?? (await mkdtemp(join(tmpdir(), "paca-herdr-")));
	if (!fake) open.push((fake = await startFakeHerdr({ path: join(dir, "herdr.sock") })));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const model = faux.getModel();
	const opened = await openUsers({
		users,
		packages: await loadPackages({ "@paca/extension-herdr": { socket: fake.path } }),
		dataDir: dir,
		models,
		model: { provider: model.provider, modelId: model.id },
		modelLabel: "faux",
		log: { log: () => {} },
	});
	open.push(opened);
	const state = async (user) => {
		await new Promise((resolve) => setTimeout(resolve, 250)); // the feed sends at most every 120 ms
		return opened.forSubject(user.subject).state.current();
	};
	return { dir, fake, faux, users: opened, state, martin: opened.forSubject(MARTIN.subject), alex: opened.forSubject(ALEX.subject) };
}

/** Martin asks; the model lists agents and proposes PROMPT for w1:p1. Returns the card. */
async function proposed(s) {
	await (await s.martin.paca.ask("Ask my claude agent to run the tests", `req-${Math.random().toString(36).slice(2)}`)).settled;
	return (await s.state(MARTIN)).turns.at(-1).drafts[0];
}
const proposing = () => [call("list_agents"), call("propose_prompt", { pane: "w1:p1", prompt: PROMPT }), fauxAssistantMessage("Proposed.")];

describe("Herdr for the operator", () => {
	it("gives the tools to the operator only, and refuses Herdr settings on another user", async () => {
		const s = await start();
		const offered = async (host) => (await host.paca.root.agent(ctx)).tools.map((t) => t.name).sort();
		assert.deepEqual(await offered(s.martin), ["list_agents", "propose_prompt", "read_agent_output"]);
		assert.deepEqual(await offered(s.alex), []);
		assert.equal(s.martin.info.scope, "Herdr agents");
		await assert.rejects(start({ users: [{ ...ALEX, herdr: { roots: ["/"] } }] }), /users "alex" herdr: only the operator/);
	});

	it("never lets another user call the tools or decide the operator's prompt", async () => {
		const s = await start({ responses: [call("list_agents"), fauxAssistantMessage("Nothing.")] });
		await (await s.alex.paca.ask("list the agents", "alex-1")).settled;
		const [step] = (await s.state(ALEX)).turns[0].steps;
		assert.deepEqual([step.label, step.status], ["Refused tool list_agents", "unavailable"]);
		assert.deepEqual(s.fake.requests, []);

		s.faux.setResponses(proposing());
		const card = await proposed(s);
		assert.deepEqual(await s.alex.paca.approveDraft(card.id), { refused: "not-found" });
		assert.deepEqual(await s.alex.paca.dismissDraft(card.id), { refused: "not-found" });
		assert.deepEqual((await s.state(ALEX)).turns.flatMap((t) => t.drafts), []);
		assert.deepEqual(s.fake.prompts, []);
	});

	it("shows the exact agent and prompt, and sends it once however often it is approved", async () => {
		const s = await start({ responses: proposing() });
		const card = await proposed(s);
		assert.deepEqual(
			{ action: card.action, target: card.target, title: card.title, body: card.body, status: card.status },
			{ action: "herdr.send_prompt", target: "claude in w1:p1", title: "/home/preview/code/notes", body: PROMPT, status: "proposed" },
		);
		assert.deepEqual(s.fake.prompts, []);

		const results = await Promise.all([1, 2, 3].map(() => s.martin.paca.approveDraft(card.id)));
		assert.deepEqual(results.filter((r) => r.status === "created"), [{ status: "created" }]);
		assert.deepEqual(s.fake.prompts, [{ pane: "w1:p1", terminal: "term_fake01", text: PROMPT }]);
		assert.deepEqual(await s.martin.paca.approveDraft(card.id), { refused: "created" });
		const after = (await s.state(MARTIN)).turns.at(-1).drafts[0];
		assert.deepEqual([after.status, after.url, after.error], ["created", undefined, undefined]);
	});

	it("sends nothing for a dismissed prompt or one whose agent changed", async () => {
		const s = await start({ responses: [...proposing(), ...proposing()] });
		const dismissed = await proposed(s);
		assert.deepEqual(await s.martin.paca.dismissDraft(dismissed.id), { status: "dismissed" });
		assert.deepEqual(await s.martin.paca.approveDraft(dismissed.id), { refused: "dismissed" });

		const stale = await proposed(s);
		s.fake.agents[0].terminal_id = "term_after_restart";
		assert.deepEqual(await s.martin.paca.approveDraft(stale.id), { status: "failed" });
		assert.deepEqual(await s.martin.paca.approveDraft(stale.id), { refused: "failed" });
		const card = (await s.state(MARTIN)).turns.at(-1).drafts[0];
		assert.equal(card.status, "failed");
		assert.match(card.error, /changed since this was proposed.*Nothing was sent\./);
		assert.deepEqual(s.fake.prompts, []);
	});

	it("never resends an unknown prompt, including one cut off by a restart", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "paca-herdr-"));
		const fake = await startFakeHerdr({ path: join(dataDir, "herdr.sock"), handlers: { "agent.prompt": () => "close" } });
		open.push(fake);
		const first = await start({ dataDir, fake, responses: [...proposing(), ...proposing()] });
		const unknown = await proposed(first);
		assert.deepEqual(await first.martin.paca.approveDraft(unknown.id), { status: "unknown" });
		assert.deepEqual(await first.martin.paca.approveDraft(unknown.id), { refused: "unknown" });
		assert.equal(fake.requests.filter((r) => r.method === "agent.prompt").length, 1);

		// A crash after the claim leaves the draft "creating": the prompt may have been typed.
		const cut = await proposed(first);
		await first.martin.paca.root.commit(async (tx) => {
			(await tx.doc(Drafts, first.martin.paca.root.id)).items[cut.id].status = "creating";
		}, ctx);
		await first.users.close();
		open = open.filter((o) => o !== first.users);

		const second = await start({ dataDir, fake });
		const cards = (await second.state(MARTIN)).turns.flatMap((t) => t.drafts);
		assert.deepEqual(cards.map((c) => c.status), ["unknown", "unknown"]);
		assert.match(cards[1].error, /Paca restarted before it recorded the outcome/);
		assert.deepEqual(await second.martin.paca.approveDraft(cut.id), { refused: "unknown" });
		assert.equal(fake.requests.filter((r) => r.method === "agent.prompt").length, 1);
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
