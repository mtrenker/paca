// Writes test/fixtures/pre-refactor.sqlite with Paca as of 51d90dc (single-user, before the
// TypeScript refactor): run once from a checkout of that revision. Synthetic: faux model, fake GitHub.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPaca } from "../../src/agent.js";

const file = join(import.meta.dirname, "pre-refactor.sqlite");
await rm(file, { force: true });
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}-${args.title ?? "x"}`.replace(/\W+/g, "-") })], { stopReason: "toolUse" });
faux.setResponses([
	call("read_issue", { repository: "legacy/repo", number: 1 }),
	fauxAssistantMessage("legacy/repo#1 needs a decision."),
	call("draft_issue", { repository: "legacy/repo", title: "Created before the refactor", body: "Approved in the old app." }),
	fauxAssistantMessage("Drafted."),
	call("draft_issue", { repository: "legacy/repo", title: "Still proposed", body: "Exact legacy body." }),
	fauxAssistantMessage("Drafted another."),
]);
const model = faux.getModel();
const github = {
	projects: [{ owner: "legacy", number: 1, repository: "legacy/repo" }],
	checkRepository: (r) => r,
	readIssue: async () => "legacy/repo#1 [open] Needs a decision",
	createIssue: async () => ({ number: 41, url: "https://github.com/legacy/repo/issues/41" }),
};
const paca = await openPaca({ storage: await openNodeSqliteStorage(file), models, model: { provider: model.provider, modelId: model.id }, github });
await (await paca.ask("What needs attention?", "legacy-request-1")).settled;
await (await paca.ask("Draft the first issue", "legacy-request-2")).settled;
const first = Object.keys((await paca.harness.snapshot((await import("../../src/agent.js")).Drafts, paca.root.id, (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT)).items)[0];
console.log(await paca.approveDraft(first));
await (await paca.ask("Draft the second issue", "legacy-request-3")).settled;
await paca.close();
const db = new DatabaseSync(file);
db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;");
db.close();
console.log("wrote", file);
