// Ask one question from the terminal as the operator, with the same tools, limits and isolation as
// the web chat. The session is in memory, so nothing is saved. A draft is printed, not stored:
// only the web page can approve one. The ask.sqlite of earlier versions is no longer read.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Proposal } from "@paca/extension";
import { LIMITS, openAgent, type Run } from "./agent.ts";
import { DATA_DIR, loadConfig, userDataDir } from "./config.ts";
import { loadPackages } from "./extensions.ts";
import { openModels } from "./models.ts";
import { toolsFor } from "./users.ts";
import { uiState } from "./view.ts";

const question = process.argv.slice(2).join(" ") || "What needs attention across my projects?";
const config = await loadConfig({ needWeb: false });
const operator = config.users.find((u) => u.operator);
if (!operator) throw new Error("npm run ask asks as the operator; mark one user with \"operator\": true");
const userDir = userDataDir(DATA_DIR, operator);
const piDir = join(userDir, "pi");
await mkdir(piDir, { recursive: true, mode: 0o700 });
const { models, model, label } = await openModels(DATA_DIR, config.model);
const proposals: Proposal[] = [];
// Cards are for the page; here they are dropped.
const packages = toolsFor(operator, await loadPackages(config.extensions, undefined, { log: { log: () => {} } }), userDir, () => (_toolCallId, _ctx, proposal) => void proposals.push(proposal), () => () => {});
console.error(`model ${label}; tools ${packages.map((p) => `${p.name} (${p.tools.scope.label})`).join(", ") || "none"}`);

let session: AgentSession | undefined;
const run: Run = {
	requests: 0,
	tools: 0,
	stop(reason) {
		if (run.stopReason !== undefined) return;
		run.stopReason = reason;
		void session?.abort();
	},
};
session = await openAgent({ dir: piDir, sessionManager: SessionManager.inMemory(piDir), modelRuntime: models, model, packages, limits: LIMITS, run: () => run });
const started = Date.now();
const timer = setTimeout(() => run.stop(`Stopped after ${LIMITS.durationMs / 60_000} minutes, the limit for one answer.`), LIMITS.durationMs);
await session.prompt(question, { expandPromptTemplates: false });
clearTimeout(timer);

const labels = Object.assign({}, ...packages.map((p) => p.tools.labels));
const last = uiState(session.sessionManager.getBranch(), { describe: { labels, checkUrl: () => undefined } }).turns.at(-1);
for (const step of last?.steps ?? []) console.error(`- ${step.label}: ${step.status}${step.detail ? ` (${step.detail})` : ""}`);
for (const notice of last?.notices ?? []) console.error(`! ${notice.text}`);
if (run.stopReason) console.error(`! ${run.stopReason}`);
for (const p of proposals) console.error(`proposal for ${p.target}, not performed (approve proposals in the web page): ${p.title}`);
console.log(last?.answer || "(no answer)");
console.error(`${run.stopReason ? "stopped" : "done"} in ${Math.round((Date.now() - started) / 1000)} s`);
session.dispose();
// Open handles in the model stack outlive dispose(); this is a one-shot command.
process.exit(run.stopReason || !last?.answer ? 1 : 0);
