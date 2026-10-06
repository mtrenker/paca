// Starts the Paca web chat. See README for the private configuration and how to run it.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openPaca } from "./agent.js";
import { createOidc, createSessions, loadSessionKey } from "./auth.js";
import { DATA_DIR, loadConfig } from "./config.js";
import { createGitHub } from "./github.js";
import { openModels } from "./models.js";
import { createApp, createStateFeed } from "./server.js";
import { uiState } from "./view.js";

const config = await loadConfig();
await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });

const oidc = await createOidc({
	issuer: config.oidc.issuer,
	clientId: config.oidc.clientId,
	clientSecret: process.env.PACA_OIDC_CLIENT_SECRET,
	redirectUri: new URL("/auth/callback", config.publicUrl).href,
});
const sessions = createSessions({ key: await loadSessionKey(DATA_DIR), issuer: oidc.issuer, allowedSubject: config.oidc.allowedSubject });

const { models, model, label } = await openModels(DATA_DIR, config.model);
const github = createGitHub({ projects: config.github.projects, piClean: config.piClean, dataDir: DATA_DIR });
const paca = await openPaca({ storage: await openNodeSqliteStorage(join(DATA_DIR, "paca.sqlite")), models, model, github });

const view = await paca.root.viewState(BACKGROUND_CONTEXT);
const drafts = await paca.draftsState();
const state = createStateFeed(() => uiState(view.value, { busy: paca.busy(), drafts: drafts.value }));
view.subscribe(() => state.changed());
drafts.subscribe(() => state.changed());

const info = { model: label, repositories: github.repositories, projects: github.projects.length };
const server = createApp({ config, sessions, oidc, paca, state, info, publicDir: join(import.meta.dirname, "..", "public") });
server.listen(config.port, config.host, () => {
	console.log(`paca: listening on http://${config.host}:${config.port}, public at ${config.publicUrl}`);
	console.log(`paca: model ${label}; ${github.projects.length} Projects in ${github.repositories.length} repositories`);
});

const shutdown = () => {
	console.log("paca: stopping");
	server.close();
	paca.close().finally(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
