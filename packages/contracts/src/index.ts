// What the API sends the page and the page reads. Types only: nothing here runs on either side.

/** GET /api/session for the signed-in user. */
export interface SessionInfo {
	csrf: string;
	name: string;
	model: string;
	/** Short scope for the header, such as "2 Projects"; `scopeDetail` is its tooltip. */
	scope: string;
	scopeDetail: string;
	/** The tool packages whose frontend the page may load for this user. */
	extensions: ExtensionInfo[];
}

/** A package's frontend, as the page loads it. URLs are same-origin paths under /ext/<name>/. */
export interface ExtensionInfo {
	/** The package's name, such as "github". */
	name: string;
	/** The ES module to import. */
	entry: string;
	/** Stylesheets to link with it. */
	styles: string[];
	/** The card kinds it renders. */
	cards: string[];
	/** Its pages by name, opened as /?page=<name>.<page>. */
	pages: Record<string, { title: string }>;
	/** Its one link in the side list. */
	nav?: { label: string; page: string };
}

export type StepStatus = "running" | "done" | "unavailable" | "interrupted";

/** One tool call in an answer's evidence trail. Tool results themselves stay on the server. */
export interface Step {
	id: string;
	label: string;
	status: StepStatus;
	detail: string;
}

export type DraftStatus = "proposed" | "creating" | "created" | "failed" | "unknown" | "dismissed";

/** A proposed write as its card shows it; approving performs exactly this. */
export interface DraftCard {
	id: string;
	/** Which write, such as "github.create_issue" or "herdr.send_prompt"; the page words the card by it. */
	action: string;
	/** Where it goes: a repository, or an agent such as "claude in w7:p5". */
	target: string;
	title: string;
	body: string;
	status: DraftStatus;
	url?: string;
	number?: number;
	error?: string;
	/** Where to look when the outcome is unknown. */
	checkUrl?: string;
	/** Proposed from an extension page, not by Paca. */
	fromPage?: boolean;
}

/**
 * A card a tool showed: a bounded projection the package renders, labeled with when Paca read it.
 * The page shows `fallback` when the package's frontend is not available.
 */
export interface CardRef {
	/** "<tool call id>:<n>", unique within the session and never reused. */
	id: string;
	package: string;
	kind: string;
	data: Record<string, unknown>;
	fallback: { text: string; url?: string };
	createdAt: string;
}

export interface Notice {
	tone: "warning" | "error";
	text: string;
}

export interface Turn {
	id: string;
	question: string | null;
	steps: Step[];
	answer: string;
	notices: Notice[];
	drafts: DraftCard[];
	/** Cards of this turn's tool calls, in the order they were shown. */
	cards: CardRef[];
	/** The answer being written, while the run is going. */
	draft?: string;
	retry?: string;
}

/** One open session's transcript. Every SSE `state` event carries it whole, so a reconnect starts from the latest one. */
export interface PageState {
	running: boolean;
	turns: Turn[];
}

/** One saved session in the list, from the SSE `sessions` event (the whole list each time). */
export interface SessionSummary {
	/** Lowercase UUID v4, made by the page when it starts the session. */
	id: string;
	/** The first question. */
	title: string;
	running: boolean;
	/** Drafts waiting for Create or Dismiss. */
	waiting: number;
	lastActivity: string;
}
