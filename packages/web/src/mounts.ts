// The page's registry of mounted extension cards, keyed by card id. A card is mounted once, when
// its id first appears in the page state, and disposed once, when its id leaves it or the page
// navigates. SSE updates, reconnects and restarts replay the same ids, so nothing remounts and a
// focused element inside a card keeps its focus. DOM-free: the page injects how to make and remove
// containers and how to load a package, so `node --test` runs this on the TypeScript source.
import type { CardRef } from "@paca/contracts";
import type { BrowserExtension, HostContext, Mounted } from "@paca/extension/browser";

export interface MountDeps<C> {
	/** Whether this user's page lists the card's package with its kind; otherwise it shows the fallback. */
	available(card: CardRef): boolean;
	/** Imports a package's entry, with its styles. Called at most once per package. */
	load(pkg: string): Promise<unknown>;
	/** A new, empty container for the card. */
	create(card: CardRef): C;
	/** Shows the card's fallback text in its container; `failed` when the frontend broke. */
	fallback(container: C, card: CardRef, failed: boolean): void;
	/** Takes the container off the page. */
	remove(container: C): void;
	/** A new context for one mount. */
	context(card: CardRef): HostContext;
	warn(message: string): void;
}

interface Slot<C> {
	container: C;
	mounted?: Mounted;
	/** Set on dispose; a load that finishes afterwards mounts nothing. */
	gone?: boolean;
}

export function createMounts<C>(deps: MountDeps<C>) {
	const slots = new Map<string, Slot<C>>();
	const modules = new Map<string, Promise<BrowserExtension | undefined>>();
	const warned = new Set<string>();
	const warnOnce = (key: string, message: string) => {
		if (warned.has(key)) return;
		warned.add(key);
		deps.warn(message);
	};

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

	async function mount(card: CardRef, slot: Slot<C>) {
		const module = await moduleOf(card.package);
		if (slot.gone) return;
		if (!module) return deps.fallback(slot.container, card, true);
		const mountCard = module.cards?.[card.kind];
		if (typeof mountCard !== "function") {
			warnOnce(`${card.package}.${card.kind}`, `paca: extension ${card.package} has no mount for card ${card.kind}`);
			return deps.fallback(slot.container, card, true);
		}
		try {
			const mounted = mountCard(slot.container as unknown as HTMLElement, { id: card.id, data: card.data, createdAt: card.createdAt, context: deps.context(card) });
			if (typeof mounted?.dispose !== "function") throw new Error("mount returned no dispose()");
			slot.mounted = mounted;
		} catch (error) {
			warnOnce(`${card.package}.${card.kind}`, `paca: extension ${card.package} card ${card.kind} failed: ${(error as Error)?.message ?? error}`);
			deps.fallback(slot.container, card, true);
		}
	}

	function dispose(id: string, slot: Slot<C>) {
		slots.delete(id);
		slot.gone = true;
		try {
			slot.mounted?.dispose();
		} catch (error) {
			deps.warn(`paca: a card's dispose failed: ${(error as Error)?.message ?? error}`);
		}
		deps.remove(slot.container);
	}

	return {
		/** The card's container, made and mounted the first time its id is seen. */
		container(card: CardRef): C {
			let slot = slots.get(card.id);
			if (!slot) {
				slot = { container: deps.create(card) };
				slots.set(card.id, slot);
				if (deps.available(card)) void mount(card, slot);
				else deps.fallback(slot.container, card, false);
			}
			return slot.container;
		},
		/** Disposes every card whose id is not in `ids`: all of them on navigation. */
		retain(ids: ReadonlySet<string>) {
			for (const [id, slot] of [...slots]) if (!ids.has(id)) dispose(id, slot);
		},
		/** How many cards are on the page. */
		get size() {
			return slots.size;
		},
	};
}
