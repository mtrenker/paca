// One user's sessions: start, resume, answers at the same time, isolation between sessions, and
// the deletion contract with its races (docs/design/multi-session.md).
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { call, fauxModel, held, idle, newId, openUser, stateOf, stubGitHub, tempDir, text, until } from "./helpers.js";

const textOf = (m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join(""));

/** Faux answers chosen by the label before ":" in the session's latest question, so sessions can interleave. */
function routed(routes) {
	const respond = async (context, options) => {
		const question = textOf(context.messages.filter((m) => m.role === "user").at(-1));
		const next = routes[question.split(":")[0]].shift();
		return typeof next === "function" ? next(context, options) : next;
	};
	return Array.from({ length: 50 }, () => respond);
}

const draftCall = (title) => call("draft_issue", { repository: "o/r", title, body: `Body of ${title}` });
const sessionFiles = (dir) => readdirSync(join(dir, "sessions"));

async function user(responses, options = {}) {
	const dir = options.dir ?? (await tempDir());
	const model = await fauxModel(dir, responses);
	const github = options.github ?? stubGitHub();
	return { dir, model, ...github, ...(await openUser({ dir, model, gh: github.gh, ...options })) };
}

describe("starting and resuming", () => {
	it("starts a session as one row and one session file, named by its id", async () => {
		const { dir, store, sessions } = await user([text("hello")]);
		const id = newId();
		assert.deepEqual(sessions.start(id, "first question", "request-1"), { duplicate: false });
		assert.equal(sessions.busy(id), true);
		await idle(sessions, id);
		assert.deepEqual(store.list().map((s) => [s.id, s.title, s.waiting]), [[id, "first question", 0]]);
		assert.deepEqual(sessionFiles(dir).map((f) => f.endsWith(`_${id}.jsonl`)), [true]);
		assert.equal(store.session(id).file, join("sessions", sessionFiles(dir)[0]));
		assert.deepEqual(sessions.start(id, "first question", "request-2"), { refused: "exists" });
	});

	it("lists every session after a restart with transcript, drafts and outcomes; a proposed draft is approvable once", async () => {
		const first = await user(routed({ A: [draftCall("Created one"), text("A done")], B: [draftCall("Still proposed"), text("B done")] }));
		const [a, b] = [newId(), newId()];
		first.sessions.start(a, "A: draft", "request-a");
		await idle(first.sessions, a);
		first.sessions.start(b, "B: draft", "request-b");
		await idle(first.sessions, b);
		const created = (await stateOf(first.sessions, a)).turns[0].drafts[0];
		assert.equal((await first.sessions.approveDraft(a, created.id)).status, "created");
		await first.sessions.close();

		const again = await user([], { dir: first.dir, github: { gh: first.gh, sent: first.sent } });
		assert.deepEqual(again.sessions.list.current().map((s) => [s.title, s.waiting, s.running]), [["B: draft", 1, false], ["A: draft", 0, false]]);
		const stateA = await stateOf(again.sessions, a);
		assert.deepEqual([stateA.turns[0].answer, stateA.turns[0].drafts[0].status, stateA.turns[0].drafts[0].url], ["A done", "created", "https://github.com/o/r/issues/12"]);
		const proposed = (await stateOf(again.sessions, b)).turns[0].drafts[0];
		const results = await Promise.all([again.sessions.approveDraft(b, proposed.id), again.sessions.approveDraft(b, proposed.id)]);
		assert.deepEqual(results.map((r) => r.status ?? r.refused).sort(), ["created", "creating"]);
		assert.deepEqual(first.sent.map((s) => s.title), ["Created one", "Still proposed"]);
	});
});

