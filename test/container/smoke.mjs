// Smoke test for the built image: `npm run test:container -- <image>` (default paca:smoke).
// Starts the real image as an ordinary container against disposable fakes (fakes.mjs) with
// throwaway data, signs in through the fake OIDC provider and asks one question of the fake
// model, then moves the operator to a users config with Herdr against a fake Herdr socket
// (fake-herdr.mjs) and approves one prompt. Between the two first containers it copies the example
// local extension of docs/local-extensions.md into the volume, as that guide says. Last, the example
// of an API called with the sign-in's access token (#21) reads and writes the fake Example API
// (fake-api.mjs) as the operator. Nothing reaches real GitHub, a real identity provider,
// a paid model or a real terminal. Every container, network and volume it creates is named
// paca-smoke-<run id> and removed at the end.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SAMPLE_AGENTS, startFakeHerdr } from "./fake-herdr.mjs";
import { FAKE_PROMPT } from "./fakes.mjs";

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
		"-v", `${tls}:/tls:ro`, "-v", `${join(import.meta.dirname, "fakes.mjs")}:/fakes.mjs:ro`, "-v", `${join(import.meta.dirname, "fake-api.mjs")}:/fake-api.mjs:ro`, "--entrypoint", "node", image, "/fakes.mjs");
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

/**
 * Copies the guide's example extension into /data/local-extensions/dice with the guide's command,
 * so /data is beside /app as in production, and checks it with the guide's check in the running
 * container: a new process, which sees the files without a restart.
 */
