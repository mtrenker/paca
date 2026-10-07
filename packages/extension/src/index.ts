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
}

/** One write for the user to approve: where, a title and a body, stored and created exactly as given. */
export interface Proposal {
	/** A write action of this package, such as "create_issue". */
	readonly action: string;
	readonly repository: string;
	readonly title: string;
	readonly body: string;
}

/**
 * What a write did. `failed` only when nothing was written (the service refused it, or it never
 * left this machine); `unknown` when it may have happened. Paca never sends an unknown write again.
 */
export type WriteOutcome =
	| { readonly status: "created"; readonly url: string; readonly number?: number }
	| { readonly status: "failed" | "unknown"; readonly error: string };

export interface WriteAction {
	/** Writes the approved proposal once. Throwing counts as `unknown`. */
	execute(proposal: Proposal): Promise<WriteOutcome>;
	/** Where the user can check whether an unknown write happened. */
	checkUrl(proposal: Proposal): string;
}

/**
 * Stores a proposal for the user's approval in the session the tool runs in, keyed by the calling
 * tool call. Pass the `toolCallId` and `ctx` your tool's `execute` received. Writes nothing else.
 */
export type Propose = (toolCallId: string, ctx: ExtensionContext, proposal: Proposal) => void;

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
	/** A short line for the page header, such as "2 Projects", and its tooltip. */
	readonly scope: { readonly label: string; readonly detail: string };
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
}

export interface ToolPackage<Settings = unknown, UserSettings = unknown> {
	/** Names the package: its key in user settings and the prefix of its actions. */
	readonly name: string;
	/** The user's tools, or undefined when this user has none. Throw for invalid settings. */
	forUser(input: ForUserInput<Settings, UserSettings>): UserTools | undefined;
}

export function defineToolPackage<Settings, UserSettings>(definition: ToolPackage<Settings, UserSettings>): ToolPackage<Settings, UserSettings> {
	return definition;
}
