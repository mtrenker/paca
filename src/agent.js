// The Paca conversation: a Pi Durable harness with one extension holding the prompt, the
// read-only GitHub tools and the per-answer limits. No coding tools or execution environment
// are installed, so the model can only call the tools defined here.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";

export const LIMITS = { modelRequests: 12, toolCalls: 30, durationMs: 3 * 60_000 };
const ctx = BACKGROUND_CONTEXT;

export class LimitReached extends Error {}

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
- This version is read-only. You cannot create, edit or reprioritize issues. When a change would help, state the exact change you would propose so Martin can decide.

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

	return {
		harness,
		root,
		ask,
		stop: () => stop("Stopped by you."),
		busy: () => run.active,
		stopReason: () => run.stopReason,
		close: () => harness.close(ctx),
	};
}
