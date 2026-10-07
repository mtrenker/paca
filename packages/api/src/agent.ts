// How Paca builds one Pi AgentSession: Paca's own system prompt and the user's package tools, and
// nothing else. Every discovery flag of Pi's loader is off, settings live in memory, the agent
// directory is an empty Paca directory, and the tools are an allowlist, so the model gets no
// coding tools and nothing found on disk. The per-answer limits count every model request at the
// session's stream function and every tool call in an inline extension.
import type { Model } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ModelRuntime, type SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { UserTools } from "@paca/extension";
import { PERSONA } from "./persona.ts";

export const LIMITS = { modelRequests: 12, toolCalls: 30, durationMs: 3 * 60_000 };
export type Limits = typeof LIMITS;

/** Custom message entries Paca adds to a transcript, shown on the page as notices. */
export const NOTICE = "paca.notice";

/** A tool package's tools for this user, under the package's name. */
export interface PackageTools {
	name: string;
	tools: UserTools;
}

/** The answer in progress. The caller makes a new one for every question. */
export interface Run {
	requests: number;
	tools: number;
	stopReason?: string;
	/** Ends the answer and records why. */
	stop(reason: string): void;
}

export interface OpenAgentOptions {
	/** The user's empty Pi directory, used as Pi's working and agent directory. */
	dir: string;
	sessionManager: SessionManager;
	modelRuntime: ModelRuntime;
	model: Model<any>;
	packages: PackageTools[];
	limits: Limits;
	/** The run the limits count against, if an answer is in progress. */
	run: () => Run | undefined;
}

export function systemPrompt(packages: PackageTools[]) {
	return [PERSONA, ...packages.flatMap((p) => p.tools.prompt ?? [])].join("\n\n");
}

export async function openAgent({ dir, sessionManager, modelRuntime, model, packages, limits, run }: OpenAgentOptions): Promise<AgentSession> {
	// Cache warming would send model requests outside the limits; retries stay as before (2).
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 }, cacheWarming: "off" });
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: systemPrompt(packages),
		appendSystemPrompt: [],
		extensionFactories: [{ name: "paca-limits", factory: toolLimit(limits, run) }],
	});
	await resourceLoader.reload();
	const tools = packages.flatMap((p) => p.tools.tools);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		model,
		tools: tools.map((t) => t.name),
		customTools: [...tools],
		resourceLoader,
		sessionManager,
		settingsManager,
	});
	// Every model request of the session passes through this function: answer turns, Pi's automatic
	// retries, and compaction summaries with their retries (agent-session.js passes it to compact()).
	// Providers do not retry on their own unless settings ask them to. So counting here bounds the
	// requests one answer can send; counting turns would miss compaction.
	const send = session.agent.streamFunction;
	session.agent.streamFunction = (requestModel, context, options) => {
		const current = run();
		if (!current) throw new Error("Paca sends model requests only while answering a question.");
		current.requests += 1;
		if (current.requests > limits.modelRequests) current.stop(`Stopped after ${limits.modelRequests} model requests, the limit for one answer.`);
		// Also catches a Stop that arrived before the request was sent.
		if (current.stopReason !== undefined) throw new Error(`Not sent: ${current.stopReason}`);
		return send(requestModel, context, options);
	};
	return session;
}

/** Counts tool calls of the run in progress; one over the limit is blocked with a reason the model sees. */
function toolLimit(limits: Limits, current: () => Run | undefined) {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", () => {
			const run = current();
			if (!run) return undefined;
			run.tools += 1;
			if (run.tools > limits.toolCalls) return { block: true, reason: `Tool call limit of ${limits.toolCalls} for one answer reached. Answer with what you have.` };
			return undefined;
		});
	};
}

/**
 * Whether a transcript ends in the middle of an answer: a question, tool call or tool result with
 * no final assistant message after it. Paca adds a notice when it opens such a session.
 */
export function interrupted(entries: readonly { type: string; message?: { role: string; stopReason?: string } }[]) {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom_message") return false;
		if (entry.type !== "message" || !entry.message) continue;
		const { role, stopReason } = entry.message;
		if (role === "user" || role === "toolResult") return true;
		if (role === "assistant") return stopReason === "toolUse";
	}
	return false;
}
