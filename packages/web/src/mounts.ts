// The page's registry of mounted extension cards and pages. A card is mounted once, when its id
// first appears in the page state, and disposed once, when its id leaves it or the page navigates.
// SSE updates, reconnects and restarts replay the same ids, so nothing remounts and a focused
// element inside a card keeps its focus. At most one extension page is mounted, keyed by its URL.
// Each mount gets its own context, whose pending calls are aborted when it is disposed.
// DOM-free: the page injects how to make and remove containers, load a package and call the API,
// so `node --test` runs this on the TypeScript source.
import type { CardRef } from "@paca/contracts";
import type { BrowserExtension, HostContext, Mounted } from "@paca/extension/browser";

/** An extension page as the URL names it: /?page=<package>.<page>&session=<id>&<params>. */
export interface PageRef {
	/** Identifies the page with its session and parameters; the same key keeps the same mount. */
	key: string;
	package: string;
	page: string;
	params: Record<string, string>;
	session?: string;
}

/** What a context is for: a package, and the session of the card or page. */
export interface Target {
	package: string;
	session?: string;
}

export interface MountDeps<C> {
	/** Whether this user's page lists the card's package with its kind; otherwise it shows the fallback. */
	available(card: CardRef): boolean;
	/** Whether this user's page lists the package with this page. */
	pageAvailable(page: PageRef): boolean;
	/** Imports a package's entry, with its styles. Called at most once per package. */
	load(pkg: string): Promise<unknown>;
	/** A new, empty container for the card. */
	create(card: CardRef): C;
	/** A new, empty container for the page. */
	createPage(page: PageRef): C;
	/** Shows the card's fallback text in its container; `failed` when the frontend broke. */
	fallback(container: C, card: CardRef, failed: boolean): void;
	/** Shows that the page is unavailable. */
	pageFallback(container: C, page: PageRef, failed: boolean): void;
	/** Takes the container off the page. */
	remove(container: C): void;
	/** A new context for one mount; `signal` aborts when the mount is disposed. */
	context(target: Target, signal: AbortSignal): HostContext;
	warn(message: string): void;
}

