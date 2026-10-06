import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const CONFIG = {
	publicUrl: "https://paca.example.test:8443",
	port: 4302,
	oidc: { issuer: "https://id.example.test/", clientId: "paca", allowedSubject: "unknown" },
	github: { projects: [{ owner: "o", number: 1, repository: "o/r" }] },
	piClean: "/opt/pi-clean",
};
const KEYS = ["PACA_CONFIG", "PACA_HOST", "PACA_PORT", "PACA_OIDC_CLIENT_SECRET"];

describe("listen address", () => {
	let dir;
	const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "paca-config-"));
		await writeFile(join(dir, "config.json"), JSON.stringify(CONFIG));
	});
	beforeEach(() => {
		for (const k of KEYS) delete process.env[k];
		process.env.PACA_CONFIG = join(dir, "config.json");
		process.env.PACA_OIDC_CLIENT_SECRET = "test-secret";
	});
	after(async () => {
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
		await rm(dir, { recursive: true });
	});

	it("binds to loopback on the configured port by default", async () => {
		const config = await loadConfig();
		assert.equal(config.host, "127.0.0.1");
		assert.equal(config.port, 4302);
	});

	it("takes the address and port from PACA_HOST and PACA_PORT", async () => {
		process.env.PACA_HOST = "0.0.0.0";
		process.env.PACA_PORT = "8080";
		const config = await loadConfig();
		assert.equal(config.host, "0.0.0.0");
		assert.equal(config.port, 8080);
	});

	it("refuses a PACA_PORT that is not a number", async () => {
		process.env.PACA_PORT = "http";
		await assert.rejects(loadConfig(), /port is required/);
	});
});