describe("sessions at the same time", () => {
	it("answers in two sessions at once; a busy session refuses a question; Stop ends only its own answer", async () => {
		const [holdA, holdB] = [held("A answer"), held("B answer")];
		const { sessions } = await user(routed({ A: [holdA.respond], B: [holdB.respond], C: [text("C answer")] }));
		const [a, b, c] = [newId(), newId(), newId()];
		sessions.start(a, "A: wait", "request-a");
		sessions.start(b, "B: wait", "request-b");
		await until(() => holdA.started && holdB.started);
		assert.deepEqual(sessions.list.current().map((s) => s.running), [true, true]);
		assert.deepEqual(sessions.ask(a, "A: again", "request-a2"), { refused: "busy" });
		assert.deepEqual(sessions.start(c, "C: other", "request-c"), { duplicate: false });
		await idle(sessions, c);

		sessions.stop(a);
		await idle(sessions, a);
		assert.equal(sessions.busy(b), true);
		assert.equal((await stateOf(sessions, a)).turns[0].notices.at(-1).text, "Stopped by you.");
		holdB.release();
		await idle(sessions, b);
		const stateB = await stateOf(sessions, b);
		assert.deepEqual([stateB.turns[0].answer, stateB.turns[0].notices], ["B answer", []]);
	});

	it("shows a Stop that arrives before the session opened as interrupted, and sends nothing", async () => {
		const { sessions, model } = await user([text("never sent")]);
		const a = newId();
		sessions.start(a, "A: stop at once", "request-a");
		sessions.stop(a);
		await idle(sessions, a);
		const [turn] = (await stateOf(sessions, a)).turns;
		assert.equal(model.faux.state.callCount, 0);
		assert.deepEqual(turn.notices.map((n) => [n.tone, n.text]), [["warning", "The answer was interrupted."], ["warning", "Stopped by you."]]);
	});

	it("shows why a session cannot be opened, and lets the question be asked again", async () => {
		const first = await user([text("one")]);
		const a = newId();
		first.sessions.start(a, "A: one", "request-a");
		await idle(first.sessions, a);
		const file = join(first.dir, first.store.session(a).file);
		await first.sessions.close();
		await writeFile(file, "not a session file\n");

		const again = await user([text("two")], { dir: first.dir });
		const shown = await stateOf(again.sessions, a);
		assert.match(shown.turns.at(-1).notices.at(-1).text, /^Paca could not open this session: /);
		assert.deepEqual(again.sessions.ask(a, "A: two", "request-a2"), { duplicate: false });
		await idle(again.sessions, a);
		assert.equal(again.store.hasRequest(a, "request-a2"), false, "the question can be asked again");
		assert.equal(again.model.faux.state.callCount, 0);
	});

	it("counts each session's model requests against its own answer", async () => {
		const loop = (label) => [call("read_issue", { repository: "o/r", number: 1 }), call("read_issue", { repository: "o/r", number: 2 }), text(`${label} done`)];
		const { sessions, model } = await user(routed({ A: loop("A"), B: loop("B") }), { limits: { modelRequests: 3, toolCalls: 30, durationMs: 60_000 } });
		const [a, b] = [newId(), newId()];
		sessions.start(a, "A: read", "request-a");
		sessions.start(b, "B: read", "request-b");
		await idle(sessions, a);
		await idle(sessions, b);
		assert.equal(model.faux.state.callCount, 6);
		for (const id of [a, b]) assert.deepEqual((await stateOf(sessions, id)).turns[0].notices, []);
	});

	it("never finds one session's draft or an unknown id under another session", async () => {
		const { sessions, sent } = await user(routed({ A: [draftCall("Only in A"), text("done")], B: [text("B done")] }));
		const [a, b, unknown] = [newId(), newId(), newId()];
		sessions.start(a, "A: draft", "request-a");
		sessions.start(b, "B: hi", "request-b");
		await idle(sessions, a);
		await idle(sessions, b);
		const draft = (await stateOf(sessions, a)).turns[0].drafts[0];
		assert.deepEqual(await sessions.approveDraft(b, draft.id), { refused: "not-found" });
		assert.deepEqual(sessions.dismissDraft(b, draft.id), { refused: "not-found" });
		for (const result of [sessions.ask(unknown, "x", "request-x"), sessions.stop(unknown), await sessions.remove(unknown), await sessions.approveDraft(unknown, draft.id), sessions.dismissDraft(unknown, draft.id)]) {
			assert.deepEqual(result, { refused: "not-found" });
		}
		assert.equal(await sessions.watch(unknown), undefined);
		assert.equal(sent.length, 0);
	});
});

