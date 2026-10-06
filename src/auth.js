// Sign-in through the configured OIDC provider (authentik) and signed session cookies.
// Only the one configured issuer and subject get a session; nothing trusts proxy headers.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as oidc from "openid-client";

export const SESSION_COOKIE = "__Host-paca";
const LOGIN_COOKIE = "__Host-paca-login";
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;

export async function loadSessionKey(dataDir) {
	const path = join(dataDir, "session.key");
	try {
		return await readFile(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const key = randomBytes(32);
		await writeFile(path, key, { mode: 0o600, flag: "wx" });
		return key;
	}
}

const b64 = (buffer) => Buffer.from(buffer).toString("base64url");

export function createSessions({ key, issuer, allowedSubject, now = () => Date.now() }) {
	const sign = (payload) => {
		const body = b64(JSON.stringify(payload));
		return `${body}.${b64(createHmac("sha256", key).update(body).digest())}`;
	};
	const verify = (value) => {
		const [body, mac] = String(value ?? "").split(".");
		if (!body || !mac) return undefined;
		const expected = createHmac("sha256", key).update(body).digest();
		const given = Buffer.from(mac, "base64url");
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
		const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		return payload.exp > now() / 1000 ? payload : undefined;
	};
	const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

	return {
		/** The session of this request, only while it still belongs to the allowed identity. */
		read(req) {
			const session = verify(parseCookies(req)[SESSION_COOKIE]);
			return session && session.iss === issuer && session.sub === allowedSubject ? session : undefined;
		},
		/** Returns Set-Cookie values for a new session, or undefined when the identity is not allowed. */
		start(claims) {
			if (claims.iss !== issuer || claims.sub !== allowedSubject) return undefined;
			const session = { iss: claims.iss, sub: claims.sub, name: claims.preferred_username ?? claims.name ?? "", csrf: b64(randomBytes(24)), exp: Math.floor(now() / 1000) + SESSION_SECONDS };
			return [cookie(SESSION_COOKIE, sign(session), SESSION_SECONDS), cookie(LOGIN_COOKIE, "", 0)];
		},
		end: () => [cookie(SESSION_COOKIE, "", 0)],
		loginCookie: (transaction) => cookie(LOGIN_COOKIE, sign({ ...transaction, exp: Math.floor(now() / 1000) + LOGIN_SECONDS }), LOGIN_SECONDS),
		readLogin: (req) => verify(parseCookies(req)[LOGIN_COOKIE]),
	};
}

export function parseCookies(req) {
	const out = {};
	for (const part of String(req.headers.cookie ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

/** Authorization code flow with PKCE, state and nonce against the configured issuer. */
export async function createOidc({ issuer, clientId, clientSecret, redirectUri }) {
	const config = await oidc.discovery(new URL(issuer), clientId, clientSecret);
	return {
		/** The issuer as the provider states it; ID tokens must carry exactly this value. */
		issuer: config.serverMetadata().issuer,
		async begin() {
			const verifier = oidc.randomPKCECodeVerifier();
			const transaction = { verifier, state: oidc.randomState(), nonce: oidc.randomNonce() };
			const url = oidc.buildAuthorizationUrl(config, {
				redirect_uri: redirectUri,
				scope: "openid profile",
				code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
				code_challenge_method: "S256",
				state: transaction.state,
				nonce: transaction.nonce,
			});
			return { url: url.href, transaction };
		},
		/** Validates the callback and returns the ID token claims. */
		async finish(callbackUrl, transaction) {
			const tokens = await oidc.authorizationCodeGrant(config, new URL(callbackUrl), {
				pkceCodeVerifier: transaction.verifier,
				expectedState: transaction.state,
				expectedNonce: transaction.nonce,
				idTokenExpected: true,
			});
			return tokens.claims();
		},
	};
}
