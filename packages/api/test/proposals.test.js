// Page proposals (#17, Contract 6): admission into an open or a new session, duplicate and
// conflicting retries across the user's store, races with a delete, and approval through the
// existing claim, write and recovery. Writes go to a GitHub stub; nothing reaches GitHub.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OperationError } from "@paca/extension";
import { githubTools } from "@paca/extension-github";
import { fauxModel, idle, newId, openUser, stateOf, stubGitHub, tempDir, text } from "./helpers.js";

const input = (extra = {}) => ({ repository: "o/r", title: "  Follow up on o/r#7  ", body: "Follow-up to o/r#7.", ...extra });
const request = (requestId, extra = {}) => ({ requestId, package: "github", action: "create_issue", input: input(), start: false, label: "GitHub", ...extra });

async function user(options = {}) {
	const dir = options.dir ?? (await tempDir());
	const model = await fauxModel(dir, options.responses ?? []);
	const github = options.github ?? stubGitHub();
	return { dir, model, ...github, ...(await openUser({ dir, model, gh: github.gh, ...options })) };
}

/** A session with one answered question, as a user's open session would be. */
async function openSession(sessions) {
	const id = newId();
	sessions.start(id, "Look at o/r#7", "request-question");
	await idle(sessions, id);
	return id;
}

