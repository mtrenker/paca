// Smoke test for the built image: `npm run test:container -- <image>` (default paca:smoke).
// Starts the real image as an ordinary container against disposable fakes (fakes.mjs) with
// throwaway data, signs in through the fake OIDC provider and asks one question of the fake
// model. Nothing reaches real GitHub, a real identity provider or a paid model. Every container,
// network and volume it creates is named paca-smoke-<run id> and removed at the end.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const image = process.argv[2] ?? "paca:smoke";
const run = `paca-smoke-${randomBytes(4).toString("hex")}`;
const names = { network: `${run}-net`, fakes: `${run}-fakes`, volume: `${run}-data` };
const PUBLIC_URL = "https://paca.smoke.test";
const ORIGIN = new URL(PUBLIC_URL).origin;
const SECRETS = { PACA_OIDC_CLIENT_SECRET: "smoke-client-secret", GH_TOKEN: "smoke-not-a-github-token" };
const SUBJECT = "smoke-subject";
const apps = [];

const exec = promisify(execFile);
const docker = async (...args) => (await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
// Secrets reach the container as `-e NAME` from the environment of docker run, as in the docs.
const dockerWithSecrets = async (...args) => (await exec("docker", args, { env: { ...process.env, ...SECRETS } })).stdout.trim();
const step = (text) => console.log(`smoke: ${text}`);

async function setUp(tls) {
	await exec("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=fakes",
		"-addext", "subjectAltName=DNS:fakes", "-keyout", join(tls, "key.pem"), "-out", join(tls, "cert.pem")]);
	// Readable by the container's node user whatever the host user is. Throwaway key.
	for (const [file, mode] of [[tls, 0o755], [join(tls, "key.pem"), 0o644], [join(tls, "cert.pem"), 0o644]]) await chmod(file, mode);
	await docker("network", "create", names.network);
	await docker("volume", "create", names.volume);
	await docker("run", "-d", "--name", names.fakes, "--network", names.network, "--network-alias", "fakes",
		"-v", `${tls}:/tls:ro`, "-v", `${join(import.meta.dirname, "fakes.mjs")}:/fakes.mjs:ro`, "--entrypoint", "node", image, "/fakes.mjs");
	// Seed the volume the way an operator would: config.json and Pi's models.json, nothing else.
	const config = {
		publicUrl: PUBLIC_URL,
		port: 4302,
		oidc: { issuer: "https://fakes:8443/", clientId: "paca-smoke", allowedSubject: SUBJECT },
		model: "fake/fake-model",
		github: { projects: [{ owner: "example", number: 1, repository: "example/repo" }] },
		piClean: "/opt/pi-clean",
	};
	const models = { providers: { fake: { baseUrl: "https://fakes:8443/v1", api: "openai-completions", apiKey: "smoke-model-key", models: [{ id: "fake-model" }] } } };
	const seed = `const fs = require("node:fs"); const { config, models } = JSON.parse(fs.readFileSync(0, "utf8"));
		fs.writeFileSync("/data/config.json", JSON.stringify(config), { mode: 0o600 });
		fs.mkdirSync("/data/pi", { mode: 0o700 });
		fs.writeFileSync("/data/pi/models.json", JSON.stringify(models), { mode: 0o600 });`;
	await new Promise((resolve, reject) => {
		const child = execFile("docker", ["run", "--rm", "-i", "-v", `${names.volume}:/data`, "--entrypoint", "node", image, "-e", seed], (error) => (error ? reject(error) : resolve()));
		child.stdin.end(JSON.stringify({ config, models }));
	});
}

/** Starts Paca the way the docs do: loopback-only port, read-only root, no capabilities. */
async function startApp(tls) {
	const name = `${run}-app${apps.length + 1}`;
	apps.push(name);
	await dockerWithSecrets("run", "-d", "--name", name, "--network", names.network, "-p", "127.0.0.1::4302",
		"--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"-v", `${names.volume}:/data`, "-v", `${join(tls, "cert.pem")}:/tls/cert.pem:ro`, "-e", "NODE_EXTRA_CA_CERTS=/tls/cert.pem",
		...Object.keys(SECRETS).flatMap((k) => ["-e", k]), image);
	const port = (await docker("port", name, "4302/tcp")).split("\n")[0].split(":").pop();
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; ; i++) {
		const ok = await fetch(`${base}/healthz`).then((r) => r.ok, () => false);
		if (ok) break;
		if (i > 120) throw new Error(`${name} did not become healthy`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return { name, base };
}

/** docker stop sends SIGTERM; Paca must exit 0 well inside the 10 second grace period. */
async function stopApp(name) {
	const started = Date.now();
	await docker("stop", "-t", "10", name);
	const seconds = (Date.now() - started) / 1000;
	const exitCode = Number(await docker("inspect", "-f", "{{.State.ExitCode}}", name));
	const logs = await exec("docker", ["logs", name]).then((r) => r.stdout + r.stderr);
	assert.equal(exitCode, 0, `exit code ${exitCode}`);
	assert.ok(seconds < 8, `stop took ${seconds}s`);
	assert.match(logs, /paca: stopping/);
	for (const secret of Object.values(SECRETS)) assert.ok(!logs.includes(secret), "a secret appeared in the logs");
	step(`SIGTERM stop of ${name}: exit 0 after ${seconds.toFixed(1)}s, no secrets in logs`);
}

const cookieOf = (response) => response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function signIn(base, sub) {
	const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
	assert.equal(login.status, 302);
	const authorize = new URL(login.headers.get("location"));
	assert.equal(authorize.origin, "https://fakes:8443");
	assert.equal(authorize.searchParams.get("redirect_uri"), `${PUBLIC_URL}/auth/callback`);
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	const code = Buffer.from(JSON.stringify({ sub, username: sub, nonce: authorize.searchParams.get("nonce") })).toString("base64url");
	const callback = `${base}/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`;
	return fetch(callback, { redirect: "manual", headers: { cookie: cookieOf(login) } });
}

/** Reads the SSE stream until a state satisfies `done`. */
async function waitForState(base, cookie, done) {
	const response = await fetch(`${base}/api/events`, { headers: { cookie }, signal: AbortSignal.timeout(60_000) });
	assert.equal(response.status, 200);
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, { stream: true });
		let end;
		while ((end = buffer.indexOf("\n\n")) >= 0) {
			const event = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const data = event.split("\n").find((l) => l.startsWith("data: "));
			if (!data) continue;
			const state = JSON.parse(data.slice(6));
			if (done(state)) {
				response.body.cancel().catch(() => {});
				return state;
			}
		}
	}
	throw new Error("event stream ended");
}

