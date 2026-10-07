import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPackages } from "../src/extensions.ts";
import { openUsers } from "../src/users.ts";
import { fauxModel, idle, newId, tempDir, text } from "./helpers.js";

describe("tool packages", () => {
	it("loads only the packages config.json enables, by package name", async () => {
		const [github] = await loadPackages({ "@paca/extension-github": { piClean: "/opt/pi-clean" } });
		assert.equal(github.package.name, "github");
		assert.deepEqual(github.settings, { piClean: "/opt/pi-clean" });
		assert.deepEqual(await loadPackages({}), []);
	});

	it("refuses paths, modules that are not tool packages and reused names", async () => {
		const tool = (name) => async () => ({ default: { name, forUser: () => undefined } });
		await assert.rejects(loadPackages({ "./local.ts": {} }), /is a path/);
		await assert.rejects(loadPackages({ "file:///tmp/x.js": {} }), /is a path/);
		await assert.rejects(loadPackages({ "some-lib": {} }, async () => ({ default: { run() {} } })), /no default export from defineToolPackage/);
		await assert.rejects(loadPackages({ a: {}, b: {} }, tool("same")), /reuses the name "same"/);
		await assert.rejects(loadPackages({ a: {} }, tool("paca")), /reuses the name "paca"/);
	});

	it("binds the real GitHub package per user, and gives a user without settings no tools", async () => {
		const dataDir = await tempDir("paca-ext-");
		const model = await fauxModel(dataDir, [text("one"), text("two")]);
		process.env.PACA_TEST_TOKEN_WITH = "test-token";
		const users = await openUsers({
			users: [
				{ id: "with", subject: "s1", operator: false, github: { projects: [{ owner: "o", number: 1, repository: "o/r" }], tokenEnv: "PACA_TEST_TOKEN_WITH" } },
				{ id: "without", subject: "s2", operator: false },
			],
			packages: await loadPackages({ "@paca/extension-github": { piClean: "/opt/pi-clean" } }),
			dataDir,
			modelRuntime: model.modelRuntime,
			model: model.model,
			modelLabel: "faux",
			log: { log: () => {}, error: () => {} },
		});
		delete process.env.PACA_TEST_TOKEN_WITH;
		const offered = async (subject) => {
			const { sessions } = users.forSubject(subject);
			const id = newId();
			sessions.start(id, "hi", "request-1");
			await idle(sessions, id);
			return sessions.agentOf(id).getActiveToolNames().sort();
		};
		assert.deepEqual(await offered("s1"), ["draft_issue", "portfolio_overview", "read_issue", "search_issues"]);
		assert.deepEqual(await offered("s2"), []);
		assert.equal(users.forSubject("s2").info.scope, "No tools");
		await users.close();
	});
});
