import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uiState } from "../src/view.js";

const draft = (id, status, extra = {}) => ({ id, repository: "o/r", title: `Title ${id}`, body: `Body ${id}`, status, ...extra });

describe("page state", () => {
	it("keeps undecided drafts visible after compaction removed their turns", () => {
		// After compaction the view starts at the summary; the turns that made d1, d3 and d4 are gone.
		const view = {
			entries: [
				{ kind: "pi.compaction", id: 1 },
				{ kind: "pi.user", id: 2, model: [{ role: "user", content: "Draft another" }] },
				{ kind: "pi.assistant", id: 3, model: [{ role: "assistant", content: [{ type: "toolCall", id: "d2", name: "draft_issue", arguments: { repository: "o/r" } }] }] },
			],
			docs: {},
		};
		const drafts = {
			items: {
				d1: draft("d1", "proposed"),
				d2: draft("d2", "proposed"),
				d3: draft("d3", "unknown", { error: "timed out" }),
				d4: draft("d4", "created", { number: 4, url: "https://github.com/o/r/issues/4" }),
			},
		};
		const { turns } = uiState(view, { drafts });
		assert.equal(turns[0].question, "Earlier drafts");
		assert.deepEqual(turns[0].drafts.map((d) => [d.id, d.status]), [["d1", "proposed"], ["d3", "unknown"]]);
		assert.equal(turns[0].drafts[0].body, "Body d1");
		assert.match(turns[0].drafts[1].checkUrl, /^https:\/\/github\.com\/o\/r\/issues\?q=/);
		assert.deepEqual(turns[1].drafts.map((d) => d.id), ["d2"]);
		assert.equal(turns.length, 2);
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
