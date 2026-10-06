// Disposable fakes for the container smoke test, served over HTTPS with a throwaway certificate:
// an OIDC provider and an OpenAI-compatible model. Runs in its own container; never in the image.
// The authorization code is the claims themselves, so the test can sign in without a browser.
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const ISSUER = "https://fakes:8443/";
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

/** First request of an answer: draft an issue. Once a tool result is back: answer in text. */
function completion(request) {
	const toolResult = request.messages.some((m) => m.role === "tool");
	const chunk = (delta, finish = null) => ({ id: "smoke", object: "chat.completion.chunk", created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] });
	if (toolResult) return [chunk({ role: "assistant", content: "Smoke answer: drafted one issue." }), chunk({}, "stop")];
	const args = JSON.stringify({ repository: "example/repo", title: "Smoke draft", body: "Made by the container smoke test." });
	return [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name: "draft_issue", arguments: args } }] }), chunk({}, "tool_calls")];
}

const json = (res, status, value) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(value));
};

createServer({ key: readFileSync("/tls/key.pem"), cert: readFileSync("/tls/cert.pem") }, async (req, res) => {
	const url = new URL(req.url, ISSUER);
	const route = `${req.method} ${url.pathname}`;
	console.log(`fakes: ${route}`);
	if (route === "GET /.well-known/openid-configuration") {
		return json(res, 200, {
			issuer: ISSUER,
			authorization_endpoint: `${ISSUER}authorize`,
			token_endpoint: `${ISSUER}token`,
			jwks_uri: `${ISSUER}jwks`,
			response_types_supported: ["code"],
			subject_types_supported: ["public"],
			id_token_signing_alg_values_supported: ["ES256"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
		});
	}
	if (route === "GET /jwks") return json(res, 200, { keys: [jwk] });
	if (route === "POST /token") {
		// The client secret must arrive at runtime through PACA_OIDC_CLIENT_SECRET.
		const form = new URLSearchParams(await readBody(req));
		const basic = `Basic ${Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString("base64")}`;
		const posted = form.get("client_id") === CLIENT.id && form.get("client_secret") === CLIENT.secret;
		if (req.headers.authorization !== basic && !posted) return json(res, 401, { error: "invalid_client" });
		const { sub, username, nonce } = JSON.parse(Buffer.from(form.get("code") ?? "", "base64url").toString("utf8"));
		const now = Math.floor(Date.now() / 1000);
		const claims = { iss: ISSUER, aud: CLIENT.id, sub, preferred_username: username, nonce, iat: now, exp: now + 300 };
		return json(res, 200, { access_token: "smoke-access-token", token_type: "Bearer", expires_in: 300, id_token: idToken(claims) });
	}
	if (route === "POST /v1/chat/completions") {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		for (const chunk of completion(JSON.parse(await readBody(req)))) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
		return res.end("data: [DONE]\n\n");
	}
	json(res, 404, { error: "not found" });
}).listen(8443, () => console.log("fakes: listening on 8443"));
