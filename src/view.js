// Reduces a Durable conversation view to what the page shows. Every update sends the whole
// state, so a client that reconnects simply starts from the latest one. Tool results stay on
// the server; the page sees only which evidence was read and whether it was available.

const TOOL_LABELS = {
	portfolio_overview: () => "Read all configured Projects",
	read_issue: (a) => `Read ${a.repository}#${a.number}`,
	search_issues: (a) => `Searched ${a.repository ?? "all repositories"} for “${a.query}”`,
	draft_issue: (a) => `Drafted an issue for ${a.repository}`,
};

/** What a draft card shows. `checkUrl` is where to look when the outcome is unknown. */
function draftCard(d) {
	const card = { id: d.id, repository: d.repository, title: d.title, body: d.body, status: d.status };
	if (d.url) Object.assign(card, { url: d.url, number: d.number });
	if (d.error) card.error = d.error;
	if (d.status === "unknown") card.checkUrl = `https://github.com/${d.repository}/issues?q=${encodeURIComponent("is:issue sort:created-desc")}`;
	return card;
}

function text(content) {
	if (typeof content === "string") return content;
	return (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

function toolLabel(call) {
	const label = TOOL_LABELS[call.name];
	return label ? label(call.arguments ?? {}) : `Refused tool ${call.name}`;
}

function resultSummary(message) {
	const body = text(message.content);
	if (message.isError) {
		// Durable wraps thrown errors as <harness>[error] message</harness>.
		const line = body.split("\n").find((l) => l.trim() && !/^<\/?harness>$/.test(l.trim())) ?? "unknown error";
		return line.replace(/^\[\w+\]\s*/, "").slice(0, 200);
	}
	const first = body.split("\n")[0];
	return first.startsWith("Captured") ? first.replace(/\s*\(closed items omitted\)\.?/, "") : "";
}

export function uiState(view, { busy, drafts } = {}) {
	const turns = [];
	let turn;
	const tools = new Map();
	const turnOfCall = new Map();
	const answer = () => {
		if (!turn) {
			turn = { id: "orphan", question: null, steps: [], answer: "", notices: [], drafts: [] };
			turns.push(turn);
		}
		return turn;
	};

	for (const entry of view.entries ?? []) {
		const message = entry.model?.[0];
		switch (entry.kind) {
			case "pi.user":
				turn = { id: String(entry.id), question: text(message.content), steps: [], answer: "", notices: [], drafts: [] };
				turns.push(turn);
				break;
			case "pi.assistant": {
				const t = answer();
				for (const block of message.content ?? []) {
					if (block.type === "toolCall") {
						const step = { id: block.id, label: toolLabel(block), status: "running", detail: "" };
						tools.set(block.id, step);
						turnOfCall.set(block.id, t);
						t.steps.push(step);
					}
				}
				const said = text(message.content).trim();
				if (said) t.answer = t.answer ? `${t.answer}\n\n${said}` : said;
				if (message.stopReason === "error") t.notices.push({ tone: "error", text: `The model request failed: ${message.errorMessage ?? "unknown error"}` });
				if (message.stopReason === "aborted") t.notices.push({ tone: "warning", text: "The answer was interrupted." });
				break;
			}
			case "pi.tool-result": {
				const step = tools.get(message.toolCallId);
				if (step) {
					step.status = message.isError ? "unavailable" : "done";
					step.detail = resultSummary(message);
				}
				break;
			}
			case "paca.notice":
				answer().notices.push({ tone: "warning", text: String(entry.data?.text ?? "") });
				break;
		}
	}

	const live = view.docs?.["pi.live"] ?? {};
	const running = Boolean(busy) || live.run !== undefined;
	const partial = live.generation?.message;
	if (running && turn && partial) {
		const said = text(partial.content).trim();
		if (said) turn.draft = said;
		for (const block of partial.content ?? []) {
			if (block.type === "toolCall" && !tools.has(block.id)) turn.steps.push({ id: block.id, label: toolLabel(block), status: "running", detail: "" });
		}
	}
	if (running && turn && live.generation?.retry) turn.retry = `Retrying after: ${live.generation.retry.error}`.slice(0, 240);
	// Steps still marked running after the run ended were cut off.
	if (!running) for (const step of tools.values()) if (step.status === "running") step.status = "interrupted";

	for (const draft of Object.values(drafts?.items ?? {})) {
		turnOfCall.get(draft.id)?.drafts.push(draftCard(draft));
	}

	return { running, turns };
}
