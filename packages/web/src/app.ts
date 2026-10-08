// The Paca page: the user's saved sessions, the open session's transcript, and questions.
// The open session is ?session=<id> in the URL; without one, the next question starts a new session.
// ?page=<package>.<page> shows a tool package's page instead, keeping ?session for its links.
// Model text becomes DOM nodes through a small Markdown subset; nothing is parsed as HTML.
// Turns are kept by id across updates, so extension cards stay mounted while an answer streams.
import type { CardRef, DraftCard, PageState, SessionInfo, SessionSummary, Turn } from "@paca/contracts";
import { createMounts, hostContext, type PageRef, pageHref, pageTitle, readPage } from "./mounts.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const EMPTY: PageState = { running: false, turns: [] };
let info: SessionInfo;
/** The open session, or the session an extension page keeps; undefined on New session or the phone's list. */
let current: string | undefined;
/** The extension page shown, if any. */
let page: PageRef | undefined;
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
	renderNav();
	readUrl();
	connect();
	render();
}

/** ?page=<package>.<page> is an extension page; ?session=<id> opens a session; ?new is New session; none is the list (on a phone). */
function readUrl() {
	const params = new URLSearchParams(location.search);
	current = params.get("session") || undefined;
	page = readPage(location.search);
	document.body.className = page ? "view-page" : current || params.has("new") ? "view-session" : "view-list";
}

/** Shows the URL's view. After navigation, focus goes to an extension page's title. */
function show(navigated: boolean) {
	readUrl();
	state = EMPTY;
	connect();
	render();
	if (navigated && page) $("page-title").focus();
}

function go(href: string, replace = false) {
	if (href === location.pathname + location.search) return;
	history[replace ? "replaceState" : "pushState"](null, "", href);
	show(true);
	scrollTo(0, 0);
}
addEventListener("popstate", () => show(true));

/** One stream: the session list always, and the open session's state until it is deleted. A page needs only the list. */
function connect() {
	source?.close();
	const open = page ? undefined : current;
	const stream = new EventSource(open ? `/api/events?session=${encodeURIComponent(open)}` : "/api/events");
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
		if (check?.ok && open && !sessions.some((s) => s.id === open)) {
			$("link-state").hidden = true;
			return leave("That session no longer exists.");
		}
		setTimeout(() => source === stream && connect(), 2000);
	};
}

/** Back to the list, after the open session was deleted here or elsewhere. */
function leave(message: string) {
	if (!current || page) return;
	go("/", true);
	showStatus(message);
	// The control that had focus is gone with the session.
	$("new-session").focus();
}

/** A turn on the page. `cards` holds its card containers and is never detached while shown. */
interface TurnView {
	section: HTMLElement;
	cards: HTMLElement;
}
const turnViews = new Map<string, TurnView>();

function render() {
	const nearBottom = innerHeight + scrollY >= document.body.scrollHeight - 120;
	const session = page ? undefined : current;
	$("session-head").hidden = !session;
	$("session-title").textContent = titleOf(session);
	$("empty").hidden = Boolean(current) || Boolean(page);
	renderTurns(session ? state.turns : []);
	renderPage();
	$("send").hidden = state.running;
	$("stop").hidden = !state.running;
	const deletable = !state.running && !drafts().some((d) => d.status === "creating");
	$<HTMLButtonElement>("delete").disabled = !deletable;
	$("delete").title = deletable ? "" : "Wait for the answer or the issue being created, or stop it, then delete.";
	renderList();
	if (nearBottom && session) scrollTo(0, document.body.scrollHeight);
}

/** The extension page frame: the manifest's title, the package's container, and Back to session. */
function renderPage() {
	$("page").hidden = !page;
	$("transcript").setAttribute("aria-live", page ? "off" : "polite");
	if (!page) {
		cards.closePage();
		document.title = "Paca";
		return;
	}
	const title = pageTitle(info.extensions, page) ?? "Page unavailable";
	$("page-title").textContent = title;
	document.title = `${title} · Paca`;
	const container = cards.page(page);
	if (container.parentElement !== $("page-body")) $("page-body").replaceChildren(container);
	renderPageBack();
}

/** Back to session, while the page's session still exists; otherwise the header's Back leads to the list. */
function renderPageBack() {
	const back = $<HTMLAnchorElement>("page-back");
	const session = page?.session && sessions.some((s) => s.id === page!.session) ? page.session : undefined;
	back.hidden = !session;
	if (session) back.href = `/?session=${session}`;
}

