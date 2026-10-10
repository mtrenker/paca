// Calling an API as the signed-in user (#21): grants from sign-in, held in memory, against the fake
// Example API (test/container/fake-api.mjs) answered in process. No network, no real provider.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "@paca/extension";
import { API_PATH, createFakeApi } from "../../../test/container/fake-api.mjs";
import { createApiAccess, GRANT_MS, RefreshRefused, resolveBelow } from "../src/api-access.ts";

const ORIGIN = "https://api.test";
const SCOPE = "openid profile offline_access notes.read notes.write";
const API = { name: "notes", label: "Example API", url: `${ORIGIN}${API_PATH}`, scopes: ["notes.read", "notes.write"], extensions: ["example-notes"] };

/**
 * The fake API and access on one clock. `refreshes` counts calls to the issuer; `issuer.down` makes
 * them fail as a network error would; `issuer.subject` and `issuer.scope` change what a refresh says.
 */
function setUp() {
	const clock = { now: Date.parse("2026-10-10T10:00:00Z") };
	const now = () => clock.now;
	const fake = createFakeApi({ audience: "paca", accessSeconds: 300, now });
	const issuer = { refreshes: 0, down: false, subject: undefined, scope: undefined };
	const lines = [];
	const access = createApiAccess({
		apis: { notes: API },
		refresh: async (token) => {
			issuer.refreshes += 1;
			if (issuer.down) throw new TypeError("fetch failed");
			const answer = await fake.renew(token);
			if (!answer) throw new RefreshRefused("invalid_grant");
			return grantOf(answer, issuer.subject, now, issuer.scope);
		},
		fetch: (url, init) => fake.handle(new Request(url, init)),
		now,
		log: { warn: (line) => lines.push(line) },
	});
	const grantFor = (sub, username, scope = SCOPE) => grantOf(fake.issue({ sub, username, scope }), sub, now);
	return { fake, access, clock, issuer, lines, grantFor, signIn: (user, sub, username, scope) => user.signedIn(grantFor(sub, username, scope)) };
}

/** A token answer as auth.ts keeps it, for the subject an ID token named (none on most refreshes). */
const grantOf = (answer, subject, now = Date.now, scope = answer.scope) => ({ accessToken: answer.access_token, refreshToken: answer.refresh_token, expiresAt: now() + answer.expires_in * 1000, scope, ...(subject ? { subject } : {}) });
const signIn = (fake, user, sub, username, scope = SCOPE) => user.signedIn(grantOf(fake.issue({ sub, username, scope }), sub));

