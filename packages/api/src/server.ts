// HTTP routes: sign-in, the page, prompts as POSTs and the conversation as an SSE stream.
// Binds to loopback unless PACA_HOST says otherwise; HTTPS comes from the reverse proxy in front.
// Every route after sign-in acts for the user of the verified session, and only for them.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { ConversationBusy } from "@earendil-works/pi-durable";
import type { PageState, SessionInfo } from "@paca/contracts";
import type { Oidc, Session, Sessions } from "./auth.ts";

const SECURITY_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
};
const STATIC: Record<string, ["public" | "script", string]> = { "/app.js": ["script", "text/javascript"], "/style.css": ["public", "text/css"], "/icon.svg": ["public", "image/svg+xml"] };
const MAX_BODY = 16 * 1024;
const MAX_QUESTION = 4000;

/** What the routes need of one user: their conversation, their page state and their header info. */
export interface RouteUser {
	paca: {
		ask(text: string, requestId: string): Promise<{ id: unknown; duplicate: boolean }>;
		stop(): void;
		approveDraft(id: string): Promise<{ refused?: string } & Record<string, unknown>>;
		dismissDraft(id: string): Promise<{ refused?: string } & Record<string, unknown>>;
	};
	state: StateFeed;
	info: Omit<SessionInfo, "csrf" | "name">;
}

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

	function events(req: IncomingMessage, res: Res, state: StateFeed) {
		res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
		const push = (value: PageState) => res.write(`event: state\ndata: ${JSON.stringify(value)}\n\n`);
		push(state.current()); // every connection starts from a fresh snapshot
		const unsubscribe = state.subscribe(push);
		const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
		req.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
	}

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
		const { paca } = user;

		if (route === "GET /api/session") return json(res, 200, { csrf: session.csrf, name: session.name, ...user.info } satisfies SessionInfo);
		if (route === "GET /api/events") return events(req, res, user.state);
		if (req.method === "POST") {
			const refused = checkPost(req, session);
			if (refused) return json(res, 403, { error: `Request refused (${refused}). Reload the page.` });
		}
		if (route === "POST /api/messages") {
			const { text, requestId } = await body(req);
			if (typeof text !== "string" || !text.trim() || text.length > MAX_QUESTION) return json(res, 400, { error: `Questions need 1 to ${MAX_QUESTION} characters.` });
			if (typeof requestId !== "string" || !/^[\w-]{8,64}$/.test(requestId)) return json(res, 400, { error: "Missing request id." });
			try {
				const { id, duplicate } = await paca.ask(text.trim(), requestId);
				return json(res, 202, { id, duplicate });
			} catch (error) {
				if (error instanceof ConversationBusy) return json(res, 409, { error: "Paca is still answering. Stop it or wait." });
				throw error;
			}
		}
		if (route === "POST /api/drafts/approve" || route === "POST /api/drafts/dismiss") {
			// Only the draft id is read; the content created is the stored draft the card showed.
			const { id } = await body(req);
			if (typeof id !== "string" || !id || id.length > 200) return json(res, 400, { error: "Missing draft id." });
			const result = route.endsWith("approve") ? await paca.approveDraft(id) : await paca.dismissDraft(id);
			if (result.refused === "not-found") return json(res, 404, { error: "That draft does not exist." });
			if (result.refused === "unavailable") return json(res, 409, { error: "That draft can't be created: its tool package is not enabled for you.", status: "proposed" });
			if (result.refused) return json(res, 409, { error: `That draft is already ${result.refused}.`, status: result.refused });
			return json(res, 200, result);
		}
		if (route === "POST /api/stop") {
			paca.stop();
			return json(res, 202, {});
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

/** Keeps the latest page state and fans it out, throttled, to every open stream. */
export type StateFeed = ReturnType<typeof createStateFeed>;

export function createStateFeed(compute: () => PageState, intervalMs = 120) {
	let latest = compute();
	let timer: NodeJS.Timeout | undefined;
	const listeners = new Set<(state: PageState) => void>();
	return {
		current: () => latest,
		subscribe(fn: (state: PageState) => void) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		changed() {
			if (timer) return;
			timer = setTimeout(() => {
				timer = undefined;
				latest = compute();
				for (const fn of listeners) fn(latest);
			}, intervalMs);
		},
	};
}
