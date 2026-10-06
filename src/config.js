// Private runtime configuration. Lives outside Git (default .data/config.json); see README.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DATA_DIR = resolve(process.env.PACA_DATA_DIR ?? join(import.meta.dirname, "..", ".data"));

export async function loadConfig({ needWeb = true } = {}) {
	const path = process.env.PACA_CONFIG ?? join(DATA_DIR, "config.json");
	const config = JSON.parse(await readFile(path, "utf8"));
	const fail = (message) => {
		throw new Error(`${path}: ${message}`);
	};
	const projects = config.github?.projects;
	if (!Array.isArray(projects) || projects.length === 0) fail("github.projects must list at least one Project");
	for (const p of projects) {
		if (typeof p.owner !== "string" || !Number.isInteger(p.number) || !/^[\w.-]+\/[\w.-]+$/.test(p.repository ?? "")) {
			fail("each github.projects entry needs owner, number and repository (owner/name)");
		}
	}
	if (typeof config.piClean !== "string") fail("piClean must be the absolute path of a pi-clean checkout");
	if (needWeb) {
		const url = new URL(config.publicUrl ?? fail("publicUrl is required"));
		if (url.protocol !== "https:") fail("publicUrl must be https");
		if (!Number.isInteger(config.port)) fail("port is required");
		for (const key of ["issuer", "clientId", "allowedSubject"]) {
			if (typeof config.oidc?.[key] !== "string" || !config.oidc[key]) fail(`oidc.${key} is required`);
		}
		if (!process.env.PACA_OIDC_CLIENT_SECRET) throw new Error("PACA_OIDC_CLIENT_SECRET is not set; start Paca through pass-cli run (see README)");
	}
	return { ...config, publicOrigin: needWeb ? new URL(config.publicUrl).origin : undefined };
}
