// Package frontends: the manifest checked at start, the fixed file map, the operator's switch,
// what the page learns, and the asset route. Packages are temporary directories, loaded through
// the injected `load` and `rootOf`.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { createSessions } from "../src/auth.ts";
import { loadPackages } from "../src/extensions.ts";
import { createFeed } from "../src/feed.ts";
import { createApp } from "../src/server.ts";
import { openUsers } from "../src/users.ts";
import { fauxModel, tempDir } from "./helpers.js";

/** A package directory with browser files; returns its root and a manifest pointing at browser/. */
async function packageDir(files = { "dist/index.js": "export default {};", "app.css": ".ext-probe {}" }) {
	const root = await tempDir("paca-pkg-");
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, "browser", path, ".."), { recursive: true });
		await writeFile(join(root, "browser", path), content);
	}
	return { root, browser: { dir: pathToFileURL(join(root, "browser")).href + "/", entry: "dist/index.js", styles: ["app.css"], cards: ["note"] } };
}

const toolPackage = (browser, forUser = () => ({ tools: [], labels: {}, scope: { label: "Probe", detail: "" } })) => ({ name: "probe", browser, forUser });

async function load(root, browser, options = {}) {
	const lines = [];
	const packages = await loadPackages({ "@example/probe": {} }, async () => ({ default: toolPackage(browser) }), { rootOf: () => root, log: { log: (l) => lines.push(l) }, ...options });
	return { frontend: packages[0].frontend, lines };
}

