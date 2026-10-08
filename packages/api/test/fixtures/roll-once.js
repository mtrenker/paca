// A fresh process for local-extensions.test.js: loads the local extensions of <data dir> (argv[2])
// for "martin", has the faux model call roll_dice once, and prints the tool's result.
import { loadLocalExtensions } from "../../src/local-extensions.ts";
import { openUsers } from "../../src/users.ts";
import { call, fauxModel, idle, newId, tempDir, text } from "../helpers.js";

const dataDir = process.argv[2];
const users = [{ id: "martin", subject: "sub-martin", operator: true }];
const local = await loadLocalExtensions({ dataDir, users, installed: [], log: { log: () => {} } });
const model = await fauxModel(await tempDir("paca-model-"), [call("roll_dice"), text("Done.")]);
const opened = await openUsers({ users, packages: [], local, dataDir, modelRuntime: model.modelRuntime, model: model.model, modelLabel: "faux", log: { log: () => {}, error: () => {} } });
const { sessions } = opened.forSubject("sub-martin");
const id = newId();
sessions.start(id, "Roll a die", "request-roll-once");
await idle(sessions, id);
console.log(sessions.agentOf(id).messages.find((m) => m.role === "toolResult")?.content[0]?.text ?? "(no tool result)");
await opened.close();
process.exit(0);
