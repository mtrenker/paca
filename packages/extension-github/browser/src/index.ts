// The GitHub package's cards, in plain TypeScript and DOM. The page imports this module the first
// time it shows a GitHub card and mounts each card once into a container it owns. Card data is
// what Paca read when the tool ran; nothing here calls GitHub or the API.
import type { BrowserExtension, CardMount } from "@paca/extension/browser";

interface IssueData {
	repository: string;
	number: number;
	title: string;
	state: "open" | "closed";
	labels: string[];
	updatedAt: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** The card data as this package stores it; anything else is refused, and the page shows the fallback. */
function issueData(data: unknown): IssueData {
	const d = data as Partial<IssueData> | null;
	if (!d || typeof d.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(d.repository) || !Number.isInteger(d.number) || typeof d.title !== "string") throw new Error("not an issue card");
	return { repository: d.repository, number: Number(d.number), title: d.title, state: d.state === "closed" ? "closed" : "open", labels: Array.isArray(d.labels) ? d.labels.map(String) : [], updatedAt: String(d.updatedAt ?? "") };
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
/** When Paca read the issue. A clock time, not "5 min ago": a card is rendered once and stays. */
function readAt(iso: string) {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "Read earlier";
	return `Read ${at.toDateString() === new Date().toDateString() ? timeFormat.format(at) : dayFormat.format(at)}`;
}

/** An issue as Paca read it: reference, state, title, labels and when it was read. */
const issue: CardMount = (container, { data, createdAt }) => {
	const d = issueData(data);
	const card = el("article", `issue-card ${d.state}`);
	const head = el("p", "issue-head");
	head.append(el("span", "issue-state", d.state === "closed" ? "Closed" : "Open"), el("span", "issue-ref", `${d.repository}#${d.number}`));
	const read = el("time", "issue-read", readAt(createdAt));
	read.dateTime = createdAt;
	read.title = "Paca shows the issue as it was when it read it.";
	head.append(read);
	const title = el("h3", "issue-title");
	const link = el("a", "", d.title || "(no title)");
	link.href = `https://github.com/${d.repository}/issues/${d.number}`;
	link.rel = "noreferrer";
	link.target = "_blank";
	title.append(link);
	card.append(head, title);
	if (d.labels.length) {
		const labels = el("ul", "issue-labels");
		labels.setAttribute("aria-label", "Labels");
		for (const label of d.labels) labels.append(el("li", "", label));
		card.append(labels);
	}
	container.append(card);
	return { dispose: () => container.replaceChildren() };
};

export default { cards: { issue } } satisfies BrowserExtension;
