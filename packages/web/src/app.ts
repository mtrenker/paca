// The Paca page: renders the server's conversation state and sends questions.
// Model text becomes DOM nodes through a small Markdown subset; nothing is parsed as HTML.
import type { DraftCard, PageState, SessionInfo, Turn } from "@paca/contracts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let session: SessionInfo;
let state: PageState = { running: false, turns: [] };

const STEP_STATUS: Record<string, string> = { running: "Working", unavailable: "Unavailable", interrupted: "Interrupted" };

async function start() {
	const response = await fetch("/api/session");
	if (response.status === 401) return location.assign("/auth/login");
	session = await response.json();
	$("scope").textContent = `${session.scope} · ${session.model}`;
	$("scope").title = session.scopeDetail;
	connect();
}

function connect() {
	const source = new EventSource("/api/events");
	source.addEventListener("state", (event: MessageEvent<string>) => {
		$("link-state").hidden = true;
		state = JSON.parse(event.data);
		render();
	});
	source.onerror = async () => {
		$("link-state").hidden = false;
		$("link-state").textContent = "Connection lost. Reconnecting…";
		if (source.readyState === EventSource.CLOSED) {
			const check = await fetch("/api/session").catch(() => undefined);
			if (check?.status === 401) return location.assign("/auth/login");
			setTimeout(connect, 2000);
		}
	};
}

