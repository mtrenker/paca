// The Paca conversation: a Pi Durable harness with one extension holding the prompt, the GitHub
// tools and the per-answer limits. No coding tools or execution environment are installed, so the
// model can only call the tools defined here. The model can draft an issue; only Martin's approval,
// through approveDraft, creates it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, GenerationTask, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { WriteRejected } from "./github.js";

export const LIMITS = { modelRequests: 12, toolCalls: 30, durationMs: 3 * 60_000 };
const ctx = BACKGROUND_CONTEXT;

export class LimitReached extends Error {}

/**
 * Issue drafts by id (the tool call that made them). Status: proposed, then created, failed,
 * unknown or dismissed; "creating" holds the claim while the one GitHub call runs. Content never
 * changes after the draft is made, so approval creates exactly what the card showed.
 */
export const Drafts = defineDoc({ kind: "paca.drafts", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: {} }) });
const TITLE_MAX = 256;
const BODY_MAX = 20_000;

function prompt(github) {
	const projects = github.projects.map((p) => `- ${p.repository} (Project ${p.owner}/${p.number})`).join("\n");
	return `You are Paca, Martin's assistant for the GitHub issues and Projects of his own repositories.

Scope (nothing else can be read):
${projects}

How to work:
- Ground every statement about issues in tool results. Never invent issue numbers, titles, states, priorities or links.
- For broad questions start with portfolio_overview. Use read_issue before recommending something specific about one issue, and search_issues to find issues by words.
- If a tool fails or reports UNAVAILABLE evidence, say exactly what could not be read. Missing data never means an empty or healthy project.
- When ranking what needs attention, weigh: urgent or active work (P0/P1, in progress, in review) that is blocked or stale; open pull requests; Ready items missing priority or size; unclear or contradictory readiness; untriaged Inbox items. Give the reason in one short clause.
- You cannot change GitHub yourself. To propose a new issue, call draft_issue: Martin sees the exact repository, title and body on a card and decides whether to create it. Until the card says so, nothing is created; never claim otherwise. Draft only when Martin asks for an issue or agrees to one.
- A good issue body is short: the outcome, the next useful step and where it stops, how to check it, and what is left out. Link related issues instead of repeating them.
- Editing existing issues, labels and Project priority are not available yet. When such a change would help, state the exact change so Martin can make it.

How to answer (Martin often reads on a phone):
- Lead with a short ranked list of at most 7 items. Each item: [owner/repo#number title](url), its status and priority, why it needs attention, and the next step.
- End with one line saying what you read, including the capture time.
- Use only headings, lists, bold, inline code and links. No tables, HTML or images.`;
}

function tools(github) {
	const text = (t) => ({ content: [{ type: "text", text: t }] });
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
			description: "Propose a new issue in a configured repository. Shows Martin a card with the exact repository, title and body; he creates or dismisses it. Does not create anything.",
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
				await api.commit(async (tx) => {
					const drafts = await tx.doc(Drafts, api.conversationId);
					// Keyed by the call, so a replayed call finds its draft instead of making another.
					drafts.items[api.callId] ??= { id: api.callId, repository, title, body: args.body, status: "proposed", createdAt: new Date().toISOString() };
				}, context);
				return text(`Draft for ${repository} shown to Martin with Create and Dismiss. It is not created unless he approves it.`);
			},
		}),
	];
}

/**
 * @param {object} options
 * @param {import("@earendil-works/pi-durable").Storage} options.storage
 * @param {import("@earendil-works/pi-ai").Models} options.models Pi's ModelRuntime in production
 * @param {{ provider: string, modelId: string }} options.model
 * @param {ReturnType<import("./github.js").createGitHub>} options.github
 */