describe("page proposals: admission", () => {
	it("stores the exact proposal as a page draft in the open session, in a turn of its own after the question", async () => {
		const { store, sessions } = await user({ responses: [text("Read it.")] });
		const id = await openSession(sessions);
		assert.deepEqual(await sessions.proposeFromPage(id, request("page-req-0001")), { session: id, draft: "page:page-req-0001", duplicate: false });
		const [draft] = store.drafts(id);
		assert.deepEqual([draft.id, draft.action, draft.repository, draft.title, draft.body, draft.status], ["page:page-req-0001", "github.create_issue", "o/r", "Follow up on o/r#7", "Follow-up to o/r#7.", "proposed"]);
		const { turns } = await stateOf(sessions, id);
		assert.deepEqual(turns.map((t) => [t.id, t.question]), [[turns[0].id, "Look at o/r#7"], ["page:page-req-0001", null]]);
		assert.equal(turns[1].drafts[0].fromPage, true);
		assert.equal(sessions.list.current()[0].waiting, 1);
	});

	it("makes a new session holding the draft when the page has none, with no question and no file yet", async () => {
		const { dir, store, sessions } = await user();
		const id = newId();
		assert.deepEqual(await sessions.proposeFromPage(id, request("page-req-0002", { start: true })), { session: id, draft: "page:page-req-0002", duplicate: false });
		const row = store.session(id);
		assert.equal(row.title, "GitHub: Follow up on o/r#7");
		assert.equal(existsSync(join(dir, row.file)), false, "the file appears with the first message");
		assert.equal(store.hasRequest(id, "page-req-0002"), false);
		assert.deepEqual(sessions.list.current().map((s) => [s.id, s.waiting, s.running]), [[id, 1, false]]);
		const { turns } = await stateOf(sessions, id);
		assert.deepEqual(turns.map((t) => [t.id, t.question, t.drafts.length]), [["page:page-req-0002", null, 1]]);
	});

	it("keeps a session made by a proposal across a restart, and opens it afterwards", async () => {
		const first = await user();
		const id = newId();
		await first.sessions.proposeFromPage(id, request("page-req-0003", { start: true }));
		await first.sessions.close();
		const again = await user({ dir: first.dir, responses: [text("Later answer.")] });
		assert.deepEqual((await stateOf(again.sessions, id)).turns.map((t) => t.id), ["page:page-req-0003"]);
		assert.deepEqual(again.sessions.ask(id, "And now?", "request-later"), { duplicate: false });
		await idle(again.sessions, id);
		assert.deepEqual((await stateOf(again.sessions, id)).turns.map((t) => t.question), [null, "And now?"]);
	});

	it("refuses a session that does not exist without start, and one being deleted", async () => {
		const { store, sessions } = await user({ responses: [text("Read it.")] });
		assert.deepEqual(await sessions.proposeFromPage(newId(), request("page-req-0004")), { refused: "not-found" });
		const id = await openSession(sessions);
		assert.ok(store.markDeleting(id));
		assert.deepEqual(await sessions.proposeFromPage(id, request("page-req-0005")), { refused: "deleting" });
		assert.deepEqual(await sessions.proposeFromPage(id, request("page-req-0006", { start: true })), { refused: "deleting" });
		assert.deepEqual(store.drafts(id), []);
	});

	it("refuses what cannot be proposed: an unknown action, a write without a builder, a builder without a write", async () => {
		const { gh } = stubGitHub();
		const base = githubTools(gh, () => {});
		const packages = [
			{ name: "github", tools: base },
			{ name: "nobuilder", tools: { ...base, proposals: undefined } },
			{ name: "nowrite", tools: { ...base, writes: undefined } },
		];
		const { sessions } = await user({ packages });
		const id = newId();
		for (const [pkg, action] of [["github", "close_issue"], ["github", "constructor"], ["nobuilder", "create_issue"], ["nowrite", "create_issue"], ["missing", "create_issue"]]) {
			assert.deepEqual(await sessions.proposeFromPage(id, request(`page-${pkg}-${action}`, { package: pkg, action, start: true })), { refused: "not-proposable" }, `${pkg} ${action}`);
		}
		assert.deepEqual(sessions.list.current(), []);
	});

	it("passes on a builder's OperationError, and calls anything else a failure", async () => {
		const { gh } = stubGitHub();
		const tools = githubTools(gh, () => {});
		const bad = (proposal) => ({ ...tools, proposals: { create_issue: async () => proposal } });
		const packages = [
			{ name: "github", tools },
			{ name: "crash", tools: { ...tools, proposals: { create_issue: () => { throw new Error("boom"); } } } },
			{ name: "other", tools: bad({ action: "close_issue", target: "o/r", title: "t", body: "b" }) },
			{ name: "loose", tools: bad({ action: "create_issue", target: "o/r", title: 1, body: "b" }) },
			{ name: "expect", tools: bad({ action: "create_issue", target: "o/r", title: "t", body: "b", expect: { n: 1 } }) },
			{ name: "huge", tools: bad({ action: "create_issue", target: "o/r", title: "t", body: "x".repeat(128 * 1024) }) },
		];
		const { sessions } = await user({ packages });
		const id = newId();
		assert.deepEqual(await sessions.proposeFromPage(id, request("page-req-0007", { input: input({ repository: "x/y" }), start: true })), { refused: "operation", status: 404, error: "Repository x/y is outside Paca's scope." });
		assert.deepEqual((await sessions.proposeFromPage(id, request("page-req-0008", { input: input({ title: "   " }), start: true }))).status, 400);
		for (const name of ["crash", "other", "loose", "expect", "huge"]) assert.equal((await sessions.proposeFromPage(id, request(`page-${name}-1`, { package: name, start: true }))).refused, "failed", name);
		assert.deepEqual(sessions.list.current(), []);
		assert.ok(new OperationError(400, "x") instanceof Error);
	});
});

