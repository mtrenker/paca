import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { childEnv, createGitHub, EvidenceUnavailable, formatOverview, WriteRejected, WriteUnknown } from "../src/github.ts";
import github_, { githubTools, issueCard } from "../src/index.ts";

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

	it("creates an issue with one fixed POST and the content on stdin", async () => {
		const inputs = [];
		const gh = createGitHub({
			projects,
			piClean: "/pi-clean",
			dataDir: await mkdtemp(join(tmpdir(), "paca-")),
			run: async (file, args, options) => {
				inputs.push({ argv: [file, ...args], input: options.input });
				return JSON.stringify({ number: 7, html_url: "https://github.com/o/api/issues/7" });
			},
		});
		assert.deepEqual(await gh.createIssue("o/api", { title: "T; rm -rf ~", body: "B" }), { number: 7, url: "https://github.com/o/api/issues/7" });
		assert.deepEqual(inputs[0].argv, ["gh", "api", "--method", "POST", "repos/o/api/issues", "--input", "-"]);
		assert.deepEqual(JSON.parse(inputs[0].input), { title: "T; rm -rf ~", body: "B" });
		await assert.rejects(gh.createIssue("someone/else", { title: "T", body: "" }), /outside Paca's scope/);
		assert.equal(inputs.length, 1);
	});

	it("only calls a write failed when GitHub refused it or gh never started", async () => {
		const failure = (props) => async () => {
			throw Object.assign(new EvidenceUnavailable("failed"), { stderr: "", notStarted: false, ...props });
		};
		const cases = [
			[failure({ stderr: "gh: Validation Failed (HTTP 422)" }), WriteRejected],
			[failure({ notStarted: true }), WriteRejected],
			[failure({ stderr: "gh: Server Error (HTTP 502)" }), WriteUnknown],
			[failure({ stderr: "" }), WriteUnknown],
			[async () => "not json", WriteUnknown],
		];
		for (const [run, expected] of cases) {
			const { gh } = await github(run);
			await assert.rejects(gh.createIssue("o/api", { title: "T", body: "" }), expected);
		}
	});
});

