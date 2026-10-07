// One user's Paca store, users/<id>/paca.db: the session list, deletion state, request ids and
// drafts. Transcripts live in one Pi session file per session (sessions/<time>_<id>.jsonl).
//
// node:sqlite is synchronous, so every method below runs to completion without an await. The
// rules that keep a write from being sent twice or lost are single statements here:
// - a question is admitted once per request id (`admit`);
// - a draft is claimed for its one write only while it is proposed and its session active (`claim`);
// - a session is marked for deletion only while no draft of it is being created (`markDeleting`).
// See docs/design/multi-session.md, "Deletion contract".
import { DatabaseSync } from "node:sqlite";
import type { DraftStatus } from "@paca/contracts";

/** A session row. `file` and `legacyFile` are relative to the user's directory. */
export interface SessionRow {
	id: string;
	file: string;
	title: string;
	createdAt: string;
	lastActivity: string;
	state: "active" | "deleting";
	/** The retained legacy store this session was converted from, if any. */
	legacyFile: string | null;
}

/** A proposed write, stored exactly as its card shows it. `id` is the tool call that made it. */
export interface StoredDraft {
	id: string;
	sessionId: string;
	action: string;
	repository: string;
	title: string;
	body: string;
	status: DraftStatus;
	createdAt: string;
	decidedAt?: string;
	number?: number;
	url?: string;
	error?: string;
}

