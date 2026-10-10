// Sign-in through the configured OIDC provider (authentik) and signed session cookies.
// Only the configured issuer and the subjects of configured users get a session; nothing trusts
// proxy headers.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import * as oidc from "openid-client";
import { type Grant, RefreshRefused } from "./api-access.ts";

export const SESSION_COOKIE = "__Host-paca";
const LOGIN_COOKIE = "__Host-paca-login";
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;

export interface Session {
	iss: string;
	sub: string;
	name: string;
	csrf: string;
	exp: number;
}
export type Sessions = ReturnType<typeof createSessions>;
export type Oidc = Pick<Awaited<ReturnType<typeof createOidc>>, "begin" | "finish">;
type Claims = { iss: string; sub: string; preferred_username?: unknown; name?: unknown; [key: string]: unknown };

export async function loadSessionKey(dataDir: string): Promise<Buffer> {
	const path = join(dataDir, "session.key");
	try {
		return await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const key = randomBytes(32);
		await writeFile(path, key, { mode: 0o600, flag: "wx" });
		return key;
	}
}

const b64 = (buffer: Buffer | string) => Buffer.from(buffer).toString("base64url");

/**
 * @param allows whether a subject of `issuer` belongs to a configured user. Checked on every request,
 * so removing a user from the config ends their sessions at the next restart.
 */
export function createSessions({ key, issuer, allows, now = () => Date.now() }: { key: Buffer; issuer: string; allows: (subject: string) => boolean; now?: () => number }) {
	const sign = (payload: object) => {
		const body = b64(JSON.stringify(payload));
		return `${body}.${b64(createHmac("sha256", key).update(body).digest())}`;
	};
	const verify = (value: unknown): Record<string, unknown> | undefined => {
		const [body, mac] = String(value ?? "").split(".");
		if (!body || !mac) return undefined;
		const expected = createHmac("sha256", key).update(body).digest();
		const given = Buffer.from(mac, "base64url");
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
		const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		return payload.exp > now() / 1000 ? payload : undefined;
	};
	const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

	return {
		/** The session of this request, only while it still belongs to a configured user. */
		read(req: IncomingMessage): Session | undefined {
			const session = verify(parseCookies(req)[SESSION_COOKIE]);
			return session && session.iss === issuer && typeof session.sub === "string" && allows(session.sub) ? (session as unknown as Session) : undefined;
		},
		/** Returns Set-Cookie values for a new session, or undefined when the identity is not allowed. */
		start(claims: Claims) {
			if (claims.iss !== issuer || !allows(claims.sub)) return undefined;
			const session: Session = { iss: claims.iss, sub: claims.sub, name: String(claims.preferred_username ?? claims.name ?? ""), csrf: b64(randomBytes(24)), exp: Math.floor(now() / 1000) + SESSION_SECONDS };
			return [cookie(SESSION_COOKIE, sign(session), SESSION_SECONDS), cookie(LOGIN_COOKIE, "", 0)];
		},
		end: () => [cookie(SESSION_COOKIE, "", 0)],
		loginCookie: (transaction: object) => cookie(LOGIN_COOKIE, sign({ ...transaction, exp: Math.floor(now() / 1000) + LOGIN_SECONDS }), LOGIN_SECONDS),
		readLogin: (req: IncomingMessage) => verify(parseCookies(req)[LOGIN_COOKIE]) as Transaction | undefined,
	};
}

export function parseCookies(req: IncomingMessage) {
	const out: Record<string, string> = {};
	for (const part of String(req.headers.cookie ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

/** Authorization code flow with PKCE, state and nonce against the configured issuer. */
export interface Transaction {
	verifier: string;
	state: string;
	nonce: string;
}

/**
 * @param scopes asked for at sign-in (config.signInScopes): "openid profile", then any for refresh
 * tokens and the configured APIs. The access token is kept in memory for those APIs (api-access.ts).
 */
export async function createOidc({ issuer, clientId, clientSecret, redirectUri, scopes = ["openid", "profile"], customFetch }: { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scopes?: readonly string[]; customFetch?: typeof fetch }) {
	const config = await oidc.discovery(new URL(issuer), clientId, clientSecret, undefined, customFetch ? { [oidc.customFetch]: customFetch as oidc.CustomFetch } : undefined);
	/** The tokens as a grant for the configured APIs. Never an ID token: that is not an API credential. */
	const grantOf = (tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers): Grant => {
		const expiresIn = tokens.expiresIn();
		const subject = tokens.claims()?.sub;
		return {
			accessToken: tokens.access_token,
			...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
			...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
			...(typeof tokens.scope === "string" ? { scope: tokens.scope } : {}),
			...(subject ? { subject } : {}),
		};
	};
	return {
		/** The issuer as the provider states it; ID tokens must carry exactly this value. */
		issuer: config.serverMetadata().issuer,
		async begin(): Promise<{ url: string; transaction: Transaction }> {
			const verifier = oidc.randomPKCECodeVerifier();
			const transaction = { verifier, state: oidc.randomState(), nonce: oidc.randomNonce() };
			const url = oidc.buildAuthorizationUrl(config, {
				redirect_uri: redirectUri,
				scope: scopes.join(" "),
				code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
				code_challenge_method: "S256",
				state: transaction.state,
				nonce: transaction.nonce,
			});
			return { url: url.href, transaction };
		},
		/** Validates the callback and returns the ID token claims, and the grant for the configured APIs. */
		async finish(callbackUrl: string, transaction: Transaction): Promise<{ claims: Claims; grant?: Grant }> {
			const tokens = await oidc.authorizationCodeGrant(config, new URL(callbackUrl), {
				pkceCodeVerifier: transaction.verifier,
				expectedState: transaction.state,
				expectedNonce: transaction.nonce,
				idTokenExpected: true,
			});
			return { claims: tokens.claims() as Claims, grant: grantOf(tokens) };
		},
		/** A fresh grant for a refresh token. Throws RefreshRefused when the issuer answers with a refusal. */
		async refresh(refreshToken: string): Promise<Grant> {
			try {
				return grantOf(await oidc.refreshTokenGrant(config, refreshToken));
			} catch (error) {
				// A temporary failure keeps the grant and fails only this request; anything else ends it.
				if (temporary(error)) throw error;
				const code = (error as { code?: string })?.code ?? "";
				throw new RefreshRefused((error as { error?: string }).error ?? (code || "refused"));
			}
		},
	};
}

/**
 * Whether a failed refresh says nothing about the grant: no answer (a network error, a timeout), or
 * an issuer that is down, overloaded or slow (HTTP 5xx, 408, 429, also as a proxy's HTML page). Any
 * other answer, a 4xx such as invalid_grant or tokens that fail validation, is a refusal.
 * openid-client 6 gives the status on a ResponseBodyError, or as the Response in `cause`.
 */
function temporary(error: unknown): boolean {
	const { code = "", status, cause } = (error ?? {}) as { code?: string; status?: unknown; cause?: unknown };
	if (code === "OAUTH_TIMEOUT" || code === "OAUTH_ABORT") return true;
	const answered = typeof status === "number" ? status : cause instanceof Response ? cause.status : undefined;
	if (answered !== undefined) return answered >= 500 || answered === 408 || answered === 429;
	return !(error instanceof oidc.ResponseBodyError) && !code.startsWith("OAUTH_");
}
