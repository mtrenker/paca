// Shared fakes for the API tests: pi-ai's faux provider behind a Pi ModelRuntime, answers that are
// held until released or stopped, and a GitHub stub whose one write is recorded. Nothing here
// reaches a real model, GitHub or the user's ~/.pi.
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { githubTools } from "@paca/extension-github";
import { openSessions } from "../src/sessions.ts";
import { openStore } from "../src/store.ts";

export const tempDir = (prefix = "paca-") => mkdtemp(join(tmpdir(), prefix));
export const newId = () => randomUUID();
export const call = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
export const text = (t) => fauxAssistantMessage(t);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(condition, ms = 5000) {
	for (const end = Date.now() + ms; !(await condition()); ) {
		if (Date.now() > end) throw new Error("condition not reached in time");
		await sleep(10);
	}
}

/** A faux provider behind a ModelRuntime with its own throwaway files. */
export async function fauxModel(dir, responses = []) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-store.json"), refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	return { faux, modelRuntime, model: modelRuntime.getModel("faux", faux.getModel().id) };
}

/** A faux answer that waits until `release()`, or ends when the request is aborted (Stop, a limit). */
export function held(answer = "held answer") {
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const state = { started: false, release: () => release() };
	state.respond = async (_context, options) => {
		state.started = true;
		await Promise.race([gate, new Promise((resolve) => (options?.signal?.aborted ? resolve() : options?.signal?.addEventListener("abort", resolve, { once: true })))]);
		return fauxAssistantMessage(answer);
	};
	return state;
}

/** A GitHub stub in scope o/r. Every write is recorded in `sent`; `outcome` decides what it returns. */
export function stubGitHub(outcome = async () => ({ number: 12, url: "https://github.com/o/r/issues/12" })) {
	const sent = [];
	const gh = {
		projects: [{ owner: "o", number: 1, repository: "o/r" }],
		overview: async () => "Captured 2026-10-06T00:00:00Z from 1 of 1 configured Projects; 1 open items (closed items omitted).",
		readIssue: async () => "o/r#1",
		searchIssues: async () => "none",
		checkRepository: (r) => {
			if (r !== "o/r") throw new Error(`Repository ${r} is outside Paca's scope.`);
			return r;
		},
		createIssue: async (repository, content) => (sent.push({ repository, ...content }), outcome()),
	};
	return { gh, sent };
}

/** One user's sessions on a real store and session files in `dir`, with the GitHub tools on `gh`. */
export async function openUser({ dir, model, gh = stubGitHub().gh, packages, limits, removeFile, log = { log: () => {}, error: () => {} } }) {
	const store = openStore(join(dir, "paca.db"));
	const sessions = await openSessions({
		userDir: dir,
		store,
		modelRuntime: model.modelRuntime,
		model: model.model,
		tools: (proposeFor) => packages ?? [{ name: "github", tools: githubTools(gh, proposeFor("github")) }],
		limits,
		removeFile,
		log,
	});
	return { store, sessions };
}

/** The open session's page state as the stream sends it. */
export async function stateOf(sessions, id) {
	return (await sessions.watch(id)).current();
}

export const idle = (sessions, id) => until(() => !sessions.busy(id));
