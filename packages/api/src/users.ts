// The configured users, each with their own store, sessions, tools and header info, all under
// users/<id>/. Requests reach a user only through the subject of their verified session; see
// docs/architecture.md.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@paca/contracts";
import type { Operation, Propose, Show, UserApi, UserTools } from "@paca/extension";
import type { Limits, PackageTools } from "./agent.ts";
import { type ApiAccess, createApiAccess, type UserAccess } from "./api-access.ts";
import { legacyStorePath, type UserConfig, userDataDir } from "./config.ts";
import type { Frontend, LoadedPackage } from "./extensions.ts";
import { convertLegacy } from "./legacy.ts";
import { logSkip } from "./local-extensions.ts";
import { openSessions, type Sessions } from "./sessions.ts";
import { openStore } from "./store.ts";

export interface UserHost {
	user: UserConfig;
	/** The user's id, for log lines. */
	id: string;
	sessions: Sessions;
	/** What the page header shows about this user's scope. The APIs' state is read per request (`apis`). */
	info: Omit<SessionInfo, "csrf" | "name" | "apis">;
	/** The frontends this user's page lists, by package name. Per user: two users' local extensions can share a name. */
	frontends: ReadonlyMap<string, Frontend>;
	/** One of the operations a package gave this user. */
	operation(packageName: string, op: string): Operation | undefined;
	/** The APIs this user's extensions call with their sign-in's access token (api-access.ts). */
	apis: UserAccess;
}

export interface OpenUsersOptions {
	users: UserConfig[];
	packages: LoadedPackage[];
	/** Each user's local extensions (local-extensions.ts), after the installed packages. */
	local?: ReadonlyMap<string, readonly LoadedPackage[]>;
	dataDir: string;
	modelRuntime: ModelRuntime;
	model: Model<any>;
	modelLabel: string;
	limits?: Limits;
	/** Access to the configured APIs; without it, nobody calls any. */
	apiAccess?: ApiAccess;
	/** Removes one file during a delete; tests hold or fail it. */
	removeFile?: (path: string) => Promise<void>;
	log?: Pick<Console, "log" | "error">;
}

/**
 * Each user's tools from every enabled package, bound to that user's identity and settings. A
 * package's cards are checked against its manifest, also while its frontend is off. A local
 * extension that throws, or whose tools are malformed or reuse a name, is left out for this user
 * with one log line; an installed package that throws still refuses the start.
 */
export function toolsFor(user: UserConfig, packages: readonly LoadedPackage[], cacheDir: string, proposeFor: (packageName: string) => Propose, showFor: (packageName: string, kinds: readonly string[]) => Show, log: Pick<Console, "log"> = console, apisFor: (packageName: string) => Record<string, UserApi> = () => ({})): PackageTools[] {
	const tools: PackageTools[] = [];
	for (const { module, package: pkg, settings, local } of packages) {
		try {
			const show = showFor(pkg.name, pkg.browser?.cards ?? []);
			const userSettings = Object.hasOwn(user, pkg.name) ? user[pkg.name] : undefined;
			const userTools = pkg.forUser({ user: { id: user.id, operator: user.operator }, settings, userSettings, cacheDir, propose: proposeFor(pkg.name), show, apis: apisFor(pkg.name) });
			if (userTools && local) checkTools(userTools, tools);
			if (userTools) tools.push({ name: pkg.name, tools: userTools });
		} catch (error) {
			if (!local) throw error;
			logSkip(log, `paca: local extension ${module} skipped for user ${user.id}: ${(error as Error)?.message ?? error}`);
		}
	}
	return tools;
}

/**
 * Throws unless a local extension's tools have the members of Pi's ToolDefinition that every
 * answer uses (a tool without `parameters` fails every model request) and new names.
 */
function checkTools(userTools: UserTools, before: readonly PackageTools[]) {
	if (!Array.isArray(userTools.tools) || typeof userTools.labels !== "object" || typeof userTools.scope?.label !== "string" || typeof userTools.scope.detail !== "string") {
		throw new Error("forUser must return { tools, labels, scope: { label, detail } }");
	}
	const names = new Map(before.flatMap((p) => p.tools.tools.map((t) => [t.name, p.name] as const)));
	for (const tool of userTools.tools) {
		if (typeof tool?.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error("each tool needs a name of letters, digits, _ and -");
		const { label, description, parameters, execute } = tool;
		if (typeof label !== "string" || typeof description !== "string" || typeof parameters !== "object" || parameters === null || Array.isArray(parameters) || typeof execute !== "function") {
			throw new Error(`tool "${tool.name}" needs a label, a description, parameters (a schema such as Type.Object({})) and an execute function`);
		}
		const owner = names.get(tool.name);
		if (owner !== undefined) throw new Error(`tool "${tool.name}" is already offered${owner ? ` by ${owner}` : " twice"}`);
		names.set(tool.name, "");
	}
}

/** Opens every user, converting each one's legacy store first. Call before the server listens. */
export async function openUsers({ users, packages, local, dataDir, modelRuntime, model, modelLabel, limits, apiAccess = noApis, removeFile, log = console }: OpenUsersOptions) {
	const bySubject = new Map<string, UserHost>();
	for (const user of users) {
		const dir = userDataDir(dataDir, user);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const store = openStore(join(dir, "paca.db"));
		await convertLegacy({ legacyPath: legacyStorePath(dataDir, user), userDir: dir, store, log });
		const mine = [...packages, ...(local?.get(user.id) ?? [])];
		const apis = apiAccess.forUser(user.id, user.subject, user.apis ?? []);
		const sessions = await openSessions({ userDir: dir, store, modelRuntime, model, tools: (proposeFor, showFor) => toolsFor(user, mine, dir, proposeFor, showFor, log, apis.forExtension), limits, removeFile, log });
		const scope = sessions.packages.map((p) => p.tools.scope);
		// The page loads a frontend only for a package that gave this user tools.
		const frontends = new Map(sessions.packages.flatMap((p) => {
			const frontend = mine.find((l) => l.package.name === p.name)?.frontend;
			return frontend ? [[p.name, frontend] as const] : [];
		}));
		const info = { model: modelLabel, scope: scope.map((s) => s.label).join(" · ") || "No tools", scopeDetail: scope.map((s) => s.detail).join("; "), extensions: [...frontends.values()].map((f) => f.info) };
		const operation = (packageName: string, op: string) => {
			const operations = sessions.packages.find((p) => p.name === packageName)?.tools.operations;
			return operations && Object.hasOwn(operations, op) ? operations[op] : undefined;
		};
		bySubject.set(user.subject, { user, id: user.id, sessions, info, frontends, operation, apis });
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

const noApis = createApiAccess({ apis: {}, refresh: () => Promise.reject(new Error("no APIs")) });
