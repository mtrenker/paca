// Loads the tool packages config.json enables. Only installed packages, by name: a package is
// trusted server code, so the operator installs it with Paca and lists it; paths are refused.
import type { ToolPackage } from "@paca/extension";

export interface LoadedPackage {
	/** The npm package name it was enabled by. */
	module: string;
	package: ToolPackage;
	settings: unknown;
}

export async function loadPackages(enabled: Record<string, unknown>, load: (name: string) => Promise<{ default?: unknown }> = (name) => import(name)): Promise<LoadedPackage[]> {
	const loaded: LoadedPackage[] = [];
	for (const [module, settings] of Object.entries(enabled)) {
		if (module.startsWith(".") || module.startsWith("/") || module.includes(":")) throw new Error(`extensions: ${module} is a path; enable installed packages by name`);
		const candidate = (await load(module)).default as Partial<ToolPackage> | undefined;
		if (typeof candidate?.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(candidate.name) || typeof candidate.forUser !== "function") {
			throw new Error(`extensions: ${module} has no default export from defineToolPackage()`);
		}
		if (candidate.name === "paca" || loaded.some((p) => p.package.name === candidate.name)) throw new Error(`extensions: ${module} reuses the name "${candidate.name}"`);
		loaded.push({ module, package: candidate as ToolPackage, settings });
	}
	return loaded;
}
