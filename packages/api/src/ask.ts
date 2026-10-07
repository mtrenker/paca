// Ask one question from the terminal as the operator, with the same tools and limits as the web
// chat. Uses its own conversation store, so it never touches the web conversation.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPaca } from "./agent.ts";
import { DATA_DIR, loadConfig } from "./config.ts";
import { loadPackages } from "./extensions.ts";
import { openModels } from "./models.ts";
import { toolsFor } from "./users.ts";
import { uiState } from "./view.ts";

const question = process.argv.slice(2).join(" ") || "What needs attention across my projects?";
const config = await loadConfig({ needWeb: false });
const operator = config.users.find((u) => u.operator);
if (!operator) throw new Error("npm run ask asks as the operator; mark one user with \"operator\": true");
await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
const { models, model, label } = await openModels(DATA_DIR, config.model);
const packages = toolsFor(operator, await loadPackages(config.extensions), DATA_DIR);
const paca = await openPaca({ storage: await openNodeSqliteStorage(join(DATA_DIR, "ask.sqlite")), models, model, packages });
console.error(`model ${label}; tools ${packages.map((p) => `${p.name} (${p.tools.scope.label})`).join(", ") || "none"}`);
const started = Date.now();
const asked = await paca.ask(question, `ask-${Date.now()}`);
const result = (await asked.settled) as { status: string; reason?: string };
const view = await paca.root.viewState(BACKGROUND_CONTEXT);
const last = uiState(view.value, { describe: paca.describe }).turns.at(-1)!;
view.dispose();
for (const step of last.steps) console.error(`- ${step.label}: ${step.status}${step.detail ? ` (${step.detail})` : ""}`);
for (const notice of last.notices) console.error(`! ${notice.text}`);
console.log(last.answer || `(no answer: ${result.status} ${result.reason ?? ""})`);
console.error(`${result.status} in ${Math.round((Date.now() - started) / 1000)} s`);
await paca.close();
// Open handles in the model stack outlive close(); this is a one-shot command.
process.exit(result.status === "done" ? 0 : 1);
