// Local extensions from a data folder outside the checkout, as in the container (/data beside
// /app): the guide's example run with the faux model, per-user visibility of tools, operations and
// frontend files, skipped extensions with one line each, host and own imports, and a fresh process
// picking up edited files. See docs/local-extensions.md.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { OperationError } from "@paca/extension";
import { createSessions } from "../src/auth.ts";
import { loadLocalExtensions } from "../src/local-extensions.ts";
import { createApp } from "../src/server.ts";
import { openUsers, toolsFor } from "../src/users.ts";
import { call, fauxModel, guideFiles, idle, newId, stateOf, tempDir, text } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ISSUER = "https://id.example.test/";
const PUBLIC = "https://paca.example.test";
const quiet = { log: () => {}, error: () => {} };

async function writeFiles(dir, files) {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(dir, path, ".."), { recursive: true });
		await writeFile(join(dir, path), content);
	}
}

/** A data folder outside the checkout, as /data is outside /app. */
async function dataFolder() {
	const dir = await tempDir("paca-data-");
	assert.ok(relative(ROOT, dir).startsWith(".."), "the data folder must be outside the checkout");
	return dir;
}

/** A small extension: one tool `tool`, an operation `which` answering `answer`, and a frontend file saying `answer`. */
const probe = (name, { tool = `${name}_tool`, answer = name } = {}) => ({
	"package.json": JSON.stringify({ type: "module" }),
	"index.ts": `import { defineToolPackage } from "@paca/extension";
export default defineToolPackage({
	name: ${JSON.stringify(name)},
	browser: { dir: new URL("./browser/", import.meta.url).href, entry: "index.js", cards: ["note"] },
	forUser: () => ({
		tools: [{ name: ${JSON.stringify(tool)}, label: "x", description: "x", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(answer)} }], details: undefined }) }],
		labels: {},
		operations: { which: async () => ({ answer: ${JSON.stringify(answer)} }) },
		scope: { label: ${JSON.stringify(name)}, detail: "" },
	}),
});
`,
	"browser/index.js": `export default ${JSON.stringify(answer)};\n`,
});

const user = (id, extra = {}) => ({ id, subject: `sub-${id}`, operator: id === "martin", ...extra });