describe("frontend manifest", () => {
	it("lists the package's .js, .css and .svg files once, and tells the page their URLs", async () => {
		const { root, browser } = await packageDir({ "dist/index.js": "x", "dist/chunk.js": "x", "app.css": "x", "icon.svg": "x", "src/index.ts": "x", "tsconfig.json": "{}", ".hidden.js": "x", "dist/.map.js": "x" });
		await symlink("/etc/hostname", join(root, "browser", "dist", "linked.js"));
		const { frontend, lines } = await load(root, browser);
		assert.deepEqual([...frontend.files.keys()].sort(), ["app.css", "dist/chunk.js", "dist/index.js", "icon.svg"]);
		assert.equal(frontend.files.get("app.css").type, "text/css");
		assert.equal(frontend.files.get("dist/index.js").type, "text/javascript");
		assert.equal(frontend.files.get("icon.svg").type, "image/svg+xml");
		assert.deepEqual(frontend.info, { name: "probe", entry: "/ext/probe/dist/index.js", styles: ["/ext/probe/app.css"], cards: ["note"], pages: {} });
		assert.deepEqual(lines, []);
	});

	it("refuses the start for a malformed manifest, naming the module", async () => {
		const { root, browser } = await packageDir();
		const outside = await tempDir("paca-outside-");
		const bad = [
			[{ ...browser, dir: "/not/a/url/" }, /dir must be a file: URL/],
			[{ ...browser, dir: "https://example.test/browser/" }, /dir must be a file: URL/],
			[{ ...browser, dir: pathToFileURL(outside).href }, /inside the package/],
			[{ ...browser, dir: pathToFileURL(root).href }, /inside the package/],
			[{ ...browser, dir: pathToFileURL(join(root, "browser", "..", "..")).href }, /inside the package/],
			[{ ...browser, entry: "../index.js" }, /entry must be/],
			[{ ...browser, entry: "/dist/index.js" }, /entry must be/],
			[{ ...browser, entry: "dist/index.ts" }, /entry must be/],
			[{ ...browser, entry: ".hidden.js" }, /entry must be/],
			[{ ...browser, styles: ["../x.css"] }, /styles must be/],
			[{ ...browser, styles: "app.css" }, /styles must be/],
			[{ ...browser, cards: ["Issue"] }, /cards must be/],
			[{ ...browser, cards: ["note", "note"] }, /cards must be/],
			[{ ...browser, cards: ["a/b"] }, /cards must be/],
			[{ ...browser, pages: ["home"] }, /pages must map/],
			[{ ...browser, pages: { Home: { title: "Home" } } }, /page "Home"/],
			[{ ...browser, pages: { home: {} } }, /needs a title/],
			[{ ...browser, pages: { home: { title: "x".repeat(61) } } }, /needs a title/],
			[{ ...browser, nav: { label: "Probe", page: "home" } }, /nav.page must be a declared page/],
			[{ ...browser, pages: { home: { title: "Home" } }, nav: { label: "", page: "home" } }, /nav.label/],
			[{ ...browser, pages: { home: { title: "Home" } }, nav: { label: "x".repeat(25), page: "home" } }, /nav.label/],
			[{ ...browser, pages: { home: { title: "Home" } }, nav: { label: "Probe", page: "constructor" } }, /nav.page must be a declared page/],
		];
		for (const [manifest, message] of bad) await assert.rejects(load(root, manifest), (e) => message.test(e.message) && e.message.includes("@example/probe"), JSON.stringify(manifest));
	});

	it("tells the page the declared pages and the nav entry", async () => {
		const { root, browser } = await packageDir();
		const { frontend } = await load(root, { ...browser, pages: { home: { title: "Probe" }, item: { title: "Item" } }, nav: { label: "Probe", page: "home" } });
		assert.deepEqual([frontend.info.pages, frontend.info.nav], [{ home: { title: "Probe" }, item: { title: "Item" } }, { label: "Probe", page: "home" }]);
	});

	it("turns the frontend off with one line when built files are missing; the tools still load", async () => {
		const { root, browser } = await packageDir({ "app.css": "x" });
		const { frontend, lines } = await load(root, browser);
		assert.equal(frontend, undefined);
		assert.deepEqual(lines, ["paca: extension @example/probe: dist/index.js missing; run npm run build. Cards show text."]);
		const noDir = await load(root, { ...browser, dir: pathToFileURL(join(root, "nothing")).href + "/" });
		assert.equal(noDir.frontend, undefined);
	});

	it("refuses more than 200 files or 5 MiB to serve", async () => {
		const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`dist/f${i}.js`, "x"]));
		const lots = await packageDir({ ...many, "dist/index.js": "x", "app.css": "x" });
		await assert.rejects(load(lots.root, lots.browser), /more than 200 files or 5 MiB/);
		const big = await packageDir({ "dist/index.js": "x".repeat(5 * 1024 * 1024 + 1), "app.css": "x" });
		await assert.rejects(load(big.root, big.browser), /more than 200 files or 5 MiB/);
	});

	it("leaves a frontend off when config disables it, still checking its manifest", async () => {
		const { root, browser } = await packageDir();
		const { frontend, lines } = await load(root, browser, { disableFrontends: ["@example/probe"] });
		assert.equal(frontend, undefined);
		assert.deepEqual(lines, ["paca: extension @example/probe: frontend disabled by config"]);
		await assert.rejects(load(root, { ...browser, cards: ["Bad"] }, { disableFrontends: ["@example/probe"] }), /cards must be/);
	});

	it("finds the real GitHub package's browser directory inside it", async () => {
		const lines = [];
		const [github] = await loadPackages({ "@paca/extension-github": { piClean: "/opt/pi-clean" } }, undefined, { disableFrontends: ["@paca/extension-github"], log: { log: (l) => lines.push(l) } });
		assert.deepEqual(github.package.browser.cards, ["issue"]);
		assert.deepEqual([Object.keys(github.package.browser.pages), github.package.browser.nav], [["home", "issue"], { label: "GitHub", page: "home" }]);
		assert.deepEqual(lines, ["paca: extension @paca/extension-github: frontend disabled by config"]);
	});

	it("lists a frontend only for users the package gave tools to", async () => {
		const { root, browser } = await packageDir();
		const forUser = ({ userSettings }) => userSettings && { tools: [], labels: {}, scope: { label: "Probe", detail: "" } };
		const packages = await loadPackages({ "@example/probe": {} }, async () => ({ default: toolPackage(browser, forUser) }), { rootOf: () => root, log: { log: () => {} } });
		const dataDir = await tempDir();
		const model = await fauxModel(dataDir);
		const users = await openUsers({
			users: [{ id: "with", subject: "s1", operator: false, probe: {} }, { id: "without", subject: "s2", operator: false }],
			packages,
			dataDir,
			modelRuntime: model.modelRuntime,
			model: model.model,
			modelLabel: "faux",
			log: { log: () => {}, error: () => {} },
		});
		assert.deepEqual(users.forSubject("s1").info.extensions.map((e) => e.name), ["probe"]);
		assert.deepEqual(users.forSubject("s2").info.extensions, []);
		await users.close();
	});
});

