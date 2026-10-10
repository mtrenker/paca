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

	describe("conditional writes", () => {
		const ready = (t) => {
			const martin = t.access.forUser("martin", "sub-martin", ["notes"]);
			t.signIn(martin, "sub-martin", "martin");
			return martin.forExtension("example-notes").notes;
		};
		const etagOf = async (api) => (await api.request("/notes")).body.notes[0].etag;

		it("sends the exact strong If-Match on a write, and none when it is left out", async () => {
			const t = setUp();
			const api = ready(t);
			const etag = await etagOf(api);
			assert.equal(etag, '"note-1-v1"');
			const answer = await api.request("/notes/1", { method: "PATCH", body: { text: "edited" }, ifMatch: etag });
			assert.deepEqual([answer.status, answer.body.etag], [200, '"note-1-v2"']);
			assert.equal(t.fake.seen.at(-1).ifMatch, etag, "unchanged on the wire");
			await api.request("/notes", { method: "POST", body: { text: "plain" } });
			await api.request("/notes");
			assert.deepEqual(t.fake.seen.slice(-2).map((r) => r.ifMatch), [null, null], "existing calls send no If-Match");
			assert.equal((await api.request("/notes/1", { method: "PATCH", body: { text: "x" } })).status, 428, "the API's own answer to a missing one comes back as it is");
		});

		it("returns a 412 as it is, without refreshing or sending the write again", async () => {
			const t = setUp();
			const api = ready(t);
			const etag = await etagOf(api);
			t.fake.changeElsewhere("sub-martin", 1, "changed by someone else");
			const answer = await api.request("/notes/1", { method: "PATCH", body: { text: "mine" }, ifMatch: etag });
			assert.equal(answer.status, 412);
			assert.equal(answer.body.current.text, "changed by someone else");
			assert.equal(t.fake.seen.filter((r) => r.method === "PATCH").length, 1);
			assert.equal(t.issuer.refreshes, 0);
			assert.equal(t.fake.notes.get("sub-martin")[0].text, "changed by someone else", "nothing overwritten");
		});

		it("refuses anything but one quoted strong version before sending, and on reads", async () => {
			const t = setUp();
			const api = ready(t);
			const before = t.fake.seen.length;
			const bad = ['W/"note-1-v1"', "*", '"a", "b"', '"a","b"', "note-1-v1", '"a\r\nAuthorization: Bearer x"', '"a" ', '"has"quote"', `"${"x".repeat(255)}"`, '"ünï"', 42];
			for (const ifMatch of bad) {
				await assert.rejects(api.request("/notes/1", { method: "PATCH", body: { text: "x" }, ifMatch }), (e) => e instanceof ApiError && e.code === "if-match" && !e.sent, String(ifMatch));
			}
			await assert.rejects(api.request("/notes", { ifMatch: '"note-1-v1"' }), (e) => e.code === "if-match" && !e.sent);
			assert.equal(t.fake.seen.length, before, "nothing was sent");
			assert.equal(t.issuer.refreshes, 0);
		});

		it("keeps the bearer credential and other headers the host's", async () => {
			const t = setUp();
			const api = ready(t);
			const etag = await etagOf(api);
			// Not part of the contract; a caller that tries anyway changes nothing.
			const answer = await api.request("/notes/1", { method: "PATCH", body: { text: "mine" }, ifMatch: etag, headers: { Authorization: "Bearer someone-else", "If-Match": "*" } });
			assert.equal(answer.status, 200);
			assert.deepEqual([t.fake.seen.at(-1).sub, t.fake.seen.at(-1).ifMatch], ["sub-martin", etag]);
		});
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

		it("lets a late 401 of an older read use the grant another read already renewed", async () => {
			const t = setUp();
			const martin = t.access.forUser("martin", "sub-martin", ["notes"]);
			// Two reads leave with the same token; the API answers the second one later.
			let release;
			const late = new Promise((resolve) => (release = resolve));
			let calls = 0;
			const staggered = createApiAccess({
				apis: { notes: API },
				refresh: async (token) => {
					t.issuer.refreshes += 1;
					const answer = await t.fake.renew(token);
					if (!answer) throw new RefreshRefused("invalid_grant");
					return grantOf(answer, undefined, () => t.clock.now);
				},
				fetch: async (url, init) => {
					const answer = await t.fake.handle(new Request(url, init));
					if (++calls === 2) await late;
					return answer;
				},
				now: () => t.clock.now,
				log: { warn: (line) => t.lines.push(line) },
			});
			const user = staggered.forUser("martin", "sub-martin", ["notes"]);
			user.signedIn(t.grantFor("sub-martin", "martin"));
			const api = user.forExtension("example-notes").notes;
			t.fake.access.clear(); // the API stops accepting the token before its recorded expiry
			const first = api.request("/notes");
			const second = api.request("/me");
			assert.equal((await first).status, 200, "the first read renewed and retried");
			release();
			assert.equal((await second).status, 200, "the late read used the renewed grant");
			assert.equal(t.issuer.refreshes, 1, "the used-up refresh token was not sent again");
			assert.equal(user.status()[0].state, "ready");
			assert.doesNotMatch(t.lines.join("\n"), /refresh refused/);
			assert.equal(martin.status()[0].state, "sign-in", "the other access instance holds nothing");
		});

		it("says sign-in in the last minute of a grant without a refresh token, as a request would find", async () => {
			const t = setUp();
			const martin = t.access.forUser("martin", "sub-martin", ["notes"]);
			t.signIn(martin, "sub-martin", "martin", "openid profile notes.read notes.write"); // no offline_access
			const api = martin.forExtension("example-notes").notes;
			t.clock.now += 240_000; // 60 seconds left
			assert.equal(api.state(), "sign-in");
			const seen = t.fake.seen.length;
			await assert.rejects(api.request("/notes", { method: "POST", body: { text: "x" } }), (e) => e.code === "sign-in" && !e.sent);
			assert.equal(t.fake.seen.length, seen);
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
