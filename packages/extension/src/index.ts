// The contract between Paca and a tool package. See docs/architecture.md#tool-packages.
//
// A tool package is trusted server code, enabled by name in config.json. Paca calls `forUser`
// once per configured user with that user's identity, which the host authenticated; a package
// never learns about users any other way. Tools may read. They never write: a tool proposes a
// write through `propose`, the user approves the exact proposal, and only then does the host call
// the package's write action, once.
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** The signed-in user, as the host knows them. */
export interface HostUser {
	/** Stable id from config.json, such as "martin". */
	readonly id: string;
	/** The host's operator (`"operator": true`). A package that controls the host offers tools only to them. */
	readonly operator: boolean;
}

/**
 * One write for the user to approve, stored and performed exactly as given. The card shows the
 * target, title and body; `expect` is not shown.
 */
export interface Proposal {
	/** A write action of this package, such as "create_issue". */
	readonly action: string;
	/** Where the write goes, as the card names it: "owner/name" for an issue, the agent for a prompt. */
	readonly target: string;
	/** One line under the target: an issue's title, the directory an agent works in. */
	readonly title: string;
	/** The exact content written: an issue's body, a prompt's text. */
	readonly body: string;
	/** What the action checks before writing, such as the identity of the agent the user saw. */
	readonly expect?: Readonly<Record<string, string>>;
}

/**
 * What a write did. `created` when it happened (an issue was created, a prompt was submitted);
 * `failed` only when nothing was written (the service refused it, or it never left this machine);
 * `unknown` when it may have happened. Paca never sends an unknown write again.
 */
export type WriteOutcome =
	| { readonly status: "created"; readonly url?: string; readonly number?: number }
	| { readonly status: "failed" | "unknown"; readonly error: string };

export interface WriteAction {
	/**
	 * Why this proposal cannot be approved right now, such as an API the user must sign in again for;
	 * undefined when it can. Asked before the approval is claimed, so a refusal
	 * leaves the proposal waiting. Must not write.
	 */
	ready?(proposal: Proposal): string | undefined;
	/** Writes the approved proposal once. Throwing counts as `unknown`. */
	execute(proposal: Proposal): Promise<WriteOutcome>;
	/** Where the user can check whether an unknown write happened, when there is a page for it. */
	checkUrl?(proposal: Proposal): string;
}

/**
 * Stores a proposal for the user's approval in the session the tool runs in, keyed by the calling
 * tool call. Pass the `toolCallId` and `ctx` your tool's `execute` received. Writes nothing else.
 */
export type Propose = (toolCallId: string, ctx: ExtensionContext, proposal: Proposal) => void;

/** A value that survives JSON: what a card may carry to the page. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * A card in the chat turn of the calling tool: a small, browser-safe projection of what the tool
 * read, which the package's browser entry renders. It is not a proposal and decides nothing. The
 * page shows `fallback` when the package's frontend is not available.
 */
export interface CardInput {
	/** A kind the package's manifest declares under `browser.cards`. */
	readonly kind: string;
	/** At most 1 KiB as UTF-8 JSON. Shape it to fit before calling `show`. */
	readonly data: Readonly<Record<string, JsonValue>>;
	/** 1 to 200 characters of text, and an optional https: link. */
	readonly fallback: { readonly text: string; readonly url?: string };
}

/**
 * Stores a card for the page under the session and tool call that made it, at most 8 per tool
 * call. Pass the `toolCallId` and `ctx` your tool's `execute` received. Throws, failing the tool
 * call, for a card outside the bounds above.
 */
export type Show = (toolCallId: string, ctx: ExtensionContext, card: CardInput) => void;

/**
 * What a package ships for the page: prebuilt ES modules and stylesheets in one directory of the
 * package. Declared here, never taken from a tool's output. See docs/architecture.md#frontends.
 */
export interface BrowserManifest {
	/** File URL of a directory inside the package, such as new URL("../browser/", import.meta.url).href. */
	readonly dir: string;
	/** The module the page imports, relative to `dir`, such as "dist/index.js". */
	readonly entry: string;
	/** Stylesheets the page links with the module, relative to `dir`. */
	readonly styles?: readonly string[];
	/** Card kinds the entry renders, such as ["issue"]. */
	readonly cards?: readonly string[];
	/** Pages the entry renders, by name, with the title the page frame shows. */
	readonly pages?: Readonly<Record<string, { readonly title: string }>>;
	/** One link in the side list, to a declared page that renders without parameters. */
	readonly nav?: { readonly label: string; readonly page: string };
}