function render() {
	const main = $("transcript");
	const nearBottom = innerHeight + scrollY >= document.body.scrollHeight - 120;
	for (const node of [...main.querySelectorAll(".turn")]) node.remove();
	$("empty").hidden = state.turns.length > 0;
	for (const turn of state.turns) main.append(renderTurn(turn, turn === state.turns.at(-1)));
	$("send").hidden = state.running;
	$("stop").hidden = !state.running;
	if (nearBottom) scrollTo(0, document.body.scrollHeight);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function renderTurn(turn: Turn, isLast: boolean) {
	const section = el("section", "turn");
	if (turn.question) section.append(el("p", "question", turn.question));
	if (turn.steps.length) {
		const trail = el("ul", "trail");
		trail.setAttribute("aria-label", "Evidence read for this answer");
		for (const step of turn.steps) {
			const li = el("li", step.status);
			const prefix = STEP_STATUS[step.status];
			if (prefix) li.append(el("span", "status", `${prefix}: `));
			li.append(step.label);
			if (step.detail) li.append(el("span", "detail", step.detail));
			trail.append(li);
		}
		section.append(trail);
	}
	const text = turn.answer || turn.draft;
	if (text) {
		const answer = renderMarkdown(text);
		if (!turn.answer) answer.classList.add("draft");
		section.append(answer);
	} else if (isLast && state.running) {
		section.append(el("p", "working", turn.steps.length ? "Thinking about what was read…" : "Starting…"));
	}
	for (const draft of turn.drafts ?? []) section.append(renderDraft(draft));
	if (turn.retry && isLast && state.running) section.append(el("p", "notice", turn.retry));
	for (const notice of turn.notices) section.append(el("p", `notice ${notice.tone === "error" ? "error" : ""}`, notice.text));
	return section;
}

// How a card speaks about its write. A draft without a known action is a GitHub issue draft.
interface CardWords {
	kicker: Record<string, string>;
	approve: string;
	note: string;
	sending: string;
	done(draft: DraftCard): Node[];
	failed(draft: DraftCard): string;
	unknown(draft: DraftCard): Node[];
	dismissed: string;
}

const ISSUE: CardWords = {
	kicker: { proposed: "Draft issue", creating: "Creating issue…", created: "Created issue", failed: "Not created", unknown: "Outcome unknown", dismissed: "Dismissed" },
	approve: "Create issue",
	note: "Creates it on GitHub as you.",
	sending: "Sending to GitHub…",
	done: (d) => [link(d.url ?? "", `Open ${d.target}#${d.number}`)],
	failed: (d) => `GitHub did not create it: ${d.error ?? "unknown reason"}. Ask Paca to draft it again if you still want it.`,
	unknown: (d) => [el("span", "draft-note", "Paca can’t tell whether GitHub created it, so it won’t send it again. Check before drafting it again: "), link(d.checkUrl ?? "", `${d.target} issues`)],
	dismissed: "Nothing was created.",
};

const PROMPT: CardWords = {
	kicker: { proposed: "Prompt for an agent", creating: "Sending prompt…", created: "Prompt submitted", failed: "Not sent", unknown: "Outcome unknown", dismissed: "Dismissed" },
	approve: "Send prompt",
	note: "Types this into the agent and presses Enter, after checking it’s still the same agent.",
	sending: "Checking the agent and typing…",
	done: () => [el("span", "draft-note", "The agent received it. Paca doesn’t follow whether it finished; ask Paca to read its screen later.")],
	failed: (d) => `${d.error ?? "Nothing was sent."} Ask Paca to propose it again if you still want it.`,
	unknown: (d) => [el("span", "draft-note", `Paca can’t tell whether the agent received it, so it won’t send it again. ${d.error ?? ""}`.trim())],
	dismissed: "Nothing was sent.",
};

const pendingDrafts = new Set<string>();

// A proposed write, shown exactly as it would be performed: plain text, nothing interpreted.
// An issue shows its repository, title and body; a prompt its agent, directory and exact text.
function renderDraft(draft: DraftCard) {
	const prompt = draft.action === "herdr.send_prompt";
	const words = prompt ? PROMPT : ISSUE;
	const kicker = words.kicker[draft.status] ?? draft.status;
	const card = el("article", `draft-card ${draft.status}`);
	if (prompt) {
		card.append(el("p", "draft-kicker", kicker), el("h3", "draft-title", draft.target));
		if (draft.title) card.append(el("p", "draft-meta", draft.title));
		if (draft.status !== "dismissed") card.append(el("pre", "draft-body draft-prompt", draft.body));
	} else {
		card.append(el("p", "draft-kicker", `${kicker} · ${draft.target}`), el("h3", "draft-title", draft.title));
		if (draft.status !== "dismissed") card.append(el("p", "draft-body", draft.body || "(no description)"));
	}
	const footer = el("div", "draft-footer");
	if (draft.status === "proposed") {
		const approve = el("button", "", words.approve);
		const dismiss = el("button", "secondary", "Dismiss");
		approve.type = dismiss.type = "button";
		approve.disabled = dismiss.disabled = pendingDrafts.has(draft.id);
		approve.addEventListener("click", () => decide(draft.id, "approve"));
		dismiss.addEventListener("click", () => decide(draft.id, "dismiss"));
		footer.append(approve, dismiss, el("span", "draft-note", words.note));
	} else if (draft.status === "creating") {
		footer.append(el("span", "draft-note", words.sending));
	} else if (draft.status === "created") {
		footer.append(...words.done(draft));
	} else if (draft.status === "failed") {
		footer.append(el("span", "draft-note", words.failed(draft)));
	} else if (draft.status === "unknown") {
		footer.append(...words.unknown(draft));
	} else if (draft.status === "dismissed") {
		footer.append(el("span", "draft-note", words.dismissed));
	}
	card.append(footer);
	return card;
}

async function decide(id: string, action: "approve" | "dismiss") {
	showError("");
	pendingDrafts.add(id);
	render();
	try {
		const response = await post(`/api/drafts/${action}`, { id });
		if (!response.ok && response.status !== 409) showError((await response.json().catch(() => ({}))).error ?? "That didn’t work.");
	} catch {
		showError("Could not reach Paca. Reload to see what happened before trying again.");
	} finally {
		pendingDrafts.delete(id);
		render();
	}
}

// Markdown subset: headings, ordered and unordered lists, paragraphs, bold, inline code, links.
type Paragraph = HTMLElement & { isItem?: boolean };

function renderMarkdown(source: string) {
	const root = el("div", "answer");
	let list: { ordered: boolean; node: HTMLOListElement | HTMLUListElement } | undefined;
	let paragraph: Paragraph | undefined;
	const close = () => {
		list = undefined;
		paragraph = undefined;
	};
	for (const raw of source.split("\n")) {
		const line = raw.trimEnd();
		let m: RegExpExecArray | null;
		if (!line.trim()) {
			paragraph = undefined; // a following list item still joins the open list
			continue;
		}
		if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
			close();
			root.append(inline(el(`h${Math.min(m[1].length + 1, 4)}` as "h2" | "h3" | "h4"), m[2]));
		} else if ((m = /^\s*(?:(\d+)[.)]|[-*•])\s+(.*)$/.exec(line))) {
			const ordered = m[1] !== undefined;
			if (!list || list.ordered !== ordered) {
				list = { ordered, node: el(ordered ? "ol" : "ul") };
				if (ordered && m[1] !== "1") (list.node as HTMLOListElement).start = Number(m[1]);
				root.append(list.node);
			}
			paragraph = inline(el("li"), m[2]);
			list.node.append(paragraph);
			paragraph.isItem = true;
		} else if (paragraph) {
			paragraph.append(paragraph.isItem ? el("br") : " ");
			inline(paragraph, line.trim());
		} else {
			list = undefined;
			paragraph = inline(el("p"), line.trim());
			root.append(paragraph);
		}
	}
	return root;
}

