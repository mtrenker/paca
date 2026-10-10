// The Example notes page: your notes, read from the Example API as you, and a note proposed for
// your approval. Plain DOM, no build step. It never sees a token: everything goes through the
// package's operation and the host's proposal route.
const element = (tag, text, className) => {
	const el = document.createElement(tag);
	if (text !== undefined) el.textContent = text;
	if (className) el.className = className;
	return el;
};

export default {
	pages: {
		home(container, { context }) {
			let gone = false;
			const status = element("p", "Reading your notes…", "notes-status");
			const list = element("ul", undefined, "notes-list");
			const form = element("form", undefined, "notes-form");
			const label = element("label", "A new note");
			const input = element("textarea");
			input.id = "notes-new";
			input.maxLength = 500;
			input.rows = 2;
			label.htmlFor = input.id;
			const submit = element("button", "Propose note");
			submit.type = "submit";
			const result = element("p", "", "notes-result");
			result.setAttribute("aria-live", "polite");
			form.hidden = true;
			form.append(label, input, submit, element("p", "Paca stores it as a proposal. Nothing is written until you approve it in the session.", "notes-hint"));
			container.append(status, list, form, result);

			async function load() {
				const answer = await context.call("notes");
				if (gone) return;
				if (answer.problem) {
					status.replaceChildren(answer.problem);
					if (answer.signIn) {
						// Paca's ordinary sign-in, not a page of this extension: a full navigation.
						const again = element("a", "Sign in again", "notes-signin");
						again.href = "/auth/login";
						status.append(" ", again);
					}
					return;
				}
				status.textContent = `${answer.label} knows you as ${answer.username}.`;
				list.replaceChildren(...(answer.notes.length ? answer.notes.map((n) => element("li", n.text)) : [element("li", "No notes yet.", "notes-empty")]));
				form.hidden = false;
			}

			form.addEventListener("submit", async (event) => {
				event.preventDefault();
				submit.disabled = true;
				result.textContent = "";
				try {
					await context.propose("add_note", { note: input.value });
				} catch (error) {
					result.textContent = error.message;
				} finally {
					submit.disabled = false;
				}
			});
			load().catch((error) => !gone && (status.textContent = error.message));
			return {
				dispose() {
					gone = true;
					container.replaceChildren();
				},
			};
		},
	},
};
