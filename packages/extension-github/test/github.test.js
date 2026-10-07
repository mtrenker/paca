import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { childEnv, createGitHub, EvidenceUnavailable, formatOverview, WriteRejected, WriteUnknown } from "../src/github.ts";
import github_ from "../src/index.ts";

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

describe("credentials", () => {
	const projects = [{ owner: "o", number: 1, repository: "o/r" }];
	const forUser = (userSettings) => github_.forUser({ user: { id: "alex" }, settings: { piClean: "/pi-clean" }, userSettings, cacheDir: "/tmp", propose: async () => {} });

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