/** A signed-in HTTP client of createApp for the given users. */
async function serve(users) {
	let next;
	const server = createApp({
		config: { publicUrl: PUBLIC, publicOrigin: PUBLIC },
		sessions: createSessions({ key: randomBytes(32), issuer: ISSUER, allows: (sub) => users.forSubject(sub) !== undefined }),
		oidc: { begin: async () => ({ url: `${ISSUER}authorize`, transaction: { state: "s", nonce: "n", verifier: "v" } }), finish: async () => ({ claims: next }) },
		users,
		web: { public: join(ROOT, "packages", "web", "public"), script: join(ROOT, "packages", "web", "public") },
		log: { warn: () => {}, error: () => {} },
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	const signIn = async (sub) => {
		next = { iss: ISSUER, sub };
		const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
		const cookie = cookieOf(await fetch(`${base}/auth/callback?code=c&state=s`, { redirect: "manual", headers: { cookie: cookieOf(login) } }));
		const { csrf, extensions } = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
		const get = async (path) => {
			const r = await fetch(`${base}${path}`, { headers: { cookie } });
			return [r.status, await r.text()];
		};
		const post = async (path, body = {}) => {
			const r = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: PUBLIC, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
			return [r.status, await r.json()];
		};
		return { extensions, get, post };
	};
	return { signIn, close: () => server.close() };
}

describe("local extensions", () => {
	it("are harmless when no folder exists", async () => {
		const dataDir = await dataFolder();
		await mkdir(join(dataDir, "users", "martin"), { recursive: true });
		const lines = [];
		const local = await loadLocalExtensions({ dataDir, users: [user("martin"), user("alex")], installed: [], log: { log: (l) => lines.push(l) } });
		assert.deepEqual([...local], [["martin", []], ["alex", []]]);
		assert.deepEqual(lines, []);
		// A file where the folder should be is reported, not loaded.
		await writeFile(join(dataDir, "local-extensions"), "not a folder");
		await loadLocalExtensions({ dataDir, users: [], installed: [], log: { log: (l) => lines.push(l) } });
		assert.match(lines.join("\n"), /^paca: local extensions in local-extensions skipped: ENOTDIR/);
	});

	describe("the guide's example", () => {
		let users;
		let model;
		let http;
		before(async () => {
			const dataDir = await dataFolder();
			const files = await guideFiles();
			assert.deepEqual(Object.keys(files).sort(), ["browser/dice.css", "browser/index.js", "index.ts", "package.json", "roll.ts"]);
			await writeFiles(join(dataDir, "local-extensions", "dice"), files);
			const lines = [];
			const configured = [user("martin", { dice: { sides: 20 } }), user("alex")];
			const local = await loadLocalExtensions({ dataDir, users: configured, installed: [], log: { log: (l) => lines.push(l) } });
			assert.deepEqual(lines, ["paca: local extension local-extensions/dice: loaded with its frontend"]);
			model = await fauxModel(dataDir);
			users = await openUsers({ users: configured, packages: [], local, dataDir, modelRuntime: model.modelRuntime, model: model.model, modelLabel: "faux", log: quiet });
			http = await serve(users);
		});
		after(async () => {
			http.close();
			await users.close();
		});

		it("runs its tool with the faux model for each user's settings, and shows its card", async () => {
			for (const [sub, sides] of [["sub-martin", 20], ["sub-alex", 6]]) {
				model.faux.setResponses([call("roll_dice"), text("Done.")]);
				const { sessions } = users.forSubject(sub);
				const id = newId();
				sessions.start(id, "Roll a die", `request-${sides}`);
				await idle(sessions, id);
				const result = sessions.agentOf(id).messages.find((m) => m.role === "toolResult");
				const [, value] = /^Rolled (\d+) on a d(?:\d+)\.$/.exec(result.content[0].text) ?? [];
				assert.ok(Number(value) >= 1 && Number(value) <= sides, result.content[0].text);
				assert.match(result.content[0].text, new RegExp(`on a d${sides}\\.$`));
				const [card] = (await stateOf(sessions, id)).turns[0].cards;
				assert.deepEqual([card.package, card.kind, card.data], ["dice", "roll", { sides, value: Number(value) }]);
				assert.equal(users.forSubject(sub).info.scope, "Dice");
			}
		});

		it("serves its frontend and operations to its users, with Paca's OperationError", async () => {
			const alex = await http.signIn("sub-alex");
			assert.deepEqual(alex.extensions, [{ name: "dice", entry: "/ext/dice/index.js", styles: ["/ext/dice/dice.css"], cards: ["roll"], pages: { home: { title: "Dice" } }, nav: { label: "Dice", page: "home" } }]);
			const [status, body] = await alex.get("/ext/dice/index.js");
			assert.equal(status, 200);
			assert.match(body, /context\.call\("roll"/);
			assert.equal((await alex.get("/ext/dice/roll.ts"))[0], 404);
			const [rolled, { sides, value }] = await alex.post("/api/ext/dice/roll", { sides: 20 });
			assert.deepEqual([rolled, sides], [200, 20]);
			assert.ok(value >= 1 && value <= 20);
			// A 400 with the message, not a 500: the extension's OperationError is the host's class.
			assert.deepEqual(await alex.post("/api/ext/dice/roll", { sides: 1 }), [400, { error: "Choose 2 to 100 sides." }]);
		});
	});

	it("binds a user's own extensions only for them, also when two users' extensions share a name", async () => {
		const dataDir = await dataFolder();
		await writeFiles(join(dataDir, "local-extensions", "shared"), probe("shared"));
		await writeFiles(join(dataDir, "users", "martin", "local-extensions", "notes"), probe("notes", { tool: "martin_notes", answer: "martin's notes" }));
		await writeFiles(join(dataDir, "users", "alex", "local-extensions", "notes"), probe("notes", { tool: "alex_notes", answer: "alex's notes" }));
		await writeFiles(join(dataDir, "users", "alex", "local-extensions", "secret"), probe("secret"));
		// A folder of a user who is not configured is never read, so this never runs.
		await writeFiles(join(dataDir, "users", "ghost", "local-extensions", "boom"), { "package.json": '{"type":"module"}', "index.ts": 'throw new Error("ghost loaded");\n' });
		const lines = [];
		const configured = [user("martin"), user("alex")];
		const local = await loadLocalExtensions({ dataDir, users: configured, installed: [], log: { log: (l) => lines.push(l) } });
		assert.deepEqual(lines, [
			"paca: local extension local-extensions/shared: loaded with its frontend",
			"paca: local extension users/martin/local-extensions/notes: loaded with its frontend",
			"paca: local extension users/alex/local-extensions/notes: loaded with its frontend",
			"paca: local extension users/alex/local-extensions/secret: loaded with its frontend",
		]);
		const model = await fauxModel(dataDir);
		const users = await openUsers({ users: configured, packages: [], local, dataDir, modelRuntime: model.modelRuntime, model: model.model, modelLabel: "faux", log: quiet });
		const http = await serve(users);
		try {
			const tools = (sub) => users.forSubject(sub).sessions.packages.flatMap((p) => p.tools.tools.map((t) => t.name));
			assert.deepEqual(tools("sub-martin"), ["shared_tool", "martin_notes"]);
			assert.deepEqual(tools("sub-alex"), ["shared_tool", "alex_notes", "secret_tool"]);
			const martin = await http.signIn("sub-martin");
			const alex = await http.signIn("sub-alex");
			assert.deepEqual(martin.extensions.map((e) => e.name), ["shared", "notes"]);
			assert.deepEqual(alex.extensions.map((e) => e.name), ["shared", "notes", "secret"]);
			// The same URLs, each user's own code.
			assert.deepEqual(await martin.get("/ext/notes/index.js"), [200, `export default "martin's notes";\n`]);
			assert.deepEqual(await alex.get("/ext/notes/index.js"), [200, `export default "alex's notes";\n`]);
			assert.deepEqual(await martin.post("/api/ext/notes/which"), [200, { answer: "martin's notes" }]);
			assert.deepEqual(await alex.post("/api/ext/notes/which"), [200, { answer: "alex's notes" }]);
			assert.deepEqual(await martin.get("/ext/shared/index.js"), [200, `export default "shared";\n`]);
			// Alex's own extension is not martin's: no file, no operation.
			assert.equal((await martin.get("/ext/secret/index.js"))[0], 404);
			assert.equal((await martin.post("/api/ext/secret/which"))[0], 404);
		} finally {
			http.close();
			await users.close();
		}
	});

	it("skips broken and colliding extensions with one line each, and loads the rest", async () => {
		const dataDir = await dataFolder();
		const module = '{"type":"module"}';
		const defined = (name, extra = "") => `import { defineToolPackage } from "@paca/extension";\nexport default defineToolPackage({ name: "${name}", forUser: () => undefined${extra} });\n`;
		const global = {
			"Bad_Name": { "package.json": module, "index.ts": defined("Bad_Name") },
			operator: { "package.json": module, "index.ts": defined("operator") },
			github: { "package.json": module, "index.ts": defined("github") },
			"no-package": { "index.ts": defined("no-package") },
			commonjs: { "package.json": "{}", "index.ts": defined("commonjs") },
			"bad-json": { "package.json": "not json", "index.ts": defined("bad-json") },
			"no-entry": { "package.json": module, "main.ts": defined("no-entry") },
			syntax: { "package.json": module, "index.ts": "export default {\n" },
			throws: { "package.json": module, "index.ts": 'throw new Error("top-level failure");\n' },
			"missing-import": { "package.json": module, "index.ts": 'import "./nope.ts";\n' },
			"not-a-package": { "package.json": module, "index.js": "export default {};\n" },
			"wrong-name": { "package.json": module, "index.ts": defined("other") },
			"bad-manifest": { "package.json": module, "index.ts": defined("bad-manifest", ', browser: { dir: new URL("./browser/", import.meta.url).href, entry: "index.js", cards: ["Bad"] }') },
			"no-build": { "package.json": module, "index.ts": defined("no-build", ', browser: { dir: new URL("./browser/", import.meta.url).href, entry: "dist/index.js" }') },
			".switched-off": { "package.json": module, "index.ts": 'throw new Error("switched off but loaded");\n' },
			good: { "package.json": module, "index.js": defined("good") },
		};
		for (const [name, files] of Object.entries(global)) await writeFiles(join(dataDir, "local-extensions", name), files);
		await writeFile(join(dataDir, "local-extensions", "README.md"), "not an extension");
		await symlink("nowhere", join(dataDir, "local-extensions", "gone"));
		await symlink("loop", join(dataDir, "local-extensions", "loop"));
		await writeFiles(join(dataDir, "users", "alex", "local-extensions", "good"), { "package.json": module, "index.ts": 'throw new Error("never imported");\n' });
		const lines = [];
		const installed = [{ module: "@paca/extension-github", package: { name: "github", forUser: () => undefined }, settings: {} }];
		const local = await loadLocalExtensions({ dataDir, users: [user("alex")], installed, log: { log: (l) => lines.push(l) } });
		assert.deepEqual(local.get("alex").map((p) => [p.module, p.package.name, p.local, p.frontend]), [["local-extensions/good", "good", true, undefined], ["local-extensions/no-build", "no-build", true, undefined]]);
		const skip = (name, why) => `paca: local extension local-extensions/${name} skipped: ${why}`;
		const expected = [
			skip("Bad_Name", "the directory name must be lowercase letters, digits and dashes, and not paca, id, subject, operator, apis"),
			skip("bad-json", 'it needs a package.json with "type": "module" (not valid JSON)'),
			skip("bad-manifest", "browser: cards must be distinct names of lowercase letters, digits and dashes"),
			skip("commonjs", 'it needs a package.json with "type": "module"'),
			skip("github", 'the name "github" is taken by @paca/extension-github'),
			/^paca: local extension local-extensions\/gone skipped: ENOENT: no such file or directory, stat '.*\/gone'$/,
			"paca: local extension local-extensions/good: loaded",
			/^paca: local extension local-extensions\/loop skipped: ELOOP: too many symbolic links encountered, stat '.*\/loop'$/,
			/^paca: local extension local-extensions\/missing-import skipped: Cannot find module '.*\/nope\.ts' imported from .*\/missing-import\/index\.ts$/,
			"paca: extension local-extensions/no-build: dist/index.js missing; build the browser code. Cards show text.",
			"paca: local extension local-extensions/no-build: loaded",
			skip("no-entry", "it needs an index.ts or index.js"),
			skip("no-package", 'it needs a package.json with "type": "module" (ENOENT)'),
			skip("not-a-package", "has no default export from defineToolPackage()"),
			skip("operator", "the directory name must be lowercase letters, digits and dashes, and not paca, id, subject, operator, apis"),
			/^paca: local extension local-extensions\/syntax skipped: .+ \(file:\/\/.*\/syntax\/index\.ts:\d+\)$/,
			/^paca: local extension local-extensions\/throws skipped: top-level failure \(file:\/\/.*\/throws\/index\.ts:1\)$/,
			skip("wrong-name", 'defineToolPackage names it "other"; use its directory name, "wrong-name"'),
			"paca: local extension users/alex/local-extensions/good skipped: the name \"good\" is taken by local-extensions/good",
		];
		assert.equal(lines.length, expected.length, lines.join("\n"));
		lines.forEach((line, i) => (typeof expected[i] === "string" ? assert.equal(line, expected[i]) : assert.match(line, expected[i])));
	});

	it("starts with a folder it can list but not search, saying so", { skip: process.getuid?.() === 0 && "root can search any folder" }, async () => {
		const dataDir = await dataFolder();
		await writeFiles(join(dataDir, "local-extensions", "dice"), { "package.json": '{"type":"module"}' });
		await chmod(join(dataDir, "local-extensions"), 0o400);
		const lines = [];
		try {
			const local = await loadLocalExtensions({ dataDir, users: [user("alex")], installed: [], log: { log: (l) => lines.push(l) } });
			assert.deepEqual(local.get("alex"), []);
		} finally {
			await chmod(join(dataDir, "local-extensions"), 0o700);
		}
		assert.deepEqual(lines.length, 1);
		assert.match(lines[0], /^paca: local extension local-extensions\/dice skipped: EACCES: permission denied, stat '.*\/dice'$/);
	});

	it("leaves a local extension out for one user when forUser throws, returns a malformed result or reuses a tool name", async () => {
		const tool = (name) => ({ name, label: name, description: name, parameters: {}, execute: async () => ({ content: [], details: undefined }) });
		const tools = (...names) => ({ tools: names.map(tool), labels: {}, scope: { label: "x", detail: "" } });
		const pkg = (name, forUser, local = true) => ({ module: local ? `local-extensions/${name}` : `@example/${name}`, package: { name, forUser }, settings: undefined, local });
		const packages = [
			pkg("installed", () => tools("read_issue"), false),
			pkg("picky", ({ user }) => (user.id === "alex" ? (() => { throw new Error("picky: needs settings"); })() : tools("pick"))),
			pkg("clash", () => tools("read_issue")),
			pkg("twice", () => tools("same", "same")),
			pkg("shapeless", () => ({ tools: "none" })),
			// Pi serializes every tool's parameters for each model request; without them every answer fails.
			pkg("schemaless", () => ({ ...tools(), tools: [{ ...tool("schemaless_tool"), parameters: undefined }] })),
			pkg("settled", ({ userSettings }) => userSettings && tools(`settled_${userSettings.n}`)),
			pkg("constructor", ({ userSettings }) => userSettings && tools("inherited")),
		];
		const lines = [];
		const bound = (u) => toolsFor(u, packages, "/nonexistent", () => () => {}, () => () => {}, { log: (l) => lines.push(l) }).map((p) => [p.name, p.tools.tools.map((t) => t.name)]);
		assert.deepEqual(bound(user("martin", { settled: { n: 1 } })), [["installed", ["read_issue"]], ["picky", ["pick"]], ["settled", ["settled_1"]]]);
		assert.deepEqual(bound(user("alex")), [["installed", ["read_issue"]]]);
		assert.deepEqual(lines, [
			'paca: local extension local-extensions/clash skipped for user martin: tool "read_issue" is already offered by installed',
			'paca: local extension local-extensions/twice skipped for user martin: tool "same" is already offered twice',
			"paca: local extension local-extensions/shapeless skipped for user martin: forUser must return { tools, labels, scope: { label, detail } }",
			'paca: local extension local-extensions/schemaless skipped for user martin: tool "schemaless_tool" needs a label, a description, parameters (a schema such as Type.Object({})) and an execute function',
			"paca: local extension local-extensions/picky skipped for user alex: picky: needs settings",
			'paca: local extension local-extensions/clash skipped for user alex: tool "read_issue" is already offered by installed',
			'paca: local extension local-extensions/twice skipped for user alex: tool "same" is already offered twice',
			"paca: local extension local-extensions/shapeless skipped for user alex: forUser must return { tools, labels, scope: { label, detail } }",
			'paca: local extension local-extensions/schemaless skipped for user alex: tool "schemaless_tool" needs a label, a description, parameters (a schema such as Type.Object({})) and an execute function',
		]);
		// An installed package still refuses the start.
		assert.throws(() => toolsFor(user("martin"), [pkg("strict", () => { throw new Error("bad settings"); }, false)], "/nonexistent", () => () => {}, () => () => {}), /bad settings/);
		// Only a user's own keys are settings: Object.prototype.constructor is not.
		assert.deepEqual(bound(user("bob")).map(([name]) => name), ["installed", "picky"]);
	});

	it("imports Paca's packages from outside the checkout, and its own dependencies from its node_modules", async () => {
		const dataDir = await dataFolder();
		const dir = join(dataDir, "users", "martin", "local-extensions", "deps");
		await writeFiles(dir, {
			"package.json": '{"type":"module","dependencies":{"own-esm":"1.0.0","own-cjs":"1.0.0","needs-host":"1.0.0"}}',
			"index.ts": `import { defineToolPackage, OperationError } from "@paca/extension";
import { Type } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { esm } from "own-esm";
import cjs from "own-cjs";
import { HostError } from "needs-host";
export default defineToolPackage({
	name: "deps",
	forUser: () => ({ tools: [defineTool({ name: "deps", label: "d", description: "d", parameters: Type.Object({}), execute: async () => ({ content: [], details: undefined }) })], labels: {}, scope: { label: "deps", detail: "" } }),
	found: { OperationError, HostError, esm, cjs, faux: typeof fauxProvider },
});
`,
			"node_modules/own-esm/package.json": '{"name":"own-esm","type":"module","exports":"./index.js"}',
			"node_modules/own-esm/index.js": 'export const esm = "own esm";\n',
			"node_modules/own-cjs/package.json": '{"name":"own-cjs","main":"index.js"}',
			"node_modules/own-cjs/index.js": 'module.exports = { cjs: "own cjs", host: require("@paca/extension").OperationError };\n',
			"node_modules/needs-host/package.json": '{"name":"needs-host","type":"module","exports":"./index.js"}',
			"node_modules/needs-host/index.js": 'export { OperationError as HostError } from "@paca/extension";\n',
			// A copy of a host package in the extension is never used.
			"node_modules/@paca/extension/package.json": '{"name":"@paca/extension","type":"module","exports":"./index.js"}',
			"node_modules/@paca/extension/index.js": 'throw new Error("the extension\'s own copy of @paca/extension was loaded");\n',
		});
		const lines = [];
		const local = await loadLocalExtensions({ dataDir, users: [user("martin")], installed: [], log: { log: (l) => lines.push(l) } });
		assert.deepEqual(lines, ["paca: local extension users/martin/local-extensions/deps: loaded"]);
		const { found } = local.get("martin")[0].package;
		assert.equal(found.OperationError, OperationError);
		assert.equal(found.HostError, OperationError);
		assert.deepEqual([found.esm, found.cjs.cjs, found.faux], ["own esm", "own cjs", "function"]);
		assert.equal(found.cjs.host, OperationError);
	});

	it("takes an edit, or a fix of a broken extension, in a fresh process", async () => {
		const dataDir = await dataFolder();
		const dir = join(dataDir, "local-extensions", "dice");
		const files = await guideFiles();
		await writeFiles(dir, { ...files, "index.ts": `${files["index.ts"]}\nthis is not TypeScript\n` });
		await writeFile(join(dataDir, "config.json"), JSON.stringify({ extensions: {}, users: [user("martin")] }));
		const env = { ...process.env, PACA_DATA_DIR: dataDir, PACA_CONFIG: join(dataDir, "config.json") };
		const run = async (script, ...args) => {
			try {
				const { stdout } = await promisify(execFile)(process.execPath, [script, ...args], { env, cwd: ROOT });
				return [0, stdout];
			} catch (error) {
				return [error.code, error.stdout];
			}
		};
		const check = () => run(join(ROOT, "packages", "api", "src", "check-extensions.ts"));
		const answer = async () => (await run(join(import.meta.dirname, "fixtures", "roll-once.js"), dataDir))[1].trim();

		const [broken, brokenOut] = await check();
		assert.equal(broken, 1);
		assert.match(brokenOut, /^paca: local extension local-extensions\/dice skipped: .+\(file:\/\/.+\/index\.ts:\d+\)\nuser martin: no tools\n$/);

		await writeFile(join(dir, "index.ts"), files["index.ts"]);
		assert.deepEqual(await check(), [0, "paca: local extension local-extensions/dice: loaded with its frontend\nuser martin: dice (roll_dice)\n"]);
		assert.match(await answer(), /^Rolled \d+ on a d6\.$/);

		// An edit of a file the entry imports, picked up by the next process.
		await writeFile(join(dir, "roll.ts"), "export function roll(sides: number) {\n\treturn sides + 1;\n}\n");
		assert.equal(await answer(), "Rolled 7 on a d6.");

		// A folder that cannot be read fails the check too.
		await mkdir(join(dataDir, "users", "martin"), { recursive: true });
		await writeFile(join(dataDir, "users", "martin", "local-extensions"), "not a folder");
		const [unreadable, unreadableOut] = await check();
		assert.equal(unreadable, 1);
		assert.match(unreadableOut, /^paca: local extensions in users\/martin\/local-extensions skipped: ENOTDIR: /m);
	});
});
