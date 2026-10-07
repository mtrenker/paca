// Issue drafts: shown exactly, written at most once and only after approval, outcomes kept, and a
// write cut off by a restart never sent again.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WriteRejected, WriteUnknown } from "@paca/extension-github";
import { call, fauxModel, idle, newId, openUser, stateOf, stubGitHub, tempDir, text } from "./helpers.js";

const draftCall = (args) => call("draft_issue", { repository: "o/r", title: "Show failed checks", body: "## Outcome\nNames of failed checks.", ...args });

async function drafted({ outcome, args, dir, packages } = {}) {
	dir ??= await tempDir();
	const { gh, sent } = stubGitHub(outcome);
	const model = await fauxModel(dir, [draftCall(args), text("Here is a draft.")]);
	const user = await openUser({ dir, model, gh, packages });
	const id = newId();
	user.sessions.start(id, "draft it", "request-d");
	await idle(user.sessions, id);
	const state = () => stateOf(user.sessions, id);
	return { ...user, dir, id, sent, state, draft: (await state()).turns[0].drafts[0] };
}

describe("issue drafts", () => {
	it("drafting shows a card and writes nothing", async () => {
		const { sent, draft } = await drafted();
		assert.equal(sent.length, 0);
		assert.deepEqual([draft.status, draft.repository, draft.title, draft.body], ["proposed", "o/r", "Show failed checks", "## Outcome\nNames of failed checks."]);
	});

	it("refuses a draft for a repository outside the scope", async () => {
		const { store, id, state } = await drafted({ args: { repository: "someone/else" } });
		assert.deepEqual(store.drafts(id), []);
		assert.equal((await state()).turns[0].steps[0].status, "unavailable");
	});

	it("approval creates exactly the stored draft, once, and links it", async () => {
		const { sessions, id, sent, state, draft } = await drafted();
		const results = await Promise.all([sessions.approveDraft(id, draft.id), sessions.approveDraft(id, draft.id), sessions.approveDraft(id, draft.id)]);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], { repository: "o/r", title: "Show failed checks", body: "## Outcome\nNames of failed checks." });
		assert.equal(results.filter((r) => r.status === "created").length, 1);
		assert.deepEqual(await sessions.approveDraft(id, draft.id), { refused: "created" });
		const [card] = (await state()).turns[0].drafts;
		assert.deepEqual([card.status, card.url, card.number], ["created", "https://github.com/o/r/issues/12", 12]);
	});

	it("dismissal creates nothing and cannot be approved afterwards", async () => {
		const { sessions, id, sent, draft } = await drafted();
		assert.deepEqual(sessions.dismissDraft(id, draft.id), { status: "dismissed" });
		assert.deepEqual(await sessions.approveDraft(id, draft.id), { refused: "dismissed" });
		assert.deepEqual(await sessions.approveDraft(id, "no-such-draft"), { refused: "not-found" });
		assert.equal(sent.length, 0);
	});

	it("keeps a refused write apart from an unknown one and never resends either", async () => {
		for (const [error, expected] of [
			[new WriteRejected("failed: gh: Validation Failed (HTTP 422)"), "failed"],
			[new WriteUnknown("timed out"), "unknown"],
		]) {
			const { sessions, id, sent, state, draft } = await drafted({ outcome: async () => Promise.reject(error) });
			assert.deepEqual(await sessions.approveDraft(id, draft.id), { status: expected });
			assert.deepEqual(await sessions.approveDraft(id, draft.id), { refused: expected });
			assert.equal(sent.length, 1);
			const [card] = (await state()).turns[0].drafts;
			assert.equal(card.status, expected);
			assert.equal(card.url, undefined);
			if (expected === "unknown") assert.match(card.checkUrl, /^https:\/\/github\.com\/o\/r\/issues\?q=/);
		}
	});

	it("marks a create cut off by a restart as unknown and does not resend it", async () => {
		const first = await drafted();
		// A crash after the claim leaves the draft in "creating".
		assert.equal(first.store.claim(first.id, first.draft.id), true);
		await first.sessions.close();

		const after = stubGitHub();
		const model = await fauxModel(first.dir, []);
		const { sessions } = await openUser({ dir: first.dir, model, gh: after.gh });
		const [card] = (await stateOf(sessions, first.id)).turns[0].drafts;
		assert.deepEqual([card.status, card.error], ["unknown", "Paca restarted while creating this issue."]);
		assert.deepEqual(await sessions.approveDraft(first.id, first.draft.id), { refused: "unknown" });
		assert.equal(after.sent.length, 0);
	});

	it("keeps a draft proposed when its tool package is no longer enabled", async () => {
		const first = await drafted();
		await first.sessions.close();
		const model = await fauxModel(first.dir, []);
		const { sessions } = await openUser({ dir: first.dir, model, packages: [] });
		assert.deepEqual(await sessions.approveDraft(first.id, first.draft.id), { refused: "unavailable" });
		assert.equal((await stateOf(sessions, first.id)).turns[0].drafts[0].status, "proposed");
		assert.deepEqual(sessions.agentOf(first.id).getActiveToolNames(), []);
		assert.equal(first.sent.length, 0);
	});
});