const INLINE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(https:\/\/github\.com\/[^\s)<>]+)/g;

function inline(parent: HTMLElement, text: string) {
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		parent.append(text.slice(last, m.index));
		if (m[1] !== undefined) parent.append(link(m[2], m[1]));
		else if (m[3] !== undefined) parent.append(el("strong", "", m[3]));
		else if (m[4] !== undefined) parent.append(el("code", "", m[4]));
		else parent.append(link(m[5], m[5].replace("https://github.com/", "")));
		last = m.index + m[0].length;
	}
	parent.append(text.slice(last));
	return parent;
}

// Only links to GitHub become clickable; anything else stays visible as text.
function link(href: string, label: string) {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return document.createTextNode(label);
	}
	if (url.protocol !== "https:" || url.hostname !== "github.com") return document.createTextNode(`${label} (${href})`);
	const a = el("a", "", label);
	a.href = url.href;
	a.rel = "noreferrer";
	a.target = "_blank";
	return a;
}

async function post(path: string, body?: unknown) {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
		body: JSON.stringify(body ?? {}),
	});
	if (response.status === 401) location.assign("/auth/login");
	return response;
}

function showError(message: string) {
	$("form-error").textContent = message;
	$("form-error").hidden = !message;
}

async function ask(text: string) {
	showError("");
	const requestId = crypto.randomUUID();
	$<HTMLButtonElement>("send").disabled = true;
	try {
		// A retry with the same request id is answered once, so a flaky network cannot ask twice.
		let response = await post("/api/messages", { text, requestId }).catch(() => undefined);
		if (!response) response = await post("/api/messages", { text, requestId });
		if (!response.ok) {
			showError((await response.json().catch(() => ({}))).error ?? "Could not send the question.");
			return false;
		}
		return true;
	} catch {
		showError("Could not reach Paca. Check the connection and try again.");
		return false;
	} finally {
		$<HTMLButtonElement>("send").disabled = false;
	}
}

$("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	const text = $<HTMLTextAreaElement>("question").value.trim();
	if (!text || state.running) return;
	if (await ask(text)) {
		$<HTMLTextAreaElement>("question").value = "";
		resize();
	}
});
$("question").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing && matchMedia("(pointer: fine)").matches) {
		event.preventDefault();
		$<HTMLFormElement>("composer").requestSubmit();
	}
});
const resize = () => {
	const q = $("question");
	q.style.height = "auto";
	q.style.height = `${q.scrollHeight}px`;
};
$("question").addEventListener("input", resize);
$("stop").addEventListener("click", () => post("/api/stop"));
for (const button of document.querySelectorAll<HTMLButtonElement>(".suggestion")) {
	button.addEventListener("click", () => ask(button.dataset.question ?? ""));
}
$("signout").addEventListener("click", async () => {
	await post("/auth/logout");
	location.assign("/signed-out");
});

start().catch(() => showError("Could not load Paca. Reload the page."));
