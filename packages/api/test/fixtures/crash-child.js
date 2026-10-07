// Starts a session whose model request never returns, reports it, and waits to be killed.
import { fauxModel, openUser } from "../helpers.js";

const [dir, id] = process.argv.slice(2);
const model = await fauxModel(dir, [() => (console.log("requested"), new Promise(() => {}))]);
const { sessions } = await openUser({ dir, model });
sessions.start(id, "still running?", "request-6");