export async function openPaca({ storage, models, model, github, limits = LIMITS }) {
	const toolList = tools(github);
	const allowedTools = new Set(toolList.map((t) => t.name));
	// Counters for the run in progress; one conversation, one run at a time.
	let run = { active: false, requests: 0, tools: 0, stopReason: undefined, timer: undefined };

	const Paca = defineExtension({
		name: "paca",
		sections: [section("paca", () => prompt(github), { tag: false })],
		tools: toolList,
		hooks: [
			hook(GenerationTask, {
				beforeRequest: () => {
					run.requests += 1;
					if (run.requests > limits.modelRequests) {
						stop(`Stopped after ${limits.modelRequests} model requests, the limit for one answer.`);
						throw new LimitReached("model request limit reached");
					}
					return undefined;
				},
			}),
			hook(ToolTask, {
				beforeTool: (call) => {
					if (!allowedTools.has(call.name)) return { block: `Tool ${call.name} is not available.` };
					run.tools += 1;
					if (run.tools > limits.toolCalls) return { block: `Tool call limit of ${limits.toolCalls} for one answer reached. Answer with what you have.` };
					return undefined;
				},
			}),
		],
	});

	const registry = createRegistry();
	registry.install(Paca);
	const harness = await Harness.open(
		storage,
		{ models, registry, settings: { extensions: [Paca], stream: { timeoutMs: 120_000 }, retry: { maxRetries: 2 } } },
		ctx,
	);
	const root = await harness.root(ctx, { agent: { model } });
	await root.configure({ model, extensions: [Paca] }, ctx);

	// A create that was claimed but never recorded may or may not exist on GitHub. Say so; never resend.
	await root.commit(async (tx) => {
		const drafts = await tx.doc(Drafts, root.id);
		for (const draft of Object.values(drafts.items)) {
			if (draft.status === "creating") Object.assign(draft, { status: "unknown", error: "Paca restarted while creating this issue." });
		}
	}, ctx);

	// A run left over from a crash would resume and spend again without its limits; end it instead.
	const initial = await root.viewState(ctx);
	const leftover = initial.value.docs["pi.live"]?.run !== undefined;
	initial.dispose();
	if (leftover) {
		await root.abort(ctx);
		await root.submit({ type: "write", entry: { kind: "paca.notice", data: { text: "This answer was interrupted because Paca restarted. Ask again to continue." } } }, ctx);
	}

	// Ends the running answer and records why in the transcript, so every client sees it.
	function stop(reason) {
		if (!run.active || run.stopReason !== undefined) return;
		run.stopReason = reason;
		root
			.abort(ctx)
			.then(() => root.submit({ type: "write", entry: { kind: "paca.notice", data: { text: reason } } }, ctx))
			.catch((error) => console.error("paca: stop failed", error));
	}

	/** Admit one question. The same requestId never submits twice, across reconnects and restarts. */
	async function ask(content, requestId) {
		const submission = await root.submit({ type: "input", content, requestId, whenBusy: "reject" }, ctx);
		// While a run is active a new input is rejected as busy, so anything returned here is a duplicate.
		if (run.active) return { id: submission.id, duplicate: true };
		const record = await submission.status(ctx);
		if (record.status !== "queued" && record.status !== "placed") return { id: submission.id, duplicate: true };
		const current = { active: true, requests: 0, tools: 0, stopReason: undefined, timer: undefined };
		run = current;
		current.timer = setTimeout(() => stop(`Stopped after ${limits.durationMs / 60_000} minutes, the limit for one answer.`), limits.durationMs);
		current.timer.unref?.();
		current.settled = submission.wait(ctx).finally(() => {
			clearTimeout(current.timer);
			current.active = false;
		});
		current.settled.catch(() => {}); // the web server never awaits it; closing rejects it
		return { id: submission.id, duplicate: false, settled: current.settled };
	}

	const setDraft = (id, change) =>
		root.commit(async (tx) => {
			Object.assign((await tx.doc(Drafts, root.id)).items[id], change);
		}, ctx);

	/**
	 * Creates the stored draft on GitHub. The claim (proposed -> creating) is one commit on the
	 * harness's single commit line, so repeated or concurrent approvals find it already claimed.
	 */
	async function approveDraft(id) {
		const claim = await root.commit(async (tx) => {
			const draft = (await tx.doc(Drafts, root.id)).items[id];
			if (!draft) return { refused: "not-found" };
			if (draft.status !== "proposed") return { refused: draft.status };
			draft.status = "creating";
			draft.decidedAt = new Date().toISOString();
			return { repository: draft.repository, title: draft.title, body: draft.body };
		}, ctx);
		if (claim.refused) return claim;
		try {
			const issue = await github.createIssue(claim.repository, { title: claim.title, body: claim.body });
			await setDraft(id, { status: "created", number: issue.number, url: issue.url });
			return { status: "created", url: issue.url };
		} catch (error) {
			const status = error instanceof WriteRejected ? "failed" : "unknown";
			await setDraft(id, { status, error: String(error.message).slice(0, 300) });
			return { status };
		}
	}

	async function dismissDraft(id) {
		return root.commit(async (tx) => {
			const draft = (await tx.doc(Drafts, root.id)).items[id];
			if (!draft) return { refused: "not-found" };
			if (draft.status !== "proposed") return { refused: draft.status };
			draft.status = "dismissed";
			draft.decidedAt = new Date().toISOString();
			return { status: "dismissed" };
		}, ctx);
	}

	return {
		harness,
		root,
		ask,
		approveDraft,
		dismissDraft,
		draftsState: () => harness.documentState(Drafts, root.id, ctx),
		stop: () => stop("Stopped by you."),
		busy: () => run.active,
		stopReason: () => run.stopReason,
		close: () => harness.close(ctx),
	};
}