describe("frontend files over HTTP", () => {
	const ISSUER = "https://id.example.test/";
	const PUBLIC = "https://paca.example.test";
	const claims = { martin: { iss: ISSUER, sub: "martin" }, alex: { iss: ISSUER, sub: "alex" } };
	let next;
	let server;
	let port;
	let frontend;
	const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

	const stubUser = (frontends) => ({
		id: "stub",
		sessions: { list: createFeed(() => [], 1) },
		info: { model: "test/model", scope: "Probe", scopeDetail: "", extensions: frontends.map((f) => f.info) },
		frontends: new Map(frontends.map((f) => [f.info.name, f])),
	});

	before(async () => {
		const { root, browser } = await packageDir({ "dist/index.js": "export default {};", "app.css": ".ext-probe {}", ".env.js": "secret" });
		await writeFile(join(root, "browser", "dist", "unlisted.ts"), "x");
		({ frontend } = await load(root, browser));
		const users = new Map([["martin", stubUser([frontend])], ["alex", stubUser([])]]);
		const sessions = createSessions({ key: randomBytes(32), issuer: ISSUER, allows: (sub) => users.has(sub) });
		server = createApp({
			config: { publicUrl: PUBLIC, publicOrigin: PUBLIC },
			sessions,
			oidc: { begin: async () => ({ url: `${ISSUER}authorize`, transaction: { state: "s", nonce: "n", verifier: "v" } }), finish: async () => next },
			users: { forSubject: (sub) => users.get(sub) },
			web: { public: join(import.meta.dirname, "..", "..", "web", "public"), script: join(import.meta.dirname, "..", "..", "web", "public") },
			log: { warn: () => {}, error: () => {} },
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = server.address().port;
	});
	after(() => server.close());

	/** A raw GET, so paths reach the server exactly as written (fetch would resolve dot segments). */
	const get = (path, cookie = "") =>
		new Promise((resolve, reject) => {
			request({ host: "127.0.0.1", port, path, headers: { cookie } }, (res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
			})
				.on("error", reject)
				.end();
		});
	const cookieOf = (headers) => (headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
	async function signIn(who) {
		next = claims[who];
		const login = await get("/auth/login");
		return cookieOf((await get("/auth/callback?code=c&state=s", cookieOf(login.headers))).headers);
	}

	it("serves a listed file with its type, no-cache and the unchanged CSP", async () => {
		const cookie = await signIn("martin");
		for (const [path, type, body] of [["/ext/probe/dist/index.js", "text/javascript", "export default {};"], ["/ext/probe/app.css", "text/css", ".ext-probe {}"]]) {
			const res = await get(path, cookie);
			assert.deepEqual([res.status, res.headers["content-type"], res.headers["cache-control"], res.body], [200, type, "no-cache", body], path);
			assert.equal(res.headers["content-security-policy"], csp);
		}
		const info = JSON.parse((await get("/api/session", cookie)).body);
		assert.deepEqual(info.extensions, [frontend.info]);
	});

	it("answers 404 for traversal, encoded dots, dotfiles, unlisted files and unknown packages", async () => {
		const cookie = await signIn("martin");
		for (const path of ["/ext/probe/../../package.json", "/ext/probe/dist/../app.css", "/ext/probe/%2e%2e/browser/app.css", "/ext/probe/dist%2Findex.js", "/ext/probe/.env.js", "/ext/probe/dist/unlisted.ts", "/ext/probe/src/index.ts", "/ext/other/dist/index.js", "/ext/probe/", "/ext/Probe/app.css"]) {
			const res = await get(path, cookie);
			assert.equal(res.status, 404, path);
			assert.doesNotMatch(res.body, /secret|export default/, path);
		}
	});

	it("answers 401 without a sign-in and 404 to a user whose page does not list the package", async () => {
		assert.equal((await get("/ext/probe/dist/index.js")).status, 401);
		assert.equal((await get("/ext/probe/dist/index.js", await signIn("alex"))).status, 404);
	});
});
