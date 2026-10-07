// One user's Paca conversation: a Pi Durable harness with Paca's own extension (persona prompt and
// per-answer limits) and one extension per tool package enabled for this user. No coding tools or
// execution environment are installed, so the model can only call the packages' tools. Tools can
// propose a write; only the user's approval, through approveDraft, performs it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, GenerationTask, Harness, hook, section, type Storage, ToolTask } from "@earendil-works/pi-durable";
import type { Proposal, Propose, UserTools, WriteAction, WriteOutcome } from "@paca/extension";
import type { DraftStatus } from "@paca/contracts";
import { persona } from "./persona.ts";

export const LIMITS = { modelRequests: 12, toolCalls: 30, durationMs: 3 * 60_000 };
export type Limits = typeof LIMITS;
const ctx = BACKGROUND_CONTEXT;

export class LimitReached extends Error {}

/**
 * A stored draft. Drafts written before tool packages have no `action`; they are GitHub issue drafts.
 * `repository` holds the proposal's target, whatever the action; the name is kept so stored drafts
 * keep their format.
 */
export type StoredDraft = {
	id: string;
	action?: string;
	repository: string;
	title: string;
	body: string;
	expect?: Record<string, string>;
	status: DraftStatus;
	createdAt: string;
	decidedAt?: string;
	number?: number;
	url?: string;
	error?: string;
};
export const LEGACY_ACTION = "github.create_issue";

/**
 * Drafts by id (the tool call that made them). Status: proposed, then created, failed, unknown or
 * dismissed; "creating" holds the claim while the one write runs. Content never changes after the
 * draft is made, so approval writes exactly what the card showed.
 */
export const Drafts = defineDoc<{ items: Record<string, StoredDraft> }>({ kind: "paca.drafts", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ items: {} }) });

/** The `propose` a package's tools get: stores the proposal as a draft of this conversation. */
export function proposeFor(packageName: string): Propose {
	return async (api, context, proposal) => {
		await api.commit(async (tx) => {
			const drafts = await tx.doc(Drafts, api.conversationId);
			// Keyed by the call, so a replayed call finds its draft instead of making another.
			drafts.items[api.callId] ??= {
				id: api.callId,
				action: `${packageName}.${proposal.action}`,
				repository: proposal.target,
				title: proposal.title,
				body: proposal.body,
				...(proposal.expect ? { expect: { ...proposal.expect } } : {}),
				status: "proposed",
				createdAt: new Date().toISOString(),
			};
		}, context);
	};
}

/** A tool package's tools for this user, under the package's name. */
export interface PackageTools {
	name: string;
	tools: UserTools;
}

export interface OpenPacaOptions {
	storage: Storage;
	/** Pi's ModelRuntime in production. */
	models: Models;
	model: { provider: string; modelId: string };
	packages: PackageTools[];
	limits?: Limits;
}

export type Paca = Awaited<ReturnType<typeof openPaca>>;