/**
 * A read the package's browser code asks for, bound to the signed-in user like their tools. It
 * must not write. Answer at most 512 KiB of JSON; the host aborts `signal` after 25 seconds.
 */
export type Operation = (input: Record<string, unknown>, signal: AbortSignal) => Promise<JsonValue>;

/** A refusal or failure the user can act on: the page shows `message`, with `status`. Nothing is logged. */
export class OperationError extends Error {
	readonly status: 400 | 404 | 409 | 502;
	constructor(status: 400 | 404 | 409 | 502, message: string) {
		super(message);
		this.name = "OperationError";
		this.status = status;
	}
}

/**
 * Turns a page's input into the exact Proposal for one of the package's write actions, validating
 * it and the user's scope. Throws OperationError(400 or 404, message) for input the user can fix.
 * Never writes: the host stores the proposal for the user's approval, as for a tool's.
 */
export type ProposalBuilder = (input: Record<string, unknown>) => Proposal | Promise<Proposal>;

/** How the page names a call of one tool in the evidence trail. */
export interface ToolLabel {
	label(args: Record<string, unknown>): string;
	/** A short note from a successful result's text, such as when the data was captured. */
	detail?(result: string): string;
}

/** A package's tools for one user. */
export interface UserTools {
	/** Pi tools (`defineTool` from pi-coding-agent). The host offers the model these and nothing else. */
	readonly tools: readonly ToolDefinition[];
	/** Facts about the tools for the model's system prompt, such as the scope. Not persona or workflow policy. */
	readonly prompt?: string;
	readonly labels: Readonly<Record<string, ToolLabel>>;
	readonly writes?: Readonly<Record<string, WriteAction>>;
	/** Reads for the package's pages and cards (`context.call`), by name. */
	readonly operations?: Readonly<Record<string, Operation>>;
	/** Write actions a page may propose directly (`context.propose`). Each needs its `writes` entry too. */
	readonly proposals?: Readonly<Record<string, ProposalBuilder>>;
	/** A short line for the page header, such as "2 Projects", and its tooltip. */
	readonly scope: { readonly label: string; readonly detail: string };
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Whether an API can be called for the user now: `sign-in` means they must sign in to Paca again. */
export type ApiState = "ready" | "sign-in" | "not-granted";

/**
 * One configured API, called as the signed-in user with the access token of their Paca sign-in,
 * which the package never sees. See docs/design/api-access.md.
 */
export interface UserApi {
	readonly name: string;
	/** What the page calls it, such as "Example API". */
	readonly label: string;
	/** Read it when you need it: the user's grant can end at any time. */
	state(): ApiState;
	/**
	 * One JSON request to a path below the configured URL. Answers every HTTP status; throws
	 * ApiError otherwise. A read (GET) may refresh and retry once after a 401. Every other method is
	 * a write and is never retried.
	 */
	request(path: string, init?: { method?: ApiMethod; body?: JsonValue; signal?: AbortSignal }): Promise<{ status: number; body: unknown }>;
}

/**
 * An API request that got no HTTP answer. `sent` is false when nothing left Paca (no grant, a
 * refused destination, a failed refresh), so a write did not happen; true when the request may have
 * reached the API, so a write's outcome is unknown.
 */
export class ApiError extends Error {
	readonly code: string;
	readonly sent: boolean;
	constructor(code: string, message: string, sent: boolean) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.sent = sent;
	}
}

export interface ForUserInput<Settings = unknown, UserSettings = unknown> {
	readonly user: HostUser;
	/** This package's entry under `extensions` in config.json. */
	readonly settings: Settings;
	/** The user's entry under the package's name, for example `users[].github`; undefined when absent. */
	readonly userSettings: UserSettings | undefined;
	/** Private directory for files the package can regenerate. Not for data it must keep. */
	readonly cacheDir: string;
	readonly propose: Propose;
	readonly show: Show;
	/** The APIs this user and this package are both allowed, by name; empty when none. */
	readonly apis: Readonly<Record<string, UserApi>>;
}

export interface ToolPackage<Settings = unknown, UserSettings = unknown> {
	/** Names the package: its key in user settings and the prefix of its actions. */
	readonly name: string;
	/** The package's frontend, when it has one. */
	readonly browser?: BrowserManifest;
	/** The user's tools, or undefined when this user has none. Throw for invalid settings. */
	forUser(input: ForUserInput<Settings, UserSettings>): UserTools | undefined;
}

export function defineToolPackage<Settings, UserSettings>(definition: ToolPackage<Settings, UserSettings>): ToolPackage<Settings, UserSettings> {
	return definition;
}