/** One side-list link per package with a nav entry, made once so a focused link stays focused. */
const navLinks = new Map<string, HTMLAnchorElement>();
function renderNav() {
	const nav = $("ext-nav");
	for (const ext of info.extensions ?? []) {
		if (!ext.nav || navLinks.has(ext.name)) continue;
		const item = el("li");
		const a = el("a", "ext-nav-link", ext.nav.label);
		a.dataset.pacaNav = "";
		navLinks.set(ext.name, a);
		item.append(a);
		nav.append(item);
	}
	nav.hidden = navLinks.size === 0;
	// The open session goes along, so a page's links and proposals stay with it; a session that no
	// longer exists does not, so a proposal from there starts a new session instead of failing.
	const session = current && sessions.some((s) => s.id === current) ? current : undefined;
	for (const [name, a] of navLinks) {
		const ext = info.extensions.find((e) => e.name === name)!;
		a.href = pageHref(name, ext.nav!.page, {}, session);
		if (page?.package === name) a.setAttribute("aria-current", "page");
		else a.removeAttribute("aria-current");
	}
}

const titleOf = (id: string | undefined) => sessions.find((s) => s.id === id)?.title ?? state.turns.find((t) => t.question && t.id !== "earlier-drafts")?.question ?? "";
const drafts = () => state.turns.flatMap((t) => t.drafts);

function renderList() {
	const list = $("session-list");
	list.replaceChildren(...sessions.map(renderSession));
	$("sessions-empty").hidden = sessions.length > 0;
	$("new-session").setAttribute("aria-current", !current && document.body.className === "view-session" ? "page" : "false");
	renderNav();
	renderPageBack();
	// On a phone the list is a screen away; the dot says another session needs a look.
	const elsewhere = sessions.filter((s) => s.id !== current && (s.running || s.waiting > 0));
	$("back-dot").hidden = elsewhere.length === 0;
	$("back").setAttribute("aria-label", elsewhere.length ? `Sessions, ${elsewhere.length} answering or waiting` : "Sessions");
	if (current && !page) $("session-title").textContent = titleOf(current);
}

function renderSession(s: SessionSummary) {
	const item = el("li");
	const a = el("a", "session");
	a.href = `/?session=${s.id}`;
	if (s.id === current && !page) a.setAttribute("aria-current", "page");
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
	// Paca's own links, and extension links marked data-paca-nav (pages of their own package).
	if (!a.matches(".session, #new-session, #back, #page-back, [data-paca-nav]")) return;
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

/**
 * Updates the transcript in place: a turn keeps its section, and a card keeps its container, so a
 * mounted card is never detached (that would blur a focused element inside it). Nodes move only
 * when their order changed. Cards that left the state are disposed once.
 */
function renderTurns(turns: Turn[]) {
	const shown = new Set<string>();
	const cardIds = new Set<string>();
	let previous: Element = $("empty");
	// The answer in progress belongs to the last question, even when a page's draft sits after it.
	const lastAsked = turns.findLast((t) => !t.id.startsWith("page:"));
	for (const turn of turns) {
		shown.add(turn.id);
		let view = turnViews.get(turn.id);
		if (!view) {
			view = { section: el("section", "turn"), cards: el("div", "turn-cards") };
			view.section.append(view.cards);
			turnViews.set(turn.id, view);
		}
		if (previous.nextElementSibling !== view.section) previous.after(view.section);
		previous = view.section;
		renderTurn(view, turn, turn === lastAsked);
		let before: Element | null = null;
		for (const card of turn.cards ?? []) {
			cardIds.add(card.id);
			const container = cards.container(card, current);
			if ((before ? before.nextElementSibling : view.cards.firstElementChild) !== container) {
				if (before) before.after(container);
				else view.cards.prepend(container);
			}
			before = container;
		}
	}
	cards.retain(cardIds);
	for (const [id, view] of turnViews) {
		if (shown.has(id)) continue;
		view.section.remove();
		turnViews.delete(id);
	}
}

/** Everything of a turn but its cards, rebuilt on each update: before the cards, then after them. */
function renderTurn({ section, cards: cardsEl }: TurnView, turn: Turn, isLast: boolean) {
	for (const child of [...section.children]) if (child !== cardsEl) child.remove();
	const before: Node[] = [];
	const after: Node[] = [];
	if (turn.question) before.push(el("p", "question", turn.question));
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
		before.push(trail);
	}
	const text = turn.answer || turn.draft;
	if (text) {
		const answer = renderMarkdown(text);
		if (!turn.answer) answer.classList.add("draft");
		after.push(answer);
	} else if (isLast && state.running) {
		after.push(el("p", "working", turn.steps.length ? "Thinking about what was read…" : "Starting…"));
	}
	for (const draft of turn.drafts ?? []) after.push(renderDraft(draft));
	if (turn.retry && isLast && state.running) after.push(el("p", "notice", turn.retry));
	for (const notice of turn.notices) after.push(el("p", `notice ${notice.tone === "error" ? "error" : ""}`, notice.text));
	cardsEl.before(...before);
	cardsEl.after(...after);
}

