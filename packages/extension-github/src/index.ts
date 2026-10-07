// Scoped GitHub tools for one user: a Projects overview, issue reads and search, and issue drafts
// the user approves. Each user brings their own repository scope and credential. How to rank work
// or phrase answers is the host's persona, not part of these tools.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, section } from "@earendil-works/pi-durable";
import { defineToolPackage, type Propose, type UserTools } from "@paca/extension";
import { createGitHub, type GitHub, type Project, WriteRejected } from "./github.ts";

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
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

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
export type GitHubAccess = Pick<GitHub, "projects" | "checkRepository" | "overview" | "readIssue" | "searchIssues" | "createIssue">;

/** One user's tools over their GitHub access. */
export function githubTools(github: GitHubAccess, propose: Propose): UserTools {
	const repositories = [...new Set(github.projects.map((p) => p.repository))].sort();
	const projects = github.projects.map((p) => `- ${p.repository} (Project ${p.owner}/${p.number})`).join("\n");
	return {
		tools: tools(github, propose),
		sections: [section("github-scope", () => `GitHub scope (nothing else can be read):\n${projects}`, { tag: false })],
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
						const issue = await github.createIssue(proposal.repository, { title: proposal.title, body: proposal.body });
						return { status: "created", url: issue.url, number: issue.number };
					} catch (error) {
						return { status: error instanceof WriteRejected ? "failed" : "unknown", error: String((error as Error).message) };
					}
				},
				checkUrl: (proposal) => `https://github.com/${proposal.repository}/issues?q=${encodeURIComponent("is:issue sort:created-desc")}`,
			},
		},
		scope: { label: `${github.projects.length} Projects`, detail: repositories.map((r) => r.split("/")[1]).join(", ") },
	};
}

function tools(github: GitHubAccess, propose: Propose) {
	return [
		defineTool({
			name: "portfolio_overview",
			description: "Read every open issue and pull request in the configured repositories with Project status, priority, size, labels, parent, blockers, last update and deterministic findings (stale, missing fields, open blockers). Takes about 20 seconds.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => text(await github.overview()),
		}),
		defineTool({
			name: "read_issue",
			description: "Read one issue with its body and recent comments.",
			parameters: Type.Object({ repository: Type.String({ description: "owner/name" }), number: Type.Integer({ minimum: 1 }) }),
			replay: "safe",
			execute: async (args) => text(await github.readIssue(args.repository, args.number)),
		}),
		defineTool({
			name: "search_issues",
			description: "Search issues and pull requests by words in the configured repositories, optionally one repository.",
			parameters: Type.Object({ query: Type.String({ maxLength: 200 }), repository: Type.Optional(Type.String({ description: "owner/name" })) }),
			replay: "safe",
			execute: async (args) => text(await github.searchIssues(args.query, args.repository)),
		}),
		defineTool({
			name: "draft_issue",
			description: "Propose a new issue in a configured repository. Shows the user a card with the exact repository, title and body; they create or dismiss it. Does not create anything.",
			parameters: Type.Object({
				repository: Type.String({ description: "owner/name" }),
				title: Type.String({ minLength: 1, maxLength: TITLE_MAX }),
				body: Type.String({ maxLength: BODY_MAX, description: "GitHub Markdown" }),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const repository = github.checkRepository(args.repository);
				const title = args.title.trim();
				if (!title) throw new Error("title must not be empty");
				await propose(api, context, { action: "create_issue", repository, title, body: args.body });
				return text(`Draft for ${repository} shown to the user with Create and Dismiss. It is not created unless they approve it.`);
			},
		}),
	];
}

export default defineToolPackage<GitHubSettings, GitHubUserSettings>({
	name: "github",
	forUser({ user, settings, userSettings, cacheDir, propose }) {
		if (userSettings === undefined) return undefined;
		if (typeof settings?.piClean !== "string") throw new Error("extensions @paca/extension-github: piClean must be the absolute path of a pi-clean checkout");
		const token = checkUserSettings(user.id, userSettings);
		const github = createGitHub({ projects: userSettings.projects, piClean: settings.piClean, dataDir: cacheDir, token });
		return githubTools(github, propose);
	},
});

export { createGitHub, EvidenceUnavailable, formatOverview, WriteRejected, WriteUnknown } from "./github.ts";
