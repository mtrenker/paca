// Local preview with two synthetic users and no real credentials: `npm run preview`.
// Starts the fake OIDC provider and model (test/container/fakes.mjs) and Paca in the foreground,
// with data in .data/preview/, a fake gh, so approving a draft never reaches GitHub, and a fake
// Herdr (test/container/fake-herdr.mjs) for the operator, so a sent prompt reaches no terminal.
// Ctrl-C stops everything; the data stays for the next start. See CONTRIBUTING.md.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeHerdr } from "../container/fake-herdr.mjs";
import { startFakes } from "../container/fakes.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const port = Number(process.env.PACA_PORT ?? 4402);
const fakesPort = port + 1;
const loginPort = port + 2;
const dataDir = join(root, ".data", "preview");
const tlsDir = join(dataDir, "tls");
// Unix socket paths are limited to about 100 bytes, too short for a path inside the checkout.
const herdrDir = mkdtempSync(join(tmpdir(), "paca-preview-herdr-"));
const issuer = `https://localhost:${fakesPort}/`;
const USERS = [
	{ id: "martin", sub: "preview-martin", username: "martin (synthetic)", repository: "preview-martin/notes", operator: true },
	{ id: "alex", sub: "preview-alex", username: "alex (synthetic)", repository: "preview-alex/garden" },
];

for (const p of [port, fakesPort, loginPort]) {
	const free = await new Promise((done) => {
		const probe = createServer().once("error", () => done(false)).listen(p, "127.0.0.1", () => probe.close(() => done(true)));
	});
	if (!free) throw new Error(`port ${p} is busy; pick another base with PACA_PORT=<port> (uses it and the next two)`);
}

mkdirSync(join(dataDir, "pi"), { recursive: true, mode: 0o700 });
if (!existsSync(join(tlsDir, "cert.pem"))) {
	mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
	execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "30", "-subj", "/CN=localhost",
		"-addext", "subjectAltName=DNS:localhost", "-keyout", join(tlsDir, "key.pem"), "-out", join(tlsDir, "cert.pem")], { stdio: "ignore" });
}
// Written on every start; the conversations in .data/preview/ are kept.
const config = {
	publicUrl: `http://localhost:${port}`,
	port,
	oidc: { issuer, clientId: "paca-smoke" },
	model: "fake/fake-model",
	extensions: { "@paca/extension-github": { piClean: "/nonexistent/pi-clean" }, "@paca/extension-herdr": { socket: join(herdrDir, "herdr.sock") } },
	users: USERS.map((u) => ({
		id: u.id,
		subject: u.sub,
		...(u.operator ? { operator: true, herdr: { roots: ["/home/preview/code"] } } : {}),
		github: { projects: [{ owner: u.repository.split("/")[0], number: 1, repository: u.repository }], tokenEnv: `PACA_GH_TOKEN_${u.id.toUpperCase()}` },
	})),
};
writeFileSync(join(dataDir, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
const models = { providers: { fake: { baseUrl: `${issuer}v1`, api: "openai-completions", apiKey: "preview-model-key", models: [{ id: "fake-model" }] } } };
writeFileSync(join(dataDir, "pi", "models.json"), JSON.stringify(models), { mode: 0o600 });

execFileSync("npm", ["run", "--silent", "build"], { cwd: root, stdio: "inherit" });
const fakes = startFakes({
	issuer,
	port: fakesPort,
	host: "127.0.0.1",
	tls: { key: readFileSync(join(tlsDir, "key.pem")), cert: readFileSync(join(tlsDir, "cert.pem")) },
	login: { origin: `https://localhost:${loginPort}`, port: loginPort, users: USERS.map((u) => ({ sub: u.sub, username: u.username })) },
});

// The operator's Herdr: two agents in /home/preview/code and one outside the scope.
const herdr = await startFakeHerdr({ path: join(herdrDir, "herdr.sock"), log: console.log });
const tokens = Object.fromEntries(USERS.map((u) => [`PACA_GH_TOKEN_${u.id.toUpperCase()}`, `preview-token-of-${u.id}`]));
const paca = spawn(process.execPath, [join(root, "packages", "api", "src", "main.ts")], {
	stdio: "inherit",
	env: {
		PATH: `${join(import.meta.dirname, "bin")}:${process.env.PATH}`,
		HOME: dataDir,
		PACA_DATA_DIR: dataDir,
		PACA_CONFIG: join(dataDir, "config.json"),
		PACA_OIDC_CLIENT_SECRET: "smoke-client-secret",
		PI_CODING_AGENT_DIR: join(dataDir, "pi"),
		NODE_EXTRA_CA_CERTS: join(tlsDir, "cert.pem"),
		...tokens,
	},
});
console.log(`preview: open http://localhost:${port}/ and sign in as ${USERS.map((u) => u.id).join(" or ")}`);
console.log("preview: martin also has a fake Herdr; ask him something about an agent to see a prompt card");
console.log(`preview: the fake sign-in page on https://localhost:${loginPort} uses a throwaway certificate; accept the browser's warning once`);
const stop = () => paca.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
paca.on("exit", async (code) => {
	await Promise.all([fakes.close(), herdr.close()]);
	rmSync(herdrDir, { recursive: true, force: true });
	process.exit(code ?? 0);
});
