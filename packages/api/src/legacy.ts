// Converts the one conversation the code before multiple sessions kept per user, a Pi Durable store
// at <data>/paca.sqlite (operator) or users/<id>/paca.sqlite, into one session. Runs at start,
// before the server listens, so no converted draft can be approved while the previous image could
// still find the store. See docs/design/multi-session.md, "Migration", for the contract:
// 1. open and close the store with Durable's storage API, which folds its WAL into the main file;
// 2. rename it to users/<id>/legacy/<session id>.sqlite, off the previous image's paths;
// 3. read it there into one session file;
// 4. write its drafts and session row (with legacy_file) in one transaction.
// A retained copy that no row names was interrupted between 2 and 4; the next start redoes 3 and 4.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { DraftStatus } from "@paca/contracts";
import { NOTICE } from "./agent.ts";
import { SESSION_ID, TITLE_MAX } from "./sessions.ts";
import type { Store, StoredDraft } from "./store.ts";

/** Drafts written before tool packages have no action; they are GitHub issue drafts. */
export const LEGACY_ACTION = "github.create_issue";
const RETAINED = new RegExp(`^(${SESSION_ID.source.slice(1, -1)})\\.sqlite$`);

type LegacyMessage = { role: string; content?: unknown; timestamp?: number };
type LegacyDraft = { id: string; action?: string; repository: string; title: string; body: string; status: DraftStatus; createdAt: string; decidedAt?: string; number?: number; url?: string; error?: string };
type Item = { message: LegacyMessage } | { notice: string };

export interface ConvertOptions {
	/** Where the previous code kept this user's store. */
	legacyPath: string;
	userDir: string;
	store: Pick<Store, "legacyFiles" | "insertConverted">;
	log?: Pick<Console, "log">;
}

export async function convertLegacy({ legacyPath, userDir, store, log = console }: ConvertOptions) {
	const legacyDir = join(userDir, "legacy");
	if (existsSync(legacyDir)) {
		const named = store.legacyFiles();
		for (const name of readdirSync(legacyDir)) {
			const id = RETAINED.exec(name)?.[1];
			if (id && !named.has(join("legacy", name))) await convert(id, `${join(legacyDir, name)} (interrupted earlier)`);
		}
	}
	if (!existsSync(legacyPath)) return;

	// 1. A killed writer can leave committed data only in the WAL; closing folds it in.
	await (await openNodeSqliteStorage(legacyPath)).close(ctx);
	for (const suffix of ["-wal", "-shm"]) {
		if (existsSync(legacyPath + suffix)) throw new Error(`legacy conversion, step 1: ${legacyPath}${suffix} is still there after closing the store`);
	}
	// 2. One rename inside the data directory; if it fails, the start stops and nothing is converted.
	mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
	const id = randomUUID();
	try {
		renameSync(legacyPath, join(legacyDir, `${id}.sqlite`));
	} catch (error) {
		throw new Error(`legacy conversion, step 2: could not move ${legacyPath}: ${(error as Error).message}`);
	}
	await convert(id, legacyPath);

	/** Steps 3 and 4 for legacy/<id>.sqlite. */
	async function convert(id: string, source: string) {
		const retained = join(legacyDir, `${id}.sqlite`);
		const { items, drafts } = await read(retained);
		const messages = items.flatMap((i) => ("message" in i ? [i.message] : []));
		if (messages.length === 0 && drafts.length === 0) {
			// Every user had a store, most of them never used. It gets no session.
			const aside = join(legacyDir, `empty-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
			renameSync(retained, aside);
			log.log(`paca: legacy store ${source} was empty; moved to ${relative(userDir, aside)}`);
			return;
		}
		const sessionsDir = join(userDir, "sessions");
		const piDir = join(userDir, "pi");
		mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
		mkdirSync(piDir, { recursive: true, mode: 0o700 });
		// A file from an interrupted earlier try is written again from the start.
		for (const name of readdirSync(sessionsDir)) if (name.endsWith(`_${id}.jsonl`)) rmSync(join(sessionsDir, name), { force: true });
		const manager = SessionManager.create(piDir, sessionsDir, { id });
		for (const item of items) {
			if ("notice" in item) manager.appendCustomMessageEntry(NOTICE, item.notice, true);
			else manager.appendMessage(item.message as Parameters<SessionManager["appendMessage"]>[0]);
		}
		const question = messages.find((m) => m.role === "user");
		const at = (m: LegacyMessage | undefined) => new Date(m?.timestamp ?? Date.now()).toISOString();
		store.insertConverted(
			{
				id,
				file: relative(userDir, manager.getSessionFile()!),
				title: (question ? textOf(question.content) : "Earlier conversation").slice(0, TITLE_MAX) || "Earlier conversation",
				createdAt: at(messages[0]),
				lastActivity: at(messages.at(-1)),
				legacyFile: relative(userDir, retained),
			},
			drafts.map((d): Omit<StoredDraft, "sessionId"> => ({ ...d, action: d.action ?? LEGACY_ACTION })),
		);
		log.log(`paca: converted legacy store ${source} into session ${id}: ${messages.length} messages, ${drafts.length} drafts`);
	}
}

/**
 * The root conversation's messages in order, including turns a compaction hid, Paca's notices, and
 * the drafts. Durable internals (live state, usage, tasks, request ids, summaries) are dropped.
 */
async function read(file: string): Promise<{ items: Item[]; drafts: LegacyDraft[] }> {
	const storage = await openNodeSqliteStorage(file);
	try {
		const conversations = (await storage.scanConversations({}, 100, undefined, ctx)).items.filter((c) => !c.parent && !c.owner);
		const root = conversations.sort((a, b) => Number(a.id) - Number(b.id))[0];
		if (!root) return { items: [], drafts: [] };
		const entries = [];
		let cursor;
		do {
			const page = await storage.scanEntries({ conversationId: root.id }, 500, cursor, ctx);
			entries.push(...page.items);
			cursor = page.next;
		} while (cursor);
		const items: Item[] = [];
		for (const entry of entries.reverse()) {
			if (entry.kind === "pi.user" || entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") for (const message of entry.model ?? []) items.push({ message: message as LegacyMessage });
			if (entry.kind === "paca.notice") items.push({ notice: String((entry.data as { text?: unknown } | null)?.text ?? "") });
		}
		const record = await storage.findDocument({ kind: "paca.drafts", scope: { kind: "conversation", conversationId: root.id } }, "current", ctx);
		const doc = record && (await storage.document(record.id, "current", ctx));
		const drafts = Object.values((doc?.value as { items?: Record<string, LegacyDraft> } | undefined)?.items ?? {});
		return { items, drafts };
	} finally {
		await storage.close(ctx);
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("") : "";
}
