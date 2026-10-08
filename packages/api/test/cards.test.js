// Cards a tool shows: their bounds, where they are stored and shown, and that they survive a
// restart and go with their session. Tools run on pi-ai's faux provider and a GitHub stub.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { githubTools } from "@paca/extension-github";
import { checkCard } from "../src/cards.ts";
import { openSessions } from "../src/sessions.ts";
import { openStore } from "../src/store.ts";
import { uiState } from "../src/view.ts";
import { call, fauxModel, idle, newId, stateOf, stubGitHub, tempDir, text } from "./helpers.js";

const silent = { log: () => {}, error: () => {} };
const ok = { kind: "note", data: { n: 1 }, fallback: { text: "A note" } };

/** A package whose one tool shows `count` cards of `kind`. */
function probe(show) {
	return {
		tools: [
			defineTool({
				name: "show_notes",
				label: "Show notes",
				description: "Shows cards.",
				parameters: Type.Object({ count: Type.Integer(), kind: Type.Optional(Type.String()) }),
				execute: async (toolCallId, args, _signal, _onUpdate, ctx) => {
					for (let i = 0; i < args.count; i++) show(toolCallId, ctx, { kind: args.kind ?? "note", data: { i }, fallback: { text: `Note ${i}` } });
					return { content: [{ type: "text", text: "shown" }], details: undefined };
				},
			}),
		],
		labels: { show_notes: { label: () => "Showed notes" } },
		scope: { label: "Probe", detail: "" },
	};
}

/** One user's sessions with the GitHub tools and the probe, both able to show cards. */
async function user(dir, responses = []) {
	const model = await fauxModel(dir, responses);
	const store = openStore(join(dir, "paca.db"));
	const sessions = await openSessions({
		userDir: dir,
		store,
		modelRuntime: model.modelRuntime,
		model: model.model,
		tools: (proposeFor, showFor) => [
			{ name: "github", tools: githubTools(stubGitHub().gh, proposeFor("github"), showFor("github", ["issue"])) },
			{ name: "probe", tools: probe(showFor("probe", ["note"])) },
		],
		log: silent,
	});
	return { store, sessions, model };
}

describe("card bounds", () => {
	it("accepts a declared kind with a small JSON projection and a fallback", () => {
		assert.deepEqual(checkCard({ ...ok, fallback: { text: "A note", url: "https://github.com/o/r/issues/1" } }, ["note"]), {
			kind: "note",
			data: '{"n":1}',
			fallback: '{"text":"A note","url":"https://github.com/o/r/issues/1"}',
		});
	});

	it("refuses an undeclared kind, data that is not plain JSON or over 1 KiB in UTF-8, and a bad fallback", () => {
		const refused = [
			[{ ...ok, kind: "other" }, /not declared/],
			[{ ...ok, data: [1] }, /plain JSON object/],
			[{ ...ok, data: { at: new Date() } }, /plain JSON object/],
			[{ ...ok, data: { n: Number.NaN } }, /plain JSON object/],
			[{ ...ok, data: { f: () => 1 } }, /plain JSON object/],
			[{ ...ok, data: { s: "ä".repeat(510) } }, /over 1024 bytes/],
			[{ ...ok, fallback: { text: "" } }, /1 to 200 characters/],
			[{ ...ok, fallback: { text: "x".repeat(201) } }, /1 to 200 characters/],
			[{ ...ok, fallback: { text: "x", url: "http://github.com/o/r" } }, /https: URL/],
			[{ ...ok, fallback: { text: "x", url: "javascript:alert(1)" } }, /https: URL/],
			[{ ...ok, fallback: undefined }, /fallback is missing/],
		];
		for (const [card, message] of refused) assert.throws(() => checkCard(card, ["note"]), message, JSON.stringify(card));
		// 1 KiB exactly still fits: {"s":"…"} is 8 bytes plus the string.
		assert.doesNotThrow(() => checkCard({ ...ok, data: { s: "x".repeat(1016) } }, ["note"]));
	});
});

