// The configured users, each with their own conversation store, tools and page state. Requests
// reach a user only through the subject of their verified session; see docs/architecture.md.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SessionInfo } from "@paca/contracts";
import { type Limits, openPaca, type PackageTools, type Paca, proposeFor } from "./agent.ts";
import { type UserConfig, userDataDir } from "./config.ts";
import type { LoadedPackage } from "./extensions.ts";
import { createStateFeed, type StateFeed } from "./server.ts";
import { uiState } from "./view.ts";

export interface UserHost {
	user: UserConfig;
	paca: Paca;
	state: StateFeed;
	/** What the page header shows about this user's scope. */
	info: Omit<SessionInfo, "csrf" | "name">;
}

export interface OpenUsersOptions {
	users: UserConfig[];
	packages: LoadedPackage[];
	dataDir: string;
	models: Models;
	model: { provider: string; modelId: string };
	modelLabel: string;
	limits?: Limits;
	/** SQLite next to the user's data unless a test passes its own. */
	storage?: (file: string) => Promise<Storage>;
	log?: Pick<Console, "log">;
}

/** Each user's tools from every enabled package, bound to that user's identity and settings. */
export function toolsFor(user: UserConfig, packages: LoadedPackage[], cacheDir: string): PackageTools[] {
	const tools: PackageTools[] = [];
	for (const { package: pkg, settings } of packages) {
		const userTools = pkg.forUser({ user: { id: user.id }, settings, userSettings: user[pkg.name], cacheDir, propose: proposeFor(pkg.name) });
		if (userTools) tools.push({ name: pkg.name, tools: userTools });
	}
	return tools;
}

export async function openUsers({ users, packages, dataDir, models, model, modelLabel, limits, storage = openNodeSqliteStorage, log = console }: OpenUsersOptions) {
	const bySubject = new Map<string, UserHost>();
	for (const user of users) {
		const dir = userDataDir(dataDir, user);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const tools = toolsFor(user, packages, dir);
		const paca = await openPaca({ storage: await storage(join(dir, "paca.sqlite")), models, model, packages: tools, limits });
		const view = await paca.root.viewState(BACKGROUND_CONTEXT);
		const drafts = await paca.draftsState();
		const state = createStateFeed(() => uiState(view.value, { busy: paca.busy(), drafts: drafts.value, describe: paca.describe }));
		view.subscribe(() => state.changed());
		drafts.subscribe(() => state.changed());
		const scope = tools.map((t) => t.tools.scope);
		const info = { model: modelLabel, scope: scope.map((s) => s.label).join(" · ") || "No tools", scopeDetail: scope.map((s) => s.detail).join("; ") };
		bySubject.set(user.subject, { user, paca, state, info });
		log.log(`paca: user ${user.id}${user.operator ? " (operator)" : ""}: ${tools.map((t) => t.name).join(", ") || "no tools"}`);
	}
	return {
		/** The user a verified session's subject belongs to. */
		forSubject: (subject: string) => bySubject.get(subject),
		all: () => [...bySubject.values()],
		close: () => Promise.all([...bySubject.values()].map((u) => u.paca.close())),
	};
}

export type Users = Awaited<ReturnType<typeof openUsers>>;
