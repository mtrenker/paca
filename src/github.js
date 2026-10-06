// Read-only GitHub evidence for the configured Projects and their repositories.
// Every read is a fixed-argument child process (no shell); nothing here can write to GitHub.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const COLLECT_TIMEOUT_MS = 90_000;
const READ_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const OVERVIEW_CACHE_MS = 60_000;

export class EvidenceUnavailable extends Error {}

export function runFile(file, args, { env, timeout }) {
	return new Promise((resolve, reject) => {
		execFile(file, args, { env, timeout, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				const detail = (stderr || error.message || "").trim().split("\n").slice(-3).join(" ");
				reject(new EvidenceUnavailable(`${error.killed ? "timed out" : "failed"}: ${detail}`.slice(0, 400)));
			} else resolve(stdout);
		});
	});
}

/**
 * @param {object} options
 * @param {{ owner: string, number: number, repository: string }[]} options.projects
 * @param {string} options.piClean absolute path of the pi-clean checkout providing github-planning.mjs
 * @param {string} options.dataDir private directory for the generated planning configuration
 * @param {typeof runFile} [options.run]
 */
export function createGitHub({ projects, piClean, dataDir, run = runFile, now = Date.now }) {
	const repositories = [...new Set(projects.map((p) => p.repository))].sort();
	const allowed = new Set(repositories.map((r) => r.toLowerCase()));
	const planningConfig = join(dataDir, "github-workflow.json");
	const env = { ...process.env, PI_GITHUB_WORKFLOW_CONFIG: planningConfig, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
	let cache;

	function checkRepository(repository) {
		if (typeof repository !== "string" || !allowed.has(repository.toLowerCase())) {
			throw new Error(`Repository ${JSON.stringify(repository)} is outside Paca's scope. Allowed: ${repositories.join(", ")}`);
		}
		return repositories.find((r) => r.toLowerCase() === repository.toLowerCase());
	}

	async function collect(command) {
		const script = join(piClean, "scripts", "github-planning.mjs");
		const out = await run(process.execPath, [script, command, "paca", "--format", "json"], { env, timeout: COLLECT_TIMEOUT_MS });
		return JSON.parse(out);
	}

	async function overview() {
		if (cache && now() - cache.at < OVERVIEW_CACHE_MS) return cache.text;
		await writeFile(planningConfig, JSON.stringify(planningConfigFor(projects), null, 2), { mode: 0o600 });
		const [snapshot, groom] = await Promise.all([collect("snapshot"), collect("groom")]);
		const text = formatOverview(snapshot, groom, projects);
		cache = { at: now(), text };
		return text;
	}

	async function readIssue(repository, number) {
		const repo = checkRepository(repository);
		if (!Number.isInteger(number) || number < 1) throw new Error("number must be a positive integer");
		const fields = "number,title,state,url,author,labels,assignees,milestone,createdAt,updatedAt,body,comments";
		const out = await run("gh", ["issue", "view", String(number), "--repo", repo, "--json", fields], { env, timeout: READ_TIMEOUT_MS });
		return formatIssue(repo, JSON.parse(out));
	}

	async function searchIssues(query, repository) {
		if (typeof query !== "string" || !query.trim()) throw new Error("query must not be empty");
		if (/\b(repo|org|user|owner):/i.test(query)) throw new Error("Use the repository argument instead of repo:, org:, user: or owner: qualifiers.");
		const repos = repository ? [checkRepository(repository)] : repositories;
		const args = ["search", "issues", query.slice(0, 200), "--limit", "30", "--json", "repository,number,title,state,url,updatedAt,labels"];
		for (const r of repos) args.push("--repo", r);
		const results = JSON.parse(await run("gh", args, { env, timeout: READ_TIMEOUT_MS }));
		// Defense in depth: never pass on a result from outside the configured scope.
		const inScope = results.filter((r) => allowed.has(String(r.repository?.nameWithOwner).toLowerCase()));
		if (inScope.length === 0) return `No issues matched ${JSON.stringify(query)} in ${repos.join(", ")}.`;
		return inScope
			.map((r) => `${r.repository.nameWithOwner}#${r.number} [${r.state.toLowerCase()}] ${r.title} | labels: ${names(r.labels)} | updated ${day(r.updatedAt)} | ${r.url}`)
			.join("\n");
	}

	return { repositories, projects, overview, readIssue, searchIssues };
}

export function planningConfigFor(projects) {
	return {
		version: 1,
		defaults: { options: { priority: ["P0 — urgent", "P1 — active outcome", "P2 — next", "P3 — later"] } },
		portfolios: {
			paca: {
				repositories: [...new Set(projects.map((p) => p.repository))].sort(),
				projects: projects.map((p) => ({ owner: p.owner, number: p.number, repositories: [p.repository] })),
			},
		},
	};
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : "unknown");
const names = (labels) => (labels?.length ? labels.map((l) => (typeof l === "string" ? l : l.name)).join(", ") : "none");

/** One line per open item so the model sees the whole portfolio in a few thousand tokens. */
export function formatOverview(snapshot, groom, projects) {
	const findingsByItem = new Map();
	for (const f of groom?.findings ?? []) {
		if (!f.itemId) continue;
		const list = findingsByItem.get(f.itemId) ?? [];
		list.push(f.code === "BLOCKER_OPEN" ? `blocked by ${f.evidence?.blocker?.repository}#${f.evidence?.blocker?.number}` : f.code);
		findingsByItem.set(f.itemId, list);
	}
	const open = (snapshot.items ?? []).filter((i) => i.state === "OPEN");
	const sources = snapshot.sources?.projects ?? [];
	const lines = [
		`Captured ${snapshot.capturedAt} from ${sources.length} of ${projects.length} configured Projects; ${open.length} open items (closed items omitted).`,
	];
	for (const s of sources) {
		if (s.unresolvedFields?.length) lines.push(`Project ${s.title} (${s.url}) is missing fields: ${s.unresolvedFields.join(", ")}`);
	}
	const missing = projects.filter((p) => !sources.some((s) => s.owner === p.owner && s.number === p.number));
	for (const p of missing) lines.push(`UNAVAILABLE: Project ${p.owner}/${p.number} (${p.repository}) returned no data.`);
	const workflowFindings = (groom?.findings ?? []).filter((f) => !f.itemId);
	for (const f of workflowFindings) lines.push(`Finding ${f.code}: ${f.message}`);
	lines.push("", "Format: item | type | status | priority | size | labels | parent | blockers | updated | findings | url | title");
	for (const i of open) {
		const blockers =
			i.blockers?.availability !== "available"
				? "unavailable"
				: i.blockers.items.filter((b) => b.state === "OPEN").map((b) => `${b.repository}#${b.number}`).join(" ") || "none";
		const type = i.itemType === "PULL_REQUEST" ? `pr(review: ${i.review?.decision ?? "none"}, checks: ${i.checks?.status ?? "unknown"})` : i.hasChildren ? "parent issue" : "issue";
		const parent = i.availability?.parent !== "available" ? "unavailable" : i.parent ? `${i.parent.repository ?? i.repository}#${i.parent.number}` : "none";
		const findings = findingsByItem.get(i.id)?.join(", ") || "none";
		lines.push(
			[`${i.repository}#${i.number}`, type, i.projectStatus ?? "no status", i.priority ?? "no priority", i.size ?? "no size", names(i.labels), parent, blockers, day(i.updatedAt), findings, i.url, i.title].join(" | "),
		);
	}
	return lines.join("\n");
}

export function formatIssue(repository, issue) {
	const clip = (text, max) => {
		const t = String(text ?? "").trim();
		return t.length > max ? `${t.slice(0, max)}\n[truncated ${t.length - max} characters]` : t || "(empty)";
	};
	const comments = issue.comments ?? [];
	const shown = comments.slice(-10);
	return [
		`${repository}#${issue.number} [${String(issue.state).toLowerCase()}] ${issue.title}`,
		`url: ${issue.url}`,
		`author: ${issue.author?.login ?? "unknown"} | created ${day(issue.createdAt)} | updated ${day(issue.updatedAt)}`,
		`labels: ${names(issue.labels)} | assignees: ${issue.assignees?.map((a) => a.login).join(", ") || "none"} | milestone: ${issue.milestone?.title ?? "none"}`,
		"",
		clip(issue.body, 6000),
		"",
		`${comments.length} comments${comments.length > shown.length ? `, showing the last ${shown.length}` : ""}:`,
		...shown.map((c) => `--- ${c.author?.login ?? "unknown"} on ${day(c.createdAt)}:\n${clip(c.body, 1500)}`),
	].join("\n");
}