// Extension cards. A package's module and styles load the first time one of its cards is shown.
// A card of a package this page does not list, or whose module or mount fails, shows its fallback.
const EXT_NAME = /^[a-z][a-z0-9-]*$/;
const cards = createMounts<HTMLElement>({
	available: (card) => Boolean(info.extensions?.some((e) => e.name === card.package && e.cards.includes(card.kind))),
	load(pkg) {
		const ext = info.extensions.find((e) => e.name === pkg)!;
		for (const href of ext.styles) {
			const sheet = el("link");
			sheet.rel = "stylesheet";
			sheet.href = href;
			document.head.append(sheet);
		}
		return import(ext.entry).then((module) => module.default);
	},
	pageAvailable: (ref) => pageTitle(info.extensions, ref) !== undefined,
	create(card) {
		const container = el("div", EXT_NAME.test(card.package) ? `ext ext-${card.package}` : "ext");
		container.dataset.cardId = card.id;
		return container;
	},
	createPage: (ref) => el("div", EXT_NAME.test(ref.package) ? `ext ext-${ref.package} ext-page` : "ext ext-page"),
	fallback: renderCardFallback,
	pageFallback: renderPageFallback,
	remove: (container) => container.remove(),
	context: (target, signal) => hostContext(target, signal, { call: callOperation, send: sendJson, go, uuid: () => crypto.randomUUID() }),
	warn: (message) => console.warn(message),
});

/** Calls a package's operation for its card or page; rejects with the API's error. */
async function callOperation(pkg: string, op: string, input: Record<string, unknown>, signal: AbortSignal) {
	const response = await post(`/api/ext/${pkg}/${op}`, input, signal);
	const answer = await response.json().catch(() => undefined);
	if (!response.ok) throw new Error(answer?.error ?? "That didn’t work. Try again.");
	return answer;
}

/** POSTs a page's proposal; rejects only when Paca could not be reached. */
async function sendJson(path: string, body: unknown) {
	const response = await post(path, body);
	return { ok: response.ok, body: await response.json().catch(() => undefined) };
}

/** A page whose package is not enabled for this user, or whose module or mount failed. */
function renderPageFallback(container: HTMLElement, ref: PageRef, failed: boolean) {
	container.className = "page-unavailable";
	const back = el("a", "", "Back");
	back.href = ref.session ? `/?session=${ref.session}` : "/";
	back.dataset.pacaNav = "";
	container.replaceChildren(el("p", "", failed ? "This page isn’t available. Its extension could not be loaded." : "This page isn’t available. Its extension is not enabled for you."), back);
}

/** What a card says without its package: its fallback text, linked when the link is GitHub's. */
function renderCardFallback(container: HTMLElement, card: CardRef, failed: boolean) {
	container.className = "card-fallback";
	const text = el("p");
	if (failed) text.append(el("span", "card-unavailable", "Card unavailable: "));
	text.append(card.fallback.url ? link(card.fallback.url, card.fallback.text) : card.fallback.text);
	container.replaceChildren(text);
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

const PROMPT_ACTION = "herdr.send_prompt";
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
	const prompt = draft.action === PROMPT_ACTION;
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
	// Exact text the user typed on a page; the model neither wrote nor saw it.
	if (draft.fromPage) card.append(el("p", "draft-origin", "Proposed from a page, not by Paca."));
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
	if (!current) return;
	showError("");
	pendingDrafts.add(id);
	render();
	try {
		const response = await post(`/api/sessions/${current}/drafts/${action}`, { id });
		if (!response.ok && response.status !== 409) showError((await response.json().catch(() => ({}))).error ?? "That didn’t work.");
	} catch {
		showError("Could not reach Paca. Reload to see what happened before trying again.");
	} finally {
		pendingDrafts.delete(id);
		render();
	}
}

// Deleting is permanent, so the confirmation names what Paca forgets: the issues it created or
// may have created stay on GitHub, and prompts stay typed, but their records are gone with the session.
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
		issues.append(el("p", "", "Paca keeps no record of these after the session is deleted. Note anything you need first:"));
		const list = el("ul", "confirm-list");
		for (const d of created) {
			const li = el("li");
			if (d.action === PROMPT_ACTION) li.append(`Prompt submitted to ${d.target}`);
			else li.append(link(d.url ?? "", `${d.target}#${d.number}`), ` ${d.title}`);
			list.append(li);
		}
		for (const d of unknown) {
			const li = el("li", "unknown");
			if (d.action === PROMPT_ACTION) li.append(`Prompt to ${d.target}: outcome unknown.`);
			else li.append(`${d.title}: outcome unknown. `, link(d.checkUrl ?? "", `Check ${d.target} issues`));
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

async function post(path: string, body?: unknown, signal?: AbortSignal) {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-CSRF-Token": info.csrf },
		body: JSON.stringify(body ?? {}),
		signal,
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
