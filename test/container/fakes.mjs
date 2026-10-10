// Disposable fakes for the container smoke test and the local preview, served over HTTPS with a
// throwaway certificate: an OIDC provider and an OpenAI-compatible model. Never part of the image.
// The authorization code is the claims themselves, so the smoke test can sign in without a browser;
// the preview's browser signs in through a page listing its synthetic users, on its own HTTPS port.
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { API_PATH, createFakeApi, toNode } from "./fake-api.mjs";

const CLIENT = { id: "paca-smoke", secret: "smoke-client-secret" };
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "smoke", alg: "ES256", use: "sig" };

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
function idToken(claims) {
	const input = `${b64({ alg: "ES256", kid: "smoke", typ: "JWT" })}.${b64(claims)}`;
	const signature = createSign("sha256").update(input).sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
	return `${input}.${signature.toString("base64url")}`;
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

export const FAKE_PROMPT = "Summarise in three lines where you are and what is left to do.";

/**
 * A question that mentions an agent, from a user with Herdr scope: list the agents, then propose
 * FAKE_PROMPT for the first one listed, then answer. A question naming an issue as owner/name#12:
 * read it, then answer slowly, so the preview shows the issue card while the answer streams. A
 * question about notes, from a user with the example's notes tools (#21): read them, or propose
 * one when asked to add or remember something, then answer. Any
 * other question: draft an issue in the first repository of the user's GitHub scope, as the system
 * prompt states it, then answer. Answers stream word by word over the model delay, or `spread`
 * times it.
 */
function completion(request) {
	const turn = request.messages.slice(request.messages.findLastIndex((m) => m.role === "user"));
	const tools = turn.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
	const chunk = (delta, finish = null) => ({ id: "smoke", object: "chat.completion.chunk", created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] });
	const say = (answer, spread = 1) => ({ spread, chunks: [chunk({ role: "assistant", content: "" }), ...answer.split(/(?<= )/).map((word) => chunk({ content: word })), chunk({}, "stop")] });
	const use = (name, args) => ({ spread: 1, chunks: [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }), chunk({}, "tool_calls")] });
	const system = request.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
	const content = turn[0]?.content;
	const asked = typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
	if (/^Herdr scope/m.test(system) && /agent/i.test(asked)) {
		if (tools.length === 0) return use("list_agents", {});
		const pane = tools.length === 1 && /^- .* in ([\w-]+:p\d+):/m.exec(tools[0])?.[1];
		if (pane) return use("propose_prompt", { pane, prompt: FAKE_PROMPT });
		return say(pane === undefined ? "Smoke answer: no agents in scope." : "Smoke answer: proposed a prompt for the first agent.");
	}
	const offered = new Set((request.tools ?? []).map((t) => t.function?.name));
	if (offered.has("read_notes") && /\bnotes?\b/i.test(asked)) {
		const write = /\b(add|remember|write|propose)\b/i.test(asked);
		if (tools.length === 0) return write ? use("propose_note", { note: asked.replace(/^.*?:\s*/, "").slice(0, 200) || "A note from the preview" }) : use("read_notes", {});
		return say(write ? `Smoke answer: ${tools[0]}` : `Smoke answer, from what Paca read:\n\n${tools[0]}`);
	}
	const issue = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/.exec(asked);
	if (issue) {
		if (tools.length === 0) return use("read_issue", { repository: issue[1], number: Number(issue[2]) });
		const read = /^\S+#\d+ \[\w+\]/.test(tools[0]);
		if (!read) return say(`Smoke answer: ${issue[0]} could not be read.`);
		const sentences = [`Smoke answer about ${issue[0]}, streamed slowly so you can tab into its card above while it arrives.`, "The card shows the issue as Paca read it, with when it was read.", "It stays where it is while this text grows, and a focused link in it keeps its focus.", "Nothing here came from GitHub: the preview's gh made the issue up."];
		return say(sentences.join("\n\n"), 4);
	}
	const repository = /^- ([\w.-]+\/[\w.-]+) \(Project /m.exec(system)?.[1];
	if (tools.length || !repository) return say(repository ? `Smoke answer: drafted one issue in ${repository}.` : "Smoke answer: no GitHub scope.");
	return use("draft_issue", { repository, title: "Smoke draft", body: `Made by the fake model for: ${asked.slice(0, 200) || "a question"}` });
}

const json = (res, status, value) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(value));
};
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * @param {object} options
 * @param {string} options.issuer HTTPS origin with a trailing slash, also the model's base
 * @param {number} options.port HTTPS port
 * @param {{ key: Buffer, cert: Buffer }} options.tls
 * @param {number} [options.modelDelayMs] spread each model answer over this long, so the preview shows
 *   an answer in progress and Stop
 * @param {{ origin: string, port: number, users: { sub: string, username: string }[] }} [options.login]
 *   a sign-in page for a browser, listing synthetic users, with the same certificate. Paca's OIDC
 *   client accepts only an HTTPS authorization endpoint. Without it, /authorize is absent.
 * @param {number} [options.accessSeconds] how long the access tokens it issues last. They are
 *   for Paca's client and accepted by the fake Example API under /example-api/v1/ (fake-api.mjs);
 *   asking for `offline_access` adds a rotating refresh token.
 */
