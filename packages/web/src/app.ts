// The Paca page: the user's saved sessions, the open session's transcript, and questions.
// The open session is ?session=<id> in the URL; without one, the next question starts a new session.
// Model text becomes DOM nodes through a small Markdown subset; nothing is parsed as HTML.
import type { DraftCard, PageState, SessionInfo, SessionSummary, Turn } from "@paca/contracts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const EMPTY: PageState = { running: false, turns: [] };
let info: SessionInfo;
/** The open session; undefined on New session or the phone's list. */
let current: string | undefined;
let sessions: SessionSummary[] = [];
let state: PageState = EMPTY;
let source: EventSource | undefined;

const STEP_STATUS: Record<string, string> = { running: "Working", unavailable: "Unavailable", interrupted: "Interrupted" };

async function start() {
	const response = await fetch("/api/session");
	if (response.status === 401) return location.assign("/auth/login");
	info = await response.json();
	$("scope").textContent = `${info.scope} · ${info.model}`;
	$("scope").title = info.scopeDetail;
	readUrl();
	connect();
	render();
}

/** ?session=<id> opens a session; ?new is New session; neither is the list (on a phone). */
function readUrl() {
	const params = new URLSearchParams(location.search);
	current = params.get("session") ?? undefined;
	document.body.className = current || params.has("new") ? "view-session" : "view-list";
}

function go(href: string, replace = false) {
	if (href === location.pathname + location.search) return;
	history[replace ? "replaceState" : "pushState"](null, "", href);
	readUrl();
	state = EMPTY;
	connect();
	render();
	scrollTo(0, 0);
}
addEventListener("popstate", () => {
	readUrl();
	state = EMPTY;
	connect();
	render();
});

/** One stream: the session list always, and the open session's state until it is deleted. */
function connect() {
	source?.close();
	const stream = new EventSource(current ? `/api/events?session=${encodeURIComponent(current)}` : "/api/events");
	source = stream;
	const live = () => ($("link-state").hidden = true);
	stream.addEventListener("sessions", (event: MessageEvent<string>) => {
		live();
		sessions = JSON.parse(event.data);
		renderList();
	});
	stream.addEventListener("state", (event: MessageEvent<string>) => {
		live();
		state = JSON.parse(event.data);
		render();
	});
	stream.addEventListener("gone", () => {
		stream.close();
		leave("This session was deleted.");
	});
	stream.onerror = async () => {
		if (source !== stream) return;
		$("link-state").hidden = false;
		$("link-state").textContent = "Connection lost. Reconnecting…";
		if (stream.readyState !== EventSource.CLOSED) return;
		const check = await fetch("/api/session").catch(() => undefined);
		if (check?.status === 401) return location.assign("/auth/login");
		// The server refuses a stream for a session that is not (or no longer) this user's.
		if (check?.ok && current && !sessions.some((s) => s.id === current)) {
			$("link-state").hidden = true;
			return leave("That session no longer exists.");
		}
		setTimeout(() => source === stream && connect(), 2000);
	};
}

/** Back to the list, after the open session was deleted here or elsewhere. */
function leave(message: string) {
	if (!current) return;
	go("/", true);
	showStatus(message);
	// The control that had focus is gone with the session.
	$("new-session").focus();
}

function render() {
	const main = $("transcript");
	const nearBottom = innerHeight + scrollY >= document.body.scrollHeight - 120;
	for (const node of [...main.querySelectorAll(".turn")]) node.remove();
	$("session-head").hidden = !current;
	$("session-title").textContent = titleOf(current);
	$("empty").hidden = Boolean(current);
	if (current) for (const turn of state.turns) main.append(renderTurn(turn, turn === state.turns.at(-1)));
	$("send").hidden = state.running;
	$("stop").hidden = !state.running;
	const deletable = !state.running && !drafts().some((d) => d.status === "creating");
	$<HTMLButtonElement>("delete").disabled = !deletable;
	$("delete").title = deletable ? "" : "Wait for the answer or the issue being created, or stop it, then delete.";
	renderList();
	if (nearBottom && current) scrollTo(0, document.body.scrollHeight);
}

const titleOf = (id: string | undefined) => sessions.find((s) => s.id === id)?.title ?? state.turns.find((t) => t.question && t.id !== "earlier-drafts")?.question ?? "";
const drafts = () => state.turns.flatMap((t) => t.drafts);

