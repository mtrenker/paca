// The browser check of the frontend contract: a Preact fixture (test/fixtures/extension-preact)
// against the real server, page and sign-in routes, in Chrome driven by puppeteer-core under the
// page's unchanged CSP. Run with `npm run test:browser`, which builds the page and the fixture
// first. Chrome comes from CHROME_BIN, or else an installed Google Chrome; without one the check
// skips, except under CI, where it fails. Nothing here reaches a model, GitHub or an identity
// provider: sign-in uses a stub OIDC client, and the session's state is pushed by the test.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import puppeteer from "puppeteer-core";
import { createSessions } from "../../packages/api/src/auth.ts";
import { loadPackages } from "../../packages/api/src/extensions.ts";
import { createFeed } from "../../packages/api/src/feed.ts";
import { createApp } from "../../packages/api/src/server.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "test", "fixtures", "extension-preact");
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const ISSUER = "https://id.example.test/";
const SESSION = randomUUID();

/** Chrome to drive, or undefined. CHROME_BIN wins; otherwise Puppeteer looks for Google Chrome. */
async function launch() {
	const options = { headless: true, args: process.env.CI ? ["--no-sandbox"] : [] };
	if (process.env.CHROME_BIN) return puppeteer.launch({ ...options, executablePath: process.env.CHROME_BIN });
	try {
		return await puppeteer.launch({ ...options, channel: "chrome" });
	} catch {
		return undefined;
	}
}

const browser = await launch();
if (!browser && process.env.CI) throw new Error("No Chrome for the browser check: install Google Chrome or set CHROME_BIN");
if (!browser) console.log("browser check skipped: no Chrome found; set CHROME_BIN to a Chrome or Chromium binary");

