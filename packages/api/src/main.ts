// Starts the Paca web chat. See README for the private configuration and how to run it.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOidc, createSessions, loadSessionKey } from "./auth.ts";
import { DATA_DIR, loadConfig } from "./config.ts";
import { loadPackages } from "./extensions.ts";
import { openModels } from "./models.ts";
import { createApp } from "./server.ts";
import { openUsers } from "./users.ts";

const config = await loadConfig();
await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });

const oidc = await createOidc({
	issuer: config.oidc.issuer,
	clientId: config.oidc.clientId,
	clientSecret: process.env.PACA_OIDC_CLIENT_SECRET!,
	redirectUri: new URL("/auth/callback", config.publicUrl).href,
});

const { models, model, label } = await openModels(DATA_DIR, config.model);
const packages = await loadPackages(config.extensions);
// Converts each user's legacy conversation before the server listens (legacy.ts).
const users = await openUsers({ users: config.users, packages, dataDir: DATA_DIR, modelRuntime: models, model, modelLabel: label });
const sessions = createSessions({ key: await loadSessionKey(DATA_DIR), issuer: oidc.issuer, allows: (subject) => users.forSubject(subject) !== undefined });

const webDir = dirname(fileURLToPath(import.meta.resolve("@paca/web/package.json")));
const server = createApp({ config, sessions, oidc, users, web: { public: join(webDir, "public"), script: join(webDir, "dist") } });
server.listen(config.port, config.host, () => {
	console.log(`paca: listening on http://${config.host}:${config.port}, public at ${config.publicUrl}`);
	console.log(`paca: model ${label}; ${users.all().length} users; tool packages: ${packages.map((p) => p.module).join(", ") || "none"}`);
});

const shutdown = () => {
	console.log("paca: stopping");
	server.close();
	users.close().finally(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
