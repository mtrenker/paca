// The browser check of local extensions (#19): the guide's example (docs/local-extensions.md) in a
// data folder outside the checkout, loaded by the real loader and users, for two users whose own
// "dice" extensions differ. Its card and page keep the frontend contract after a reload, and each
// user's page loads their own code. The model is pi-ai's faux provider and sign-in a stub OIDC
// client; nothing leaves the machine. Chrome as in fixture.test.mjs.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import puppeteer from "puppeteer-core";
import { createSessions } from "../../packages/api/src/auth.ts";
import { loadLocalExtensions } from "../../packages/api/src/local-extensions.ts";
import { createApp } from "../../packages/api/src/server.ts";
import { openUsers } from "../../packages/api/src/users.ts";
import { call, fauxModel, guideFiles, idle, text } from "../../packages/api/test/helpers.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const ISSUER = "https://id.example.test/";
const SESSION = randomUUID();

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

describe("a local extension in the browser", { skip: !browser }, () => {
	let server;
	let users;
	let base;
	let subject = "sub-martin";
	const violations = [];

	before(async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "paca-data-"));
		const files = await guideFiles();
		// Alex's own "dice" is different code under the same name.
		const own = { martin: files, alex: { ...files, "browser/index.js": files["browser/index.js"].replace("Roll a d20", "Alex rolls a d20") } };
		for (const [id, extension] of Object.entries(own)) {
			for (const [path, content] of Object.entries(extension)) {
				const file = join(dataDir, "users", id, "local-extensions", "dice", path);
				await mkdir(join(file, ".."), { recursive: true });
				await writeFile(file, content);
			}
		}
		const configured = [{ id: "martin", subject: "sub-martin", operator: true }, { id: "alex", subject: "sub-alex", operator: false }];
		const local = await loadLocalExtensions({ dataDir, users: configured, installed: [], log: { log: () => {} } });
		const model = await fauxModel(dataDir, [call("roll_dice"), text("Rolled.")]);
		users = await openUsers({ users: configured, packages: [], local, dataDir, modelRuntime: model.modelRuntime, model: model.model, modelLabel: "faux", log: { log: () => {}, error: () => {} } });
		const { sessions } = users.forSubject("sub-martin");
		sessions.start(SESSION, "Roll a die", "request-browser-1");
		await idle(sessions, SESSION);

		const config = { publicUrl: "", publicOrigin: "" };
		server = createApp({
			config,
			sessions: createSessions({ key: randomBytes(32), issuer: ISSUER, allows: (sub) => users.forSubject(sub) !== undefined }),
			oidc: { begin: async () => ({ url: "/auth/callback?code=c&state=s", transaction: { state: "s", nonce: "n", verifier: "v" } }), finish: async () => ({ iss: ISSUER, sub: subject }) },
			users,
			web: { public: join(ROOT, "packages", "web", "public"), script: join(ROOT, "packages", "web", "dist") },
			log: { warn: () => {}, error: () => {} },
		});
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		base = `http://localhost:${server.address().port}`;
		Object.assign(config, { publicUrl: base, publicOrigin: base });
	});

	after(async () => {
		await browser?.close();
		server?.close();
		await users?.close();
	});

	/** A signed-in page in its own browser context, which counts CSP violations. */
	async function signedIn(sub) {
		subject = sub;
		const page = await (await browser.createBrowserContext()).newPage();
		await page.setViewport({ width: 1280, height: 900 });
		await page.exposeFunction("__pacaViolation", (v) => violations.push(v));
		await page.evaluateOnNewDocument(() => document.addEventListener("securitypolicyviolation", (e) => window.__pacaViolation(`${e.violatedDirective} ${e.blockedURI}`)));
		await page.goto(`${base}/`);
		await page.waitForSelector("#scope:not(:empty)");
		return page;
	}

	it("shows the tool's card, also after a reload, and opens its page from the nav", async () => {
		const page = await signedIn("sub-martin");
		await page.goto(`${base}/?session=${SESSION}`);
		const card = () => page.waitForSelector(".ext-dice .dice-value").then((p) => p.evaluate((e) => e.textContent));
		const shown = await card();
		assert.match(shown, /^d6: [1-6]$/);
		await page.reload();
		assert.equal(await card(), shown, "the stored card mounts again");

		await page.click("a.ext-nav-link");
		await page.waitForSelector(".ext-dice .dice-roll");
		assert.equal(await page.$eval("#page-title", (h) => h.textContent), "Dice");
		await page.click(".dice-roll");
		await page.waitForFunction(() => /^You rolled \d+\.$/.test(document.querySelector(".ext-dice .dice-value")?.textContent ?? ""));

		await page.reload();
		await page.waitForSelector(".ext-dice .dice-roll");
		assert.equal(await page.$eval(".dice-roll", (b) => b.textContent), "Roll a d20");
		await page.click(".dice-roll");
		await page.waitForFunction(() => /^You rolled \d+\.$/.test(document.querySelector(".ext-dice .dice-value")?.textContent ?? ""));
	});

	it("loads the other user's own extension of the same name for them", async () => {
		const page = await signedIn("sub-alex");
		await page.goto(`${base}/?page=dice.home`);
		await page.waitForSelector(".ext-dice .dice-roll");
		assert.equal(await page.$eval(".dice-roll", (b) => b.textContent), "Alex rolls a d20");
		await page.click(".dice-roll");
		await page.waitForFunction(() => /^You rolled \d+\.$/.test(document.querySelector(".ext-dice .dice-value")?.textContent ?? ""));
	});

	it("caused no CSP violation", () => {
		assert.deepEqual(violations, []);
	});
});
