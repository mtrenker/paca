// Reduces one session's Pi transcript to what the page shows. Every update sends the whole state,
// so a client that reconnects simply starts from the latest one. Tool results stay on the server;
// the page sees only which evidence was read, whether it was available, and the bounded cards a
// tool chose to show.
import type { CardRef, DraftCard, PageState, Step, Turn } from "@paca/contracts";
import type { ToolLabel } from "@paca/extension";
import { NOTICE } from "./agent.ts";
import type { StoredCard, StoredDraft } from "./store.ts";

/** How the user's tool packages name their calls, and where to check an unknown write. */
export interface Describe {
	labels: Readonly<Record<string, ToolLabel>>;
	checkUrl(draft: StoredDraft): string | undefined;
}

interface Block {
	readonly type: string;
	readonly text?: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: Record<string, unknown>;
}
interface Message {
	readonly role: string;
	readonly content?: string | readonly Block[];
	readonly isError?: boolean;
	readonly toolCallId?: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly customType?: string;
}
/** The parts of a Pi session entry the page needs (`SessionManager.getBranch()`). */
export interface Entry {
	readonly type: string;
	readonly id: string;
	/** When the entry was written (ISO 8601); places page drafts among the questions. */
	readonly timestamp?: string;
	readonly message?: unknown;
	readonly customType?: string;
	readonly content?: string | readonly Block[];
}

export interface Live {
	/** The session is answering. */
	running?: boolean;
	/** The assistant message being streamed, while answering. */
	partial?: unknown;
	retry?: string;
	/** Why the session could not be opened. */
	error?: string;
	drafts?: readonly StoredDraft[];
	cards?: readonly StoredCard[];
	describe?: Describe;
}

const NO_TOOLS: Describe = { labels: {}, checkUrl: () => undefined };
/** The id prefix of drafts a page proposed (Contract 6); only that route writes it. */
const PAGE_DRAFT = "page:";

function draftCard(d: StoredDraft, describe: Describe): DraftCard {
	const card: DraftCard = { id: d.id, action: d.action, target: d.repository, title: d.title, body: d.body, status: d.status };
	if (d.url) Object.assign(card, { url: d.url, number: d.number });
	if (d.error) card.error = d.error;
	if (d.status === "unknown") card.checkUrl = describe.checkUrl(d);
	if (d.id.startsWith(PAGE_DRAFT)) card.fromPage = true;
	return card;
}

