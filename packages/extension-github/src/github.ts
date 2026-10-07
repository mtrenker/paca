// GitHub access for one user's Projects and repositories. Every call is a fixed-argument child
// process (no shell). The only write is createIssue, which Paca calls after the user approves.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const COLLECT_TIMEOUT_MS = 90_000;
const READ_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const OVERVIEW_CACHE_MS = 60_000;
const WRITE_TIMEOUT_MS = 30_000;

export class EvidenceUnavailable extends Error {
	/** The program never started (ENOENT and the like). */
	notStarted = false;
	stderr = "";
}

export interface RunOptions {
	env: NodeJS.ProcessEnv;
	timeout: number;
	input?: string;
}
export type Run = (file: string, args: string[], options: RunOptions) => Promise<string>;

export interface Project {
	owner: string;
	number: number;
	repository: string;
}

export const runFile: Run = (file, args, { env, timeout, input }) => {
	return new Promise((resolve, reject) => {
		const child = execFile(file, args, { env, timeout, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) {
				const detail = (stderr || error.message || "").trim().split("\n").slice(-3).join(" ");
				reject(
					Object.assign(new EvidenceUnavailable(`${error.killed ? "timed out" : "failed"}: ${detail}`.slice(0, 400)), {
						// A string code (ENOENT, ...) means the program never started.
						notStarted: typeof error.code === "string" && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
						stderr: String(stderr ?? ""),
					}),
				);
			} else resolve(stdout);
		});
		if (input !== undefined) {
			child.stdin?.on("error", () => {}); // gh exiting early is reported through the exit callback
			child.stdin?.end(input);
		}
	});
};

/** GitHub refused the write, or it never left this machine: nothing was created. */
export class WriteRejected extends Error {}
/** The write may or may not have happened; someone has to check on GitHub. */
export class WriteUnknown extends Error {}

export interface GitHubOptions {
	projects: Project[];
	/** Absolute path of the pi-clean checkout providing github-planning.mjs. */
	piClean: string;
	/** Private directory for the generated planning configuration. */
	dataDir: string;
	/** This user's token. Without one, gh uses the server's own login, which the operator granted. */
	token?: string;
	run?: Run;
	now?: () => number;
}

/**
 * The environment of every gh and collector process. Paca's own variables never pass through, so
 * the OIDC secret and other users' tokens stay out; a user's token replaces the server login.
 */
export function childEnv(token: string | undefined, planningConfig: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parent)) if (!key.startsWith("PACA_")) env[key] = value;
	if (token !== undefined) {
		delete env.GITHUB_TOKEN;
		delete env.GH_ENTERPRISE_TOKEN;
		delete env.GITHUB_ENTERPRISE_TOKEN;
		env.GH_TOKEN = token;
	}
	return { ...env, PI_GITHUB_WORKFLOW_CONFIG: planningConfig, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
}

export type GitHub = ReturnType<typeof createGitHub>;

