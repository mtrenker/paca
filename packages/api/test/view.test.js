import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { githubTools } from "@paca/extension-github";
import { uiState as reduce } from "../src/view.ts";

const { labels, writes } = githubTools({ projects: [] }, async () => {});
const uiState = (view, extra) => reduce(view, { ...extra, describe: { labels, checkUrl: (d) => writes.create_issue.checkUrl(d) } });

const draft = (id, status, extra = {}) => ({ id, repository: "o/r", title: `Title ${id}`, body: `Body ${id}`, status, ...extra });

describe("page state", () => {
	// After compaction the view starts at the summary; the turns that made d1 and d3 are gone.
	const compacted = {
		entries: [
			{ kind: "pi.compaction", id: 1 },
			{ kind: "pi.user", id: 2, model: [{ role: "user", content: "Draft another" }] },
			{ kind: "pi.assistant", id: 3, model: [{ role: "assistant", content: [{ type: "toolCall", id: "d2", name: "draft_issue", arguments: { repository: "o/r" } }] }] },
		],
		docs: {},
	};

	it("shows drafts whose turns were compacted away, once, in an Earlier drafts turn", () => {
		const drafts = { items: { d1: draft("d1", "proposed"), d2: draft("d2", "proposed"), d3: draft("d3", "unknown", { error: "timed out" }) } };
		const { turns } = uiState(compacted, { drafts });
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
			const { turns } = uiState(compacted, { drafts: { items: { d1: draft("d1", status, extra) } } });
			const [card] = turns[0].drafts;
			assert.equal(turns[0].question, "Earlier drafts", status);
			assert.equal(card.status, status);
			if (status === "created") assert.deepEqual([card.url, card.number], ["https://github.com/o/r/issues/4", 4]);
			if (status === "failed") assert.equal(card.error, "Validation Failed (HTTP 422)");
		}
	});

	it("adds no extra turn when every draft still has its turn", () => {
		const view = {
			entries: [
				{ kind: "pi.user", id: 1, model: [{ role: "user", content: "Draft one" }] },
				{ kind: "pi.assistant", id: 2, model: [{ role: "assistant", content: [{ type: "toolCall", id: "d1", name: "draft_issue", arguments: { repository: "o/r" } }] }] },
			],
			docs: {},
		};
		const { turns } = uiState(view, { drafts: { items: { d1: draft("d1", "proposed") } } });
		assert.equal(turns.length, 1);
		assert.deepEqual(turns[0].drafts.map((d) => d.id), ["d1"]);
	});
});
