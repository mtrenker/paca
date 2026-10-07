// A small client for Herdr's Unix socket API (newline-delimited JSON, one connection per
// request). It knows only the four methods Paca uses; see docs/herdr.md. Errors carry Herdr's code
// and say whether the request may have reached Herdr, never the request itself.
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

/** An agent as `agent.list` and `agent.get` report it (Herdr 0.9.3 `AgentInfo`); fields Paca uses. */
export interface AgentInfo {
	pane_id: string;
	terminal_id: string;
	workspace_id: string;
	tab_id: string;
	agent?: string | null;
	name?: string | null;
	agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
	cwd?: string | null;
	foreground_cwd?: string | null;
	launch_pending?: boolean;
	agent_session?: { source: string; agent: string; kind: string; value: string } | null;
}

export interface ReadResult {
	pane_id: string;
	text: string;
	truncated: boolean;
}

export const LIMITS = { readMs: 5_000, promptMs: 15_000, responseBytes: 1024 * 1024 };

export class HerdrError extends Error {
	/** Herdr's error code, or the client's own: timeout, closed, too_large, bad_response, or a socket errno such as ENOENT. */
	readonly code: string;
	/** The request was written to the socket, so Herdr may have acted on it. */
	readonly written: boolean;
	/** Herdr answered with this error, as opposed to the connection failing. */
	readonly answered: boolean;
	constructor(code: string, message: string, { written, answered = false }: { written: boolean; answered?: boolean }) {
		super(message);
		this.code = code;
		this.written = written;
		this.answered = answered;
	}
}

type Method = "agent.list" | "agent.get" | "agent.read" | "agent.prompt";

export interface Herdr {
	listAgents(): Promise<AgentInfo[]>;
	getAgent(pane: string): Promise<AgentInfo>;
	/** The agent's visible screen; never `recent`, which can scroll a full-screen agent (docs/herdr.md). */
	readScreen(pane: string, lines: number): Promise<ReadResult>;
	/** Types `text` into the agent and presses Enter. Returns the agent Herdr typed into. */
	prompt(pane: string, text: string): Promise<AgentInfo>;
}

export function createHerdr({ socket, limits = LIMITS }: { socket: string; limits?: typeof LIMITS }): Herdr {
	function call(method: Method, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const id = `paca-${randomUUID()}`; // a fresh id per request, not an idempotency key
			let written = false;
			let settled = false;
			let buffer = Buffer.alloc(0);
			const connection = createConnection(socket);
			const finish = (error: HerdrError | undefined, result?: Record<string, unknown>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				connection.destroy();
				if (error) reject(error);
				else resolve(result!);
			};
			const fail = (code: string, message: string) => finish(new HerdrError(code, message, { written }));
			const timer = setTimeout(() => fail("timeout", `Herdr did not answer within ${timeoutMs / 1000} seconds`), timeoutMs);
			connection.on("connect", () => {
				written = true;
				connection.write(`${JSON.stringify({ id, method, params })}\n`);
			});
			connection.on("data", (chunk: Buffer) => {
				// Bytes, not characters: a newline byte never occurs inside a multibyte UTF-8 character.
				buffer = Buffer.concat([buffer, chunk]);
				const end = buffer.indexOf(0x0a);
				if ((end < 0 ? buffer.length : end) > limits.responseBytes) return fail("too_large", "Herdr's answer was too large");
				if (end < 0) return;
				let response: { id?: unknown; result?: Record<string, unknown>; error?: { code?: unknown; message?: unknown } };
				try {
					response = JSON.parse(buffer.subarray(0, end).toString("utf8"));
				} catch {
					return fail("bad_response", "Herdr's answer was not JSON");
				}
				if (response.id !== id) return fail("bad_response", "Herdr answered a different request");
				if (response.error) {
					const code = typeof response.error.code === "string" ? response.error.code : "error";
					return finish(new HerdrError(code, String(response.error.message ?? code).slice(0, 300), { written, answered: true }));
				}
				if (typeof response.result !== "object" || response.result === null) return fail("bad_response", "Herdr's answer had no result");
				finish(undefined, response.result);
			});
			connection.on("error", (error: NodeJS.ErrnoException) => {
				const code = error.code ?? "socket_error";
				const where = code === "ENOENT" || code === "ECONNREFUSED" ? ` at ${socket}. Is Herdr running? After a Herdr restart, recreate Paca's container` : "";
				fail(code, `Herdr's socket failed (${code})${where}`);
			});
			connection.on("close", () => fail("closed", "Herdr closed the connection without answering"));
		});
	}

	const agentOf = (result: Record<string, unknown>) => {
		const agent = result.agent as AgentInfo | undefined;
		if (typeof agent?.pane_id !== "string" || typeof agent.terminal_id !== "string") throw new HerdrError("bad_response", "Herdr's answer had no agent", { written: true });
		return agent;
	};

	return {
		async listAgents() {
			const { agents } = await call("agent.list", {}, limits.readMs);
			if (!Array.isArray(agents)) throw new HerdrError("bad_response", "Herdr's answer had no agent list", { written: true });
			return agents as AgentInfo[];
		},
		async getAgent(pane) {
			return agentOf(await call("agent.get", { target: pane }, limits.readMs));
		},
		async readScreen(pane, lines) {
			const { read } = await call("agent.read", { target: pane, source: "visible", lines, format: "text", strip_ansi: true }, limits.readMs);
			const result = read as ReadResult | undefined;
			if (typeof result?.text !== "string") throw new HerdrError("bad_response", "Herdr's answer had no output", { written: true });
			return result;
		},
		async prompt(pane, text) {
			return agentOf(await call("agent.prompt", { target: pane, text }, limits.promptMs));
		},
	};
}