export function createGitHub({ projects, piClean, dataDir, token, run = runFile, now = Date.now }: GitHubOptions) {
	const repositories = [...new Set(projects.map((p) => p.repository))].sort();
	const allowed = new Set(repositories.map((r) => r.toLowerCase()));
	const planningConfig = join(dataDir, "github-workflow.json");
	const env = childEnv(token, planningConfig);
	let cache: { at: number; text: string } | undefined;

	function checkRepository(repository: unknown): string {
		if (typeof repository !== "string" || !allowed.has(repository.toLowerCase())) {
			throw new Error(`Repository ${JSON.stringify(repository)} is outside Paca's scope. Allowed: ${repositories.join(", ")}`);
		}
		return repositories.find((r) => r.toLowerCase() === repository.toLowerCase())!;
	}

	async function collect(command: string) {
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

	async function readIssue(repository: string, number: number) {
		const repo = checkRepository(repository);
		if (!Number.isInteger(number) || number < 1) throw new Error("number must be a positive integer");
		const fields = "number,title,state,url,author,labels,assignees,milestone,createdAt,updatedAt,body,comments";
		const out = await run("gh", ["issue", "view", String(number), "--repo", repo, "--json", fields], { env, timeout: READ_TIMEOUT_MS });
		return formatIssue(repo, JSON.parse(out));
	}

	async function searchIssues(query: string, repository?: string) {
		if (typeof query !== "string" || !query.trim()) throw new Error("query must not be empty");
		if (/\b(repo|org|user|owner):/i.test(query)) throw new Error("Use the repository argument instead of repo:, org:, user: or owner: qualifiers.");
		const repos = repository ? [checkRepository(repository)] : repositories;
		const args = ["search", "issues", query.slice(0, 200), "--limit", "30", "--json", "repository,number,title,state,url,updatedAt,labels"];
		for (const r of repos) args.push("--repo", r);
		const results: SearchResult[] = JSON.parse(await run("gh", args, { env, timeout: READ_TIMEOUT_MS }));
		// Defense in depth: never pass on a result from outside the configured scope.
		const inScope = results.filter((r) => allowed.has(String(r.repository?.nameWithOwner).toLowerCase()));
		if (inScope.length === 0) return `No issues matched ${JSON.stringify(query)} in ${repos.join(", ")}.`;
		return inScope
			.map((r) => `${r.repository!.nameWithOwner}#${r.number} [${r.state.toLowerCase()}] ${r.title} | labels: ${names(r.labels)} | updated ${day(r.updatedAt)} | ${r.url}`)
			.join("\n");
	}

	/**
	 * Creates one issue with exactly this title and body. Not idempotent: callers must never retry
	 * after WriteUnknown. Only an HTTP 4xx answer or a failure to start gh counts as "not created".
	 */
	async function createIssue(repository: string, { title, body }: { title: string; body: string }) {
		const repo = checkRepository(repository);
		let out: string;
		try {
			out = await run("gh", ["api", "--method", "POST", `repos/${repo}/issues`, "--input", "-"], { env, timeout: WRITE_TIMEOUT_MS, input: JSON.stringify({ title, body }) });
		} catch (error) {
			const { stderr = "", notStarted = false, message } = error as EvidenceUnavailable;
			if (notStarted || /\(HTTP 4\d\d\)/.test(stderr)) throw new WriteRejected(message);
			throw new WriteUnknown(message);
		}
		try {
			const issue = JSON.parse(out);
			if (!Number.isInteger(issue.number) || typeof issue.html_url !== "string") throw new Error("no issue in the response");
			return { number: issue.number, url: issue.html_url };
		} catch (error) {
			throw new WriteUnknown(`unreadable response: ${(error as Error).message}`);
		}
	}

	return { repositories, projects, checkRepository, overview, readIssue, searchIssues, createIssue };
}

export function planningConfigFor(projects: Project[]) {
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

interface SearchResult {
	repository?: { nameWithOwner: string };
	number: number;
	title: string;
	state: string;
	url: string;
	updatedAt?: string;
	labels?: Label[];
}
type Label = string | { name: string };

const day = (iso: unknown) => (iso ? String(iso).slice(0, 10) : "unknown");
const names = (labels: Label[] | undefined) => (labels?.length ? labels.map((l) => (typeof l === "string" ? l : l.name)).join(", ") : "none");

/** One line per open item so the model sees the whole portfolio in a few thousand tokens. */
// The collector's JSON (pi-clean github-planning.mjs), read loosely: a missing field reads as unavailable.
type Loose = any;

export function formatOverview(snapshot: Loose, groom: Loose, projects: Project[]) {
	const findingsByItem = new Map<string, string[]>();
	for (const f of groom?.findings ?? []) {
		if (!f.itemId) continue;
		const list = findingsByItem.get(f.itemId) ?? [];
		list.push(f.code === "BLOCKER_OPEN" ? `blocked by ${f.evidence?.blocker?.repository}#${f.evidence?.blocker?.number}` : f.code);
		findingsByItem.set(f.itemId, list);
	}
	const open = (snapshot.items ?? []).filter((i: Loose) => i.state === "OPEN");
	const sources = snapshot.sources?.projects ?? [];
	const lines = [
		`Captured ${snapshot.capturedAt} from ${sources.length} of ${projects.length} configured Projects; ${open.length} open items (closed items omitted).`,
	];
	for (const s of sources) {
		if (s.unresolvedFields?.length) lines.push(`Project ${s.title} (${s.url}) is missing fields: ${s.unresolvedFields.join(", ")}`);
	}
	const missing = projects.filter((p) => !sources.some((s: Loose) => s.owner === p.owner && s.number === p.number));
	for (const p of missing) lines.push(`UNAVAILABLE: Project ${p.owner}/${p.number} (${p.repository}) returned no data.`);
	const workflowFindings = (groom?.findings ?? []).filter((f: Loose) => !f.itemId);
	for (const f of workflowFindings) lines.push(`Finding ${f.code}: ${f.message}`);
	lines.push("", "Format: item | type | status | priority | size | labels | parent | blockers | updated | findings | url | title");
	for (const i of open) {
		const blockers =
			i.blockers?.availability !== "available"
				? "unavailable"
				: i.blockers.items.filter((b: Loose) => b.state === "OPEN").map((b: Loose) => `${b.repository}#${b.number}`).join(" ") || "none";
		const type = i.itemType === "PULL_REQUEST" ? `pr(review: ${i.review?.decision ?? "none"}, checks: ${i.checks?.status ?? "unknown"})` : i.hasChildren ? "parent issue" : "issue";
		const parent = i.availability?.parent !== "available" ? "unavailable" : i.parent ? `${i.parent.repository ?? i.repository}#${i.parent.number}` : "none";
		const findings = findingsByItem.get(i.id)?.join(", ") || "none";
		lines.push(
			[`${i.repository}#${i.number}`, type, i.projectStatus ?? "no status", i.priority ?? "no priority", i.size ?? "no size", names(i.labels), parent, blockers, day(i.updatedAt), findings, i.url, i.title].join(" | "),
		);
	}
	return lines.join("\n");
}

export function formatIssue(repository: string, issue: Loose) {
	const clip = (text: unknown, max: number) => {
		const t = String(text ?? "").trim();
		return t.length > max ? `${t.slice(0, max)}\n[truncated ${t.length - max} characters]` : t || "(empty)";
	};
	const comments = issue.comments ?? [];
	const shown = comments.slice(-10);
	return [
		`${repository}#${issue.number} [${String(issue.state).toLowerCase()}] ${issue.title}`,
		`url: ${issue.url}`,
		`author: ${issue.author?.login ?? "unknown"} | created ${day(issue.createdAt)} | updated ${day(issue.updatedAt)}`,
		`labels: ${names(issue.labels)} | assignees: ${issue.assignees?.map((a: Loose) => a.login).join(", ") || "none"} | milestone: ${issue.milestone?.title ?? "none"}`,
		"",
		clip(issue.body, 6000),
		"",
		`${comments.length} comments${comments.length > shown.length ? `, showing the last ${shown.length}` : ""}:`,
		...shown.map((c: Loose) => `--- ${c.author?.login ?? "unknown"} on ${day(c.createdAt)}:\n${clip(c.body, 1500)}`),
	].join("\n");
}