export async function openPaca({ storage, models, model, packages, limits = LIMITS }: OpenPacaOptions) {
	const allowedTools = new Set(packages.flatMap((p) => p.tools.tools.map((t) => t.name)));
	const writes = new Map<string, WriteAction>();
	for (const p of packages) for (const [name, action] of Object.entries(p.tools.writes ?? {})) writes.set(`${p.name}.${name}`, action);
	const actionOf = (draft: StoredDraft) => writes.get(draft.action ?? LEGACY_ACTION);
	// A plain copy: inside a commit, the draft is the transaction's view and ends with it.
	const proposalOf = (draft: StoredDraft): Proposal => ({ action: draft.action ?? LEGACY_ACTION, target: draft.repository, title: draft.title, body: draft.body, ...(draft.expect ? { expect: { ...draft.expect } } : {}) });
	// Counters for the run in progress; one conversation, one run at a time.
	let run: { active: boolean; requests: number; tools: number; stopReason?: string; timer?: NodeJS.Timeout; settled?: Promise<unknown> } = { active: false, requests: 0, tools: 0 };

	const Host = defineExtension({
		name: "paca",
		sections: [section("paca", () => persona(packages.map((p) => p.name)), { tag: false })],
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
	const extensions = [Host, ...packages.map((p) => defineExtension({ name: p.name, tools: p.tools.tools, sections: p.tools.sections }))];

	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	const harness = await Harness.open(storage, { models, registry, settings: { extensions, stream: { timeoutMs: 120_000 }, retry: { maxRetries: 2 } } }, ctx);
	const root = await harness.root(ctx, { agent: { model } });
	await root.configure({ model, extensions }, ctx);

	// A write that was claimed but never recorded may or may not have happened. Say so; never resend.
	await root.commit(async (tx) => {
		const drafts = await tx.doc(Drafts, root.id);
		for (const draft of Object.values(drafts.items)) {
			if (draft.status === "creating") Object.assign(draft, { status: "unknown", error: "Paca restarted before it recorded the outcome." });
		}
	}, ctx);

	// A run left over from a crash would resume and spend again without its limits; end it instead.
	const initial = await root.viewState(ctx);
	const leftover = (initial.value.docs["pi.live"] as { run?: unknown } | undefined)?.run !== undefined;
	initial.dispose();
	if (leftover) {
		await root.abort(ctx);
		await root.submit({ type: "write", entry: { kind: "paca.notice", data: { text: "This answer was interrupted because Paca restarted. Ask again to continue." } } }, ctx);
	}

	// Ends the running answer and records why in the transcript, so every client sees it.
	function stop(reason: string) {
		if (!run.active || run.stopReason !== undefined) return;
		run.stopReason = reason;
		root
			.abort(ctx)
			.then(() => root.submit({ type: "write", entry: { kind: "paca.notice", data: { text: reason } } }, ctx))
			.catch((error) => console.error("paca: stop failed", error));
	}

	/** Admit one question. The same requestId never submits twice, across reconnects and restarts. */
	async function ask(content: string, requestId: string) {
		const submission = await root.submit({ type: "input", content, requestId, whenBusy: "reject" }, ctx);
		// While a run is active a new input is rejected as busy, so anything returned here is a duplicate.
		if (run.active) return { id: submission.id, duplicate: true };
		const record = await submission.status(ctx);
		if (record.status !== "queued" && record.status !== "placed") return { id: submission.id, duplicate: true };
		const current: typeof run = { active: true, requests: 0, tools: 0 };
		run = current;
		current.timer = setTimeout(() => stop(`Stopped after ${limits.durationMs / 60_000} minutes, the limit for one answer.`), limits.durationMs);
		current.timer.unref?.();
		const settled = submission.wait(ctx).finally(() => {
			clearTimeout(current.timer);
			current.active = false;
		});
		current.settled = settled;
		settled.catch(() => {}); // the web server never awaits it; closing rejects it
		return { id: submission.id, duplicate: false, settled };
	}

	const setDraft = (id: string, change: Partial<StoredDraft>) =>
		root.commit(async (tx) => {
			Object.assign((await tx.doc(Drafts, root.id)).items[id], change);
		}, ctx);

	/**
	 * Performs the stored draft with its package's write action. The claim (proposed -> creating) is
	 * one commit on the harness's single commit line, so repeated or concurrent approvals find it
	 * already claimed.
	 */
	async function approveDraft(id: string): Promise<{ refused: string } | { status: DraftStatus; url?: string }> {
		const claim = await root.commit(async (tx) => {
			const draft = (await tx.doc(Drafts, root.id)).items[id];
			if (!draft) return { refused: "not-found" } as const;
			if (draft.status !== "proposed") return { refused: draft.status } as const;
			const action = actionOf(draft);
			if (!action) return { refused: "unavailable" } as const;
			draft.status = "creating";
			draft.decidedAt = new Date().toISOString();
			return { action, proposal: proposalOf(draft) };
		}, ctx);
		if (!claim.action) return { refused: claim.refused };
		let outcome: WriteOutcome;
		try {
			outcome = await claim.action.execute(claim.proposal);
		} catch (error) {
			outcome = { status: "unknown", error: String((error as Error)?.message ?? error) };
		}
		if (outcome.status === "created") {
			await setDraft(id, outcome.url ? { status: "created", number: outcome.number, url: outcome.url } : { status: "created" });
			return outcome.url ? { status: "created", url: outcome.url } : { status: "created" };
		}
		await setDraft(id, { status: outcome.status, error: outcome.error.slice(0, 300) });
		return { status: outcome.status };
	}

	async function dismissDraft(id: string) {
		return root.commit(async (tx) => {
			const draft = (await tx.doc(Drafts, root.id)).items[id];
			if (!draft) return { refused: "not-found" };
			if (draft.status !== "proposed") return { refused: draft.status };
			draft.status = "dismissed";
			draft.decidedAt = new Date().toISOString();
			return { status: "dismissed" };
		}, ctx);
	}

	/** How the page names tool calls and where it sends the user to check an unknown write. */
	const describe = {
		labels: Object.assign({}, ...packages.map((p) => p.tools.labels)) as UserTools["labels"],
		checkUrl: (draft: StoredDraft) => actionOf(draft)?.checkUrl?.(proposalOf(draft)),
	};

	return {
		harness,
		root,
		ask,
		approveDraft,
		dismissDraft,
		describe,
		/** The drafts document as live state; openPaca's first commit created it. */
		draftsState: async () => (await harness.documentState(Drafts, root.id, ctx)) ?? Promise.reject(new Error("drafts document missing")),
		stop: () => stop("Stopped by you."),
		busy: () => run.active,
		stopReason: () => run.stopReason,
		close: () => harness.close(ctx),
	};
}
