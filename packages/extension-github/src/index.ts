// Scoped GitHub tools for one user: a Projects overview, issue reads and search, and issue drafts
// the user approves. Each user brings their own repository scope and credential. How to rank work
// or phrase answers is the host's persona, not part of these tools. A read issue is also shown as a
// card in the chat, and the GitHub pages read issues fresh through two read-only operations; both
// are rendered by this package's browser entry (browser/).
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type CardInput, defineToolPackage, type JsonValue, type Operation, OperationError, type Proposal, type Propose, type Show, type UserTools } from "@paca/extension";
import { createGitHub, EvidenceUnavailable, formatIssue, type GitHub, type Label, type Project, WriteRejected } from "./github.ts";

export interface GitHubSettings {
	/** Absolute path of the pi-clean checkout providing github-planning.mjs. */
	piClean: string;
}

export interface GitHubUserSettings {
	/** Each Project and the one repository the user may read and create issues in for it. */
	projects: Project[];
	/** Name of the environment variable holding this user's token. Must start with PACA_. */
	tokenEnv?: string;
	/** Use the server's own gh login for this user. The operator grants it per user. */
	serverLogin?: boolean;
}

const TITLE_MAX = 256;
const BODY_MAX = 20_000;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

function checkUserSettings(id: string, settings: GitHubUserSettings): string | undefined {
	const fail = (message: string): never => {
		throw new Error(`users "${id}" github: ${message}`);
	};
	if (!Array.isArray(settings.projects) || settings.projects.length === 0) fail("projects must list at least one Project");
	for (const p of settings.projects) {
		if (typeof p.owner !== "string" || !Number.isInteger(p.number) || !/^[\w.-]+\/[\w.-]+$/.test(p.repository ?? "")) {
			fail("each projects entry needs owner, number and repository (owner/name)");
		}
	}
	if (settings.serverLogin === true && settings.tokenEnv === undefined) return undefined;
	if (settings.serverLogin !== undefined && settings.serverLogin !== false) fail("use either tokenEnv or serverLogin, not both");
	if (typeof settings.tokenEnv !== "string" || !/^PACA_[A-Z0-9_]+$/.test(settings.tokenEnv)) {
		fail("needs its own credential: tokenEnv (a PACA_... variable) or serverLogin: true");
	}
	const token = process.env[settings.tokenEnv!];
	if (!token) fail(`${settings.tokenEnv} is not set`);
	return token;
}

/** The part of the GitHub client the tools use; tests pass a stub. */
export type GitHubAccess = Pick<GitHub, "projects" | "checkRepository" | "overview" | "issue" | "findIssues" | "searchIssues" | "createIssue">;

const CARD_MAX = 1024;
const CARD_TITLE_MAX = 120;
const CARD_LABELS = 5;
const CARD_LABEL_MAX = 30;

