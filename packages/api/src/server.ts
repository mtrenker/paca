// HTTP routes: sign-in, the page, questions and decisions as POSTs, and the session list and one
// open session as an SSE stream.
// Binds to loopback unless PACA_HOST says otherwise; HTTPS comes from the reverse proxy in front.
// Every route after sign-in acts for the user of the verified session, and only for them.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { PageState, SessionInfo, SessionSummary } from "@paca/contracts";
import { type Operation, OperationError } from "@paca/extension";
import type { Oidc, Session, Sessions } from "./auth.ts";
import type { Frontend } from "./extensions.ts";
import type { Feed } from "./feed.ts";
import { SESSION_ID } from "./sessions.ts";

const SECURITY_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
};
const STATIC: Record<string, ["public" | "script", string]> = { "/app.js": ["script", "text/javascript"], "/mounts.js": ["script", "text/javascript"], "/style.css": ["public", "text/css"], "/icon.svg": ["public", "image/svg+xml"] };
/** A package's frontend file: /ext/<package name>/<path listed at start>. */
const EXT_ASSET = /^\/ext\/([a-z][a-z0-9-]*)\/(.+)$/;
/** A package's read for its pages and cards: POST /api/ext/<package name>/<operation>. */
const EXT_OPERATION = /^\/api\/ext\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9_-]*)$/;
const OPERATION_MAX = 512 * 1024;
const MAX_BODY = 16 * 1024;
const MAX_QUESTION = 4000;
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/(messages|stop|delete|drafts\/approve|drafts\/dismiss)$/;
/** Routes of the single-conversation page; a page loaded before the update gets told to reload. */
const OLD_ROUTES = new Set(["POST /api/messages", "POST /api/stop", "POST /api/drafts/approve", "POST /api/drafts/dismiss"]);

type Result = { refused?: string } & Record<string, unknown>;

/**
 * What the routes need of one user: their sessions and their header info. A session id is only
 * ever looked up among this user's sessions; an id that is not theirs is refused as not-found.
 */
export interface RouteUser {
	sessions: {
		list: Feed<SessionSummary[]>;
		start(id: string, text: string, requestId: string): Result;
		ask(id: string, text: string, requestId: string): Result;
		stop(id: string): Result;
		remove(id: string): Promise<Result>;
		approveDraft(id: string, draftId: string): Promise<Result>;
		dismissDraft(id: string, draftId: string): Result;
		watch(id: string): Promise<Feed<PageState> | undefined>;
	};
	info: Omit<SessionInfo, "csrf" | "name">;
	/** The user's id, for log lines. */
	id: string;
	/** One of the user's package operations; the route checks the frontend is on first. */
	operation?(packageName: string, op: string): Operation | undefined;
}

/** How each refusal reads to the page. */
const REFUSED: Record<string, [number, string]> = {
	"not-found": [404, "That session does not exist."],
	busy: [409, "Paca is still answering in this session. Stop it or wait."],
	exists: [409, "That session already exists."],
	deleting: [409, "That session is being deleted."],
	creating: [409, "A write of this session is in progress. Wait for it, then delete."],
	unavailable: [409, "That can't be done now: its tool package is not enabled for you."],
};

export interface AppDeps {
	config: { publicUrl: string; publicOrigin: string };
	sessions: Sessions;
	oidc: Oidc;
	/** The user a verified session's subject belongs to. */
	users: { forSubject(subject: string): RouteUser | undefined };
	/** `public`: HTML, CSS and icon; `script`: the compiled app.js. */
	web: { public: string; script: string };
	/** Each package's frontend that is on, by package name (extensions.ts). */
	frontends?: ReadonlyMap<string, Frontend>;
	/** How long an operation may take before it is aborted and answers 504. */
	operationTimeoutMs?: number;
	log?: Pick<Console, "warn" | "error">;
}

