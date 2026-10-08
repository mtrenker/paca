// The page's card registry on its TypeScript source, with fake containers instead of the DOM.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMounts } from "../src/mounts.ts";

const card = (id, extra = {}) => ({ id, package: "github", kind: "issue", data: { n: id }, fallback: { text: `fallback ${id}` }, createdAt: "2026-10-08T00:00:00Z", ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A registry whose package module is `module` (or a load that rejects), recording everything. */
function registry({ module, available = () => true } = {}) {
	const log = { loads: [], mounts: [], disposes: [], fallbacks: [], removed: [], warnings: [], contexts: [] };
	const mountIssue = (container, { id, data, context }) => {
		log.mounts.push(id);
		log.contexts.push(context);
		container.content = data;
		return { dispose: () => log.disposes.push(id) };
	};
	const mounts = createMounts({
		available,
		load: async (pkg) => {
			log.loads.push(pkg);
			if (module instanceof Error) throw module;
			return module ?? { cards: { issue: mountIssue } };
		},
		create: (c) => ({ id: c.id }),
		fallback: (container, c, failed) => log.fallbacks.push([c.id, failed]),
		remove: (container) => log.removed.push(container.id),
		context: (c) => ({ package: c.package, session: "s1" }),
		warn: (message) => log.warnings.push(message),
	});
	return { mounts, log };
}

/** What the page does on every state event: ask for each card's container, then retain them. */
function render(mounts, cards) {
	const containers = cards.map((c) => mounts.container(c));
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
		for (const module of [{ cards: {} }, { cards: { issue: throwing } }, { cards: { issue: () => ({}) } }, {}]) {
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
});
