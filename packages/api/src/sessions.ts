// One user's sessions: start, ask, Stop, resume, delete, and the drafts they propose. Each session
// is a Pi session file with one AgentSession while it is in use; the list, request ids, drafts and
// deletion state are in the user's store (store.ts). Every check that must not interleave with
// another (admission, claim, the delete mark) runs without an await between reading and writing.
// See docs/design/multi-session.md.
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type AgentSession, type ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { DraftStatus, PageState, SessionSummary } from "@paca/contracts";
import type { Propose, UserTools, WriteAction, WriteOutcome } from "@paca/extension";
import { interrupted, LIMITS, type Limits, NOTICE, openAgent, type PackageTools, type Run } from "./agent.ts";
import { createFeed, type Feed } from "./feed.ts";
import type { Store, StoredDraft } from "./store.ts";
import { type Describe, uiState } from "./view.ts";

/** A session id: a lowercase UUID v4, made by the page. The only client value that names a file. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TITLE_MAX = 120;

export interface SessionsOptions {
	/** users/<id>: paca.db, sessions/, pi/ and legacy/ live here. */
	userDir: string;
	store: Store;
	modelRuntime: ModelRuntime;
	model: Model<any>;
	/** The user's package tools, given the `propose` that stores a package's drafts in this store. */
	tools: (proposeFor: (packageName: string) => Propose) => PackageTools[];
	limits?: Limits;
	/** Removes one file; a missing file counts as removed. Tests hold or fail it. */
	removeFile?: (path: string) => Promise<void>;
	log?: Pick<Console, "log" | "error">;
}

/** A session in use: its AgentSession once opened, and the answer in progress. */
interface Live {
	/** The manager a start made, until the AgentSession opens with it. */
	created?: SessionManager;
	agent?: Promise<AgentSession>;
	session?: AgentSession;
	busy: boolean;
	run?: Run & { timer?: NodeJS.Timeout };
	retry?: string;
	/** Why the session could not be opened, shown on the page until an open succeeds. */
	error?: string;
	feed: Feed<PageState>;
}

export type Refused<R extends string> = { refused: R };
export type Sessions = Awaited<ReturnType<typeof openSessions>>;

const removeIfPresent = (path: string) => rm(path, { force: true });