function renderList() {
	const list = $("session-list");
	list.replaceChildren(...sessions.map(renderSession));
	$("sessions-empty").hidden = sessions.length > 0;
	$("new-session").setAttribute("aria-current", !current && document.body.className === "view-session" ? "page" : "false");
	// On a phone the list is a screen away; the dot says another session needs a look.
	const elsewhere = sessions.filter((s) => s.id !== current && (s.running || s.waiting > 0));
	$("back-dot").hidden = elsewhere.length === 0;
	$("back").setAttribute("aria-label", elsewhere.length ? `Sessions, ${elsewhere.length} answering or waiting` : "Sessions");
	if (current) $("session-title").textContent = titleOf(current);
}

function renderSession(s: SessionSummary) {
	const item = el("li");
	const a = el("a", "session");
	a.href = `/?session=${s.id}`;
	if (s.id === current) a.setAttribute("aria-current", "page");
	a.append(el("span", "session-title", s.title));
	const meta = el("span", "session-meta");
	if (s.running) meta.append(el("span", "running", "Answering"));
	if (s.waiting > 0) meta.append(el("span", "waiting", s.waiting === 1 ? "1 draft waiting" : `${s.waiting} drafts waiting`));
	meta.append(el("span", "when", when(s.lastActivity)));
	a.append(meta);
	item.append(a);
	return item;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
function when(iso: string) {
	const at = new Date(iso);
	const minutes = (Date.now() - at.getTime()) / 60_000;
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${Math.round(minutes)} min ago`;
	return at.toDateString() === new Date().toDateString() ? timeFormat.format(at) : dayFormat.format(at);
}

// In-page navigation for plain clicks; modified clicks open a new tab as links do.
document.addEventListener("click", (event) => {
	const a = (event.target as HTMLElement).closest?.("a");
	if (!a || a.target || a.origin !== location.origin || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	if (!(a.matches(".session, #new-session, #back"))) return;
	event.preventDefault();
	go(a.pathname + a.search);
	if (a.id === "new-session") $("question").focus();
});

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

const DRAFT_KICKER: Record<string, string> = {
	proposed: "Draft issue",
	creating: "Creating issue…",
	created: "Created issue",
	failed: "Not created",
	unknown: "Outcome unknown",
	dismissed: "Dismissed",
};
const pendingDrafts = new Set<string>();

// A proposed issue, shown exactly as it would be created: plain text, nothing interpreted.
function renderDraft(draft: DraftCard) {
	const card = el("article", `draft-card ${draft.status}`);
	card.append(el("p", "draft-kicker", `${DRAFT_KICKER[draft.status] ?? draft.status} · ${draft.repository}`));
	card.append(el("h3", "draft-title", draft.title));
	if (draft.status !== "dismissed") card.append(el("p", "draft-body", draft.body || "(no description)"));
	const footer = el("div", "draft-footer");
	if (draft.status === "proposed") {
		const create = el("button", "", "Create issue");
		const dismiss = el("button", "secondary", "Dismiss");
		create.type = dismiss.type = "button";
		create.disabled = dismiss.disabled = pendingDrafts.has(draft.id);
		create.addEventListener("click", () => decide(draft.id, "approve"));
		dismiss.addEventListener("click", () => decide(draft.id, "dismiss"));
		footer.append(create, dismiss, el("span", "draft-note", "Creates it on GitHub as you."));
	} else if (draft.status === "creating") {
		footer.append(el("span", "draft-note", "Sending to GitHub…"));
	} else if (draft.status === "created") {
		footer.append(link(draft.url ?? "", `Open ${draft.repository}#${draft.number}`));
	} else if (draft.status === "failed") {
		footer.append(el("span", "draft-note", `GitHub did not create it: ${draft.error ?? "unknown reason"}. Ask Paca to draft it again if you still want it.`));
	} else if (draft.status === "unknown") {
		footer.append(el("span", "draft-note", "Paca can’t tell whether GitHub created it, so it won’t send it again. Check before drafting it again: "), link(draft.checkUrl ?? "", `${draft.repository} issues`));
	} else if (draft.status === "dismissed") {
		footer.append(el("span", "draft-note", "Nothing was created."));
	}
	card.append(footer);
	return card;
}

