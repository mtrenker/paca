// A fake Herdr server on a Unix socket for the tests, the local preview and the container smoke
// test: newline-delimited JSON with Herdr 0.9.3's shapes for agent.list, agent.get, agent.read and
// agent.prompt. It types nothing anywhere; prompts are only recorded. Never part of the image.
import { chmod } from "node:fs/promises";
import { createServer } from "node:net";

/** Synthetic agents: what agent.list reports, plus the screen agent.read returns. */
export const SAMPLE_AGENTS = [
	{ pane_id: "w1:p1", terminal_id: "term_fake01", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", name: null, agent_status: "idle", cwd: "/home/preview/code/notes", focused: false, revision: 1, screen: "● Tests pass (12/12).\n> " },
	{ pane_id: "w1:p2", terminal_id: "term_fake02", workspace_id: "w1", tab_id: "w1:t1", agent: "codex", name: "reviewer", agent_status: "working", cwd: "/home/preview/code/notes", focused: false, revision: 1, screen: "Reviewing the diff…" },
	{ pane_id: "w2:p1", terminal_id: "term_fake03", workspace_id: "w2", tab_id: "w2:t1", agent: "pi", name: null, agent_status: "idle", cwd: "/home/preview/private", focused: false, revision: 1, screen: "secret-looking output" },
];

/**
 * @param {object} options
 * @param {string} options.path socket path
 * @param {object[]} [options.agents] agents with an optional `screen`; changed in place to simulate Herdr
 * @param {Record<string, (params: object, request: object) => unknown>} [options.handlers] per method:
 *   return a response object, "hang" (never answer) or "close" (close without answering), or a
 *   promise of one, to hold the answer
 * @param {number} [options.mode] socket file mode, 0600 by default like Herdr's
 */
export async function startFakeHerdr({ path, agents = structuredClone(SAMPLE_AGENTS), handlers = {}, mode = 0o600, log = () => {} }) {
	const requests = [];
	const prompts = [];
	const info = ({ screen, ...agent }) => agent;
	const find = (target) => agents.find((a) => a.pane_id === target || (a.name && a.name === target));
	const notFound = (id, target) => ({ id, error: { code: "agent_not_found", message: `agent target ${target} not found` } });

	function answer(request) {
		const { id, method, params } = request;
		if (handlers[method]) return handlers[method](params, request);
		if (method === "agent.list") return { id, result: { type: "agent_list", agents: agents.map(info) } };
		if (method === "agent.get") {
			const agent = find(params.target);
			return agent ? { id, result: { type: "agent_info", agent: info(agent) } } : notFound(id, params.target);
		}
		if (method === "agent.read") {
			const agent = find(params.target);
			if (!agent) return notFound(id, params.target);
			return { id, result: { type: "pane_read", read: { pane_id: agent.pane_id, workspace_id: agent.workspace_id, tab_id: agent.tab_id, source: params.source, format: "text", text: agent.screen ?? "", revision: 0, truncated: false } } };
		}
		if (method === "agent.prompt") {
			const agent = find(params.target);
			if (!agent) return notFound(id, params.target);
			if (agent.agent_status === "blocked") return { id, error: { code: "agent_blocked", message: `agent ${params.target} is blocked and requires interactive input` } };
			prompts.push({ pane: agent.pane_id, terminal: agent.terminal_id, text: params.text });
			log(`fake herdr: recorded a prompt of ${params.text.length} characters for ${agent.pane_id}; nothing was typed`);
			return { id, result: { type: "agent_prompted", agent: info(agent) } };
		}
		return { id, error: { code: "unknown_method", message: `unknown method ${method}` } };
	}

	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			const end = buffer.indexOf("\n");
			if (end < 0) return;
			const request = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			requests.push(request);
			log(`fake herdr: ${request.method}`);
			Promise.resolve(answer(request)).then((response) => {
				if (response === "hang") return;
				if (response === "close") return socket.destroy();
				socket.write(`${typeof response === "string" ? response : JSON.stringify(response)}\n`);
			});
		});
	});
	await new Promise((resolve, reject) => server.once("error", reject).listen(path, resolve));
	await chmod(path, mode);
	return {
		path,
		agents,
		requests,
		prompts,
		close: () => {
			for (const socket of sockets) socket.destroy();
			return new Promise((resolve) => server.close(resolve));
		},
	};
}
