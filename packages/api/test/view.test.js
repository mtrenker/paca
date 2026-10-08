import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { githubTools } from "@paca/extension-github";
import { uiState as reduce } from "../src/view.ts";

const { labels, writes } = githubTools({ projects: [] }, () => {});
const uiState = (entries, extra) => reduce(entries, { ...extra, describe: { labels, checkUrl: (d) => writes.create_issue.checkUrl({ ...d, target: d.repository }) } });

const draft = (id, status, extra = {}) => ({ id, sessionId: "s", action: "github.create_issue", repository: "o/r", title: `Title ${id}`, body: `Body ${id}`, status, createdAt: "2026-10-07T00:00:00Z", ...extra });
const message = (id, message) => ({ type: "message", id, parentId: null, timestamp: "", message });
const user = (id, text) => message(id, { role: "user", content: [{ type: "text", text }] });
const toolCall = (id, callId) => message(id, { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: callId, name: "draft_issue", arguments: { repository: "o/r" } }] });

describe("page state", () => {
	// A converted legacy transcript may lack the turns that made d1 and d3.
	const later = [user("1", "Draft another"), toolCall("2", "d2")];

	it("shows drafts whose turns are not in the transcript, once, in an Earlier drafts turn", () => {
		const { turns } = uiState(later, { drafts: [draft("d1", "proposed"), draft("d2", "proposed"), draft("d3", "unknown", { error: "timed out" })] });
		assert.equal(turns.length, 2);
		assert.equal(turns[0].question, "Earlier drafts");
		assert.deepEqual(turns[0].drafts.map((d) => [d.id, d.status]), [["d1", "proposed"], ["d3", "unknown"]]);
		assert.equal(turns[0].drafts[0].body, "Body d1");
		assert.match(turns[0].drafts[1].checkUrl, /^https:\/\/github\.com\/o\/r\/issues\?q=/);
		assert.deepEqual(turns[1].drafts.map((d) => d.id), ["d2"]);
	});

	it("keeps the outcome of a decision made on an earlier draft on the page", () => {
		for (const [status, extra] of [
			["creating", {}],
			["created", { number: 4, url: "https://github.com/o/r/issues/4" }],
			["failed", { error: "Validation Failed (HTTP 422)" }],
			["dismissed", {}],
		]) {
			const { turns } = uiState(later, { drafts: [draft("d1", status, extra)] });
			const [card] = turns[0].drafts;
			assert.equal(turns[0].question, "Earlier drafts", status);
			assert.equal(card.status, status);
			if (status === "created") assert.deepEqual([card.url, card.number], ["https://github.com/o/r/issues/4", 4]);
			if (status === "failed") assert.equal(card.error, "Validation Failed (HTTP 422)");
		}
	});

	it("adds no extra turn when every draft still has its turn", () => {
		const { turns } = uiState([user("1", "Draft one"), toolCall("2", "d1")], { drafts: [draft("d1", "proposed")] });
		assert.equal(turns.length, 1);
		assert.deepEqual(turns[0].drafts.map((d) => d.id), ["d1"]);
	});

	it("shows Paca's notices, says why an answer stopped, and marks cut-off steps", () => {
		const entries = [
			user("1", "Read it"),
			toolCall("2", "d1"),
			message("3", { role: "assistant", stopReason: "aborted", errorMessage: "Not sent: Stopped by you.", content: [] }),
			{ type: "custom_message", id: "4", parentId: "3", timestamp: "", customType: "paca.notice", content: "Stopped by you.", display: true },
		];
		const [turn] = uiState(entries).turns;
		assert.deepEqual(turn.notices.map((n) => [n.tone, n.text]), [["warning", "The answer was interrupted."], ["warning", "Stopped by you."]]);
		assert.equal(turn.steps[0].status, "interrupted");
		assert.equal(uiState(entries, { running: true }).turns[0].steps[0].status, "running");
	});

	it("shows a request Paca refused to send as interrupted, not as a model failure", () => {
		const entries = [user("1", "Stop at once"), message("2", { role: "assistant", stopReason: "error", errorMessage: "Not sent: Stopped by you.", content: [] })];
		assert.deepEqual(uiState(entries).turns[0].notices, [{ tone: "warning", text: "The answer was interrupted." }]);
	});

	it("shows why a session could not be opened", () => {
		assert.deepEqual(uiState([], { error: "Paca could not open this session: bad file" }).turns[0].notices, [{ tone: "error", text: "Paca could not open this session: bad file" }]);
	});

	it("shows a converted Durable error result by its message, and a failed model request as an error", () => {
		const entries = [
			user("1", "Read it"),
			toolCall("2", "c1"),
			message("3", { role: "toolResult", toolCallId: "c1", toolName: "draft_issue", isError: true, content: [{ type: "text", text: "<harness>\n[error] Repository x/y is outside Paca's scope.\n</harness>" }] }),
			message("4", { role: "assistant", stopReason: "error", errorMessage: "529 overloaded", content: [] }),
		];
		const [turn] = uiState(entries).turns;
		assert.deepEqual([turn.steps[0].status, turn.steps[0].detail], ["unavailable", "Repository x/y is outside Paca's scope."]);
		assert.deepEqual(turn.notices, [{ tone: "error", text: "The model request failed: 529 overloaded" }]);
	});

	it("gives each page draft its own turn, before the first question asked after it, never in Earlier drafts", () => {
		const asked = (id, text, timestamp) => ({ ...user(id, text), timestamp });
		const entries = [asked("1", "First", "2026-10-08T10:00:00.000Z"), toolCall("2", "d1"), asked("3", "Second", "2026-10-08T11:00:00.000Z")];
		const page = (id, createdAt, extra) => draft(id, "proposed", { createdAt, ...extra });
		const { turns } = uiState(entries, {
			drafts: [draft("d1", "proposed"), page("page:early", "2026-10-08T09:00:00.000Z"), page("page:between", "2026-10-08T10:30:00.000Z"), page("page:late", "2026-10-08T12:00:00.000Z", { status: "created" }), draft("lost", "proposed")],
		});
		assert.deepEqual(turns.map((t) => [t.id, t.question]), [["earlier-drafts", "Earlier drafts"], ["page:early", null], ["1", "First"], ["page:between", null], ["3", "Second"], ["page:late", null]]);
		assert.deepEqual(turns[0].drafts.map((d) => d.id), ["lost"]);
		assert.deepEqual(turns.flatMap((t) => t.drafts).map((d) => [d.id, d.fromPage ?? false]), [["lost", false], ["page:early", true], ["d1", false], ["page:between", true], ["page:late", true]]);
		assert.equal(turns[3].drafts[0].title, "Title page:between");
	});
});
