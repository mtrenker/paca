// The GitHub package's cards and pages, in plain TypeScript and DOM. The page imports this module
// the first time it shows a GitHub card or page and mounts each one into a container it owns.
// A card shows what Paca read when the tool ran; pages read fresh data through the package's
// operations (`context.call`), in the signed-in user's scope. Text from GitHub is set with
// textContent only, and links to GitHub open in a new tab.
import type { BrowserExtension, CardMount, HostContext, PageMount } from "@paca/extension/browser";

interface IssueData {
	repository: string;
	number: number;
	title: string;
	state: "open" | "closed";
	labels: string[];
	updatedAt: string;
}

interface IssueList {
	repositories: string[];
	results: IssueData[];
}

interface Issue extends IssueData {
	url: string;
	author: string;
	body: string;
	comments: { author: string; createdAt: string; body: string }[];
}

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** A link to github.com, the only external links this package makes. */
function githubLink(path: string, text: string) {
	const a = el("a", "gh-external", text);
	a.href = `https://github.com/${path}`;
	a.rel = "noreferrer";
	a.target = "_blank";
	return a;
}

/** A link to one of this package's pages, opened in place by the page. */
function pageLink(context: HostContext, page: string, params: Record<string, string>, text: string, className = "") {
	const a = el("a", className, text);
	a.href = context.href(page, params);
	a.dataset.pacaNav = "";
	return a;
}

/** The card data as this package stores it; anything else is refused, and the page shows the fallback. */
function issueData(data: unknown): IssueData {
	const d = data as Partial<IssueData> | null;
	if (!d || typeof d.repository !== "string" || !REPOSITORY.test(d.repository) || !Number.isInteger(d.number) || typeof d.title !== "string") throw new Error("not an issue card");
	return { repository: d.repository, number: Number(d.number), title: d.title, state: d.state === "closed" ? "closed" : "open", labels: Array.isArray(d.labels) ? d.labels.map(String) : [], updatedAt: String(d.updatedAt ?? "") };
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
/** A clock time today, a date otherwise. Not "5 min ago": what this package renders is not re-rendered. */
function when(iso: string) {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "unknown";
	return at.toDateString() === new Date().toDateString() ? timeFormat.format(at) : dayFormat.format(at);
}

function stateBadge(state: IssueData["state"]) {
	return el("span", `gh-state ${state}`, state === "closed" ? "Closed" : "Open");
}

function labelList(labels: string[]) {
	const list = el("ul", "gh-labels");
	list.setAttribute("aria-label", "Labels");
	for (const label of labels) list.append(el("li", "", label));
	return list;
}

/** An issue as Paca read it: reference, state, title, labels and when it was read. The title opens the issue page. */
const issueCard: CardMount = (container, { data, createdAt, context }) => {
	const d = issueData(data);
	const card = el("article", `issue-card ${d.state}`);
	const head = el("p", "issue-head");
	head.append(stateBadge(d.state), el("span", "issue-ref", `${d.repository}#${d.number}`));
	const read = el("time", "issue-read", `Read ${when(createdAt)}`);
	read.dateTime = createdAt;
	read.title = "Paca shows the issue as it was when it read it. The issue page reads it again.";
	head.append(read);
	const title = el("h3", "issue-title");
	title.append(pageLink(context, "issue", { repository: d.repository, number: String(d.number) }, d.title || "(no title)"));
	card.append(head, title);
	if (d.labels.length) card.append(labelList(d.labels));
	container.append(card);
	return { dispose: () => container.replaceChildren() };
};

/** A status line for loading and errors, announced politely. */
function status(text = "") {
	const p = el("p", "gh-status", text);
	p.setAttribute("role", "status");
	return p;
}

/** Search results or recent open issues, each linking to its issue page. */
function resultList(context: HostContext, results: IssueData[], empty: string) {
	if (!results.length) return el("p", "gh-empty", empty);
	const list = el("ul", "gh-results");
	for (const r of results) {
		const item = el("li", "gh-result");
		const title = el("p", "gh-result-title");
		title.append(pageLink(context, "issue", { repository: r.repository, number: String(r.number) }, r.title || "(no title)"));
		const meta = el("p", "gh-meta");
		meta.append(stateBadge(r.state), el("span", "issue-ref", `${r.repository}#${r.number}`), el("span", "", `updated ${when(r.updatedAt)}`));
		item.append(title, meta);
		if (r.labels.length) item.append(labelList(r.labels));
		list.append(item);
	}
	return list;
}

/** The repositories in scope, a search with a repository filter, and recent open issues until the user searches. */
const home: PageMount = (container, { context }) => {
	const root = el("div", "gh-home");
	const repos = el("section", "gh-repos");
	repos.setAttribute("aria-labelledby", "gh-repos-heading");
	const reposHeading = el("h2", "", "Repositories");
	reposHeading.id = "gh-repos-heading";
	const repoList = el("ul", "gh-repo-list");
	repos.append(reposHeading, repoList);

	const form = el("form", "gh-search");
	form.setAttribute("role", "search");
	const queryLabel = el("label", "", "Search issues");
	const query = el("input", "");
	query.type = "search";
	query.name = "q";
	query.maxLength = 200;
	query.id = queryLabel.htmlFor = "gh-query";
	const repoLabel = el("label", "", "Repository");
	const repoSelect = el("select", "");
	repoSelect.id = repoLabel.htmlFor = "gh-repository";
	repoSelect.append(new Option("All repositories", ""));
	const submit = el("button", "", "Search");
	submit.type = "submit";
	const fields = el("div", "gh-fields");
	const q = el("div", "gh-field gh-field-query");
	q.append(queryLabel, query);
	const r = el("div", "gh-field");
	r.append(repoLabel, repoSelect);
	fields.append(q, r, submit);
	form.append(fields);

	const results = el("section", "gh-found");
	results.setAttribute("aria-labelledby", "gh-found-heading");
	const resultsHeading = el("h2", "", "Recent open issues");
	resultsHeading.id = "gh-found-heading";
	const line = status("Loading…");
	const body = el("div", "");
	results.append(resultsHeading, line, body);
	root.append(repos, form, results);
	container.append(root);

	let filled = false;
	async function load(input: { query?: string; repository?: string }) {
		line.textContent = "Loading…";
		submit.disabled = true;
		try {
			const list = (await context.call("issues", input)) as IssueList;
			if (!filled) {
				filled = true;
				for (const repository of list.repositories) {
					const item = el("li", "");
					item.append(el("span", "issue-ref", repository), " ", githubLink(repository, "Open on GitHub"));
					repoList.append(item);
					repoSelect.append(new Option(repository, repository));
				}
			}
			resultsHeading.textContent = input.query ? `Issues matching “${input.query}”` : "Recent open issues";
			body.replaceChildren(resultList(context, list.results, input.query ? "No issues matched." : "No open issues."));
			line.textContent = input.query ? `${list.results.length} found.` : "";
		} catch (error) {
			if (!container.isConnected) return;
			line.textContent = (error as Error).message;
		} finally {
			submit.disabled = false;
		}
	}
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void load({ query: query.value.trim() || undefined, repository: repoSelect.value || undefined });
	});
	void load({});
	return { dispose: () => container.replaceChildren() };
};

