// Starts an answer whose model request never returns, reports it, and waits to be killed.
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { githubTools } from "@paca/extension-github";
import { openPaca, proposeFor } from "../../src/agent.ts";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([() => (console.log("requested"), new Promise(() => {}))]);
const model = faux.getModel();
const github = { projects: [{ owner: "o", number: 1, repository: "o/r" }] };
const packages = [{ name: "github", tools: githubTools(github, proposeFor("github")) }];
const paca = await openPaca({ storage: await openNodeSqliteStorage(process.argv[2]), models, model: { provider: model.provider, modelId: model.id }, packages });
await paca.ask("still running?", "request-6");