async function addLocalExtension(appName) {
	const guide = await readFile(join(import.meta.dirname, "..", "..", "docs", "local-extensions.md"), "utf8");
	const dir = await mkdtemp(join(tmpdir(), "paca-smoke-dice-"));
	try {
		for (const [, path, content] of guide.matchAll(/<!-- file: (\S+) -->\n```\w*\n([\s\S]*?)\n```/g)) {
			await mkdir(join(dir, path, ".."), { recursive: true });
			await writeFile(join(dir, path), `${content}\n`, { mode: 0o644 });
		}
		await exec("sh", ["-c", 'tar -C "$1" -c . | docker run --rm -i -v "$2":/data --entrypoint sh "$3" -c "mkdir -p /data/local-extensions/dice && tar -x -C /data/local-extensions/dice"', "sh", dir, names.volume, image]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	const check = await docker("exec", appName, "node", "packages/api/src/check-extensions.ts");
	assert.match(check, /^paca: local extension local-extensions\/dice: loaded with its frontend$/m);
	assert.match(check, /^user operator: github \(.+\); dice \(roll_dice\)$/m);
}

/** Starts Paca the way the docs do: loopback-only port, read-only root, no capabilities. */
async function startApp(tls, extra = []) {
	const name = `${run}-app${apps.length + 1}`;
	apps.push(name);
	await dockerWithSecrets("run", "-d", "--name", name, "--network", names.network, "-p", "127.0.0.1::4302",
		"--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"-v", `${names.volume}:/data`, "-v", `${join(tls, "cert.pem")}:/tls/cert.pem:ro`, "-e", "NODE_EXTRA_CA_CERTS=/tls/cert.pem",
		...Object.keys(SECRETS).flatMap((k) => ["-e", k]), ...extra, image);
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

/** Signs in through the fake provider, which grants the scopes Paca asked for. */
async function signIn(base, sub, { scope = "openid profile" } = {}) {
	const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
	assert.equal(login.status, 302);
	const authorize = new URL(login.headers.get("location"));
	assert.equal(authorize.origin, "https://fakes:8443");
	assert.equal(authorize.searchParams.get("redirect_uri"), `${PUBLIC_URL}/auth/callback`);
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	assert.equal(authorize.searchParams.get("scope"), scope);
	const code = Buffer.from(JSON.stringify({ sub, username: sub, nonce: authorize.searchParams.get("nonce"), scope })).toString("base64url");
	const callback = `${base}/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`;
	return fetch(callback, { redirect: "manual", headers: { cookie: cookieOf(login) } });
}

/** Reads the open session's SSE stream until an event satisfies `done(event, data)`. */
async function waitFor(base, cookie, session, done) {
	const response = await fetch(`${base}/api/events?session=${session}`, { headers: { cookie }, signal: AbortSignal.timeout(60_000) });
	assert.equal(response.status, 200);
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of response.body) {
		buffer += decoder.decode(chunk, { stream: true });
		let end;
		while ((end = buffer.indexOf("\n\n")) >= 0) {
			const lines = buffer.slice(0, end).split("\n");
			buffer = buffer.slice(end + 2);
			const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
			const data = lines.find((l) => l.startsWith("data: "));
			if (!data) continue;
			const value = JSON.parse(data.slice(6));
			if (done(event, value)) {
				response.body.cancel().catch(() => {});
				return value;
			}
		}
	}
	throw new Error("event stream ended");
}

const answeredWithDraft = (question) => (event, state) => event === "state" && !state.running && state.turns.some((t) => t.question === question && t.answer && t.drafts.length === 1);
const answered = answeredWithDraft("Smoke question");

/** Replaces /data/config.json, as an operator would with the copy command in docs/container.md. */
async function writeConfig(config) {
	await new Promise((resolve, reject) => {
		const child = execFile("docker", ["run", "--rm", "-i", "-v", `${names.volume}:/data`, "--entrypoint", "sh", image, "-c", "umask 077 && cat > /data/config.json"], (error) => (error ? reject(error) : resolve()));
		child.stdin.end(JSON.stringify(config));
	});
}

/**
 * The operator moves to a users config with Herdr. The fake Herdr socket is bind-mounted read-only
 * like the real one (docs/herdr.md); mode 0666 only because CI's host user is not uid 1000.
 * `earlier` is the session the first containers answered, which must not reach the new card.
 */
async function checkHerdr(tls, cookie, earlier) {
	const herdr = await startFakeHerdr({ path: join(tls, "herdr.sock"), mode: 0o666 });
	try {
		await writeConfig({
			publicUrl: PUBLIC_URL,
			oidc: { issuer: "https://fakes:8443/", clientId: "paca-smoke" },
			model: "fake/fake-model",
			extensions: { "@paca/extension-github": { piClean: "/opt/pi-clean" }, "@paca/extension-herdr": { socket: "/run/herdr.sock" } },
			users: [{ id: "operator", subject: SUBJECT, operator: true, github: { projects: [{ owner: "example", number: 1, repository: "example/repo" }], serverLogin: true }, herdr: { roots: ["/home/preview/code"] } }],
		});
		const app = await startApp(tls, ["-v", `${herdr.path}:/run/herdr.sock:ro`]);
		const info = await (await fetch(`${app.base}/api/session`, { headers: { cookie } })).json();
		assert.match(info.scope, /Herdr agents/);
		const post = (path, body) => fetch(`${app.base}${path}`, { method: "POST", headers: { cookie, origin: ORIGIN, "x-csrf-token": info.csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
		const session = randomUUID();
		assert.equal((await post("/api/sessions", { id: session, text: "Smoke agent question", requestId: `smoke-agent-${run}` })).status, 202);
		const state = await waitFor(app.base, cookie, session, answeredWithDraft("Smoke agent question"));
		const card = state.turns.find((t) => t.question === "Smoke agent question").drafts[0];
		assert.deepEqual([card.action, card.target, card.title, card.body, card.status], ["herdr.send_prompt", "claude in w1:p1", SAMPLE_AGENTS[0].cwd, FAKE_PROMPT, "proposed"]);
		assert.deepEqual(herdr.prompts, []);
		step("operator in a users config: Herdr agents listed through the read-only socket mount, prompt proposed in a new session, nothing sent");

		assert.equal((await post(`/api/sessions/${earlier}/drafts/approve`, { id: card.id })).status, 404);
		assert.deepEqual(herdr.prompts, []);
		assert.deepEqual(await (await post(`/api/sessions/${session}/drafts/approve`, { id: card.id })).json(), { status: "created" });
		assert.equal((await post(`/api/sessions/${session}/drafts/approve`, { id: card.id })).status, 409);
		assert.deepEqual(herdr.prompts, [{ pane: "w1:p1", terminal: "term_fake01", text: FAKE_PROMPT }]);
		const logs = await exec("docker", ["logs", app.name]).then((r) => r.stdout + r.stderr);
		assert.ok(!logs.includes(FAKE_PROMPT), "the prompt appeared in the logs");
		step("approval under another session refused (404); approved prompt sent once with the exact text; a second approval refused (409); prompt not in the logs");
		await stopApp(app.name);
	} finally {
		await herdr.close();
	}
}

/**
 * An API called with the sign-in's access token (#21): the example extension of
 * test/fixtures/extension-downstream copied into the volume, the fake Example API in the fakes
 * container, and the image's own openid-client over HTTPS. Reads and one approved write as the
 * operator, sign-out on another device, and no token in the logs.
 */
async function checkApi(tls) {
	const scope = "openid profile offline_access notes.read notes.write";
	await writeConfig({
		publicUrl: PUBLIC_URL,
		oidc: { issuer: "https://fakes:8443/", clientId: "paca-smoke", scopes: ["offline_access"] },
		model: "fake/fake-model",
		extensions: {},
		apis: { notes: { label: "Example API", url: "https://fakes:8443/example-api/v1/", scopes: ["notes.read", "notes.write"], extensions: ["example-notes"] } },
		users: [{ id: "operator", subject: SUBJECT, operator: true, apis: ["notes"] }],
	});
	const dir = await mkdtemp(join(tmpdir(), "paca-smoke-notes-"));
	try {
		const fixture = join(import.meta.dirname, "..", "fixtures", "extension-downstream");
		for (const path of ["package.json", "index.ts", "browser/index.js", "browser/notes.css"]) {
			await mkdir(join(dir, path, ".."), { recursive: true });
			await writeFile(join(dir, path), await readFile(join(fixture, path)), { mode: 0o644 });
		}
		await exec("sh", ["-c", 'tar -C "$1" -c . | docker run --rm -i -v "$2":/data --entrypoint sh "$3" -c "mkdir -p /data/local-extensions/example-notes && tar -x -C /data/local-extensions/example-notes"', "sh", dir, names.volume, image]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	const app = await startApp(tls);
	const device = async () => {
		const cookie = cookieOf(await signIn(app.base, SUBJECT, { scope }));
		const info = await (await fetch(`${app.base}/api/session`, { headers: { cookie } })).json();
		const post = async (path, body = {}) => {
			const response = await fetch(`${app.base}${path}`, { method: "POST", headers: { cookie, origin: ORIGIN, "x-csrf-token": info.csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
			return [response.status, await response.json()];
		};
		return { cookie, info, post, notes: async () => (await post("/api/ext/example-notes/notes"))[1] };
	};
	const phone = await device();
	assert.deepEqual(phone.info.apis, [{ name: "notes", label: "Example API", state: "ready" }]);
	assert.ok(phone.info.extensions.some((e) => e.name === "example-notes"), "the example is listed beside the dice example from earlier");
	const read = await phone.notes();
	assert.equal(read.username, SUBJECT);
	assert.match(read.notes[0].text, /^Welcome, /);
	step("APIs: one sign-in asked for the API's scopes; the example read the fake Example API with that access token, as the operator");

	const session = randomUUID();
	assert.equal((await phone.post("/api/sessions", { id: session, text: "Add a note: Smoke note", requestId: `smoke-note-${run}` }))[0], 202);
	const state = await waitFor(app.base, phone.cookie, session, answeredWithDraft("Add a note: Smoke note"));
	const card = state.turns.find((t) => t.question === "Add a note: Smoke note").drafts[0];
	assert.deepEqual([card.action, card.target, card.body, card.status], ["example-notes.add_note", "Example API", "Smoke note", "proposed"]);
	assert.deepEqual(await phone.post(`/api/sessions/${session}/drafts/approve`, { id: card.id }), [200, { status: "created" }]);
	assert.equal((await phone.post(`/api/sessions/${session}/drafts/approve`, { id: card.id }))[0], 409);
	assert.deepEqual((await phone.notes()).notes.map((n) => n.text).filter((t) => t === "Smoke note"), ["Smoke note"]);
	step("APIs: a proposed note approved once and written once; a second approval refused (409)");

	const laptop = await device();
	await phone.post("/auth/logout");
	const after = await (await fetch(`${app.base}/api/session`, { headers: { cookie: laptop.cookie } })).json();
	assert.equal(after.apis[0].state, "sign-in");
	assert.equal((await laptop.notes()).signIn, true);
	const logs = await exec("docker", ["logs", app.name]).then((r) => r.stdout + r.stderr);
	assert.ok(!/\b(at|rt)-[A-Za-z0-9_-]{20,}/.test(logs), "a token appeared in the logs");
	assert.ok(!logs.includes("Smoke note"), "the note appeared in the logs");
	step("APIs: sign-out on one device asks the other to sign in again; no token or note in the logs");
	await stopApp(app.name);
}

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
		const session = randomUUID();
		for (const [method, path] of [["GET", "/api/session"], ["GET", "/api/events"], ["POST", "/api/sessions"], ["POST", `/api/sessions/${session}/messages`], ["POST", `/api/sessions/${session}/drafts/approve`], ["POST", `/api/sessions/${session}/delete`]]) {
			const response = await fetch(`${first.base}${path}`, { method, headers: { origin: ORIGIN, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
			assert.equal(response.status, 401, `${method} ${path} without a session`);
		}
		step("without a session: / redirects to sign-in, session and draft endpoints answer 401");

		const refused = await signIn(first.base, "someone-else");
		assert.equal(refused.status, 403);
		assert.ok(!refused.headers.getSetCookie().some((c) => c.startsWith("__Host-paca=")));
		const signedIn = await signIn(first.base, SUBJECT);
		assert.equal(signedIn.status, 303);
		const cookie = cookieOf(signedIn);
		const info = await (await fetch(`${first.base}/api/session`, { headers: { cookie } })).json();
		assert.equal(info.model, "fake/fake-model");
		step("OIDC through the fake provider: other subject refused (403), allowed subject signed in");

		// The GitHub package's frontend was built into the image and is served to this user only.
		assert.deepEqual(info.extensions, [{ name: "github", entry: "/ext/github/dist/index.js", styles: ["/ext/github/github.css"], cards: ["issue"], pages: { home: { title: "GitHub" }, issue: { title: "Issue" } }, nav: { label: "GitHub", page: "home" } }]);
		for (const [path, type] of [["/ext/github/dist/index.js", "text/javascript"], ["/ext/github/github.css", "text/css"]]) {
			const asset = await fetch(`${first.base}${path}`, { headers: { cookie } });
			assert.deepEqual([asset.status, asset.headers.get("content-type")], [200, type], path);
			assert.equal(asset.headers.get("content-security-policy"), (await fetch(`${first.base}/healthz`)).headers.get("content-security-policy"));
		}
		assert.equal((await fetch(`${first.base}/ext/github/dist/index.js`)).status, 401);
		assert.equal((await fetch(`${first.base}/ext/github/src/index.ts`, { headers: { cookie } })).status, 404);
		// The GitHub pages' deep links load the page itself; the test-only Preact fixture is not in the image.
		assert.equal((await fetch(`${first.base}/?page=github.issue&repository=example%2Frepo&number=1`, { headers: { cookie } })).status, 200);
		assert.equal(await docker("exec", first.name, "find", "/app", "-path", "*extension-preact*", "-print", "-quit"), "");
		assert.equal(await docker("exec", first.name, "find", "/app/node_modules", "-maxdepth", "1", "-name", "preact", "-print", "-quit"), "");
		step("GitHub frontend listed with its nav entry; card assets served with the page's CSP (401 without a session, sources 404); deep links load; no fixture or Preact in the image");

		const post = (path, body, origin = ORIGIN, csrf = info.csrf) =>
			fetch(`${first.base}${path}`, { method: "POST", headers: { cookie, origin, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
		const start = { id: session, text: "Smoke question", requestId: `smoke-${run}` };
		assert.equal((await post("/api/sessions", start, "https://elsewhere.test")).status, 403);
		assert.equal((await post("/api/sessions", start, ORIGIN, "wrong-token-wrong-token-wrong-to")).status, 403);
		assert.equal((await post("/api/sessions", { ...start, id: "../legacy" })).status, 400);
		assert.equal((await post("/api/messages", { text: "Smoke question", requestId: `smoke-old-${run}` })).status, 410);
		assert.equal((await post("/api/sessions", start)).status, 202);
		const state = await waitFor(first.base, cookie, session, answered);
		const draft = state.turns.find((t) => t.question === "Smoke question").drafts[0];
		assert.equal(draft.status, "proposed");
		const list = await waitFor(first.base, cookie, session, (event, value) => event === "sessions" && value.some((s) => s.id === session && s.waiting === 1 && !s.running));
		assert.equal(list.length, 1);
		// A page proposal with no open session makes a new session holding the draft. Nobody approves
		// it, so nothing reaches GitHub; its retry under another new session id is a duplicate.
		const pageSession = randomUUID();
		const proposal = { requestId: `smoke-page-${run}`, package: "github", action: "create_issue", input: { repository: "example/repo", title: "Smoke follow-up", body: "Follow-up to example/repo#1." }, start: true };
		const proposed = await post(`/api/sessions/${pageSession}/proposals`, proposal);
		assert.deepEqual(await proposed.json(), { session: pageSession, draft: `page:smoke-page-${run}`, duplicate: false });
		assert.deepEqual(await (await post(`/api/sessions/${randomUUID()}/proposals`, proposal)).json(), { session: pageSession, draft: `page:smoke-page-${run}`, duplicate: true });
		const pageState = await waitFor(first.base, cookie, pageSession, (event, value) => event === "state" && value.turns.length === 1);
		assert.deepEqual(pageState.turns[0].drafts.map((d) => [d.title, d.status, d.fromPage]), [["Smoke follow-up", "proposed", true]]);
		assert.equal((await post(`/api/sessions/${pageSession}/delete`, {})).status, 200);
		step("wrong Origin and CSRF refused (403), bad id (400), old route (410); a new session answered by the fake model with one proposed draft waiting");
		step("a page proposal made a new session holding its draft, a retry under another session id was a duplicate, and the session was deleted unapproved");

		await addLocalExtension(first.name);
		assert.equal((await fetch(`${first.base}/api/session`, { headers: { cookie } }).then((r) => r.json())).extensions.length, 1, "loaded only at start");
		step("example local extension copied into /data with the guide's command; the guide's check in the running container loads it");

		await stopApp(first.name);
		await docker("rm", first.name);
		const second = await startApp(tls);
		const again = await fetch(`${second.base}/api/session`, { headers: { cookie } });
		assert.equal(again.status, 200, "the session from the first container should still be valid");
		const local = await again.json();
		assert.deepEqual(local.extensions.map((e) => e.name), ["github", "dice"]);
		assert.equal((await fetch(`${second.base}/ext/dice/index.js`, { headers: { cookie } })).status, 200);
		const roll = (sides) => fetch(`${second.base}/api/ext/dice/roll`, { method: "POST", headers: { cookie, origin: ORIGIN, "x-csrf-token": local.csrf, "content-type": "application/json" }, body: JSON.stringify({ sides }) });
		const rolled = await (await roll(20)).json();
		assert.ok(rolled.sides === 20 && rolled.value >= 1 && rolled.value <= 20, JSON.stringify(rolled));
		const refusedRoll = await roll(1);
		assert.deepEqual([refusedRoll.status, await refusedRoll.json()], [400, { error: "Choose 2 to 100 sides." }]);
		const logs = await exec("docker", ["logs", second.name]).then((r) => r.stdout + r.stderr);
		assert.match(logs, /paca: local extension local-extensions\/dice: loaded with its frontend/);
		step("after the restart: dice listed beside github, its module served, its operation answers, and its OperationError keeps its 400 under /data beside /app");
		const kept = await waitFor(second.base, cookie, session, answered);
		assert.deepEqual(kept.turns.find((t) => t.question === "Smoke question").drafts[0], draft);
		step(`new container ${second.name} on the same volume: session key, session and draft kept`);
		await stopApp(second.name);
		await checkHerdr(tls, cookie, session);
		await checkApi(tls);
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