function text(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

function resultSummary(message: Message, label: ToolLabel | undefined): string {
	const body = text(message.content);
	if (message.isError) {
		// Transcripts converted from Durable wrap thrown errors as <harness>[error] message</harness>.
		const line = body.split("\n").find((l) => l.trim() && !/^<\/?harness>$/.test(l.trim())) ?? "unknown error";
		return line.replace(/^\[\w+\]\s*/, "").slice(0, 200);
	}
	return label?.detail?.(body) ?? "";
}

export function uiState(entries: readonly Entry[], { running = false, partial, retry, error, drafts = [], cards = [], describe = NO_TOOLS }: Live = {}): PageState {
	const toolLabel = (call: Block) => {
		const label = describe.labels[call.name ?? ""];
		return label ? label.label(call.arguments ?? {}) : `Refused tool ${call.name}`;
	};
	const turns: Turn[] = [];
	let turn: Turn | undefined;
	const tools = new Map<string, Step>();
	const nameOfCall = new Map<string, string>();
	const turnOfCall = new Map<string, Turn>();
	/** When each question was asked, by its turn. */
	const askedAt = new Map<Turn, string>();
	const current = () => {
		if (!turn) {
			turn = { id: "orphan", question: null, steps: [], answer: "", notices: [], drafts: [], cards: [] };
			turns.push(turn);
		}
		return turn;
	};

	for (const entry of entries) {
		if (entry.type === "custom_message") {
			if (entry.customType === NOTICE) current().notices.push({ tone: "warning", text: text(entry.content) });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message as Message;
		switch (message.role) {
			case "user":
				turn = { id: entry.id, question: text(message.content), steps: [], answer: "", notices: [], drafts: [], cards: [] };
				turns.push(turn);
				if (entry.timestamp) askedAt.set(turn, entry.timestamp);
				break;
			case "assistant": {
				const t = current();
				for (const block of Array.isArray(message.content) ? message.content : []) {
					if (block.type === "toolCall" && block.id) {
						const step: Step = { id: block.id, label: toolLabel(block), status: "running", detail: "" };
						tools.set(block.id, step);
						nameOfCall.set(block.id, block.name ?? "");
						turnOfCall.set(block.id, t);
						t.steps.push(step);
					}
				}
				const said = text(message.content).trim();
				if (said) t.answer = t.answer ? `${t.answer}\n\n${said}` : said;
				// Stop, a limit and a restart abort the request, or Paca refuses to send it ("Not sent: ...");
				// Paca's notice after it says why.
				if (message.stopReason === "aborted" || (message.stopReason === "error" && /aborted|^Not sent:/i.test(message.errorMessage ?? ""))) t.notices.push({ tone: "warning", text: "The answer was interrupted." });
				else if (message.stopReason === "error") t.notices.push({ tone: "error", text: `The model request failed: ${message.errorMessage ?? "unknown error"}` });
				break;
			}
			case "toolResult": {
				const step = message.toolCallId ? tools.get(message.toolCallId) : undefined;
				if (step) {
					step.status = message.isError ? "unavailable" : "done";
					step.detail = resultSummary(message, describe.labels[nameOfCall.get(step.id) ?? ""]);
				}
				break;
			}
		}
	}

	const streaming = partial as Message | undefined;
	if (running && turn && streaming?.role === "assistant") {
		const said = text(streaming.content).trim();
		if (said) turn.draft = said;
		for (const block of Array.isArray(streaming.content) ? streaming.content : []) {
			if (block.type === "toolCall" && block.id && !tools.has(block.id)) turn.steps.push({ id: block.id, label: toolLabel(block), status: "running", detail: "" });
		}
	}
	if (running && turn && retry) turn.retry = retry.slice(0, 240);
	if (error) current().notices.push({ tone: "error", text: error.slice(0, 300) });
	// Steps still marked running after the answer ended were cut off.
	if (!running) for (const step of tools.values()) if (step.status === "running") step.status = "interrupted";

	// A draft whose tool call is not in the transcript (a compacted legacy turn) is shown in one turn
	// at the top, whatever its status, so a decision made there keeps its outcome and link. A draft a
	// page proposed gets a turn of its own, before the first question asked after it.
	const earlier: DraftCard[] = [];
	for (const draft of drafts) {
		const owner = turnOfCall.get(draft.id);
		if (owner) owner.drafts.push(draftCard(draft, describe));
		else if (draft.id.startsWith(PAGE_DRAFT)) {
			const page: Turn = { id: draft.id, question: null, steps: [], answer: "", notices: [], drafts: [draftCard(draft, describe)], cards: [] };
			const after = turns.findIndex((t) => (askedAt.get(t) ?? "") > draft.createdAt);
			turns.splice(after < 0 ? turns.length : after, 0, page);
		} else earlier.push(draftCard(draft, describe));
	}
	if (earlier.length) turns.unshift({ id: "earlier-drafts", question: "Earlier drafts", steps: [], answer: "", notices: [], drafts: earlier, cards: [] });

	// A card goes with its tool call's turn. One whose call is not in the branch is dropped: unlike a
	// draft, it records no decision.
	for (const card of cards) {
		const ref: CardRef = { id: card.id, package: card.package, kind: card.kind, data: card.data, fallback: card.fallback, createdAt: card.createdAt };
		turnOfCall.get(card.toolCallId)?.cards.push(ref);
	}

	return { running, turns };
}
