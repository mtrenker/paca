// The Paca page: renders the server's conversation state and sends questions.
// Model text becomes DOM nodes through a small Markdown subset; nothing is parsed as HTML.
"use strict";

const $ = (id) => document.getElementById(id);
let session;
let state = { running: false, turns: [] };

const STEP_STATUS = { running: "Working", unavailable: "Unavailable", interrupted: "Interrupted" };

async function start() {
	const response = await fetch("/api/session");
	if (response.status === 401) return location.assign("/auth/login");
	session = await response.json();
	const repos = session.repositories.map((r) => r.split("/")[1]).join(", ");
	$("scope").textContent = `${session.projects} Projects · ${session.model}`;
	$("scope").title = repos;
	connect();
}

function connect() {
	const source = new EventSource("/api/events");
	source.addEventListener("state", (event) => {
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

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function renderTurn(turn, isLast) {
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
	if (turn.retry && isLast && state.running) section.append(el("p", "notice", turn.retry));
	for (const notice of turn.notices) section.append(el("p", `notice ${notice.tone === "error" ? "error" : ""}`, notice.text));
	return section;
}

// Markdown subset: headings, ordered and unordered lists, paragraphs, bold, inline code, links.
function renderMarkdown(source) {
	const root = el("div", "answer");
	let list;
	let paragraph;
	const close = () => {
		list = undefined;
		paragraph = undefined;
	};
	for (const raw of source.split("\n")) {
		const line = raw.trimEnd();
		let m;
		if (!line.trim()) {
			paragraph = undefined; // a following list item still joins the open list
			continue;
		}
		if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
			close();
			root.append(inline(el(`h${Math.min(m[1].length + 1, 4)}`), m[2]));
		} else if ((m = /^\s*(?:(\d+)[.)]|[-*•])\s+(.*)$/.exec(line))) {
			const ordered = m[1] !== undefined;
			if (!list || list.ordered !== ordered) {
				list = { ordered, node: el(ordered ? "ol" : "ul") };
				if (ordered && m[1] !== "1") list.node.start = Number(m[1]);
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

function inline(parent, text) {
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
function link(href, label) {
	let url;
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

async function post(path, body) {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
		body: JSON.stringify(body ?? {}),
	});
	if (response.status === 401) location.assign("/auth/login");
	return response;
}

function showError(message) {
	$("form-error").textContent = message;
	$("form-error").hidden = !message;
}

async function ask(text) {
	showError("");
	const requestId = crypto.randomUUID();
	$("send").disabled = true;
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
		$("send").disabled = false;
	}
}

$("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	const text = $("question").value.trim();
	if (!text || state.running) return;
	if (await ask(text)) {
		$("question").value = "";
		resize();
	}
});
$("question").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing && matchMedia("(pointer: fine)").matches) {
		event.preventDefault();
		$("composer").requestSubmit();
	}
});
const resize = () => {
	const q = $("question");
	q.style.height = "auto";
	q.style.height = `${q.scrollHeight}px`;
};
$("question").addEventListener("input", resize);
$("stop").addEventListener("click", () => post("/api/stop"));
for (const button of document.querySelectorAll(".suggestion")) {
	button.addEventListener("click", () => ask(button.dataset.question));
}
$("signout").addEventListener("click", async () => {
	await post("/auth/logout");
	location.assign("/signed-out");
});

start().catch(() => showError("Could not load Paca. Reload the page."));