describe("deleting a session", () => {
	it("removes an idle session's file and rows, ends its stream, and leaves another answer running", async () => {
		const hold = held("B answer");
		const { dir, store, sessions, sent } = await user(routed({ A: [draftCall("Created"), text("A done")], B: [hold.respond] }));
		const [a, b] = [newId(), newId()];
		sessions.start(a, "A: draft", "request-a");
		await idle(sessions, a);
		const draft = (await stateOf(sessions, a)).turns[0].drafts[0];
		await sessions.approveDraft(a, draft.id);
		sessions.start(b, "B: wait", "request-b");
		await until(() => hold.started);
		let gone = false;
		(await sessions.watch(a)).subscribe(() => {}, () => (gone = true));

		assert.deepEqual(await sessions.remove(a), { deleted: true });
		assert.equal(gone, true);
		assert.equal(store.session(a), undefined);
		assert.deepEqual([store.drafts(a), store.hasRequest(a, "request-a")], [[], false]);
		assert.equal(sessionFiles(dir).some((f) => f.includes(a)), false);
		assert.deepEqual(sessions.ask(a, "A: again", "request-a2"), { refused: "not-found" });
		assert.equal(await sessions.watch(a), undefined);
		assert.deepEqual(await sessions.remove(a), { refused: "not-found" });
		assert.equal(sent.length, 1, "deleting never writes to GitHub");

		hold.release();
		await idle(sessions, b);
		assert.equal((await stateOf(sessions, b)).turns[0].answer, "B answer");
	});

	it("refuses while the session answers or one of its drafts is being created", async () => {
		const hold = held();
		let finish;
		const github = stubGitHub(() => new Promise((resolve) => (finish = resolve)));
		const { sessions } = await user(routed({ A: [hold.respond, draftCall("Slow write"), text("drafted")] }), { github });
		const a = newId();
		sessions.start(a, "A: wait", "request-a");
		await until(() => hold.started);
		assert.deepEqual(await sessions.remove(a), { refused: "busy" });
		hold.release();
		await idle(sessions, a);

		sessions.ask(a, "A: draft", "request-a2");
		await idle(sessions, a);
		const draft = (await stateOf(sessions, a)).turns[1].drafts[0];
		const approving = sessions.approveDraft(a, draft.id);
		assert.deepEqual(await sessions.remove(a), { refused: "creating" });
		finish({ number: 7, url: "https://github.com/o/r/issues/7" });
		assert.equal((await approving).status, "created");
		assert.deepEqual(await sessions.remove(a), { deleted: true });
	});

	it("never ends an approval and a delete started together as a write without a record", async () => {
		for (const approveFirst of [true, false]) {
			const { store, sessions, sent } = await user(routed({ A: [draftCall("Raced"), text("done")] }));
			const a = newId();
			sessions.start(a, "A: draft", "request-a");
			await idle(sessions, a);
			const draft = (await stateOf(sessions, a)).turns[0].drafts[0];
			const [approved, removed] = approveFirst ? [sessions.approveDraft(a, draft.id), sessions.remove(a)] : await Promise.all([sessions.remove(a), sessions.approveDraft(a, draft.id)]).then((r) => r.reverse());
			const outcome = [await approved, await removed];
			if (approveFirst) {
				assert.deepEqual(outcome, [{ status: "created", url: "https://github.com/o/r/issues/12" }, { refused: "creating" }]);
				assert.deepEqual([sent.length, store.draft(a, draft.id).status], [1, "created"]);
			} else {
				assert.deepEqual(outcome, [{ refused: "not-found" }, { deleted: true }]);
				assert.equal(sent.length, 0);
			}
		}
	});

	it("ends a question and a delete started together with one of them refused", async () => {
		for (const askFirst of [true, false]) {
			const { sessions } = await user(routed({ A: [text("one"), text("two")] }));
			const a = newId();
			sessions.start(a, "A: one", "request-a");
			await idle(sessions, a);
			if (askFirst) {
				assert.deepEqual(sessions.ask(a, "A: two", "request-a2"), { duplicate: false });
				assert.deepEqual(await sessions.remove(a), { refused: "busy" });
				await idle(sessions, a);
			} else {
				const removing = sessions.remove(a);
				assert.deepEqual(sessions.ask(a, "A: two", "request-a2"), { refused: "not-found" });
				assert.deepEqual(await removing, { deleted: true });
			}
		}
	});

	it("keeps the id reserved until the deletion's last step; then the same create makes one new session", async () => {
		let hold;
		const removeFile = async (path) => {
			await hold?.promise;
			return rm(path, { force: true });
		};
		const { dir, sessions, store } = await user(routed({ A: [text("old"), text("new")] }), { removeFile });
		const a = newId();
		sessions.start(a, "A: old", "request-a");
		await idle(sessions, a);
		let release;
		hold = { promise: new Promise((resolve) => (release = resolve)) };
		const removing = sessions.remove(a);
		await until(() => !sessions.agentOf(a));

		assert.deepEqual(sessions.start(a, "A: new", "request-b"), { refused: "deleting" });
		assert.equal(sessions.agentOf(a), undefined);
		assert.equal(sessions.busy(a), false);
		assert.deepEqual(sessions.list.current(), []);
		release();
		assert.deepEqual(await removing, { deleted: true });
		assert.deepEqual(sessionFiles(dir), []);

		hold = undefined;
		assert.deepEqual(sessions.start(a, "A: new", "request-b"), { duplicate: false });
		await idle(sessions, a);
		assert.deepEqual((await stateOf(sessions, a)).turns.map((t) => [t.question, t.answer]), [["A: new", "new"]]);
		assert.equal(store.list().length, 1);
	});

	it("answers an error when removing the file fails, and a second delete or the next start finishes it", async () => {
		for (const finishBy of ["delete", "start"]) {
			let fail = true;
			const removeFile = async (path) => {
				if (fail) throw new Error("EIO: stubbed failure");
				return rm(path, { force: true });
			};
			const first = await user(routed({ A: [text("old")] }), { removeFile });
			const a = newId();
			first.sessions.start(a, "A: old", "request-a");
			await idle(first.sessions, a);
			await assert.rejects(first.sessions.remove(a), /stubbed failure/);
			assert.equal(first.store.session(a).state, "deleting");
			assert.deepEqual(first.sessions.list.current(), []);
			assert.deepEqual(first.sessions.ask(a, "A: again", "request-a2"), { refused: "not-found" });
			assert.deepEqual(first.sessions.start(a, "A: again", "request-a2"), { refused: "deleting" });
			fail = false;
			if (finishBy === "delete") {
				assert.deepEqual(await first.sessions.remove(a), { deleted: true });
				assert.equal(first.store.session(a), undefined);
			} else {
				await first.sessions.close();
				const again = await user([], { dir: first.dir });
				assert.equal(again.store.session(a), undefined);
			}
			assert.deepEqual(sessionFiles(first.dir), []);
		}
	});

	it("removes a converted session's retained legacy copy with it", async () => {
		const { dir, store, sessions } = await user([]);
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const a = newId();
		mkdirSync(join(dir, "legacy"));
		for (const suffix of ["", "-wal", "-shm"]) writeFileSync(join(dir, "legacy", `${a}.sqlite${suffix}`), "");
		store.insertConverted({ id: a, file: join("sessions", `x_${a}.jsonl`), title: "Converted", createdAt: "2026-10-01T00:00:00Z", lastActivity: "2026-10-01T00:00:00Z", legacyFile: join("legacy", `${a}.sqlite`) }, []);
		assert.deepEqual(await sessions.remove(a), { deleted: true });
		assert.deepEqual(readdirSync(join(dir, "legacy")), []);
		assert.equal(existsSync(join(dir, "paca.db")), true);
	});
});