/** One issue, read fresh: state, labels, author, update time, body and recent comments as plain text. */
const issue: PageMount = (container, { params, context }) => {
	const line = status("Loading…");
	container.append(line);
	const number = Number(params.number);
	if (!REPOSITORY.test(params.repository ?? "") || !Number.isInteger(number) || number < 1) {
		line.textContent = "This link names no issue.";
		container.append(pageLink(context, "home", {}, "All issues"));
		return { dispose: () => container.replaceChildren() };
	}
	context.call("issue", { repository: params.repository, number }).then(
		(answer) => {
			const d = answer as Issue;
			const article = el("article", `gh-issue ${d.state}`);
			const meta = el("p", "gh-meta");
			meta.append(stateBadge(d.state), el("span", "issue-ref", `${d.repository}#${d.number}`), el("span", "", `by ${d.author}`), el("span", "", `updated ${when(d.updatedAt)}`));
			const title = el("h2", "gh-issue-title", d.title || "(no title)");
			const links = el("p", "gh-links");
			links.append(githubLink(`${d.repository}/issues/${d.number}`, "Open on GitHub"), pageLink(context, "home", {}, "All issues"));
			article.append(meta, title);
			if (d.labels.length) article.append(labelList(d.labels));
			article.append(links, el("div", "gh-body", d.body || "(no description)"));
			const comments = el("section", "gh-comments");
			const heading = el("h3", "", d.comments.length ? `Latest comments (${d.comments.length})` : "No comments");
			comments.append(heading);
			for (const c of d.comments) {
				const item = el("article", "gh-comment");
				item.append(el("p", "gh-meta", `${c.author} · ${when(c.createdAt)}`), el("div", "gh-body", c.body));
				comments.append(item);
			}
			article.append(comments);
			line.textContent = "";
			container.append(article);
		},
		(error: Error) => {
			if (!container.isConnected) return;
			line.textContent = error.message;
			container.append(pageLink(context, "home", {}, "All issues"));
		},
	);
	return { dispose: () => container.replaceChildren() };
};

export default { cards: { issue: issueCard }, pages: { home, issue } } satisfies BrowserExtension;