async function decide(id: string, action: "approve" | "dismiss") {
	if (!current) return;
	showError("");
	pendingDrafts.add(id);
	render();
	try {
		const response = await post(`/api/sessions/${current}/drafts/${action}`, { id });
		if (!response.ok && response.status !== 409) showError((await response.json().catch(() => ({}))).error ?? "That didn’t work.");
	} catch {
		showError("Could not reach Paca. Reload to see whether the issue was created before trying again.");
	} finally {
		pendingDrafts.delete(id);
		render();
	}
}

// Deleting is permanent, so the confirmation names what Paca forgets: the issues it created or
// may have created stay on GitHub, but their links are gone with the session.
function confirmDelete() {
	const all = drafts();
	const created = all.filter((d) => d.status === "created");
	const unknown = all.filter((d) => d.status === "unknown");
	const proposed = all.filter((d) => d.status === "proposed").length;
	const turns = state.turns.filter((t) => t.question && t.id !== "earlier-drafts").length;
	let what = `“${titleOf(current)}”, its ${turns === 1 ? "question and answer" : `${turns} questions and answers`} and its drafts are removed from Paca.`;
	if (proposed) what += proposed === 1 ? " The draft waiting for a decision is not created." : ` The ${proposed} drafts waiting for a decision are not created.`;
	$("confirm-what").textContent = what;
	const issues = $("confirm-issues");
	issues.replaceChildren();
	if (created.length || unknown.length) {
		issues.append(el("p", "", "Paca keeps no record of these issues after the session is deleted. Note anything you need first:"));
		const list = el("ul", "confirm-list");
		for (const d of created) {
			const li = el("li");
			li.append(link(d.url ?? "", `${d.repository}#${d.number}`), ` ${d.title}`);
			list.append(li);
		}
		for (const d of unknown) {
			const li = el("li", "unknown");
			li.append(`${d.title}: outcome unknown. `, link(d.checkUrl ?? "", `Check ${d.repository} issues`));
			list.append(li);
		}
		issues.append(list);
	}
	$<HTMLDialogElement>("confirm-delete").showModal();
}

$("delete").addEventListener("click", confirmDelete);
$("confirm-delete").addEventListener("close", async () => {
	const dialog = $<HTMLDialogElement>("confirm-delete");
	if (dialog.returnValue !== "delete" || !current) return;
	dialog.returnValue = "";
	showError("");
	try {
		const response = await post(`/api/sessions/${current}/delete`);
		if (response.ok) leave("Session deleted.");
		else showError((await response.json().catch(() => ({}))).error ?? "Could not delete the session.");
	} catch {
		showError("Could not reach Paca. Reload to see whether the session was deleted.");
	}
});

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
		headers: { "Content-Type": "application/json", "X-CSRF-Token": info.csrf },
		body: JSON.stringify(body ?? {}),
	});
	if (response.status === 401) location.assign("/auth/login");
	return response;
}

function showError(message: string) {
	$("form-error").textContent = message;
	$("form-error").hidden = !message;
}

let statusTimer: number | undefined;
function showStatus(message: string) {
	$("link-state").textContent = message;
	$("link-state").hidden = false;
	clearTimeout(statusTimer);
	statusTimer = setTimeout(() => ($("link-state").hidden = true), 5000);
}

/** Asks in the open session, or starts a new one with this question. */
async function ask(text: string) {
	showError("");
	const requestId = crypto.randomUUID();
	const id = current ?? crypto.randomUUID();
	const [path, body] = current ? [`/api/sessions/${id}/messages`, { text, requestId }] : ["/api/sessions", { id, text, requestId }];
	$<HTMLButtonElement>("send").disabled = true;
	try {
		// A retry with the same ids is answered once, so a flaky network cannot ask twice.
		let response = await post(path, body).catch(() => undefined);
		if (!response) response = await post(path, body);
		if (!response.ok) {
			showError((await response.json().catch(() => ({}))).error ?? "Could not send the question.");
			return false;
		}
		if (!current) go(`/?session=${id}`, true);
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
$("stop").addEventListener("click", () => current && post(`/api/sessions/${current}/stop`));
for (const button of document.querySelectorAll<HTMLButtonElement>(".suggestion")) {
	button.addEventListener("click", () => ask(button.dataset.question ?? ""));
}
$("signout").addEventListener("click", async () => {
	await post("/auth/logout");
	location.assign("/signed-out");
});

start().catch(() => showError("Could not load Paca. Reload the page."));
