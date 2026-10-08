// Loads the tool packages and local extensions as a start would, binds them for every configured
// user, and prints what each user gets: a check of an edited local extension before restarting
// Paca. It starts no server, opens no store and runs no tool, but importing and binding run the
// extensions' own code. Exits 1 when a local extension, or a folder of them, was skipped. See
// docs/local-extensions.md.
import { DATA_DIR, loadConfig, userDataDir } from "./config.ts";
import { loadPackages } from "./extensions.ts";
import { loadLocalExtensions, skipCount } from "./local-extensions.ts";
import { toolsFor } from "./users.ts";

const config = await loadConfig({ needWeb: false });
const installed = await loadPackages(config.extensions, undefined, { disableFrontends: config.disableFrontends, log: console });
const local = await loadLocalExtensions({ dataDir: DATA_DIR, users: config.users, installed, log: console });
for (const user of config.users) {
	const packages = toolsFor(user, [...installed, ...(local.get(user.id) ?? [])], userDataDir(DATA_DIR, user), () => () => {}, () => () => {});
	console.log(`user ${user.id}: ${packages.map((p) => `${p.name} (${p.tools.tools.map((t) => t.name).join(", ") || "no tools"})`).join("; ") || "no tools"}`);
}
process.exit(skipCount() > 0 ? 1 : 0);