describe("API access with the sign-in's access token", () => {
	it("lets each of two users' extensions read only as that user", async () => {
		const { fake, access } = setUp();
		const martin = access.forUser("martin", "sub-martin", ["notes"]);
		const alex = access.forUser("alex", "sub-alex", ["notes"]);
		signIn(fake, martin, "sub-martin", "martin (synthetic)");
		signIn(fake, alex, "sub-alex", "alex (synthetic)");
		assert.deepEqual((await martin.forExtension("example-notes").notes.request("/me")).body, { subject: "sub-martin", username: "martin (synthetic)" });
		assert.deepEqual((await alex.forExtension("example-notes").notes.request("/me")).body, { subject: "sub-alex", username: "alex (synthetic)" });
		assert.deepEqual(martin.status(), [{ name: "notes", label: "Example API", state: "ready" }]);
		assert.deepEqual(Object.keys(martin.forExtension("other")), [], "another extension gets nothing");
		assert.deepEqual(Object.keys(access.forUser("sam", "sub-sam", []).forExtension("example-notes")), [], "a user not allowed the API gets nothing");
	});

	it("asks for a new sign-in without a grant, never using another user's, and keeps no grant for another subject", async () => {
		const { fake, access } = setUp();
		const martin = access.forUser("martin", "sub-martin", ["notes"]);
		const alex = access.forUser("alex", "sub-alex", ["notes"]);
		signIn(fake, martin, "sub-martin", "martin");
		alex.signedIn(grantOf(fake.issue({ sub: "sub-martin", username: "martin", scope: SCOPE }), "sub-martin"));
		assert.equal(alex.status()[0].state, "sign-in");
		const before = fake.seen.length;
		await assert.rejects(alex.forExtension("example-notes").notes.request("/notes"), (e) => e instanceof ApiError && e.code === "sign-in" && !e.sent);
		assert.equal(fake.seen.length, before, "nothing was sent");
		martin.signedOut();
		assert.equal(martin.status()[0].state, "sign-in");
	});

	it("refuses destinations outside the API before sending, and never follows a redirect", async () => {
		const { fake, access } = setUp();
		const martin = access.forUser("martin", "sub-martin", ["notes"]);
		signIn(fake, martin, "sub-martin", "martin");
		const api = martin.forExtension("example-notes").notes;
		for (const path of ["https://elsewhere.invalid/", "//elsewhere.invalid/x", "/../../token", "/%2e%2e/x", "/a/%2F/b", "notes", "/a\\b", "/x#y"]) {
			await assert.rejects(api.request(path), (e) => e.code === "destination" && !e.sent, path);
		}
		const before = fake.seen.length;
		await assert.rejects(api.request("/moved"), (e) => e.code === "redirect" && e.sent);
		assert.equal(fake.seen.length, before + 1);
		assert.equal(resolveBelow(API.url, "/notes?x=1").href, `${API.url}notes?x=1`);
	});

	it("marks an API not granted when the sign-in lacks its scopes", async () => {
		const { fake, access } = setUp();
		const martin = access.forUser("martin", "sub-martin", ["notes"]);
		signIn(fake, martin, "sub-martin", "martin", "openid profile notes.read");
		assert.equal(martin.status()[0].state, "not-granted");
		await assert.rejects(martin.forExtension("example-notes").notes.request("/notes"), (e) => e.code === "not-granted" && !e.sent);
	});

	describe("lifetime", () => {
		const ready = (t) => {
			const martin = t.access.forUser("martin", "sub-martin", ["notes"]);
			t.signIn(martin, "sub-martin", "martin");
			return { martin, api: martin.forExtension("example-notes").notes };
		};

		it("renews an access token about to expire before using it, with the rotated refresh token", async () => {
			const t = setUp();
			const { api } = ready(t);
			const [firstRefresh] = t.fake.refresh.keys();
			t.clock.now += 250_000; // 50 seconds left
			assert.equal((await api.request("/notes")).status, 200);
			assert.equal(t.issuer.refreshes, 1);
			assert.equal(t.fake.refresh.has(firstRefresh), false, "the old refresh token is used up");
			t.clock.now += 250_000;
			assert.equal((await api.request("/notes")).status, 200);
			assert.equal(t.issuer.refreshes, 2, "the rotated refresh token was used");
		});

		it("refreshes once for simultaneous requests, across the user's sessions", async () => {
			const t = setUp();
			const { martin, api } = ready(t);
			const other = martin.forExtension("example-notes").notes; // another session's tools share the grant
			t.fake.faults.refreshDelayMs = 30;
			t.clock.now += 290_000;
			const answers = await Promise.all([api.request("/notes"), other.request("/me"), api.request("/notes"), other.request("/notes")]);
			assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200]);
			assert.equal(t.issuer.refreshes, 1);
		});

		it("ends the grant when the issuer refuses a refresh, without sending the request", async () => {
			const t = setUp();
			const { martin, api } = ready(t);
			t.fake.faults.refuseRefresh = true;
			t.clock.now += 290_000;
			const seen = t.fake.seen.length;
			await assert.rejects(api.request("/notes"), (e) => e instanceof ApiError && e.code === "sign-in" && !e.sent);
			assert.equal(martin.status()[0].state, "sign-in");
			assert.equal(t.fake.seen.length, seen);
			assert.match(t.lines.join("\n"), /user martin: refresh refused \(invalid_grant\)/);
			await assert.rejects(api.request("/notes"), (e) => e.code === "sign-in");
			assert.equal(t.issuer.refreshes, 1, "a refused refresh is not tried again");
		});

		it("keeps the grant when the issuer cannot be reached, failing only that request", async () => {
			const t = setUp();
			const { martin, api } = ready(t);
			t.issuer.down = true;
			t.clock.now += 290_000;
			await assert.rejects(api.request("/notes"), (e) => e.code === "refresh" && !e.sent);
			assert.equal(martin.status()[0].state, "ready");
			t.issuer.down = false;
			assert.equal((await api.request("/notes")).status, 200);
		});

		it("retries a read once after a 401 with a fresh token, but never a write", async () => {
			const t = setUp();
			const { api } = ready(t);
			t.fake.access.clear(); // the API stops accepting the token before it expires
			assert.equal((await api.request("/notes")).status, 200);
			assert.deepEqual(t.fake.seen.slice(-2).map((r) => [r.method, r.path, r.sub]), [["GET", "notes", undefined], ["GET", "notes", "sub-martin"]]);
			assert.equal(t.issuer.refreshes, 1);
			t.fake.access.clear();
			const answer = await api.request("/notes", { method: "POST", body: { text: "once" } });
			assert.equal(answer.status, 401);
			assert.equal(t.fake.seen.filter((r) => r.method === "POST").length, 1);
			assert.equal(t.issuer.refreshes, 1, "a write's 401 does not refresh and resend");
		});

		it("reports a write whose answer is lost as possibly sent, and sends it once", async () => {
			const t = setUp();
			const martin = t.access.forUser("martin", "sub-martin", ["notes"]);
			let posts = 0;
			const lossy = createApiAccess({ apis: { notes: API }, refresh: async () => assert.fail("no refresh"), fetch: async (url, init) => (init.method === "POST" ? (posts++, Promise.reject(new TypeError("socket hang up"))) : t.fake.handle(new Request(url, init))), now: () => t.clock.now });
			const user = lossy.forUser("martin", "sub-martin", ["notes"]);
			user.signedIn(t.grantFor("sub-martin", "martin"));
			await assert.rejects(user.forExtension("example-notes").notes.request("/notes", { method: "POST", body: { text: "x" } }), (e) => e.code === "unreachable" && e.sent);
			assert.equal(posts, 1);
			assert.equal(martin.status()[0].state, "sign-in", "the other access instance holds nothing");
		});

		it("ends the grant with the sign-in's 12-hour session, even with a refresh token", async () => {
			const t = setUp();
			const { martin, api } = ready(t);
			t.clock.now += GRANT_MS - 1000;
			assert.equal((await api.request("/notes")).status, 200);
			t.clock.now += 1000;
			assert.equal(martin.status()[0].state, "sign-in");
			await assert.rejects(api.request("/notes"), (e) => e.code === "sign-in" && !e.sent);
		});

		it("ends the grant when a refresh names another subject or narrows the scopes", async () => {
			for (const change of [{ subject: "sub-alex" }, { scope: "openid notes.read" }]) {
				const t = setUp();
				const { martin, api } = ready(t);
				Object.assign(t.issuer, change);
				t.clock.now += 290_000;
				await assert.rejects(api.request("/notes"), (e) => e.code === "sign-in" && !e.sent);
				assert.equal(martin.status()[0].state, "sign-in", JSON.stringify(change));
			}
		});

		it("drops a refresh that finishes after sign-out, and a grant without a refresh token at expiry", async () => {
			const t = setUp();
			const { martin, api } = ready(t);
			t.fake.faults.refreshDelayMs = 30;
			t.clock.now += 290_000;
			const pending = api.request("/notes");
			martin.signedOut();
			await assert.rejects(pending, (e) => e.code === "sign-in");
			assert.equal(martin.status()[0].state, "sign-in", "the late refresh did not bring the grant back");
			t.signIn(martin, "sub-martin", "martin", "openid profile notes.read notes.write"); // no offline_access
			t.clock.now += 301_000;
			assert.equal(martin.status()[0].state, "sign-in");
			await assert.rejects(api.request("/notes"), (e) => e.code === "sign-in");
		});
	});
});