describe("a framework extension under the page's CSP", { skip: !browser }, () => {
	let server;
	let base;
	let page;
	/** The open session's state, which the test changes and the stream sends. */
	let state = { running: false, turns: [] };
	const feed = createFeed(() => state, 1);
	const echoed = [];
	const cspHeaders = new Set();

	const push = (next) => {
		state = next;
		feed.changed();
	};
	const card = { id: "call_1:0", package: "preact-fixture", kind: "counter", data: {}, fallback: { text: "A counter" }, createdAt: "2026-10-08T00:00:00Z" };
	const turn = (answer, cards) => ({ running: true, turns: [{ id: "t1", question: "Count with me", steps: [], answer: "", draft: answer, notices: [], drafts: [], cards }] });
	const counts = () => page.evaluate(() => ({ ...document.documentElement.dataset }));
	/** Every CSP violation in every document the page loaded, reported to the test as it happens. */
	const violations = [];

	before(async () => {
		const [fixture] = await loadPackages({ "@paca-test/extension-preact": {} }, () => import(join(FIXTURE, "index.ts")), { rootOf: () => FIXTURE, log: { log: () => {} } });
		assert.ok(fixture.frontend, "run npm run build:fixture first (npm run test:browser does)");
		const { operations } = fixture.package.forUser({});
		const user = {
			id: "tester",
			sessions: {
				list: createFeed(() => [{ id: SESSION, title: "Count with me", running: state.running, waiting: 0, lastActivity: new Date().toISOString() }], 1),
				watch: async (id) => (id === SESSION ? feed : undefined),
			},
			info: { model: "test/model", scope: "Fixture", scopeDetail: "", extensions: [fixture.frontend.info] },
			operation: (pkg, op) => (pkg === "preact-fixture" && Object.hasOwn(operations, op) ? (input, signal) => (echoed.push(input), operations[op](input, signal)) : undefined),
		};
		const config = { publicUrl: "", publicOrigin: "" };
		server = createApp({
			config,
			sessions: createSessions({ key: randomBytes(32), issuer: ISSUER, allows: (sub) => sub === "tester" }),
			// The browser goes straight back to the real callback route, which sets the real cookies.
			oidc: { begin: async () => ({ url: "/auth/callback?code=c&state=s", transaction: { state: "s", nonce: "n", verifier: "v" } }), finish: async () => ({ iss: ISSUER, sub: "tester", preferred_username: "tester" }) },
			users: { forSubject: (sub) => (sub === "tester" ? user : undefined) },
			web: { public: join(ROOT, "packages", "web", "public"), script: join(ROOT, "packages", "web", "dist") },
			frontends: new Map([["preact-fixture", fixture.frontend]]),
			log: { warn: () => {}, error: () => {} },
		});
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		base = `http://localhost:${server.address().port}`;
		Object.assign(config, { publicUrl: base, publicOrigin: base });

		page = await browser.newPage();
		// Wide enough for the side list beside the session; on a phone the nav is on the list screen.
		await page.setViewport({ width: 1280, height: 900 });
		await page.exposeFunction("__pacaViolation", (violation) => violations.push(violation));
		await page.evaluateOnNewDocument(() => {
			document.addEventListener("securitypolicyviolation", (e) => window.__pacaViolation(`${location.search} ${e.violatedDirective} ${e.blockedURI}`));
		});
		page.on("response", (r) => r.url().startsWith(base) && r.headers()["content-type"]?.startsWith("text/html") && cspHeaders.add(r.headers()["content-security-policy"]));
		// Sign in through the real routes; the session cookie is Secure, which Chrome keeps on localhost.
		await page.goto(`${base}/`);
		await page.waitForSelector("#scope:not(:empty)");
		await page.goto(`${base}/?session=${SESSION}`);
		await page.waitForFunction(() => document.querySelector("#scope")?.textContent !== "Connecting…");
	});

	after(async () => {
		await browser?.close();
		server?.close();
	});

	it("mounts a card once, keeps its Preact state and focus across updates, and disposes it once", async () => {
		push(turn("Counting", [card]));
		await page.waitForSelector(".ext-preact-fixture .fixture-counter");
		await page.click(".fixture-counter");
		assert.equal(await page.$eval(".fixture-counter", (b) => b.textContent), "Count 1");
		assert.equal(await page.evaluate(() => document.activeElement?.className), "fixture-counter");
		assert.equal(await page.$eval(".fixture-counter", (b) => getComputedStyle(b).borderTopWidth), "2px", "the style prop is a CSSOM write");
		assert.equal(await page.$eval(".fixture-counter", (b) => getComputedStyle(b).borderTopStyle), "solid", "the linked stylesheet applies");

		for (let i = 1; i <= 5; i++) {
			push(turn(`Counting, update ${i}`, [card]));
			await page.waitForFunction((text) => document.querySelector(".turn .answer")?.textContent === text, {}, `Counting, update ${i}`);
		}
		assert.equal(await page.$eval(".fixture-counter", (b) => b.textContent), "Count 1");
		assert.equal(await page.evaluate(() => document.activeElement?.className), "fixture-counter");
		assert.deepEqual((({ counterMounts, counterDisposes }) => [counterMounts, counterDisposes])(await counts()), ["1", undefined]);

		push(turn("Done", []));
		await page.waitForFunction(() => !document.querySelector("[data-card-id]"));
		// Preact may run effect cleanups just after render(null) returns.
		await page.waitForFunction(() => document.documentElement.dataset.counterCleanups !== undefined);
		const after = await counts();
		assert.deepEqual([after.counterMounts, after.counterDisposes, after.counterCleanups], ["1", "1", "1"]);
	});

	it("opens its page from the nav, which calls the operation through the host, and disposes it on Back", async () => {
		const nav = await page.$('a[data-paca-nav].ext-nav-link');
		assert.equal(await nav.evaluate((a) => a.textContent), "Fixture");
		assert.equal(await nav.evaluate((a) => new URL(a.href).search), `?page=preact-fixture.demo&session=${SESSION}`);
		await nav.click();
		await page.waitForFunction(() => document.querySelector(".fixture-echo")?.textContent.startsWith("{"));
		assert.deepEqual(JSON.parse(await page.$eval(".fixture-echo", (p) => p.textContent)), { echo: { hello: "fixture" }, from: "preact-fixture" });
		assert.deepEqual(echoed, [{ hello: "fixture" }]);
		assert.equal(await page.$eval("#page-title", (h) => h.textContent), "Fixture");
		assert.equal(await page.evaluate(() => document.activeElement?.id), "page-title", "focus moves to the page's title");
		assert.equal(await nav.evaluate((a) => a.getAttribute("aria-current")), "page");
		assert.equal(await page.evaluate(() => document.body.className), "view-page");

		await page.goBack();
		await page.waitForFunction(() => document.querySelector("#page").hidden && document.body.className === "view-session");
		const after = await counts();
		assert.deepEqual([after.demoMounts, after.demoDisposes], ["1", "1"]);
	});

	it("shows the page again from its URL after a reload", async () => {
		await page.goto(`${base}/?page=preact-fixture.demo&session=${SESSION}`);
		await page.waitForFunction(() => document.querySelector(".fixture-echo")?.textContent.startsWith("{"));
		assert.equal(await page.$eval("#page-back", (a) => !a.hidden && new URL(a.href).search), `?session=${SESSION}`);
		assert.equal(await page.$eval(".ext-nav-link", (a) => new URL(a.href).search), `?page=preact-fixture.demo&session=${SESSION}`, "a live session goes along");
		// A page whose session is gone: no Back to session, and the nav link starts afresh, so a
		// proposal from there makes a new session instead of failing.
		await page.goto(`${base}/?page=preact-fixture.demo&session=${randomUUID()}`);
		await page.waitForFunction(() => document.querySelector(".fixture-echo")?.textContent.startsWith("{"));
		await page.waitForFunction(() => new URL(document.querySelector(".ext-nav-link").href).search === "?page=preact-fixture.demo");
		assert.equal(await page.$eval("#page-back", (a) => a.hidden), true);
		await page.goto(`${base}/?page=preact-fixture.missing`);
		await page.waitForSelector(".page-unavailable");
		assert.match(await page.$eval(".page-unavailable", (p) => p.textContent), /isn’t available/);
	});

	it("caused no CSP violation in any document, under the unchanged policy", async () => {
		assert.deepEqual(violations, []);
		assert.equal((await counts()).fixtureCspViolations, undefined);
		assert.deepEqual([...cspHeaders], [CSP]);
	});

	it("would have counted a violation in an earlier document (negative control)", async () => {
		await page.goto(`${base}/?page=preact-fixture.demo&session=${SESSION}`);
		await page.waitForSelector(".fixture-echo");
		// A remote image breaks img-src 'self'; then the page moves on to another document.
		await page.evaluate(() => {
			const img = document.createElement("img");
			img.src = "https://example.test/blocked.png";
			document.body.append(img);
		});
		for (let i = 0; i < 50 && violations.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
		await page.goto(`${base}/?session=${SESSION}`);
		assert.equal(violations.length, 1);
		assert.match(violations[0], /^\?page=preact-fixture\.demo.* img-src https:\/\/example\.test\/blocked\.png$/);
	});
});
