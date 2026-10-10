// The example of an API called as the signed-in user (#21): notes in the fake Example API
// (test/container/fake-api.mjs), read and written with the access token of the user's Paca sign-in.
// Loaded as a local extension by the preview, the tests and the container check; never installed or
// shipped. It never sees a token: it calls `api.request`, and a write goes only through an approved
// proposal. An edit is conditional: the proposal stores the note's version (its strong ETag) as the
// user saw it, and the write sends exactly that as If-Match, so a note changed meanwhile is not
// overwritten.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ApiError, defineToolPackage, type JsonValue, OperationError, type Proposal, type UserApi, type WriteOutcome } from "@paca/extension";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Note {
	id: number;
	text: string;
	/** The note's version as the API states it in the body: a quoted strong ETag. */
	etag: string;
}

/** Who the API says the caller is, and their notes. */
async function read(api: UserApi, signal?: AbortSignal) {
	const [me, list] = await Promise.all([api.request("/me", { signal }), api.request("/notes", { signal })]);
	for (const answer of [me, list]) if (answer.status !== 200) throw new Error(`${api.label} answered ${answer.status}.`);
	const notes = (list.body as { notes: Note[] }).notes.map(({ id, text }) => ({ id, text }));
	return { username: (me.body as { username: string }).username, notes };
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

/** An edit of one note, bound to the version read now: the one the user sees on the card. */
async function editProposal(api: UserApi, id: unknown, text: unknown, signal?: AbortSignal): Promise<Proposal> {
	if (!Number.isInteger(id) || (id as number) < 1) throw new OperationError(400, "Name the note by its number.");
	const { body } = noteProposal(api, text);
	const answer = await api.request("/notes", { signal });
	if (answer.status !== 200) throw new Error(`${api.label} answered ${answer.status}.`);
	const note = (answer.body as { notes: Note[] }).notes.find((n) => n.id === id);
	if (!note) throw new OperationError(404, `There is no note ${id}.`);
	return { action: "edit_note", target: api.label, title: `Edit note ${id}, which said: ${note.text.slice(0, 80)}`, body, expect: { id: String(id), etag: note.etag } };
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
		const ready = () => {
			const problem = unavailable(api);
			return problem && `${problem} Then approve it, or dismiss it.`;
		};
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
				defineTool({
					name: "propose_note_edit",
					label: "Propose a note edit",
					description: `Proposes replacing the text of one of the user's notes in ${api.label}, as it is now. Nothing is written until the user approves; if the note changes meanwhile, the edit is refused.`,
					parameters: Type.Object({ id: Type.Integer({ description: "The note's number." }), note: Type.String({ description: "The note's new exact text, at most 500 characters." }) }),
					execute: async (toolCallId, args, signal, _onUpdate, ctx) => {
						try {
							propose(toolCallId, ctx, await editProposal(api, args.id, args.note, signal));
							return text("Proposed the edit for the user's approval. It is not written yet.");
						} catch (error) {
							return text(`Could not propose it: ${why(error)}`);
						}
					},
				}),
			],
			prompt: `${api.label} holds the user's notes. Read them with read_notes; propose a new note with propose_note, or a new text for one with propose_note_edit.`,
			labels: { read_notes: { label: () => `Read notes in ${api.label}` }, propose_note: { label: () => "Proposed a note" }, propose_note_edit: { label: () => "Proposed a note edit" } },
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
					ready,
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
				edit_note: {
					ready,
					async execute(proposal): Promise<WriteOutcome> {
						const { id, etag } = proposal.expect ?? {};
						if (!id || !etag) return { status: "failed", error: "This proposal names no note version" };
						try {
							// The version the user approved, from the proposal. Never read a newer one here:
							// that would overwrite whatever changed the note meanwhile.
							const answer = await api.request(`/notes/${id}`, { method: "PATCH", body: { text: proposal.body }, ifMatch: etag });
							if (answer.status >= 200 && answer.status < 300) return { status: "created" };
							if (answer.status === 412) return { status: "failed", error: `The note changed in ${api.label} after this was proposed; propose the edit again` };
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