interface Slot<C> {
	container: C;
	controller: AbortController;
	mounted?: Mounted;
	/** Set on dispose; a load that finishes afterwards mounts nothing. */
	gone?: boolean;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const RESERVED = new Set(["page", "session", "new"]);

/** The extension page a query string names, or undefined when it names none. */
export function readPage(search: string): PageRef | undefined {
	const query = new URLSearchParams(search);
	const name = query.get("page");
	if (name === null) return undefined;
	const [pkg = "", page = "", ...rest] = name.split(".");
	const params: Record<string, string> = {};
	for (const [key, value] of query) if (!RESERVED.has(key) && !Object.hasOwn(params, key)) params[key] = value;
	const session = query.get("session") || undefined;
	const valid = NAME.test(pkg) && NAME.test(page) && rest.length === 0;
	const sorted = new URLSearchParams(Object.keys(params).sort().map((k) => [k, params[k]]));
	return { key: `${name} ${session ?? ""} ${sorted}`, package: valid ? pkg : "", page: valid ? page : "", params, ...(session ? { session } : {}) };
}

/** The URL of a package's page, keeping `session`. Throws for a malformed name or a reserved parameter. */
export function pageHref(pkg: string, page: string, params: Record<string, string> = {}, session?: string): string {
	if (!NAME.test(pkg) || !NAME.test(page)) throw new Error(`no page ${pkg}.${page}`);
	const query = new URLSearchParams({ page: `${pkg}.${page}` });
	if (session) query.set("session", session);
	for (const key of Object.keys(params).sort()) {
		if (RESERVED.has(key)) throw new Error(`"${key}" is reserved in page URLs`);
		query.set(key, String(params[key]));
	}
	return `/?${query}`;
}

/** What a context needs of the page: operation calls, proposal posts, navigation and fresh ids. */
export interface ContextApi {
	call(pkg: string, op: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
	/** POSTs JSON; resolves with the answer, rejects only when Paca could not be reached. */
	send(path: string, body: unknown): Promise<{ ok: boolean; body: { error?: string; session?: string } | undefined }>;
	go(href: string): void;
	/** A lowercase UUID v4. */
	uuid(): string;
}

/**
 * A context for one mount. `call` posts to the package's operation and rejects once `signal`
 * aborts; links and navigation stay within the package's own pages and keep the session.
 * `propose` fixes its request id and target session (the mount's, or a new one) when it starts and
 * reuses both on its one retry, so a lost answer cannot store a proposal twice; it then shows the
 * session holding the draft. Dispose does not abort it: the proposal may already be stored.
 */
export function hostContext(target: Target, signal: AbortSignal, api: ContextApi): HostContext {
	const href = (page: string, params?: Record<string, string>) => pageHref(target.package, page, params, target.session);
	let proposing = false;
	return Object.freeze({
		package: target.package,
		session: target.session,
		call(op: string, input: Record<string, unknown> = {}) {
			if (signal.aborted) return Promise.reject(new Error("This card or page was closed."));
			if (!/^[a-z][a-z0-9_-]*$/.test(op)) return Promise.reject(new Error(`no operation ${op}`));
			return api.call(target.package, op, input, signal);
		},
		async propose(action: string, input: Record<string, unknown>) {
			if (proposing) throw new Error("A proposal is already being sent.");
			proposing = true;
			try {
				const session = target.session ?? api.uuid();
				const body = { requestId: api.uuid(), package: target.package, action, input, ...(target.session ? {} : { start: true }) };
				const path = `/api/sessions/${encodeURIComponent(session)}/proposals`;
				const answer = await api.send(path, body).catch(() => api.send(path, body)).catch(() => {
					throw new Error("Could not reach Paca. Open the session list to see whether the proposal arrived.");
				});
				if (!answer.ok || !answer.body?.session) throw new Error(answer.body?.error ?? "That didn’t work. Try again.");
				api.go(`/?session=${encodeURIComponent(answer.body.session)}`);
			} finally {
				proposing = false;
			}
		},
		href,
		navigate: (page: string, params?: Record<string, string>) => api.go(href(page, params)),
	});
}

export function createMounts<C>(deps: MountDeps<C>) {
	const slots = new Map<string, Slot<C>>();
	let page: { key: string; slot: Slot<C> } | undefined;
	const modules = new Map<string, Promise<BrowserExtension | undefined>>();
	const warned = new Set<string>();
	const warnOnce = (key: string, message: string) => {
		if (warned.has(key)) return;
		warned.add(key);
		deps.warn(message);
	};
	const newSlot = (container: C): Slot<C> => ({ container, controller: new AbortController() });

	function moduleOf(pkg: string) {
		let loading = modules.get(pkg);
		if (!loading) {
			loading = Promise.resolve()
				.then(() => deps.load(pkg))
				.then(
					(module) => (module ?? {}) as BrowserExtension,
					(error: unknown) => {
						warnOnce(pkg, `paca: extension ${pkg} could not be loaded: ${(error as Error)?.message ?? error}`);
						return undefined;
					},
				);
			modules.set(pkg, loading);
		}
		return loading;
	}

	/** Mounts with the package's `kind` mount from `group`, or calls `fail` once the module or mount fails. */
	async function mount(slot: Slot<C>, pkg: string, group: "cards" | "pages", kind: string, run: (fn: Function, context: HostContext) => Mounted, context: () => HostContext, fail: () => void) {
		const module = await moduleOf(pkg);
		if (slot.gone) return;
		if (!module) return fail();
		const fn = module[group]?.[kind];
		const what = `${group === "cards" ? "card" : "page"} ${kind}`;
		if (typeof fn !== "function") {
			warnOnce(`${pkg}.${group}.${kind}`, `paca: extension ${pkg} has no mount for ${what}`);
			return fail();
		}
		try {
			const mounted = run(fn, context());
			if (typeof mounted?.dispose !== "function") throw new Error("mount returned no dispose()");
			slot.mounted = mounted;
		} catch (error) {
			warnOnce(`${pkg}.${group}.${kind}`, `paca: extension ${pkg} ${what} failed: ${(error as Error)?.message ?? error}`);
			fail();
		}
	}

	function dispose(slot: Slot<C>) {
		slot.gone = true;
		slot.controller.abort();
		try {
			slot.mounted?.dispose();
		} catch (error) {
			deps.warn(`paca: an extension's dispose failed: ${(error as Error)?.message ?? error}`);
		}
		deps.remove(slot.container);
	}

	return {
		/** The card's container, made and mounted the first time its id is seen. `session` is the card's. */
		container(card: CardRef, session?: string): C {
			let slot = slots.get(card.id);
			if (!slot) {
				const s = newSlot(deps.create(card));
				slot = s;
				slots.set(card.id, s);
				const context = () => deps.context({ package: card.package, session }, s.controller.signal);
				if (deps.available(card)) void mount(s, card.package, "cards", card.kind, (fn, ctx) => fn(s.container, { id: card.id, data: card.data, createdAt: card.createdAt, context: ctx }), context, () => deps.fallback(s.container, card, true));
				else deps.fallback(s.container, card, false);
			}
			return slot.container;
		},
		/** Disposes every card whose id is not in `ids`: all of them on navigation. */
		retain(ids: ReadonlySet<string>) {
			for (const [id, slot] of [...slots]) {
				if (ids.has(id)) continue;
				slots.delete(id);
				dispose(slot);
			}
		},
		/** The page's container, mounted when its key differs from the page shown before, which is disposed. */
		page(ref: PageRef): C {
			if (page?.key === ref.key) return page.slot.container;
			this.closePage();
			const s = newSlot(deps.createPage(ref));
			page = { key: ref.key, slot: s };
			const context = () => deps.context({ package: ref.package, session: ref.session }, s.controller.signal);
			if (deps.pageAvailable(ref)) void mount(s, ref.package, "pages", ref.page, (fn, ctx) => fn(s.container, { params: Object.freeze({ ...ref.params }), context: ctx }), context, () => deps.pageFallback(s.container, ref, true));
			else deps.pageFallback(s.container, ref, false);
			return s.container;
		},
		/** Disposes the page, if one is shown. */
		closePage() {
			const shown = page;
			page = undefined;
			if (shown) dispose(shown.slot);
		},
		/** How many cards are on the page. */
		get size() {
			return slots.size;
		},
	};
}
