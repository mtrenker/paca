// Ask one question from the terminal, with the same tools and limits as the web chat.
// Uses its own conversation store, so it never touches the web conversation.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPaca } from "./agent.js";
import { DATA_DIR, loadConfig } from "./config.js";
import { createGitHub } from "./github.js";
import { openModels } from "./models.js";
import { uiState } from "./view.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const question = process.argv.slice(2).join(" ") || "What needs attention across my projects?";
const config = await loadConfig({ needWeb: false });
await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
const { models, model, label } = await openModels(DATA_DIR, config.model);
const github = createGitHub({ projects: config.github.projects, piClean: config.piClean, dataDir: DATA_DIR });
const paca = await openPaca({ storage: await openNodeSqliteStorage(join(DATA_DIR, "ask.sqlite")), models, model, github });
console.error(`model ${label}; scope ${github.repositories.join(", ")}`);
const started = Date.now();
const { settled } = await paca.ask(question, `ask-${Date.now()}`);
const result = await settled;
const view = await paca.root.viewState(BACKGROUND_CONTEXT);
const last = uiState(view.value).turns.at(-1);
view.dispose();
for (const step of last.steps) console.error(`- ${step.label}: ${step.status}${step.detail ? ` (${step.detail})` : ""}`);
for (const notice of last.notices) console.error(`! ${notice.text}`);
console.log(last.answer || `(no answer: ${result.status} ${result.reason ?? ""})`);
console.error(`${result.status} in ${Math.round((Date.now() - started) / 1000)} s`);
await paca.close();
// Open handles in the model stack outlive close(); this is a one-shot command.
process.exit(result.status === "done" ? 0 : 1);
