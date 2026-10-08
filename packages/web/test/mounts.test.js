// The page's card registry on its TypeScript source, with fake containers instead of the DOM.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMounts, hostContext, pageHref, pageTitle, readPage } from "../src/mounts.ts";

const card = (id, extra = {}) => ({ id, package: "github", kind: "issue", data: { n: id }, fallback: { text: `fallback ${id}` }, createdAt: "2026-10-08T00:00:00Z", ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A registry whose package module is `module` (or a load that rejects), recording everything. */
function registry({ module, available = () => true, pageAvailable = () => true } = {}) {
	const log = { loads: [], mounts: [], disposes: [], fallbacks: [], removed: [], warnings: [], contexts: [], signals: [] };
	const mountIssue = (container, { id, data, context }) => {
		log.mounts.push(id);
		log.contexts.push(context);
		container.content = data;
		return { dispose: () => log.disposes.push(id) };
	};
	const mountPage = (container, { params, context }) => {
		log.mounts.push(`page ${params.n ?? ""}`);
		log.contexts.push(context);
		return { dispose: () => log.disposes.push(`page ${params.n ?? ""}`) };
	};
	const mounts = createMounts({
		available,
		pageAvailable,
		load: async (pkg) => {
			log.loads.push(pkg);
			if (module instanceof Error) throw module;
			return module ?? { cards: { issue: mountIssue }, pages: { home: mountPage } };
		},
		create: (c) => ({ id: c.id }),
		createPage: (ref) => ({ id: `page ${ref.params.n ?? ""}` }),
		fallback: (container, c, failed) => log.fallbacks.push([c.id, failed]),
		pageFallback: (container, ref, failed) => log.fallbacks.push([container.id, failed]),
		remove: (container) => log.removed.push(container.id),
		context: (target, signal) => (log.signals.push(signal), { ...target }),
		warn: (message) => log.warnings.push(message),
	});
	return { mounts, log };
}

/** What the page does on every state event: ask for each card's container, then retain them. */
function render(mounts, cards) {
	const containers = cards.map((c) => mounts.container(c, "s1"));
	mounts.retain(new Set(cards.map((c) => c.id)));
	return containers;
}

describe("card mounts", () => {
	it("mounts a card once across many renders, with the same container and its own context", async () => {
		const { mounts, log } = registry();
		const [first] = render(mounts, [card("a")]);
		await settle();
		for (let i = 0; i < 20; i++) assert.equal(render(mounts, [card("a"), card("b")])[0], first);
		await settle();
		assert.deepEqual(log.mounts, ["a", "b"]);
		assert.deepEqual(log.loads, ["github"], "a package loads once");
		assert.deepEqual(first.content, { n: "a" });
		assert.notEqual(log.contexts[0], log.contexts[1]);
		assert.deepEqual(log.disposes, []);
	});

	it("disposes a card once when it leaves the state, and every card on navigation", async () => {
		const { mounts, log } = registry();
		render(mounts, [card("a"), card("b"), card("c")]);
		await settle();
		render(mounts, [card("a"), card("c")]);
		render(mounts, [card("a"), card("c")]);
		assert.deepEqual([log.disposes, log.removed], [["b"], ["b"]]);
		render(mounts, []);
		render(mounts, []);
		assert.deepEqual(log.disposes.sort(), ["a", "b", "c"]);
		assert.equal(mounts.size, 0);
	});

	it("never mounts a card that left before its package loaded", async () => {
		const { mounts, log } = registry();
		render(mounts, [card("a")]);
		render(mounts, []);
		await settle();
		assert.deepEqual([log.mounts, log.disposes, log.removed], [[], [], ["a"]]);
	});

	it("shows the fallback without loading anything for a package the page does not list", async () => {
		const { mounts, log } = registry({ available: () => false });
		render(mounts, [card("a")]);
		await settle();
		assert.deepEqual([log.loads, log.mounts, log.fallbacks, log.warnings], [[], [], [["a", false]], []]);
	});

	it("falls back when the module fails to load, loading and warning once per package", async () => {
		const { mounts, log } = registry({ module: new Error("404") });
		render(mounts, [card("a"), card("b")]);
		await settle();
		render(mounts, [card("a"), card("b"), card("c")]);
		await settle();
		assert.deepEqual(log.loads, ["github"]);
		assert.deepEqual(log.fallbacks, [["a", true], ["b", true], ["c", true]]);
		assert.equal(log.warnings.length, 1);
		assert.match(log.warnings[0], /github could not be loaded: 404/);
	});

	it("falls back for a kind without a mount, or a mount that throws, warning once per kind", async () => {
		const throwing = () => {
			throw new Error("boom");
		};
		for (const module of [{ cards: {} }, { cards: { issue: throwing } }, { cards: { issue: () => ({}) } }, {}, { pages: { issue: () => ({ dispose() {} }) } }]) {
			const { mounts, log } = registry({ module });
			render(mounts, [card("a"), card("b")]);
			await settle();
			assert.deepEqual(log.fallbacks, [["a", true], ["b", true]]);
			assert.equal(log.warnings.length, 1);
		}
	});

	it("removes the container even when dispose throws", async () => {
		const { mounts, log } = registry({ module: { cards: { issue: () => ({ dispose: () => { throw new Error("bad dispose"); } }) } } });
		render(mounts, [card("a")]);
		await settle();
		render(mounts, []);
		assert.deepEqual(log.removed, ["a"]);
		assert.match(log.warnings[0], /bad dispose/);
	});

	it("gives each card its own context for its session, aborted when the card goes", async () => {
		const { mounts, log } = registry();
		render(mounts, [card("a"), card("b")]);
		await settle();
		assert.deepEqual(log.contexts.map((c) => c.session), ["s1", "s1"]);
		render(mounts, [card("b")]);
		assert.deepEqual(log.signals.map((s) => s.aborted), [true, false]);
	});
});

describe("page mounts", () => {
	const page = (n, extra = {}) => ({ key: `github.home s1 n=${n}`, package: "github", page: "home", params: { n: String(n) }, session: "s1", ...extra });

	it("mounts a page once per key, and disposes it on another page or on close", async () => {
		const { mounts, log } = registry();
		const first = mounts.page(page(1));
		for (let i = 0; i < 5; i++) assert.equal(mounts.page(page(1)), first);
		await settle();
		mounts.page(page(2));
		await settle();
		assert.deepEqual([log.mounts, log.disposes, log.removed], [["page 1", "page 2"], ["page 1"], ["page 1"]]);
		assert.deepEqual([log.signals[0].aborted, log.signals[1].aborted], [true, false]);
		mounts.closePage();
		mounts.closePage();
		assert.deepEqual(log.disposes, ["page 1", "page 2"]);
		assert.equal(log.signals[1].aborted, true);
	});

	it("mounts only a package's own page and card mounts, not inherited properties", async () => {
		const { mounts, log } = registry({ module: { cards: {}, pages: {} } });
		mounts.page({ key: "github.constructor  ", package: "github", page: "constructor", params: {} });
		render(mounts, [card("a", { kind: "constructor" })]);
		await settle();
		assert.deepEqual(log.fallbacks, [["page ", true], ["a", true]]);
		assert.deepEqual(log.mounts, []);
		// Not "constructor failed: mount returned no dispose()": Object was never called as a mount.
		assert.deepEqual(log.warnings, ["paca: extension github has no mount for page constructor", "paca: extension github has no mount for card constructor"]);
	});

	it("shows the unavailable notice for a page the page does not list, or whose mount is missing", async () => {
		const off = registry({ pageAvailable: () => false });
		off.mounts.page(page(1));
		await settle();
		assert.deepEqual([off.log.loads, off.log.fallbacks], [[], [["page 1", false]]]);
		const missing = registry({ module: { cards: {} } });
		missing.mounts.page(page(1));
		await settle();
		assert.deepEqual(missing.log.fallbacks, [["page 1", true]]);
		assert.match(missing.log.warnings[0], /no mount for page home/);
	});
});

describe("page URLs and contexts", () => {
	it("reads the page, its session and its parameters from the query; page, session and new are reserved", () => {
		assert.equal(readPage("?session=s1"), undefined);
		assert.deepEqual(readPage("?page=github.issue&session=s1&repository=o%2Fr&number=12&new"), {
			key: "github.issue s1 number=12&repository=o%2Fr",
			package: "github",
			page: "issue",
			params: { repository: "o/r", number: "12" },
			session: "s1",
		});
		assert.equal(readPage("?page=github.issue&number=12&repository=o%2Fr").key, readPage("?repository=o%2Fr&page=github.issue&number=12").key);
		for (const bad of ["?page=github", "?page=GitHub.home", "?page=a.b.c", "?page=..%2Fx.home"]) assert.deepEqual([readPage(bad).package, readPage(bad).page], ["", ""], bad);
	});

	it("finds a page's title only among the pages the package declares", () => {
		const extensions = [{ name: "github", entry: "", styles: [], cards: [], pages: { home: { title: "GitHub" } } }];
		assert.equal(pageTitle(extensions, { package: "github", page: "home" }), "GitHub");
		for (const page of ["constructor", "__proto__", "toString", "issue"]) assert.equal(pageTitle(extensions, { package: "github", page }), undefined, page);
		assert.equal(pageTitle(extensions, { package: "other", page: "home" }), undefined);
		assert.equal(pageTitle(undefined, { package: "github", page: "home" }), undefined);
	});

	it("makes page URLs within the package, keeping the session", () => {
		assert.equal(pageHref("github", "issue", { repository: "o/r", number: "12" }, "s1"), "/?page=github.issue&session=s1&number=12&repository=o%2Fr");
		assert.equal(pageHref("github", "home"), "/?page=github.home");
		assert.throws(() => pageHref("github", "home", { session: "other" }), /reserved/);
		assert.throws(() => pageHref("github", "../x"), /no page/);
	});

	it("calls the package's operations with the mount's signal, and refuses once it is aborted", async () => {
		const calls = [];
		const went = [];
		const controller = new AbortController();
		const context = hostContext({ package: "github", session: "s1" }, controller.signal, { call: async (...args) => (calls.push(args), { ok: true }), go: (href) => went.push(href) });
		assert.deepEqual(await context.call("issues", { query: "x" }), { ok: true });
		assert.deepEqual(calls[0].slice(0, 3), ["github", "issues", { query: "x" }]);
		assert.equal(calls[0][3], controller.signal);
		await assert.rejects(context.call("../session"), /no operation/);
		context.navigate("issue", { number: "1" });
		assert.deepEqual(went, ["/?page=github.issue&session=s1&number=1"]);
		assert.ok(Object.isFrozen(context));
		controller.abort();
		await assert.rejects(context.call("issues"), /closed/);
		assert.equal(calls.length, 1);
	});

	/** A context whose posts answer from `answers` in turn: an object, or "offline" for a network failure. */
	function proposing(target, answers) {
		const sent = [];
		const went = [];
		let n = 0;
		const context = hostContext(target, new AbortController().signal, {
			call: async () => ({}),
			send: async (path, body) => {
				sent.push([path, body]);
				const next = answers.shift();
				if (next === "offline") throw new TypeError("fetch failed");
				return next;
			},
			go: (href) => went.push(href),
			uuid: () => `00000000-0000-4000-8000-00000000000${n++}`,
		});
		return { context, sent, went };
	}

	it("proposes into the page's session and then shows it", async () => {
		const { context, sent, went } = proposing({ package: "github", session: "s1" }, [{ ok: true, body: { session: "s1", draft: "page:x", duplicate: false } }]);
		await context.propose("create_issue", { title: "t" });
		assert.deepEqual(sent, [["/api/sessions/s1/proposals", { requestId: "00000000-0000-4000-8000-000000000000", package: "github", action: "create_issue", input: { title: "t" } }]]);
		assert.deepEqual(went, ["/?session=s1"]);
	});

	it("starts a new session without one, retrying once with the same request and session ids", async () => {
		const { context, sent, went } = proposing({ package: "github" }, ["offline", { ok: true, body: { session: "first-session", duplicate: true } }]);
		await context.propose("create_issue", { title: "t" });
		assert.equal(sent.length, 2);
		assert.deepEqual(sent[0], sent[1]);
		assert.deepEqual(sent[0], ["/api/sessions/00000000-0000-4000-8000-000000000000/proposals", { requestId: "00000000-0000-4000-8000-000000000001", package: "github", action: "create_issue", input: { title: "t" }, start: true }]);
		assert.deepEqual(went, ["/?session=first-session"], "the session holding the draft, whatever the retry named");
	});

	it("rejects with the API's error or after the retry fails, and refuses a second proposal while one is pending", async () => {
		const refused = proposing({ package: "github", session: "s1" }, [{ ok: false, body: { error: "That session does not exist." } }]);
		await assert.rejects(refused.context.propose("create_issue", {}), /That session does not exist/);
		assert.deepEqual(refused.went, []);
		const offline = proposing({ package: "github", session: "s1" }, ["offline", "offline"]);
		await assert.rejects(offline.context.propose("create_issue", {}), /Could not reach Paca. Open the session list/);
		assert.equal(offline.sent.length, 2);
		const twice = proposing({ package: "github", session: "s1" }, [{ ok: true, body: { session: "s1" } }]);
		const first = twice.context.propose("create_issue", {});
		await assert.rejects(twice.context.propose("create_issue", {}), /already being sent/);
		await first;
		assert.equal(twice.sent.length, 1);
	});
});