/** Cuts text to `max` UTF-16 units without leaving half a surrogate pair. */
function clip(text: string, max: number) {
	const cut = text.slice(0, max);
	return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The issue card: what Paca read, cut to fit the host's 1 KiB bound. A long title is cut to 120
 * characters and at most 5 labels of 30 are kept; if that is still too much, the labels go, then
 * the title shortens. Undefined only if even an empty title would not fit.
 */
export function issueCard(repository: string, issue: { number?: unknown; title?: unknown; state?: unknown; labels?: unknown; updatedAt?: unknown }): CardInput | undefined {
	const number = Number(issue.number);
	if (!Number.isInteger(number) || number < 1) return undefined;
	const state = String(issue.state).toLowerCase() === "closed" ? "closed" : "open";
	const updatedAt = clip(String(issue.updatedAt ?? ""), 40);
	let title = clip(String(issue.title ?? "").trim(), CARD_TITLE_MAX);
	let labels = (Array.isArray(issue.labels) ? issue.labels : []).slice(0, CARD_LABELS).map((l) => clip(String(typeof l === "string" ? l : l?.name ?? ""), CARD_LABEL_MAX)).filter(Boolean);
	const data = () => ({ repository, number, title, state, labels, updatedAt });
	const fits = () => Buffer.byteLength(JSON.stringify(data())) <= CARD_MAX;
	if (!fits()) labels = [];
	while (!fits() && title) title = clip(title, title.length - 8);
	if (!fits()) return undefined;
	return {
		kind: "issue",
		data: data(),
		fallback: { text: clip(`${repository}#${number} · ${title || "(no title)"} · ${state}`, 200), url: `https://github.com/${repository}/issues/${number}` },
	};
}

const ISSUE_BODY_MAX = 20_000;
const COMMENT_BODY_MAX = 4_000;
const COMMENTS = 10;
const RESULT_LABELS = 5;

const labelNames = (labels: unknown) => (Array.isArray(labels) ? labels : []).map((l: Label) => String(typeof l === "string" ? l : l?.name ?? "")).filter(Boolean);

/**
 * The reads behind the GitHub pages, bound to this user's scope and credential. An out-of-scope
 * repository is a 404 the page shows, and so is a missing issue; GitHub failing to answer is a 502.
 */
function operations(github: GitHubAccess): Record<string, Operation> {
	const scoped = (repository: unknown) => {
		try {
			return github.checkRepository(repository);
		} catch {
			throw new OperationError(404, "That repository is not in your GitHub scope.");
		}
	};
	const reading = async <T>(read: () => Promise<T>): Promise<T> => {
		try {
			return await read();
		} catch (error) {
			if (!(error instanceof EvidenceUnavailable)) throw error;
			if (/Could not resolve to an? (issue|Issue)|not found/i.test(error.stderr || error.message)) throw new OperationError(404, "That issue does not exist.");
			throw new OperationError(502, `GitHub could not be read: ${clip(error.message, 200)}`);
		}
	};
	return {
		async issue(input) {
			const repository = scoped(input.repository);
			const number = Number(input.number);
			if (!Number.isInteger(number) || number < 1) throw new OperationError(400, "An issue number is a positive whole number.");
			const { issue } = await reading(() => github.issue(repository, number));
			const comments: unknown[] = Array.isArray(issue.comments) ? issue.comments.slice(-COMMENTS) : [];
			return {
				repository,
				number,
				title: String(issue.title ?? ""),
				state: String(issue.state).toLowerCase() === "closed" ? "closed" : "open",
				url: `https://github.com/${repository}/issues/${number}`,
				author: String(issue.author?.login ?? "unknown"),
				labels: labelNames(issue.labels),
				updatedAt: String(issue.updatedAt ?? ""),
				body: clip(String(issue.body ?? ""), ISSUE_BODY_MAX),
				// The follow-up form offers these, and only these, as the new issue's repository.
				repositories: [...new Set(github.projects.map((p) => p.repository))].sort(),
				comments: comments.map((c: any) => ({ author: String(c?.author?.login ?? "unknown"), createdAt: String(c?.createdAt ?? ""), body: clip(String(c?.body ?? ""), COMMENT_BODY_MAX) })),
			} satisfies JsonValue;
		},
		async issues(input) {
			const query = input.query === undefined || input.query === "" ? undefined : input.query;
			if (query !== undefined && (typeof query !== "string" || query.length > 200)) throw new OperationError(400, "A search has at most 200 characters.");
			if (query && /\b(repo|org|user|owner):/i.test(query)) throw new OperationError(400, "Choose a repository instead of repo:, org:, user: or owner: in the search.");
			const repository = input.repository === undefined || input.repository === "" ? undefined : scoped(input.repository);
			const found = await reading(() => github.findIssues({ query, repository }));
			return {
				repositories: [...new Set(github.projects.map((p) => p.repository))].sort(),
				results: found.results.map((r) => ({
					repository: r.repository!.nameWithOwner,
					number: r.number,
					title: String(r.title ?? ""),
					state: String(r.state).toLowerCase() === "closed" ? "closed" : "open",
					updatedAt: String(r.updatedAt ?? ""),
					labels: labelNames(r.labels).slice(0, RESULT_LABELS),
				})),
			};
		},
	};
}

/**
 * The exact create_issue proposal: a repository in scope, a title of 1 to 256 characters (trimmed)
 * and a body of at most 20,000. `draft_issue` and the page's follow-up form both use it, so a tool's
 * and a page's proposal are checked alike.
 */
export function issueProposal(github: Pick<GitHubAccess, "checkRepository">, input: Record<string, unknown>): Proposal {
	let repository: string;
	try {
		repository = github.checkRepository(input.repository);
	} catch (error) {
		throw new OperationError(404, (error as Error).message);
	}
	const title = typeof input.title === "string" ? input.title.trim() : "";
	if (!title || title.length > TITLE_MAX) throw new OperationError(400, `A title needs 1 to ${TITLE_MAX} characters.`);
	if (typeof input.body !== "string" || input.body.length > BODY_MAX) throw new OperationError(400, `A body has at most ${BODY_MAX} characters.`);
	return { action: "create_issue", target: repository, title, body: input.body };
}

/** One user's tools over their GitHub access. `show` is the host's; without it no card is shown. */
export function githubTools(github: GitHubAccess, propose: Propose, show?: Show): UserTools {
	const repositories = [...new Set(github.projects.map((p) => p.repository))].sort();
	const projects = github.projects.map((p) => `- ${p.repository} (Project ${p.owner}/${p.number})`).join("\n");
	return {
		tools: tools(github, propose, show),
		prompt: `GitHub scope (nothing else can be read):\n${projects}`,
		labels: {
			portfolio_overview: { label: () => "Read all configured Projects", detail: (result) => (result.startsWith("Captured") ? result.split("\n")[0].replace(/\s*\(closed items omitted\)\.?/, "") : "") },
			read_issue: { label: (a) => `Read ${a.repository}#${a.number}` },
			search_issues: { label: (a) => `Searched ${a.repository ?? "all repositories"} for “${a.query}”` },
			draft_issue: { label: (a) => `Drafted an issue for ${a.repository}` },
		},
		writes: {
			create_issue: {
				async execute(proposal) {
					try {
						const issue = await github.createIssue(proposal.target, { title: proposal.title, body: proposal.body });
						return { status: "created", url: issue.url, number: issue.number };
					} catch (error) {
						return { status: error instanceof WriteRejected ? "failed" : "unknown", error: String((error as Error).message) };
					}
				},
				checkUrl: (proposal) => `https://github.com/${proposal.target}/issues?q=${encodeURIComponent("is:issue sort:created-desc")}`,
			},
		},
		operations: operations(github),
		proposals: { create_issue: (input) => issueProposal(github, input) },
		scope: { label: `${github.projects.length} Projects`, detail: repositories.map((r) => r.split("/")[1]).join(", ") },
	};
}

function tools(github: GitHubAccess, propose: Propose, show: Show | undefined) {
	return [
		defineTool({
			name: "portfolio_overview",
			label: "Projects overview",
			description: "Read every open issue and pull request in the configured repositories with Project status, priority, size, labels, parent, blockers, last update and deterministic findings (stale, missing fields, open blockers). Takes about 20 seconds.",
			parameters: Type.Object({}),
			execute: async () => text(await github.overview()),
		}),
		defineTool({
			name: "read_issue",
			label: "Read issue",
			description: "Read one issue with its body and recent comments.",
			parameters: Type.Object({ repository: Type.String({ description: "owner/name" }), number: Type.Integer({ minimum: 1 }) }),
			execute: async (toolCallId, args, _signal, _onUpdate, ctx) => {
				const read = await github.issue(args.repository, args.number);
				const card = issueCard(read.repository, read.issue);
				if (card) show?.(toolCallId, ctx, card);
				return text(formatIssue(read.repository, read.issue));
			},
		}),
		defineTool({
			name: "search_issues",
			label: "Search issues",
			description: "Search issues and pull requests by words in the configured repositories, optionally one repository.",
			parameters: Type.Object({ query: Type.String({ maxLength: 200 }), repository: Type.Optional(Type.String({ description: "owner/name" })) }),
			execute: async (_id, args) => text(await github.searchIssues(args.query, args.repository)),
		}),
		defineTool({
			name: "draft_issue",
			label: "Draft issue",
			description: "Propose a new issue in a configured repository. Shows the user a card with the exact repository, title and body; they create or dismiss it. Does not create anything.",
			parameters: Type.Object({
				repository: Type.String({ description: "owner/name" }),
				title: Type.String({ minLength: 1, maxLength: TITLE_MAX }),
				body: Type.String({ maxLength: BODY_MAX, description: "GitHub Markdown" }),
			}),
			execute: async (toolCallId, args, _signal, _onUpdate, ctx) => {
				const proposal = issueProposal(github, args);
				propose(toolCallId, ctx, proposal);
				return text(`Draft for ${proposal.target} shown to the user with Create and Dismiss. It is not created unless they approve it.`);
			},
		}),
	];
}

export default defineToolPackage<GitHubSettings, GitHubUserSettings>({
	name: "github",
	// Built by `npm run build` from browser/src into browser/dist.
	browser: {
		dir: new URL("../browser/", import.meta.url).href,
		entry: "dist/index.js",
		styles: ["github.css"],
		cards: ["issue"],
		pages: { home: { title: "GitHub" }, issue: { title: "Issue" } },
		nav: { label: "GitHub", page: "home" },
	},
	forUser({ user, settings, userSettings, cacheDir, propose, show }) {
		if (userSettings === undefined) return undefined;
		if (typeof settings?.piClean !== "string") throw new Error("extensions @paca/extension-github: piClean must be the absolute path of a pi-clean checkout");
		const token = checkUserSettings(user.id, userSettings);
		const github = createGitHub({ projects: userSettings.projects, piClean: settings.piClean, dataDir: cacheDir, token });
		return githubTools(github, propose, show);
	},
});

export { createGitHub, EvidenceUnavailable, formatOverview, WriteRejected, WriteUnknown } from "./github.ts";