describe("cards in a session", () => {
	it("stores a read issue's card under the calling session and tool call, and shows it in that turn", async () => {
		const dir = await tempDir();
		const { store, sessions } = await user(dir, [call("read_issue", { repository: "o/r", number: 7 }), text("Read it.")]);
		const id = newId();
		sessions.start(id, "Read o/r#7", "request-1");
		await idle(sessions, id);
		const [turn] = (await stateOf(sessions, id)).turns;
		const callId = turn.steps[0].id;
		assert.equal(turn.steps[0].status, "done");
		assert.deepEqual(turn.cards.map((c) => [c.id, c.package, c.kind]), [[`${callId}:0`, "github", "issue"]]);
		assert.deepEqual(turn.cards[0].data, { repository: "o/r", number: 7, title: "Issue 7", state: "open", labels: ["bug"], updatedAt: "2026-10-07T00:00:00Z" });
		assert.deepEqual(turn.cards[0].fallback, { text: "o/r#7 · Issue 7 · open", url: "https://github.com/o/r/issues/7" });
		assert.deepEqual(store.cards(id).map((c) => [c.sessionId, c.toolCallId]), [[id, callId]]);
		await sessions.close();
	});

	it("keeps cards across a restart, and removes them with their session", async () => {
		const dir = await tempDir();
		const first = await user(dir, [call("show_notes", { count: 2 }), text("Shown.")]);
		const id = newId();
		first.sessions.start(id, "Show two", "request-1");
		await idle(first.sessions, id);
		const before = (await stateOf(first.sessions, id)).turns[0].cards;
		assert.equal(before.length, 2);
		await first.sessions.close();

		const again = await user(dir);
		assert.deepEqual((await stateOf(again.sessions, id)).turns[0].cards, before);
		assert.deepEqual(await again.sessions.remove(id), { deleted: true });
		assert.deepEqual(again.store.cards(id), []);
		await again.sessions.close();
	});

	it("fails the tool call for a card out of bounds: an undeclared kind, or a ninth card", async () => {
		const dir = await tempDir();
		const { store, sessions } = await user(dir, [call("show_notes", { count: 1, kind: "issue" }), call("show_notes", { count: 9 }), text("Done.")]);
		const id = newId();
		sessions.start(id, "Show too much", "request-1");
		await idle(sessions, id);
		const [turn] = (await stateOf(sessions, id)).turns;
		assert.deepEqual(turn.steps.map((s) => s.status), ["unavailable", "unavailable"]);
		assert.match(turn.steps[0].detail, /kind "issue" is not declared/);
		assert.match(turn.steps[1].detail, /at most 8 cards/);
		assert.deepEqual(turn.cards.map((c) => c.data.i), [0, 1, 2, 3, 4, 5, 6, 7]);
		assert.equal(store.cards(id).length, 8);
		await sessions.close();
	});

	it("never shows one session's cards in another", async () => {
		const dir = await tempDir();
		const { store, sessions } = await user(dir, [call("show_notes", { count: 1 }), text("A."), text("B.")]);
		const [a, b] = [newId(), newId()];
		sessions.start(a, "A", "request-a");
		await idle(sessions, a);
		sessions.start(b, "B", "request-b");
		await idle(sessions, b);
		assert.equal((await stateOf(sessions, a)).turns[0].cards.length, 1);
		assert.deepEqual((await stateOf(sessions, b)).turns[0].cards, []);
		assert.deepEqual(store.cards(b), []);
		await sessions.close();
	});

	it("stores nothing for a session marked for deletion", async () => {
		const store = openStore(join(await tempDir(), "paca.db"));
		const card = (sessionId) => ({ sessionId, toolCallId: "call_1", package: "probe", kind: "note", data: "{}", fallback: '{"text":"x"}' });
		store.create({ id: "s1", file: "f", title: "t" }, "request-1");
		assert.equal(store.addCard(card("s1"), 8), true);
		assert.ok(store.markDeleting("s1"));
		assert.equal(store.addCard(card("s1"), 8), true);
		assert.deepEqual(store.cards("s1").map((c) => c.id), ["call_1:0"]);
		store.deleteRows("s1");
		assert.deepEqual(store.cards("s1"), []);
		store.close();
	});
});

describe("cards in the page state", () => {
	const message = (id, message) => ({ type: "message", id, parentId: null, timestamp: "", message });
	const user = (id, text) => message(id, { role: "user", content: [{ type: "text", text }] });
	const toolCall = (id, callId) => message(id, { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: callId, name: "show_notes", arguments: {} }] });
	const stored = (toolCallId, n) => ({ id: `${toolCallId}:${n}`, sessionId: "s", toolCallId, package: "probe", kind: "note", data: { n }, fallback: { text: "x" }, createdAt: "2026-10-08T00:00:00Z" });

	it("attaches each card to its tool call's turn and drops a card whose call is not in the branch", () => {
		const entries = [user("1", "First"), toolCall("2", "c1"), user("3", "Second"), toolCall("4", "c2")];
		const { turns } = uiState(entries, { cards: [stored("c2", 0), stored("gone", 0), stored("c1", 0), stored("c2", 1)] });
		assert.deepEqual(turns.map((t) => t.cards.map((c) => c.id)), [["c1:0"], ["c2:0", "c2:1"]]);
		assert.deepEqual(Object.keys(turns[0].cards[0]).sort(), ["createdAt", "data", "fallback", "id", "kind", "package"]);
	});
});