describe("issue card", () => {
	const issueJson = (extra = {}) => ({ number: 12, title: "Fix the thing", state: "OPEN", url: "https://github.com/o/api/issues/12", author: { login: "a" }, labels: [{ name: "bug" }, { name: "P1" }], updatedAt: "2026-10-07T10:00:00Z", body: "Body", comments: [], ...extra });

	it("shows the issue read_issue read, once, and gives the model the same text as before", async () => {
		const { gh, calls } = await github(() => JSON.stringify(issueJson()));
		const shown = [];
		const ctx = { sessionManager: { getSessionId: () => "s1" } };
		const readIssue = githubTools(gh, () => {}, (id, c, card) => shown.push([id, c, card])).tools.find((t) => t.name === "read_issue");
		const result = await readIssue.execute("call_1", { repository: "O/API", number: 12 }, undefined, undefined, ctx);
		assert.equal(result.content[0].text, await gh.readIssue("o/api", 12));
		assert.equal(calls.length, 2, "one gh call per read");
		assert.equal(shown.length, 1);
		const [[id, context, card]] = shown;
		assert.deepEqual([id, context], ["call_1", ctx]);
		assert.deepEqual(card, {
			kind: "issue",
			data: { repository: "o/api", number: 12, title: "Fix the thing", state: "open", labels: ["bug", "P1"], updatedAt: "2026-10-07T10:00:00Z" },
			fallback: { text: "o/api#12 · Fix the thing · open", url: "https://github.com/o/api/issues/12" },
		});
	});

	it("fits a 256-character multibyte title with many long labels into 1 KiB", () => {
		const labels = Array.from({ length: 20 }, (_, i) => ({ name: `${"ラベル".repeat(20)}${i}` }));
		for (const title of ["😀".repeat(128), "ä".repeat(256), "\u0001".repeat(256), "t".repeat(256)]) {
			const card = issueCard("o/api", issueJson({ title, labels, state: "CLOSED" }));
			assert.ok(Buffer.byteLength(JSON.stringify(card.data)) <= 1024, title.slice(0, 4));
			assert.ok(card.data.title.length <= 120);
			assert.ok(card.data.labels.length <= 5 && card.data.labels.every((l) => l.length <= 30));
			assert.equal(card.data.state, "closed");
			assert.ok(card.fallback.text.length <= 200);
			assert.doesNotMatch(card.data.title, /[\uD800-\uDBFF]$/, "no half surrogate pair");
		}
		// Labels go first; only then, with a long repository name, does the title shorten.
		const wide = issueCard(`o/${"r".repeat(400)}`, issueJson({ title: "\u0001".repeat(256), labels }));
		assert.ok(Buffer.byteLength(JSON.stringify(wide.data)) <= 1024);
		assert.deepEqual(wide.data.labels, []);
		assert.ok(wide.data.title.length > 0 && wide.data.title.length < 120);
	});

	it("shows no card for a read without a valid number, and none without the host's show", async () => {
		assert.equal(issueCard("o/api", issueJson({ number: "x" })), undefined);
		const { gh } = await github(() => JSON.stringify(issueJson()));
		const readIssue = githubTools(gh, () => {}).tools.find((t) => t.name === "read_issue");
		assert.match((await readIssue.execute("call_1", { repository: "o/api", number: 12 })).content[0].text, /^o\/api#12 \[open\] Fix the thing/);
	});

	it("declares its card in the manifest, with its browser files in the package", () => {
		assert.deepEqual({ ...github_.browser, dir: undefined }, { dir: undefined, entry: "dist/index.js", styles: ["github.css"], cards: ["issue"] });
		assert.match(github_.browser.dir, /^file:.*\/extension-github\/browser\/$/);
	});
});

describe("credentials", () => {
	const projects = [{ owner: "o", number: 1, repository: "o/r" }];
	const forUser = (userSettings) => github_.forUser({ user: { id: "alex" }, settings: { piClean: "/pi-clean" }, userSettings, cacheDir: "/tmp", propose: async () => {}, show: () => {} });

	it("needs each user's own credential; the server login only when granted", () => {
		assert.equal(forUser(undefined), undefined);
		assert.throws(() => forUser({ projects }), /needs its own credential/);
		assert.throws(() => forUser({ projects, tokenEnv: "GH_TOKEN" }), /needs its own credential/);
		assert.throws(() => forUser({ projects, tokenEnv: "PACA_GH_TOKEN_UNSET" }), /PACA_GH_TOKEN_UNSET is not set/);
		assert.throws(() => forUser({ projects, tokenEnv: "PACA_X", serverLogin: true }), /not both/);
		assert.deepEqual(Object.keys(forUser({ projects, serverLogin: true }).writes), ["create_issue"]);
	});

	it("runs gh with the user's token and without Paca's secrets", () => {
		const parent = { PATH: "/bin", GH_TOKEN: "server", GITHUB_TOKEN: "server", PACA_OIDC_CLIENT_SECRET: "secret", PACA_GH_TOKEN_MARTIN: "martins" };
		const own = childEnv("alexs", "/cfg.json", parent);
		assert.deepEqual([own.GH_TOKEN, own.GITHUB_TOKEN, own.PATH, own.PI_GITHUB_WORKFLOW_CONFIG], ["alexs", undefined, "/bin", "/cfg.json"]);
		assert.ok(!Object.keys(own).some((k) => k.startsWith("PACA_")));
		const server = childEnv(undefined, "/cfg.json", parent);
		assert.deepEqual([server.GH_TOKEN, server.GITHUB_TOKEN, server.PACA_GH_TOKEN_MARTIN], ["server", "server", undefined]);
	});
});