export async function openSessions({ userDir, store, modelRuntime, model, tools: toolsOf, limits = LIMITS, removeFile = removeIfPresent, log = console }: SessionsOptions) {
	const sessionsDir = join(userDir, "sessions");
	const piDir = join(userDir, "pi");
	for (const dir of [sessionsDir, piDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lives = new Map<string, Live>();
	/** Deletions in progress, by session id. */
	const deletions = new Map<string, Promise<void>>();

	// Drafts are stored under the session the calling tool runs in. Pi's session id is Paca's.
	const proposeFor = (packageName: string): Propose => (toolCallId, ctx, proposal) => {
		const sessionId = ctx.sessionManager.getSessionId();
		store.propose({ id: toolCallId, sessionId, action: `${packageName}.${proposal.action}`, repository: proposal.repository, title: proposal.title, body: proposal.body });
		changed(sessionId);
	};
	const packages = toolsOf(proposeFor);
	const writes = new Map<string, WriteAction>();
	for (const p of packages) for (const [name, action] of Object.entries(p.tools.writes ?? {})) writes.set(`${p.name}.${name}`, action);
	const proposalOf = (d: StoredDraft) => ({ action: d.action, repository: d.repository, title: d.title, body: d.body });
	const describe: Describe = {
		labels: Object.assign({}, ...packages.map((p) => p.tools.labels)) as UserTools["labels"],
		checkUrl: (draft) => writes.get(draft.action)?.checkUrl(proposalOf(draft)),
	};

	const list = createFeed<SessionSummary[]>(() =>
		store.list().map((s) => ({ id: s.id, title: s.title, running: lives.get(s.id)?.busy ?? false, waiting: s.waiting, lastActivity: s.lastActivity })),
	);
	function liveOf(id: string): Live {
		let live = lives.get(id);
		if (!live) {
			const created: Live = {
				busy: false,
				feed: createFeed(() =>
					uiState(created.session?.sessionManager.getBranch() ?? [], { running: created.busy, partial: created.session?.state.streamingMessage, retry: created.retry, error: created.error, drafts: store.drafts(id), describe }),
				),
			};
			live = created;
			lives.set(id, live);
		}
		return live;
	}
	function changed(id: string) {
		lives.get(id)?.feed.changed();
		list.changed();
	}

	/** Opens the session's AgentSession once; later callers get the same one. */
	function open(id: string, live: Live): Promise<AgentSession> {
		const opening = (live.agent ??= (async () => {
			const row = store.session(id);
			if (!row) throw new Error(`session ${id} has no row`);
			const file = join(userDir, row.file);
			// A row whose first question never reached the file opens as an empty session.
			const manager = live.created ?? (existsSync(file) ? SessionManager.open(file, sessionsDir, piDir) : SessionManager.create(piDir, sessionsDir, { id }));
			if (manager.getSessionId() !== id) throw new Error(`${file} holds session ${manager.getSessionId()}, not ${id}`);
			const path = relative(userDir, manager.getSessionFile()!);
			if (path !== row.file) store.setFile(id, path);
			const session = await openAgent({ dir: piDir, sessionManager: manager, modelRuntime, model, packages, limits, run: () => live.run });
			session.subscribe((event) => {
				if (event.type === "auto_retry_start") live.retry = `Retrying after: ${event.errorMessage}`;
				if (event.type === "auto_retry_end" || event.type === "agent_end") live.retry = undefined;
				live.feed.changed();
			});
			if (interrupted(manager.getBranch())) await notice(session, "This answer was interrupted because Paca restarted. Ask again to continue.");
			live.session = session;
			live.created = undefined;
			live.error = undefined;
			return session;
		})());
		// A failed open can be tried again; until then the page says why, and the log has the detail.
		opening.catch((error) => {
			if (live.agent !== opening) return;
			live.agent = undefined;
			live.error = `Paca could not open this session: ${(error as Error)?.message ?? error}`;
			log.error(`paca: session ${id}: ${live.error}`);
			live.feed.changed();
		});
		return opening;
	}

	const notice = (session: AgentSession, text: string) => session.sendCustomMessage({ customType: NOTICE, content: text, display: true });

	/** Sets the session busy and starts the answer. Synchronous up to `prompt`, which runs on. */
	function begin(id: string, text: string, requestId: string) {
		const live = liveOf(id);
		live.busy = true;
		const run: NonNullable<Live["run"]> = {
			requests: 0,
			tools: 0,
			stop(reason) {
				if (run.stopReason !== undefined || live.run !== run) return;
				run.stopReason = reason;
				live.session?.abort().catch((error) => log.error("paca: stop failed", error));
			},
		};
		live.run = run;
		changed(id);
		void answer(id, live, run, text, requestId);
	}

	async function answer(id: string, live: Live, run: NonNullable<Live["run"]>, text: string, requestId: string) {
		let session: AgentSession | undefined;
		let failed: string | undefined;
		try {
			session = await open(id, live);
			run.timer = setTimeout(() => run.stop(`Stopped after ${limits.durationMs / 60_000} minutes, the limit for one answer.`), limits.durationMs);
			run.timer.unref?.();
			await session.prompt(text, { expandPromptTemplates: false });
		} catch (error) {
			// Opening failed (logged and shown by open()), or prompt() threw, which it does only before
			// the question is in the transcript (no credential, compacting). Either way it can be asked again.
			if (session) failed = String((error as Error)?.message ?? error);
			if (failed) log.error(`paca: session ${id}: ${failed}`);
			store.forgetRequest(id, requestId);
		} finally {
			clearTimeout(run.timer);
			const reason = failed ? `Paca could not answer: ${failed}` : run.stopReason;
			if (session && reason) await notice(session, reason).catch((error) => log.error("paca: notice failed", error));
			live.run = undefined;
			live.busy = false;
			store.touch(id);
			changed(id);
		}
	}

	/** Why a claim or dismissal changed nothing: decided already, or the session is being deleted. */
	function refusal(id: string, draftId: string): Refused<string> {
		if (store.session(id)?.state !== "active") return { refused: "not-found" };
		return { refused: store.draft(id, draftId)?.status ?? "not-found" };
	}

	function busy(id: string) {
		const live = lives.get(id);
		return Boolean(live?.busy || live?.session?.isCompacting);
	}

	/**
	 * Steps after the delete mark. A delete that arrives while they run joins them instead of running
	 * its own, so no cleanup outlives the id's reservation and touches a session created again under
	 * it. After a failure nothing is running, and the next delete or start runs them again; each step
	 * is idempotent.
	 */
	function finishDelete(id: string): Promise<void> {
		let running = deletions.get(id);
		if (!running) {
			running = deleteSteps(id).finally(() => deletions.delete(id));
			deletions.set(id, running);
		}
		return running;
	}

	async function deleteSteps(id: string) {
		const row = store.session(id);
		if (!row) return;
		const live = lives.get(id);
		live?.feed.end(); // open streams get `gone`
		const session = await live?.agent?.catch(() => undefined);
		if (session) {
			await session.abort();
			// After dispose nothing writes the file again, so removing it is final.
			session.dispose();
		}
		if (lives.get(id) === live) lives.delete(id);
		await removeFile(join(userDir, row.file));
		if (row.legacyFile) for (const suffix of ["", "-wal", "-shm"]) await removeFile(join(userDir, row.legacyFile + suffix));
		store.deleteRows(id);
		list.changed();
	}

	// Start-up: a write claimed before a restart is unknown, and deletions the user asked for finish.
	store.recoverCreating();
	for (const row of store.deleting()) {
		await finishDelete(row.id).catch((error) => log.error(`paca: could not finish deleting session ${row.id}`, error));
	}

	return {
		list,
		/** A new session with its first question. The same id and request again is a duplicate. */
		start(id: string, text: string, requestId: string): { duplicate: boolean } | Refused<"deleting" | "exists"> {
			const row = store.session(id);
			if (row?.state === "deleting") return { refused: "deleting" };
			if (row) return store.hasRequest(id, requestId) ? { duplicate: true } : { refused: "exists" };
			// The file appears with the first message; until then the id is reserved by its row.
			const manager = SessionManager.create(piDir, sessionsDir, { id });
			if (!store.create({ id, file: relative(userDir, manager.getSessionFile()!), title: text.slice(0, TITLE_MAX) }, requestId)) return { refused: "exists" };
			liveOf(id).created = manager;
			begin(id, text, requestId);
			return { duplicate: false };
		},
		/** A question to a saved session. A repeated request id is answered once. */
		ask(id: string, text: string, requestId: string): { duplicate: boolean } | Refused<"not-found" | "busy"> {
			if (store.session(id)?.state !== "active") return { refused: "not-found" };
			if (store.hasRequest(id, requestId)) return { duplicate: true };
			if (busy(id)) return { refused: "busy" };
			// The statement decides; the reads above only choose the answer to a refusal.
			if (!store.admit(id, requestId)) return { refused: "not-found" };
			begin(id, text, requestId);
			return { duplicate: false };
		},
		stop(id: string): {} | Refused<"not-found"> {
			if (store.session(id)?.state !== "active") return { refused: "not-found" };
			lives.get(id)?.run?.stop("Stopped by you.");
			return {};
		},
		/** The session's page state, opening it on first use; undefined for an id that is not this user's. */
		async watch(id: string): Promise<Feed<PageState> | undefined> {
			if (store.session(id)?.state !== "active") return undefined;
			const live = liveOf(id);
			// A session that cannot be opened is still shown, with the reason (open() records it).
			await open(id, live).catch(() => {});
			return live.feed;
		},
		/**
		 * Permanently deletes a session: its file, any retained legacy copy and its rows. Refused while
		 * it answers or creates an issue. Throws if a file cannot be removed; the session stays marked
		 * and the next delete or start finishes it. Never calls GitHub.
		 */
		async remove(id: string): Promise<{ deleted: true } | Refused<"not-found" | "busy" | "creating">> {
			const row = store.session(id);
			if (!row) return { refused: "not-found" };
			if (row.state === "active") {
				if (busy(id)) return { refused: "busy" };
				if (!store.markDeleting(id)) return { refused: "creating" };
				list.changed();
			}
			await finishDelete(id);
			return { deleted: true };
		},
		/** Performs the stored draft with its package's write action, once. */
		async approveDraft(id: string, draftId: string): Promise<{ status: DraftStatus; url?: string } | Refused<string>> {
			if (store.session(id)?.state !== "active") return { refused: "not-found" };
			const draft = store.draft(id, draftId);
			if (!draft) return { refused: "not-found" };
			if (draft.status !== "proposed") return { refused: draft.status };
			const action = writes.get(draft.action);
			if (!action) return { refused: "unavailable" };
			if (!store.claim(id, draftId)) return refusal(id, draftId);
			changed(id);
			let outcome: WriteOutcome;
			try {
				outcome = await action.execute(proposalOf(draft));
			} catch (error) {
				outcome = { status: "unknown", error: String((error as Error)?.message ?? error) };
			}
			if (outcome.status === "created") store.settle(id, draftId, { status: "created", number: outcome.number, url: outcome.url });
			else store.settle(id, draftId, { status: outcome.status, error: outcome.error.slice(0, 300) });
			changed(id);
			return outcome.status === "created" ? { status: "created", url: outcome.url } : { status: outcome.status };
		},
		dismissDraft(id: string, draftId: string): { status: "dismissed" } | Refused<string> {
			if (store.session(id)?.state !== "active") return { refused: "not-found" };
			const draft = store.draft(id, draftId);
			if (!draft) return { refused: "not-found" };
			if (!store.dismiss(id, draftId)) return refusal(id, draftId);
			changed(id);
			return { status: "dismissed" };
		},
		/** The model only sees these tools; tests read them to pin isolation. */
		packages,
		/** The open AgentSession of a session, if any. For tests and diagnosis. */
		agentOf: (id: string) => lives.get(id)?.session,
		busy,
		async close() {
			list.dispose();
			for (const live of lives.values()) live.feed.dispose();
			const opened = await Promise.all([...lives.values()].map((l) => l.agent?.catch(() => undefined)));
			for (const session of opened) session?.dispose();
			store.close();
		},
	};
}
