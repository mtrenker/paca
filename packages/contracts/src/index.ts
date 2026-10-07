// What the API sends the page and the page reads. Types only: nothing here runs on either side.

/** GET /api/session for the signed-in user. */
export interface SessionInfo {
	csrf: string;
	name: string;
	model: string;
	/** Short scope for the header, such as "2 Projects"; `scopeDetail` is its tooltip. */
	scope: string;
	scopeDetail: string;
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

/** A proposed write as its card shows it; approving creates exactly this. */
export interface DraftCard {
	id: string;
	repository: string;
	title: string;
	body: string;
	status: DraftStatus;
	url?: string;
	number?: number;
	error?: string;
	/** Where to look when the outcome is unknown. */
	checkUrl?: string;
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
	/** The answer being written, while the run is going. */
	draft?: string;
	retry?: string;
}

/** Every SSE `state` event carries the whole state, so a reconnect starts from the latest one. */
export interface PageState {
	running: boolean;
	turns: Turn[];
}
