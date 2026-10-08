// Loads the tool packages config.json enables. Only installed packages, by name: a package is
// trusted server code, so the operator installs it with Paca and lists it; paths are refused.
// A package's frontend (`browser`) is checked here once: a malformed manifest refuses the start,
// and missing built files turn that frontend off. The page is then served only files listed at
// start, never paths taken from a request. See docs/architecture.md#frontends.
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserManifest, ToolPackage } from "@paca/extension";
import type { ExtensionInfo } from "@paca/contracts";

export interface LoadedPackage {
	/** The npm package name it was enabled by. */
	module: string;
	package: ToolPackage;
	settings: unknown;
	/** The package's frontend, unless it has none, it is switched off or its files are missing. */
	frontend?: Frontend;
}

export interface Frontend {
	/** What the page of a user with this package's tools learns about it. */
	info: ExtensionInfo;
	/** Every file the page may load, by its path under the manifest's `dir`. */
	files: ReadonlyMap<string, { path: string; type: string }>;
}

export interface LoadOptions {
	/** The directory of an installed module's package.json. Tests point it elsewhere. */
	rootOf?: (module: string) => string;
	/** Modules whose frontend is off (`disableFrontends`); their tools still work. */
	disableFrontends?: readonly string[];
	log?: Pick<Console, "log">;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
/** A path segment the file map keeps: no dotfiles, no "..", nothing to escape. */
const SEGMENT = /^[\w-][\w.-]*$/;
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;

const defaultRoot = (module: string) => dirname(fileURLToPath(import.meta.resolve(`${module}/package.json`)));

export async function loadPackages(
	enabled: Record<string, unknown>,
	load: (name: string) => Promise<{ default?: unknown }> = (name) => import(name),
	{ rootOf = defaultRoot, disableFrontends = [], log = console }: LoadOptions = {},
): Promise<LoadedPackage[]> {
	const loaded: LoadedPackage[] = [];
	for (const [module, settings] of Object.entries(enabled)) {
		if (module.startsWith(".") || module.startsWith("/") || module.includes(":")) throw new Error(`extensions: ${module} is a path; enable installed packages by name`);
		const candidate = (await load(module)).default as Partial<ToolPackage> | undefined;
		if (typeof candidate?.name !== "string" || !NAME.test(candidate.name) || typeof candidate.forUser !== "function") {
			throw new Error(`extensions: ${module} has no default export from defineToolPackage()`);
		}
		if (candidate.name === "paca" || loaded.some((p) => p.package.name === candidate.name)) throw new Error(`extensions: ${module} reuses the name "${candidate.name}"`);
		const pkg = candidate as ToolPackage;
		const entry: LoadedPackage = { module, package: pkg, settings };
		if (pkg.browser !== undefined) {
			const manifest = checkManifest(module, pkg.browser, rootOf(module));
			if (disableFrontends.includes(module)) log.log(`paca: extension ${module}: frontend disabled by config`);
			else entry.frontend = frontendOf(module, pkg.name, manifest, log);
		}
		loaded.push(entry);
	}
	return loaded;
}

/** A clean relative file path ending in `ext`: no leading slash, no dot segments, no backslashes. */
const isFile = (path: unknown, ext: string): path is string => typeof path === "string" && path.endsWith(ext) && path.split("/").every((s) => SEGMENT.test(s));

/** Throws for a developer error in the manifest; returns its directory as a path. */
function checkManifest(module: string, manifest: BrowserManifest, root: string) {
	const fail = (message: string): never => {
		throw new Error(`extensions: ${module} browser: ${message}`);
	};
	if (typeof manifest !== "object" || manifest === null) fail("must be an object");
	let dir = "";
	try {
		dir = fileURLToPath(new URL(manifest.dir));
	} catch {
		fail("dir must be a file: URL");
	}
	const inside = relative(root, dir);
	if (!inside || inside.split(sep).includes("..") || /^([a-zA-Z]:|[\\/])/.test(inside)) fail("dir must be a directory inside the package");
	if (!isFile(manifest.entry, ".js")) fail("entry must be a .js file inside dir");
	const styles = manifest.styles ?? [];
	if (!Array.isArray(styles) || !styles.every((s) => isFile(s, ".css"))) fail("styles must be .css files inside dir");
	const cards = manifest.cards ?? [];
	if (!Array.isArray(cards) || !cards.every((k) => typeof k === "string" && NAME.test(k)) || new Set(cards).size !== cards.length) fail("cards must be distinct names of lowercase letters, digits and dashes");
	const pages: Record<string, { title: string }> = {};
	if (manifest.pages !== undefined && (typeof manifest.pages !== "object" || manifest.pages === null || Array.isArray(manifest.pages))) fail("pages must map page names to { title }");
	for (const [page, value] of Object.entries(manifest.pages ?? {})) {
		if (!NAME.test(page)) fail(`page ${JSON.stringify(page)} must be lowercase letters, digits and dashes`);
		if (typeof value?.title !== "string" || !value.title.trim() || value.title.length > 60) fail(`page ${page} needs a title of 1 to 60 characters`);
		pages[page] = { title: value.title };
	}
	const nav = manifest.nav;
	if (nav !== undefined) {
		if (typeof nav?.page !== "string" || !Object.hasOwn(pages, nav.page)) fail("nav.page must be a declared page");
		if (typeof nav.label !== "string" || !nav.label.trim() || nav.label.length > 24) fail("nav.label must have 1 to 24 characters");
	}
	return { dir, entry: manifest.entry, styles: [...styles], cards: [...cards], pages, ...(nav ? { nav: { label: nav.label, page: nav.page } } : {}) };
}

/** The frontend with its file map, or undefined (logged once) when its built files are missing. */
function frontendOf(module: string, name: string, manifest: ReturnType<typeof checkManifest>, log: Pick<Console, "log">): Frontend | undefined {
	const files = new Map<string, { path: string; type: string }>();
	let bytes = 0;
	const walk = (dir: string, prefix: string) => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return; // a missing directory has no files
		}
		for (const entry of names) {
			if (!SEGMENT.test(entry)) continue;
			const path = join(dir, entry);
			const stat = lstatSync(path);
			if (stat.isDirectory()) walk(path, `${prefix}${entry}/`);
			else if (stat.isFile() && TYPES[entry.slice(entry.lastIndexOf("."))]) {
				files.set(`${prefix}${entry}`, { path, type: TYPES[entry.slice(entry.lastIndexOf("."))] });
				bytes += stat.size;
				if (files.size > MAX_FILES || bytes > MAX_BYTES) throw new Error(`extensions: ${module} browser: more than ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MiB to serve`);
			}
		}
	};
	walk(manifest.dir, "");
	const missing = [manifest.entry, ...manifest.styles].find((f) => !files.has(f));
	if (missing) {
		log.log(`paca: extension ${module}: ${missing} missing; run npm run build. Cards show text.`);
		return undefined;
	}
	const url = (file: string) => `/ext/${name}/${file}`;
	const info: ExtensionInfo = { name, entry: url(manifest.entry), styles: manifest.styles.map(url), cards: manifest.cards, pages: manifest.pages };
	if (manifest.nav) info.nav = manifest.nav;
	return { info, files };
}