export function createApp({ config, sessions, oidc, users, web, frontends = new Map(), operationTimeoutMs = 25_000, log = console }: AppDeps) {
	type Res = ServerResponse;
	const send = (res: Res, status: number, body: string | Buffer, headers: Record<string, string | string[]> = {}) => {
		res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
		res.end(body);
	};
	const json = (res: Res, status: number, value: unknown, headers?: Record<string, string | string[]>) => send(res, status, JSON.stringify(value), { "Content-Type": "application/json", ...headers });
	const page = async (res: Res, status: number, name: string) => send(res, status, await readFile(join(web.public, name)), { "Content-Type": "text/html; charset=utf-8" });

	function checkPost(req: IncomingMessage, session: Session) {
		if (req.headers.origin !== config.publicOrigin) return "origin";
		const token = Buffer.from(String(req.headers["x-csrf-token"] ?? ""));
		const expected = Buffer.from(session.csrf);
		if (token.length !== expected.length || !timingSafeEqual(token, expected)) return "csrf";
		return undefined;
	}

	async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
		let size = 0;
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			size += chunk.length;
			if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
			chunks.push(chunk);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw Object.assign(new Error("invalid JSON"), { status: 400 });
		}
	}

	/** The session list, and the open session's state until it is deleted (`gone`). */
	function events(req: IncomingMessage, res: Res, list: Feed<SessionSummary[]>, state: Feed<PageState> | undefined) {
		res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
		const send = (event: string, value: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
		// Every connection starts from a fresh snapshot.
		send("sessions", list.current());
		const unsubscribe = [list.subscribe((value) => send("sessions", value))];
		if (state) {
			send("state", state.current());
			unsubscribe.push(
				state.subscribe(
					(value) => send("state", value),
					() => {
						send("gone", {});
						res.end();
					},
				),
			);
		}
		const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
		req.on("close", () => {
			clearInterval(heartbeat);
			for (const fn of unsubscribe) fn();
		});
	}

	/**
	 * Runs one of the user's package operations with a time limit and a size cap. Only the API's
	 * `error` reaches the page; a crash is logged with the user, never shown.
	 */
	async function operate(res: Res, user: RouteUser, name: string, opName: string, op: Operation, input: Record<string, unknown>) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), operationTimeoutMs);
		// A page that goes away stops waiting; the operation is told through the same signal.
		res.on("close", () => controller.abort());
		const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
		const where = `extension ${name} op ${opName}`;
		try {
			const value = await Promise.race([op(input, controller.signal), aborted]);
			const text = JSON.stringify(value ?? null);
			if (Buffer.byteLength(text) > OPERATION_MAX) {
				log.warn(`paca: ${where} answered ${Buffer.byteLength(text)} bytes for user ${user.id}`);
				return json(res, 502, { error: "The extension answered too much." });
			}
			return send(res, 200, text, { "Content-Type": "application/json" });
		} catch (error) {
			if (res.destroyed) return;
			if (error instanceof OperationError && [400, 404, 409, 502].includes(error.status)) return json(res, error.status, { error: error.message });
			if (controller.signal.aborted) {
				log.warn(`paca: ${where} took longer than ${operationTimeoutMs / 1000} s for user ${user.id}`);
				return json(res, 504, { error: "The extension took too long. Try again." });
			}
			log.error(`paca: ${where} failed for user ${user.id}: ${(error as Error)?.message ?? error}`);
			return json(res, 500, { error: "Something went wrong on the server." });
		} finally {
			clearTimeout(timer);
		}
	}

	const reply = (res: Res, result: Result, status = 200) => {
		const refused = result.refused;
		if (!refused) return json(res, status, result);
		const [code, error] = REFUSED[refused] ?? [409, `That draft is already ${refused}.`];
		return json(res, code, { error, ...(code === 409 && !REFUSED[refused] ? { status: refused } : {}) });
	};
	const question = (fields: Record<string, unknown>) => {
		const { text, requestId } = fields;
		if (typeof text !== "string" || !text.trim() || text.length > MAX_QUESTION) return { error: `Questions need 1 to ${MAX_QUESTION} characters.` };
		if (typeof requestId !== "string" || !/^[\w-]{8,64}$/.test(requestId)) return { error: "Missing request id." };
		return { text: text.trim(), requestId };
	};

	async function handle(req: IncomingMessage, res: Res) {
		const url = new URL(req.url ?? "/", config.publicUrl);
		const route = `${req.method} ${url.pathname}`;

		if (route === "GET /healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });
		const asset = req.method === "GET" ? STATIC[url.pathname] : undefined;
		if (asset) return send(res, 200, await readFile(join(web[asset[0]], url.pathname.slice(1))), { "Content-Type": asset[1], "Cache-Control": "no-cache" });
		if (route === "GET /auth/login") {
			const { url: target, transaction } = await oidc.begin();
			return send(res, 302, "", { Location: target, "Set-Cookie": sessions.loginCookie(transaction) });
		}
		if (route === "GET /auth/callback") {
			const transaction = sessions.readLogin(req);
			if (!transaction) return page(res, 400, "signin-expired.html");
			let claims;
			try {
				claims = await oidc.finish(url.href, transaction);
			} catch (error) {
				log.warn(`paca: sign-in failed: ${(error as Error).message}`);
				return page(res, 400, "signin-expired.html");
			}
			const cookies = sessions.start(claims);
			if (!cookies) {
				log.warn(`paca: refused sign-in for subject ${JSON.stringify(claims.sub)} (username ${JSON.stringify(claims.preferred_username ?? null)}) from ${claims.iss}`);
				return page(res, 403, "refused.html");
			}
			return send(res, 303, "", { Location: "/", "Set-Cookie": cookies });
		}
		if (route === "GET /signed-out") return page(res, 200, "signed-out.html");

		const session = sessions.read(req);
		const user = session && users.forSubject(session.sub);
		if (route === "GET /") return user ? page(res, 200, "index.html") : send(res, 302, "", { Location: "/auth/login" });
		if (!session || !user) return json(res, 401, { error: "Sign in again." });
		const { sessions: chats } = user;

		if (route === "GET /api/session") return json(res, 200, { csrf: session.csrf, name: session.name, ...user.info } satisfies SessionInfo);
		const ext = req.method === "GET" ? EXT_ASSET.exec(url.pathname) : null;
		if (ext) {
			// Only a package this user's page lists, and only a file listed at start: the path is a key
			// of that list, never resolved on disk, so traversal and encoded dots find nothing.
			// A path with dot segments is refused before the URL parser resolves them.
			const exact = req.url?.split("?")[0] === url.pathname;
			const file = exact && user.info.extensions?.some((e) => e.name === ext[1]) ? frontends.get(ext[1])?.files.get(ext[2]) : undefined;
			const content = file && (await readFile(file.path).catch(() => undefined));
			if (!file || !content) return json(res, 404, { error: "Not found." });
			return send(res, 200, content, { "Content-Type": file.type, "Cache-Control": "no-cache" });
		}
		if (route === "GET /api/events") {
			const id = url.searchParams.get("session");
			if (id === null) return events(req, res, chats.list, undefined);
			const state = SESSION_ID.test(id) ? await chats.watch(id) : undefined;
			if (!state) return reply(res, { refused: "not-found" });
			return events(req, res, chats.list, state);
		}
		if (req.method === "POST") {
			const refused = checkPost(req, session);
			if (refused) return json(res, 403, { error: `Request refused (${refused}). Reload the page.` });
		}
		if (OLD_ROUTES.has(route)) return json(res, 410, { error: "Paca was updated. Reload the page." });
		const extOp = req.method === "POST" ? EXT_OPERATION.exec(url.pathname) : null;
		if (extOp) {
			// Only a package this user's page lists (tools for them, frontend on) has operations here.
			const op = user.info.extensions?.some((e) => e.name === extOp[1]) ? user.operation?.(extOp[1], extOp[2]) : undefined;
			if (!op) return json(res, 404, { error: "Not found." });
			const input = await body(req);
			if (typeof input !== "object" || input === null || Array.isArray(input)) return json(res, 400, { error: "The request must be a JSON object." });
			return operate(res, user, extOp[1], extOp[2], op, input);
		}
		if (route === "POST /api/sessions") {
			const fields = await body(req);
			const asked = question(fields);
			if ("error" in asked) return json(res, 400, asked);
			// The one place a client value becomes a file name, so only a lowercase UUID v4 passes.
			if (typeof fields.id !== "string" || !SESSION_ID.test(fields.id)) return json(res, 400, { error: "A new session needs a lowercase UUID v4 id." });
			const result = chats.start(fields.id, asked.text, asked.requestId);
			return reply(res, result.refused ? result : { id: fields.id, ...result }, 202);
		}
		const match = req.method === "POST" ? SESSION_ROUTE.exec(url.pathname) : null;
		if (match) {
			const [, id, action] = match;
			if (!SESSION_ID.test(id)) return reply(res, { refused: "not-found" });
			const fields = await body(req);
			if (action === "messages") {
				const asked = question(fields);
				if ("error" in asked) return json(res, 400, asked);
				return reply(res, chats.ask(id, asked.text, asked.requestId), 202);
			}
			if (action === "stop") return reply(res, chats.stop(id), 202);
			if (action === "delete") return reply(res, await chats.remove(id));
			// Only the draft id is read; the content created is the stored draft the card showed.
			const draftId = fields.id;
			if (typeof draftId !== "string" || !draftId || draftId.length > 200) return json(res, 400, { error: "Missing draft id." });
			const result = action === "drafts/approve" ? await chats.approveDraft(id, draftId) : chats.dismissDraft(id, draftId);
			if (result.refused === "not-found") return json(res, 404, { error: "That draft does not exist." });
			return reply(res, result);
		}
		if (route === "POST /auth/logout") return json(res, 200, {}, { "Set-Cookie": sessions.end() });
		return json(res, 404, { error: "Not found." });
	}

	return createServer((req, res) => {
		handle(req, res).catch((error: Error & { status?: number }) => {
			if (!error.status) log.error("paca: request failed", error);
			if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : "Something went wrong on the server." });
			else res.end();
		});
	});
}
