// The configured users, each with their own store, sessions, tools and header info, all under
// users/<id>/. Requests reach a user only through the subject of their verified session; see
// docs/architecture.md.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@paca/contracts";
import type { Propose } from "@paca/extension";
import type { Limits, PackageTools } from "./agent.ts";
import { legacyStorePath, type UserConfig, userDataDir } from "./config.ts";
import type { LoadedPackage } from "./extensions.ts";
import { convertLegacy } from "./legacy.ts";
import { openSessions, type Sessions } from "./sessions.ts";
import { openStore } from "./store.ts";

export interface UserHost {
	user: UserConfig;
	sessions: Sessions;
	/** What the page header shows about this user's scope. */
	info: Omit<SessionInfo, "csrf" | "name">;
}

export interface OpenUsersOptions {
	users: UserConfig[];
	packages: LoadedPackage[];
	dataDir: string;
	modelRuntime: ModelRuntime;
	model: Model<any>;
	modelLabel: string;
	limits?: Limits;
	/** Removes one file during a delete; tests hold or fail it. */
	removeFile?: (path: string) => Promise<void>;
	log?: Pick<Console, "log" | "error">;
}

/** Each user's tools from every enabled package, bound to that user's identity and settings. */
export function toolsFor(user: UserConfig, packages: LoadedPackage[], cacheDir: string, proposeFor: (packageName: string) => Propose): PackageTools[] {
	const tools: PackageTools[] = [];
	for (const { package: pkg, settings } of packages) {
		const userTools = pkg.forUser({ user: { id: user.id }, settings, userSettings: user[pkg.name], cacheDir, propose: proposeFor(pkg.name) });
		if (userTools) tools.push({ name: pkg.name, tools: userTools });
	}
	return tools;
}

/** Opens every user, converting each one's legacy store first. Call before the server listens. */
export async function openUsers({ users, packages, dataDir, modelRuntime, model, modelLabel, limits, removeFile, log = console }: OpenUsersOptions) {
	const bySubject = new Map<string, UserHost>();
	for (const user of users) {
		const dir = userDataDir(dataDir, user);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const store = openStore(join(dir, "paca.db"));
		await convertLegacy({ legacyPath: legacyStorePath(dataDir, user), userDir: dir, store, log });
		const sessions = await openSessions({ userDir: dir, store, modelRuntime, model, tools: (proposeFor) => toolsFor(user, packages, dir, proposeFor), limits, removeFile, log });
		const scope = sessions.packages.map((p) => p.tools.scope);
		const info = { model: modelLabel, scope: scope.map((s) => s.label).join(" · ") || "No tools", scopeDetail: scope.map((s) => s.detail).join("; ") };
		bySubject.set(user.subject, { user, sessions, info });
		log.log(`paca: user ${user.id}${user.operator ? " (operator)" : ""}: ${sessions.packages.map((t) => t.name).join(", ") || "no tools"}`);
	}
	return {
		/** The user a verified session's subject belongs to. */
		forSubject: (subject: string) => bySubject.get(subject),
		all: () => [...bySubject.values()],
		close: () => Promise.all([...bySubject.values()].map((u) => u.sessions.close())),
	};
}

export type Users = Awaited<ReturnType<typeof openUsers>>;
