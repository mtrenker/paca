// Paca's sign-in keeps the access token for the configured APIs (#21), with the real openid-client
// against a small issuer answered in process (no network): the grant is the access token, never
// the ID token; the configured scopes are asked for; a wrong state, nonce or PKCE verifier gets no
// grant; a refused refresh is told apart from an unreachable issuer.
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { API_PATH, createFakeApi } from "../../../test/container/fake-api.mjs";
import { RefreshRefused } from "../src/api-access.ts";
import { createOidc } from "../src/auth.ts";
import { signInScopes } from "../src/config.ts";

const ISSUER = "https://id.example.test/";
const CLIENT = { id: "paca", secret: "test-secret" };
const REDIRECT = "https://paca.example.test/auth/callback";

/** An issuer with discovery, keys and a token endpoint that checks PKCE, issuing the fake API's tokens. */
function issuer() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
	const sign = (claims) => {
		const input = `${b64({ alg: "ES256", kid: "k" })}.${b64(claims)}`;
		return `${input}.${createSign("sha256").update(input).sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
	};
	const api = createFakeApi({ audience: CLIENT.id });
	const codes = new Map();
	const state = { down: false, idToken: undefined };
	const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
	async function handle(url, init) {
		if (state.down) throw new TypeError("fetch failed");
		const request = new Request(url, init);
		const path = new URL(request.url).pathname;
		if (path === "/.well-known/openid-configuration") return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}authorize`, token_endpoint: `${ISSUER}token`, jwks_uri: `${ISSUER}jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["ES256"], code_challenge_methods_supported: ["S256"] });
		if (path === "/jwks") return json(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k", alg: "ES256", use: "sig" }] });
		const form = new URLSearchParams(await request.text());
		if (form.get("grant_type") === "refresh_token") {
			const answer = await api.renew(form.get("refresh_token"));
			return answer ? json(200, answer) : json(400, { error: "invalid_grant" });
		}
		const code = codes.get(form.get("code"));
		codes.delete(form.get("code"));
		if (!code || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== code.challenge) return json(400, { error: "invalid_grant" });
		const now = Math.floor(Date.now() / 1000);
		const claims = { iss: ISSUER, aud: CLIENT.id, sub: "sub-martin", nonce: code.nonce, iat: now, exp: now + 300, ...state.idToken };
		return json(200, { ...api.issue({ sub: "sub-martin", username: "martin", scope: code.scope }), id_token: sign(claims) });
	}
	/** The provider's half of the browser flow: a code for the authorization request, returned to Paca. */
	const authorize = (authorizationUrl, { state: given } = {}) => {
		const asked = new URL(authorizationUrl).searchParams;
		const code = `code-${codes.size}-${Math.random()}`;
		codes.set(code, { challenge: asked.get("code_challenge"), nonce: asked.get("nonce"), scope: asked.get("scope") });
		return `${REDIRECT}?code=${code}&state=${given ?? asked.get("state")}`;
	};
	return { handle, authorize, api, state };
}

const config = { oidc: { issuer: ISSUER, clientId: CLIENT.id, scopes: ["offline_access"] }, apis: { notes: { name: "notes", label: "Notes", url: `https://api.example.test${API_PATH}`, scopes: ["notes.read", "notes.write"], extensions: [] } } };

async function signInClient(fake) {
	return createOidc({ issuer: ISSUER, clientId: CLIENT.id, clientSecret: CLIENT.secret, redirectUri: REDIRECT, scopes: signInScopes(config), customFetch: fake.handle });
}

describe("sign-in grant", () => {
	it("asks for the APIs' scopes and keeps the access token, not the ID token", async () => {
		const fake = issuer();
		const oidc = await signInClient(fake);
		const { url, transaction } = await oidc.begin();
		assert.equal(new URL(url).searchParams.get("scope"), "openid profile offline_access notes.read notes.write");
		const { claims, grant } = await oidc.finish(fake.authorize(url), transaction);
		assert.equal(claims.sub, "sub-martin");
		assert.ok(fake.api.access.has(grant.accessToken), "the grant carries the access token");
		assert.ok(fake.api.refresh.has(grant.refreshToken));
		assert.equal(grant.subject, "sub-martin");
		assert.equal(grant.scope, "openid profile offline_access notes.read notes.write");
		assert.ok(grant.expiresAt > Date.now());
		assert.ok(!Object.values(grant).some((v) => typeof v === "string" && v.startsWith("eyJ")), "no JWT, so no ID token, in the grant");
		const answer = await fake.api.handle(new Request(`https://api.example.test${API_PATH}me`, { headers: { Authorization: `Bearer ${grant.accessToken}` } }));
		assert.equal(answer.status, 200);
	});

	it("gets no grant for a wrong state, a wrong nonce or another verifier", async () => {
		const fake = issuer();
		const oidc = await signInClient(fake);
		const { url, transaction } = await oidc.begin();
		await assert.rejects(oidc.finish(fake.authorize(url, { state: "forged" }), transaction));
		await assert.rejects(oidc.finish(fake.authorize(url), { ...transaction, nonce: "another" }));
		await assert.rejects(oidc.finish(fake.authorize(url), { ...transaction, verifier: "another-verifier-of-sufficient-length-0123456789" }));
		fake.state.idToken = { aud: "another-client" };
		await assert.rejects(oidc.finish(fake.authorize(url), transaction), "an ID token for another client");
	});

	it("tells a refused refresh from an unreachable issuer", async () => {
		const fake = issuer();
		const oidc = await signInClient(fake);
		const { url, transaction } = await oidc.begin();
		const { grant } = await oidc.finish(fake.authorize(url), transaction);
		const renewed = await oidc.refresh(grant.refreshToken);
		assert.ok(fake.api.access.has(renewed.accessToken));
		assert.notEqual(renewed.refreshToken, grant.refreshToken, "rotated");
		await assert.rejects(oidc.refresh(grant.refreshToken), RefreshRefused, "a used refresh token is refused");
		fake.state.down = true;
		await assert.rejects(oidc.refresh(renewed.refreshToken), (e) => !(e instanceof RefreshRefused));
	});
});