export function startFakes({ issuer, port, tls, host, login, modelDelayMs = 0, accessSeconds, log = console.log }) {
	const authorizationEndpoint = login ? `${login.origin}/authorize` : `${issuer}authorize`;
	const exampleApi = createFakeApi({ audience: CLIENT.id, accessSeconds });
	const api = createServer(tls, async (req, res) => {
		const url = new URL(req.url, issuer);
		const route = `${req.method} ${url.pathname}`;
		log(`fakes: ${route}`);
		if (url.pathname.startsWith(API_PATH)) return toNode(req, res, exampleApi.handle);
		if (route === "GET /.well-known/openid-configuration") {
			return json(res, 200, {
				issuer,
				authorization_endpoint: authorizationEndpoint,
				token_endpoint: `${issuer}token`,
				jwks_uri: `${issuer}jwks`,
				response_types_supported: ["code"],
				subject_types_supported: ["public"],
				id_token_signing_alg_values_supported: ["ES256"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
				grant_types_supported: ["authorization_code", "refresh_token"],
			});
		}
		if (route === "GET /jwks") return json(res, 200, { keys: [jwk] });
		if (route === "POST /token") {
			// The client secret must arrive at runtime through PACA_OIDC_CLIENT_SECRET.
			const form = new URLSearchParams(await readBody(req));
			const basic = `Basic ${Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString("base64")}`;
			const posted = form.get("client_id") === CLIENT.id && form.get("client_secret") === CLIENT.secret;
			if (req.headers.authorization !== basic && !posted) return json(res, 401, { error: "invalid_client" });
			if (form.get("grant_type") === "refresh_token") {
				const renewed = await exampleApi.renew(form.get("refresh_token") ?? "");
				return renewed ? json(res, 200, renewed) : json(res, 400, { error: "invalid_grant" });
			}
			// A code from the smoke test may name no scope: then only Paca's own.
			const { sub, username, nonce, scope = "openid profile" } = JSON.parse(Buffer.from(form.get("code") ?? "", "base64url").toString("utf8"));
			const now = Math.floor(Date.now() / 1000);
			const claims = { iss: issuer, aud: CLIENT.id, sub, preferred_username: username, nonce, iat: now, exp: now + 300 };
			return json(res, 200, { ...exampleApi.issue({ sub, username, scope }), id_token: idToken(claims) });
		}
		if (route === "POST /v1/chat/completions") {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const { chunks, spread } = completion(JSON.parse(await readBody(req)));
			for (const chunk of chunks) {
				if (modelDelayMs) await new Promise((resolve) => setTimeout(resolve, (modelDelayMs * spread) / chunks.length));
				if (res.destroyed) return; // Stop aborted the request
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			}
			return res.end("data: [DONE]\n\n");
		}
		json(res, 404, { error: "not found" });
	}).listen(port, host, () => log(`fakes: listening on ${issuer}`));

	// The browser's half of sign-in: pick a synthetic user, return to Paca with that user as the code.
	const page = login
		? createServer(tls, (req, res) => {
				const url = new URL(req.url, login.origin);
				if (url.pathname !== "/authorize") return json(res, 404, { error: "not found" });
				// A stray request, now that a proxy may reach this page: refuse it, never crash the preview.
				if (!URL.canParse(url.searchParams.get("redirect_uri") ?? "")) return json(res, 400, { error: "redirect_uri is required" });
				const back = (user) => {
					const target = new URL(url.searchParams.get("redirect_uri"));
					target.searchParams.set("code", b64({ sub: user.sub, username: user.username, nonce: url.searchParams.get("nonce"), scope: url.searchParams.get("scope") ?? "openid" }));
					target.searchParams.set("state", url.searchParams.get("state") ?? "");
					return target.href;
				};
				const links = login.users.map((u) => `<li><a href="${escape(back(u))}">Sign in as ${escape(u.username)}</a></li>`).join("");
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Fake sign-in</title><h1>Fake sign-in (preview only)</h1><p>Paca asks for: ${escape(url.searchParams.get("scope") ?? "")}</p><ul>${links}</ul>`);
			}).listen(login.port, host, () => log(`fakes: sign-in page on ${login.origin}/authorize`))
		: undefined;

	return { exampleApi, close: () => Promise.all([api, page].filter(Boolean).map((s) => new Promise((resolve) => s.close(resolve)))) };
}

// In the smoke test's container: fixed name, port and certificate.
if (import.meta.main) {
	startFakes({ issuer: "https://fakes:8443/", port: 8443, tls: { key: readFileSync("/tls/key.pem"), cert: readFileSync("/tls/cert.pem") } });
}
