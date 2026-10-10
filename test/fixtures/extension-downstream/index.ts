// The example of an API called as the signed-in user (#21): notes in the fake Example API
// (test/container/fake-api.mjs), read and written with the access token of the user's Paca sign-in.
// Loaded as a local extension by the preview, the tests and the container check; never installed or
// shipped. It never sees a token: it calls `api.request`, and a write goes only through an approved
// proposal.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ApiError, defineToolPackage, type JsonValue, OperationError, type Proposal, type UserApi, type WriteOutcome } from "@paca/extension";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Who the API says the caller is, and their notes. */
async function read(api: UserApi, signal?: AbortSignal) {
	const [me, list] = await Promise.all([api.request("/me", { signal }), api.request("/notes", { signal })]);
	for (const answer of [me, list]) if (answer.status !== 200) throw new Error(`${api.label} answered ${answer.status}.`);
	return { username: (me.body as { username: string }).username, notes: (list.body as { notes: { id: number; text: string }[] }).notes };
}

/** Why the API cannot be used now, in words the user can act on; undefined when it can. */
function unavailable(api: UserApi) {
	const state = api.state();
	if (state === "sign-in") return `Sign in to Paca again so this can use ${api.label}.`;
	if (state === "not-granted") return `Your Paca sign-in does not include access to ${api.label}.`;
	return undefined;
}

function noteProposal(api: UserApi, note: unknown): Proposal {
	if (typeof note !== "string" || !note.trim() || note.length > 500) throw new OperationError(400, "A note needs 1 to 500 characters.");
	return { action: "add_note", target: api.label, title: "New note", body: note.trim() };
}

export default defineToolPackage<undefined, undefined>({
	name: "example-notes",
	browser: {
		dir: new URL("./browser/", import.meta.url).href,
		entry: "index.js",
		styles: ["notes.css"],
		pages: { home: { title: "Example notes" } },
		nav: { label: "Example notes", page: "home" },
	},
	forUser: ({ apis, propose }) => {
		const api = apis.notes;
		if (!api) return undefined;
		return {
			tools: [
				defineTool({
					name: "read_notes",
					label: "Read notes",
					description: `Reads the user's notes in ${api.label}, as the user.`,
					parameters: Type.Object({}),
					execute: async (_id, _args, signal) => {
						try {
							const { username, notes } = await read(api, signal);
							return text(`${api.label}, as ${username}:\n${notes.map((n) => `- ${n.text}`).join("\n") || "(no notes)"}`);
						} catch (error) {
							return text(`${api.label} could not be read: ${why(error)}`);
						}
					},
				}),
				defineTool({
					name: "propose_note",
					label: "Propose a note",
					description: `Proposes adding one note to the user's ${api.label}. Nothing is written until the user approves the exact note.`,
					parameters: Type.Object({ note: Type.String({ description: "The note's exact text, at most 500 characters." }) }),
					execute: async (toolCallId, args, _signal, _onUpdate, ctx) => {
						try {
							propose(toolCallId, ctx, noteProposal(api, args.note));
							return text("Proposed the note for the user's approval. It is not written yet.");
						} catch (error) {
							return text(`Could not propose it: ${why(error)}`);
						}
					},
				}),
			],
			prompt: `${api.label} holds the user's notes. Read them with read_notes; propose a new note with propose_note.`,
			labels: { read_notes: { label: () => `Read notes in ${api.label}` }, propose_note: { label: () => "Proposed a note" } },
			operations: {
				notes: async (_input, signal): Promise<JsonValue> => {
					const problem = unavailable(api);
					if (problem) return { label: api.label, problem, signIn: api.state() === "sign-in" };
					try {
						const { username, notes } = await read(api, signal);
						return { label: api.label, username, notes };
					} catch (error) {
						if (error instanceof ApiError && error.code === "sign-in") return { label: api.label, problem: error.message, signIn: true };
						throw new OperationError(502, why(error));
					}
				},
			},
			proposals: { add_note: (input) => noteProposal(api, input.note) },
			writes: {
				add_note: {
					ready: () => {
						const problem = unavailable(api);
						return problem && `${problem} Then approve it, or dismiss it.`;
					},
					async execute(proposal): Promise<WriteOutcome> {
						try {
							const answer = await api.request("/notes", { method: "POST", body: { text: proposal.body } });
							if (answer.status >= 200 && answer.status < 300) return { status: "created" };
							if (answer.status >= 400 && answer.status < 500) return { status: "failed", error: `${api.label} refused it (${answer.status})` };
							return { status: "unknown", error: `${api.label} answered ${answer.status}` };
						} catch (error) {
							return { status: error instanceof ApiError && !error.sent ? "failed" : "unknown", error: why(error) };
						}
					},
				},
			},
			scope: { label: api.label, detail: `Your ${api.label} notes, as you` },
		};
	},
});