const answered = (state) => !state.running && state.turns.some((t) => t.question === "Smoke question" && t.answer && t.drafts.length === 1);

async function main() {
	const tls = await mkdtemp(join(tmpdir(), "paca-smoke-"));
	try {
		step(`image ${image}, run ${run}`);
		await setUp(tls);
		const first = await startApp(tls);
		step(`${first.name} healthy at ${first.base}/healthz`);

		const user = await docker("exec", first.name, "id", "-u");
		assert.equal(user, "1000");
		assert.equal(await docker("inspect", "-f", "{{.Config.User}}", image), "node");
		const healthcheck = JSON.parse(await docker("inspect", "-f", "{{json .Config.Healthcheck.Test}}", image));
		await docker("exec", first.name, ...healthcheck.slice(1));
		step("runs as uid 1000 (node); the image HEALTHCHECK command passes");

		const page = await fetch(`${first.base}/`, { redirect: "manual" });
		assert.equal(page.status, 302);
		assert.equal(page.headers.get("location"), "/auth/login");
		for (const [method, path] of [["GET", "/api/session"], ["GET", "/api/events"], ["POST", "/api/messages"], ["POST", "/api/drafts/approve"], ["POST", "/api/stop"]]) {
			const response = await fetch(`${first.base}${path}`, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
			assert.equal(response.status, 401, `${method} ${path} without a session`);
		}
		step("without a session: / redirects to sign-in, chat and draft endpoints answer 401");

		const refused = await signIn(first.base, "someone-else");
		assert.equal(refused.status, 403);
		assert.ok(!refused.headers.getSetCookie().some((c) => c.startsWith("__Host-paca=")));
		const signedIn = await signIn(first.base, SUBJECT);
		assert.equal(signedIn.status, 303);
		const cookie = cookieOf(signedIn);
		const session = await (await fetch(`${first.base}/api/session`, { headers: { cookie } })).json();
		assert.equal(session.model, "fake/fake-model");
		step("OIDC through the fake provider: other subject refused (403), allowed subject signed in");

		const ask = (origin, csrf) =>
			fetch(`${first.base}/api/messages`, { method: "POST", headers: { cookie, origin, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ text: "Smoke question", requestId: `smoke-${run}` }) });
		assert.equal((await ask("https://elsewhere.test", session.csrf)).status, 403);
		assert.equal((await ask(ORIGIN, "wrong-token-wrong-token-wrong-to")).status, 403);
		assert.equal((await ask(ORIGIN, session.csrf)).status, 202);
		const state = await waitForState(first.base, cookie, answered);
		const draft = state.turns.find((t) => t.question === "Smoke question").drafts[0];
		assert.equal(draft.status, "proposed");
		step("wrong Origin and CSRF refused (403); question answered by the fake model with one proposed draft");

		await stopApp(first.name);
		await docker("rm", first.name);
		const second = await startApp(tls);
		const again = await fetch(`${second.base}/api/session`, { headers: { cookie } });
		assert.equal(again.status, 200, "the session from the first container should still be valid");
		const kept = await waitForState(second.base, cookie, answered);
		assert.deepEqual(kept.turns.find((t) => t.question === "Smoke question").drafts[0], draft);
		step(`new container ${second.name} on the same volume: session key, conversation and draft kept`);
		await stopApp(second.name);
		step("passed");
	} catch (error) {
		for (const name of [...apps, names.fakes]) {
			const logs = await exec("docker", ["logs", "--tail", "40", name]).then((r) => r.stdout + r.stderr, () => "");
			if (logs) console.error(`--- logs of ${name}\n${logs}`);
		}
		throw error;
	} finally {
		await exec("docker", ["rm", "-f", ...apps, names.fakes]).catch(() => {});
		await exec("docker", ["volume", "rm", names.volume]).catch(() => {});
		await exec("docker", ["network", "rm", names.network]).catch(() => {});
		await rm(tls, { recursive: true, force: true });
		step(`removed ${run} containers, volume and network`);
	}
}

await main();
