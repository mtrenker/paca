// HTTP routes: sign-in, the page, questions and decisions as POSTs, and the session list and one
// open session as an SSE stream.
// Binds to loopback unless PACA_HOST says otherwise; HTTPS comes from the reverse proxy in front.
// Every route after sign-in acts for the user of the verified session, and only for them.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { PageState, SessionInfo, SessionSummary } from "@paca/contracts";
import type { Oidc, Session, Sessions } from "./auth.ts";
import type { Feed } from "./feed.ts";
import { SESSION_ID } from "./sessions.ts";

const SECURITY_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
};
const STATIC: Record<string, ["public" | "script", string]> = { "/app.js": ["script", "text/javascript"], "/style.css": ["public", "text/css"], "/icon.svg": ["public", "image/svg+xml"] };
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
}

/** How each refusal reads to the page. */
const REFUSED: Record<string, [number, string]> = {
	"not-found": [404, "That session does not exist."],
	busy: [409, "Paca is still answering in this session. Stop it or wait."],
	exists: [409, "That session already exists."],
	deleting: [409, "That session is being deleted."],
	creating: [409, "An issue of this session is being created. Wait for it, then delete."],
	unavailable: [409, "That draft can't be created: its tool package is not enabled for you."],
};

export interface AppDeps {
	config: { publicUrl: string; publicOrigin: string };
	sessions: Sessions;
	oidc: Oidc;
	/** The user a verified session's subject belongs to. */
	users: { forSubject(subject: string): RouteUser | undefined };
	/** `public`: HTML, CSS and icon; `script`: the compiled app.js. */
	web: { public: string; script: string };
	log?: Pick<Console, "warn" | "error">;
}

export function createApp({ config, sessions, oidc, users, web, log = console }: AppDeps) {
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