export type Store = ReturnType<typeof openStore>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	file TEXT NOT NULL,
	title TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_activity TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting')),
	legacy_file TEXT
);
CREATE TABLE IF NOT EXISTS requests (
	session_id TEXT NOT NULL,
	request_id TEXT NOT NULL,
	PRIMARY KEY (session_id, request_id)
);
CREATE TABLE IF NOT EXISTS drafts (
	id TEXT NOT NULL,
	session_id TEXT NOT NULL,
	action TEXT NOT NULL,
	repository TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at TEXT NOT NULL,
	decided_at TEXT,
	number INTEGER,
	url TEXT,
	error TEXT,
	PRIMARY KEY (session_id, id)
);
`;

type Row = Record<string, string | number | null>;
const now = () => new Date().toISOString();

const sessionOf = (r: Row): SessionRow => ({
	id: String(r.id),
	file: String(r.file),
	title: String(r.title),
	createdAt: String(r.created_at),
	lastActivity: String(r.last_activity),
	state: r.state as SessionRow["state"],
	legacyFile: r.legacy_file === null ? null : String(r.legacy_file),
});

function draftOf(r: Row): StoredDraft {
	const draft: StoredDraft = {
		id: String(r.id),
		sessionId: String(r.session_id),
		action: String(r.action),
		repository: String(r.repository),
		title: String(r.title),
		body: String(r.body),
		status: r.status as DraftStatus,
		createdAt: String(r.created_at),
	};
	if (r.decided_at !== null) draft.decidedAt = String(r.decided_at);
	if (r.number !== null) draft.number = Number(r.number);
	if (r.url !== null) draft.url = String(r.url);
	if (r.error !== null) draft.error = String(r.error);
	return draft;
}

export function openStore(file: string) {
	const db = new DatabaseSync(file);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
	db.exec(SCHEMA);
	const one = (sql: string, ...params: (string | number | null)[]) => db.prepare(sql).get(...params) as Row | undefined;
	const all = (sql: string, ...params: (string | number | null)[]) => db.prepare(sql).all(...params) as Row[];
	const run = (sql: string, ...params: (string | number | null)[]) => db.prepare(sql).run(...params);
	const transaction = <T>(fn: () => T): T => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	};
	const insertDraft = (d: StoredDraft) =>
		run(
			"INSERT OR IGNORE INTO drafts (id, session_id, action, repository, title, body, status, created_at, decided_at, number, url, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			d.id, d.sessionId, d.action, d.repository, d.title, d.body, d.status, d.createdAt, d.decidedAt ?? null, d.number ?? null, d.url ?? null, d.error ?? null,
		);

	return {
		/** Every session, most recently active first, with how many drafts wait for a decision. */
		list(): (SessionRow & { waiting: number })[] {
			return all(
				"SELECT s.*, (SELECT count(*) FROM drafts d WHERE d.session_id = s.id AND d.status = 'proposed') AS waiting FROM sessions s WHERE s.state = 'active' ORDER BY s.last_activity DESC, s.created_at DESC",
			).map((r) => ({ ...sessionOf(r), waiting: Number(r.waiting) }));
		},
		session(id: string): SessionRow | undefined {
			const row = one("SELECT * FROM sessions WHERE id = ?", id);
			return row && sessionOf(row);
		},
		/** Rows a start must finish deleting. */
		deleting: () => all("SELECT * FROM sessions WHERE state = 'deleting'").map(sessionOf),
		legacyFiles: () => new Set(all("SELECT legacy_file FROM sessions WHERE legacy_file IS NOT NULL").map((r) => String(r.legacy_file))),

		/** A new session with its first question's request id. False when the id is taken. */
		create(row: { id: string; file: string; title: string }, requestId: string): boolean {
			return transaction(() => {
				const at = now();
				if (run("INSERT OR IGNORE INTO sessions (id, file, title, created_at, last_activity) VALUES (?, ?, ?, ?, ?)", row.id, row.file, row.title, at, at).changes === 0) return false;
				run("INSERT INTO requests (session_id, request_id) VALUES (?, ?)", row.id, requestId);
				return true;
			});
		},
		hasRequest: (sessionId: string, requestId: string) => one("SELECT 1 FROM requests WHERE session_id = ? AND request_id = ?", sessionId, requestId) !== undefined,
		/** Records a question's request id on an active session. False for a duplicate or a session not active. */
		admit(sessionId: string, requestId: string): boolean {
			return transaction(() => {
				if (!one("SELECT 1 FROM sessions WHERE id = ? AND state = 'active'", sessionId)) return false;
				if (run("INSERT OR IGNORE INTO requests (session_id, request_id) VALUES (?, ?)", sessionId, requestId).changes === 0) return false;
				run("UPDATE sessions SET last_activity = ? WHERE id = ?", now(), sessionId);
				return true;
			});
		},
		/** Forgets a request id whose question never reached the transcript, so a retry can ask it. */
		forgetRequest: (sessionId: string, requestId: string) => void run("DELETE FROM requests WHERE session_id = ? AND request_id = ?", sessionId, requestId),
		touch: (sessionId: string) => void run("UPDATE sessions SET last_activity = ? WHERE id = ?", now(), sessionId),
		setFile: (sessionId: string, file: string) => void run("UPDATE sessions SET file = ? WHERE id = ?", file, sessionId),

		drafts: (sessionId: string) => all("SELECT * FROM drafts WHERE session_id = ? ORDER BY created_at, id", sessionId).map(draftOf),
		draft(sessionId: string, id: string): StoredDraft | undefined {
			const row = one("SELECT * FROM drafts WHERE session_id = ? AND id = ?", sessionId, id);
			return row && draftOf(row);
		},
		/** Stores a proposal. A replayed tool call finds its draft instead of making another. */
		propose: (draft: Omit<StoredDraft, "status" | "createdAt">) => void insertDraft({ ...draft, status: "proposed", createdAt: now() }),
		/**
		 * Claims a proposed draft for its one write (proposed -> creating), only while its session is
		 * active. A repeated or concurrent approval, or a delete marked first, makes this return false.
		 */
		claim: (sessionId: string, id: string) =>
			run(
				"UPDATE drafts SET status = 'creating', decided_at = ? WHERE session_id = ? AND id = ? AND status = 'proposed' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND state = 'active')",
				now(), sessionId, id, sessionId,
			).changes === 1,
		/** Records the outcome of a claimed write. */
		settle(sessionId: string, id: string, outcome: { status: "created" | "failed" | "unknown"; number?: number; url?: string; error?: string }) {
			run("UPDATE drafts SET status = ?, number = ?, url = ?, error = ? WHERE session_id = ? AND id = ? AND status = 'creating'", outcome.status, outcome.number ?? null, outcome.url ?? null, outcome.error ?? null, sessionId, id);
		},
		dismiss: (sessionId: string, id: string) =>
			run(
				"UPDATE drafts SET status = 'dismissed', decided_at = ? WHERE session_id = ? AND id = ? AND status = 'proposed' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND state = 'active')",
				now(), sessionId, id, sessionId,
			).changes === 1,
		/** At start: a write claimed but never recorded may or may not have happened. Never resend it. */
		recoverCreating: () => run("UPDATE drafts SET status = 'unknown', error = 'Paca restarted while creating this issue.' WHERE status = 'creating'").changes,

		/**
		 * Marks an active session for deletion unless one of its drafts is being created. The caller
		 * checks that the session is not answering in the same synchronous step.
		 */
		markDeleting: (id: string) =>
			run("UPDATE sessions SET state = 'deleting' WHERE id = ? AND state = 'active' AND NOT EXISTS (SELECT 1 FROM drafts WHERE session_id = ? AND status = 'creating')", id, id).changes === 1,
		/** The last deletion step: the rows go, and the id is free again. */
		deleteRows(id: string) {
			transaction(() => {
				run("DELETE FROM requests WHERE session_id = ?", id);
				run("DELETE FROM drafts WHERE session_id = ?", id);
				run("DELETE FROM sessions WHERE id = ? AND state = 'deleting'", id);
			});
		},

		/** A converted legacy store: its session row and drafts in one transaction. */
		insertConverted(row: { id: string; file: string; title: string; createdAt: string; lastActivity: string; legacyFile: string }, drafts: Omit<StoredDraft, "sessionId">[]) {
			transaction(() => {
				run("INSERT INTO sessions (id, file, title, created_at, last_activity, legacy_file) VALUES (?, ?, ?, ?, ?, ?)", row.id, row.file, row.title, row.createdAt, row.lastActivity, row.legacyFile);
				for (const d of drafts) insertDraft({ ...d, sessionId: row.id });
			});
		},
		close: () => db.close(),
	};
}
