// Reduces a Durable conversation view to what the page shows. Every update sends the whole
// state, so a client that reconnects simply starts from the latest one. Tool results stay on
// the server; the page sees only which evidence was read and whether it was available.
import type { DraftCard, PageState, Step, Turn } from "@paca/contracts";
import type { ToolLabel } from "@paca/extension";
import { LEGACY_ACTION, type StoredDraft } from "./agent.ts";

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
	readonly content?: string | readonly Block[];
	isError?: boolean;
	toolCallId?: string;
	toolName?: string;
	stopReason?: string;
	errorMessage?: string;
}
interface ViewEntry {
	kind: string;
	id: unknown;
	model?: readonly Message[];
	data?: unknown;
}
/** The parts of a Durable ConversationView the page needs. */
export interface View {
	readonly entries?: readonly ViewEntry[];
	readonly docs?: Readonly<Record<string, unknown>>;
}

const NO_TOOLS: Describe = { labels: {}, checkUrl: () => undefined };

function draftCard(d: StoredDraft, describe: Describe): DraftCard {
	const card: DraftCard = { id: d.id, action: d.action ?? LEGACY_ACTION, target: d.repository, title: d.title, body: d.body, status: d.status };
	if (d.url) Object.assign(card, { url: d.url, number: d.number });
	if (d.error) card.error = d.error;
	if (d.status === "unknown") card.checkUrl = describe.checkUrl(d);
	return card;
}

function text(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

function resultSummary(message: Message, label: ToolLabel | undefined): string {
	const body = text(message.content);
	if (message.isError) {
		// Durable wraps thrown errors as <harness>[error] message</harness>.
		const line = body.split("\n").find((l) => l.trim() && !/^<\/?harness>$/.test(l.trim())) ?? "unknown error";
		return line.replace(/^\[\w+\]\s*/, "").slice(0, 200);
	}
	return label?.detail?.(body) ?? "";
}

export function uiState(view: View, { busy, drafts, describe = NO_TOOLS }: { busy?: boolean; drafts?: { readonly items: Readonly<Record<string, StoredDraft>> } | null; describe?: Describe } = {}): PageState {
	const toolLabel = (call: Block) => {
		const label = describe.labels[call.name ?? ""];
		return label ? label.label(call.arguments ?? {}) : `Refused tool ${call.name}`;
	};
	const turns: Turn[] = [];
	let turn: Turn | undefined;
	const tools = new Map<string, Step>();
	const nameOfCall = new Map<string, string>();
	const turnOfCall = new Map<string, Turn>();
	const answer = () => {
		if (!turn) {
			turn = { id: "orphan", question: null, steps: [], answer: "", notices: [], drafts: [] };
			turns.push(turn);
		}
		return turn;
	};

	for (const entry of view.entries ?? []) {
		const message = entry.model?.[0];
		switch (entry.kind) {
			case "pi.user":
				turn = { id: String(entry.id), question: text(message?.content), steps: [], answer: "", notices: [], drafts: [] };
				turns.push(turn);
				break;
			case "pi.assistant": {
				const t = answer();
				for (const block of Array.isArray(message?.content) ? message.content : []) {
					if (block.type === "toolCall" && block.id) {
						const step: Step = { id: block.id, label: toolLabel(block), status: "running", detail: "" };
						tools.set(block.id, step);
						nameOfCall.set(block.id, block.name ?? "");
						turnOfCall.set(block.id, t);
						t.steps.push(step);
					}
				}
				const said = text(message?.content).trim();
				if (said) t.answer = t.answer ? `${t.answer}\n\n${said}` : said;
				if (message?.stopReason === "error") t.notices.push({ tone: "error", text: `The model request failed: ${message.errorMessage ?? "unknown error"}` });
				if (message?.stopReason === "aborted") t.notices.push({ tone: "warning", text: "The answer was interrupted." });
				break;
			}
			case "pi.tool-result": {
				const step = message?.toolCallId ? tools.get(message.toolCallId) : undefined;
				if (step && message) {
					step.status = message.isError ? "unavailable" : "done";
					step.detail = resultSummary(message, describe.labels[nameOfCall.get(step.id) ?? ""]);
				}
				break;
			}
			case "paca.notice":
				answer().notices.push({ tone: "warning", text: String((entry.data as { text?: unknown } | null)?.text ?? "") });
				break;
		}
	}

	const live = (view.docs?.["pi.live"] ?? {}) as { run?: unknown; generation?: { message?: Message; retry?: { error: string } } };
	const running = Boolean(busy) || live.run !== undefined;
	const partial = live.generation?.message;
	if (running && turn && partial) {
		const said = text(partial.content).trim();
		if (said) turn.draft = said;
		for (const block of Array.isArray(partial.content) ? partial.content : []) {
			if (block.type === "toolCall" && block.id && !tools.has(block.id)) turn.steps.push({ id: block.id, label: toolLabel(block), status: "running", detail: "" });
		}
	}
	if (running && turn && live.generation?.retry) turn.retry = `Retrying after: ${live.generation.retry.error}`.slice(0, 240);
	// Steps still marked running after the run ended were cut off.
	if (!running) for (const step of tools.values()) if (step.status === "running") step.status = "interrupted";

	// Compaction drops old turns from the view, but not their drafts. Show those in one turn at the
	// top, whatever their status, so a decision made there keeps its outcome and link on the page.
	const earlier: DraftCard[] = [];
	for (const draft of Object.values(drafts?.items ?? {})) {
		const owner = turnOfCall.get(draft.id);
		if (owner) owner.drafts.push(draftCard(draft, describe));
		else earlier.push(draftCard(draft, describe));
	}
	if (earlier.length) turns.unshift({ id: "earlier-drafts", question: "Earlier drafts", steps: [], answer: "", notices: [], drafts: earlier });

	return { running, turns };
}
