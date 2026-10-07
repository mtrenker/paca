import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadPackages } from "../src/extensions.ts";
import { openUsers } from "../src/users.ts";

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
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		process.env.PACA_TEST_TOKEN_WITH = "test-token";
		const users = await openUsers({
			users: [
				{ id: "with", subject: "s1", operator: false, github: { projects: [{ owner: "o", number: 1, repository: "o/r" }], tokenEnv: "PACA_TEST_TOKEN_WITH" } },
				{ id: "without", subject: "s2", operator: false },
			],
			packages: await loadPackages({ "@paca/extension-github": { piClean: "/opt/pi-clean" } }),
			dataDir: await mkdtemp(join(tmpdir(), "paca-ext-")),
			models,
			model: { provider: model.provider, modelId: model.id },
			modelLabel: "faux",
			storage: async () => new MemoryStorage(),
			log: { log: () => {} },
		});
		delete process.env.PACA_TEST_TOKEN_WITH;
		const offered = async (subject) => (await users.forSubject(subject).paca.root.agent(ctx)).tools.map((t) => t.name).sort();
		assert.deepEqual(await offered("s1"), ["draft_issue", "portfolio_overview", "read_issue", "search_issues"]);
		assert.deepEqual(await offered("s2"), []);
		assert.equal(users.forSubject("s2").info.scope, "No tools");
		await users.close();
	});
});
