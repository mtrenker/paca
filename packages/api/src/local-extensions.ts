// Private extensions from the data folder (#19), loaded once at start: <data>/local-extensions/<name>/
// for every configured user, <data>/users/<id>/local-extensions/<name>/ for that user only. They
// keep the installed packages' contract and are trusted server code the same way, not sandboxed.
// Unlike an installed package, one that is broken or collides is skipped with one log line instead
// of refusing the start, since the data folder is edited by hand or by an agent. An edit takes
// effect at the next start: nothing watches or reloads. Authoring and recovery:
// docs/local-extensions.md.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { UserConfig } from "./config.ts";
import { checkPackage, type LoadedPackage } from "./extensions.ts";

/** Resolved from Paca for every local extension, like peer dependencies: one Pi, one OperationError class. */
const HOST_PACKAGES = /^(@paca\/extension|@earendil-works\/pi-ai|@earendil-works\/pi-coding-agent)(\/|$)/;
const NAME = /^[a-z][a-z0-9-]*$/;
/** Names a local extension may not take: Paca's own, and the keys of a users[] entry. */
const RESERVED = ["paca", "id", "subject", "operator"];

const roots: string[] = [];
let hooked = false;
let skips = 0;

/** Logs why a local extension, or a folder of them, is left out; `npm run check-extensions` counts these. */
export function logSkip(log: Pick<Console, "log">, line: string) {
	skips += 1;
	log.log(line);
}

/** How many skips this process logged. */
export const skipCount = () => skips;

/**
 * Lets files under `dir` import the host packages, which no node_modules above them holds (/data
 * beside /app in the container). They get the very modules Paca imports, also through `require`,
 * whose resolver ignores a changed parentURL. Imports from anywhere else, and every other import,
 * resolve as usual, so an extension's own dependencies come from its own node_modules.
 */
function shareHostPackages(dir: string) {
	roots.push(pathToFileURL(dir).href + "/");
	if (hooked) return;
	hooked = true;
	registerHooks({
		resolve: (specifier, context, next) =>
			HOST_PACKAGES.test(specifier) && roots.some((root) => context.parentURL?.startsWith(root)) ? { url: import.meta.resolve(specifier), shortCircuit: true } : next(specifier, context),
	});
}

export interface LocalOptions {
	dataDir: string;
	/** The configured users; other directories under users/ are never read. */
	users: readonly UserConfig[];
	/** The installed packages, whose names win. */
	installed: readonly LoadedPackage[];
	log?: Pick<Console, "log">;
}

/**
 * Each user's local extensions, in the order they join the installed packages: the global ones,
 * then the user's own, each by directory name. A name belongs to the first package loaded with it.
 */
export async function loadLocalExtensions({ dataDir, users, installed, log = console }: LocalOptions): Promise<Map<string, LoadedPackage[]>> {
	const taken = new Map<string, string>([["paca", "Paca"], ...installed.map((p) => [p.package.name, p.module] as const)]);
	const global = await loadFolder(dataDir, "local-extensions", taken, log);
	const byUser = new Map<string, LoadedPackage[]>();
	for (const user of users) byUser.set(user.id, [...global, ...(await loadFolder(dataDir, `users/${user.id}/local-extensions`, new Map(taken), log))]);
	return byUser;
}

async function loadFolder(dataDir: string, folder: string, taken: Map<string, string>, log: Pick<Console, "log">) {
	let names: string[];
	try {
		names = readdirSync(join(dataDir, folder)).sort();
	} catch (error) {
		// No folder, no extensions; one that cannot be read, such as one owned by another user, says so.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") logSkip(log, `paca: local extensions in ${folder} skipped: ${(error as Error).message}`);
		return [];
	}
	const loaded: LoadedPackage[] = [];
	for (const name of names) {
		const where = `${folder}/${name}`;
		// A dot directory is switched off.
		if (name.startsWith(".")) continue;
		let dir = join(dataDir, folder, name);
		try {
			// Throws for a link to nothing, a link loop or a folder that cannot be searched.
			if (!statSync(dir).isDirectory()) continue; // files beside the extensions are not extensions
			// Node gives modules their real path, so the manifest's dir and the resolve hook compare against it.
			dir = realpathSync(dir);
			const pkg = await loadOne(dir, name, where, taken, log);
			taken.set(name, where);
			loaded.push(pkg);
			log.log(`paca: local extension ${where}: loaded${pkg.frontend ? " with its frontend" : ""}`);
		} catch (error) {
			logSkip(log, `paca: local extension ${where} skipped: ${reason(error, where, dir)}`);
		}
	}
	return loaded;
}

async function loadOne(dir: string, name: string, where: string, taken: ReadonlyMap<string, string>, log: Pick<Console, "log">): Promise<LoadedPackage> {
	if (!NAME.test(name) || RESERVED.includes(name)) throw new Error(`the directory name must be lowercase letters, digits and dashes, and not ${RESERVED.join(", ")}`);
	const owner = taken.get(name);
	if (owner) throw new Error(`the name "${name}" is taken by ${owner}`);
	let type: unknown;
	try {
		type = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).type;
	} catch (error) {
		throw new Error(`it needs a package.json with "type": "module" (${(error as NodeJS.ErrnoException).code ?? "not valid JSON"})`);
	}
	if (type !== "module") throw new Error('it needs a package.json with "type": "module"');
	const entry = ["index.ts", "index.js"].find((file) => existsSync(join(dir, file)));
	if (!entry) throw new Error("it needs an index.ts or index.js");
	shareHostPackages(dir);
	const pkg = checkPackage(where, (await import(pathToFileURL(join(dir, entry)).href)).default, undefined, () => dir, { log, build: "build the browser code" });
	if (pkg.package.name !== name) throw new Error(`defineToolPackage names it "${pkg.package.name}"; use its directory name, "${name}"`);
	return { ...pkg, local: true };
}

/** One line: the error, without repeating `where`, and the first place in the extension's own files the stack names. */
function reason(error: unknown, where: string, dir: string) {
	const { message = String(error), stack = "" } = (error ?? {}) as Error;
	const own = pathToFileURL(dir).href + "/";
	const at = stack.match(/file:\/\/[^\s)]+?:\d+/g)?.find((url) => url.startsWith(own));
	return `${message.replace(`extensions: ${where} `, "").split("\n")[0]}${at ? ` (${at})` : ""}`;
}
