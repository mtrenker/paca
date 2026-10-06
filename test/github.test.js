import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createGitHub, EvidenceUnavailable, formatOverview } from "../src/github.js";

const projects = [
	{ owner: "o", number: 1, repository: "o/api" },
	{ owner: "o", number: 2, repository: "o/web" },
];

async function github(run) {
	const calls = [];
	const gh = createGitHub({
		projects,
		piClean: "/pi-clean",
		dataDir: await mkdtemp(join(tmpdir(), "paca-")),
		run: async (file, args) => (calls.push([file, ...args]), run(file, args)),
	});
	return { gh, calls };
}

describe("GitHub reads", () => {
	it("refuses repositories outside the configured scope without running anything", async () => {
		const { gh, calls } = await github(() => "{}");
		await assert.rejects(gh.readIssue("someone/else", 1), /outside Paca's scope/);
		await assert.rejects(gh.searchIssues("token", "someone/else"), /outside Paca's scope/);
		await assert.rejects(gh.searchIssues("repo:someone/else token"), /qualifiers/);
		assert.equal(calls.length, 0);
	});

	it("passes arguments as argv and drops search results from other repositories", async () => {
		const { gh, calls } = await github(() =>
			JSON.stringify([
				{ repository: { nameWithOwner: "o/api" }, number: 3, title: "In scope", state: "OPEN", url: "https://github.com/o/api/issues/3", labels: [] },
				{ repository: { nameWithOwner: "x/secret" }, number: 4, title: "Leak", state: "OPEN", url: "https://github.com/x/secret/issues/4", labels: [] },
			]),
		);
		const out = await gh.searchIssues("a; rm -rf ~");
		assert.match(out, /o\/api#3/);
		assert.doesNotMatch(out, /secret/);
		assert.deepEqual(calls[0].slice(0, 4), ["gh", "search", "issues", "a; rm -rf ~"]);
	});

	it("reports a failed collection instead of an empty portfolio", async () => {
		const { gh } = await github(() => {
			throw new EvidenceUnavailable("failed: rate limited");
		});
		await assert.rejects(gh.overview(), EvidenceUnavailable);
	});

	it("names Projects that returned no data", () => {
		const snapshot = { capturedAt: "2026-10-06T00:00:00Z", sources: { projects: [{ owner: "o", number: 1, title: "API" }] }, items: [] };
		const text = formatOverview(snapshot, { findings: [] }, projects);
		assert.match(text, /from 1 of 2 configured Projects/);
		assert.match(text, /UNAVAILABLE: Project o\/2 \(o\/web\)/);
	});
});