describe("page proposals: duplicates and retries", () => {
	it("answers the same request again, or at the same time, with the one draft it stored", async () => {
		const { store, sessions } = await user({ responses: [text("Read it.")] });
		const id = await openSession(sessions);
		const first = await sessions.proposeFromPage(id, request("page-req-0010"));
		assert.deepEqual(await sessions.proposeFromPage(id, request("page-req-0010")), { ...first, duplicate: true });
		const both = await Promise.all([sessions.proposeFromPage(id, request("page-req-0011")), sessions.proposeFromPage(id, request("page-req-0011"))]);
		assert.deepEqual(both.map((r) => r.duplicate).sort(), [false, true]);
		assert.deepEqual(store.drafts(id).map((d) => d.id), ["page:page-req-0010", "page:page-req-0011"]);
	});

	it("refuses the same request id with different content, and changes nothing", async () => {
		const { store, sessions } = await user({ responses: [text("Read it.")] });
		const id = await openSession(sessions);
		await sessions.proposeFromPage(id, request("page-req-0012"));
		const before = store.drafts(id);
		assert.deepEqual(await sessions.proposeFromPage(id, request("page-req-0012", { input: input({ body: "Changed." }) })), { refused: "conflict" });
		assert.deepEqual(store.drafts(id), before);
	});

	it("finds a stored new-session proposal when its retry names another new session, and makes no second session", async () => {
		const { store, sessions } = await user();
		const [first, second] = [newId(), newId()];
		await sessions.proposeFromPage(first, request("page-req-0013", { start: true }));
		assert.deepEqual(await sessions.proposeFromPage(second, request("page-req-0013", { start: true })), { session: first, draft: "page:page-req-0013", duplicate: true });
		assert.equal(store.session(second), undefined);
		assert.deepEqual(sessions.list.current().map((s) => s.id), [first]);
		assert.deepEqual(await sessions.proposeFromPage(second, request("page-req-0013", { start: true, input: input({ title: "Other" }) })), { refused: "conflict" });
	});

	it("makes separate drafts for separate submissions of the same content", async () => {
		const { store, sessions } = await user({ responses: [text("Read it.")] });
		const id = await openSession(sessions);
		await sessions.proposeFromPage(id, request("page-req-0014"));
		await sessions.proposeFromPage(id, request("page-req-0015"));
		assert.equal(store.drafts(id).length, 2);
	});
});

describe("page proposals: approval, recovery and deletion", () => {
	it("creates the stored proposal once on approval, with the existing route's wording", async () => {
		const { sessions, sent } = await user({ responses: [text("Read it.")] });
		const id = await openSession(sessions);
		const { draft } = await sessions.proposeFromPage(id, request("page-req-0020"));
		assert.deepEqual(await sessions.approveDraft(id, draft), { status: "created", url: "https://github.com/o/r/issues/12" });
		assert.deepEqual(await sessions.approveDraft(id, draft), { refused: "created" });
		assert.deepEqual(sent, [{ repository: "o/r", title: "Follow up on o/r#7", body: "Follow-up to o/r#7." }]);
		assert.deepEqual(await sessions.proposeFromPage(id, request("page-req-0020")), { session: id, draft, duplicate: true }, "a late retry finds the created draft and stores nothing");
		assert.equal(sent.length, 1);
	});

	it("never sends a page draft again after a restart during its write", async () => {
		const first = await user();
		const id = newId();
		const { draft } = await first.sessions.proposeFromPage(id, request("page-req-0021", { start: true }));
		assert.ok(first.store.claim(id, draft), "claimed as an approval would, then Paca stops before the outcome");
		await first.sessions.close();
		const again = await user({ dir: first.dir });
		const card = (await stateOf(again.sessions, id)).turns[0].drafts[0];
		assert.deepEqual([card.status, card.fromPage], ["unknown", true]);
		assert.deepEqual(await again.sessions.approveDraft(id, draft), { refused: "unknown" });
		assert.deepEqual([first.sent, again.sent], [[], []]);
	});

	it("never leaves a page draft in a deleted session, whichever of the delete and the proposal comes first", async () => {
		let release;
		const gate = new Promise((resolve) => (release = resolve));
		const { gh } = stubGitHub();
		const tools = githubTools(gh, () => {});
		const held = { ...tools, proposals: { create_issue: async (i) => (await gate, tools.proposals.create_issue(i)) } };
		const { store, sessions } = await user({ responses: [text("Read it.")], packages: [{ name: "github", tools: held }] });
		const id = await openSession(sessions);
		const pending = sessions.proposeFromPage(id, request("page-req-0022"));
		assert.deepEqual(await sessions.remove(id), { deleted: true });
		release();
		assert.deepEqual(await pending, { refused: "not-found" });
		assert.deepEqual([store.session(id), store.drafts(id)], [undefined, []]);

		const other = await openSession(sessions);
		await sessions.proposeFromPage(other, request("page-req-0023"));
		assert.deepEqual(await sessions.remove(other), { deleted: true });
		assert.deepEqual([store.session(other), store.drafts(other)], [undefined, []]);
	});
});
