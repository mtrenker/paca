// What a tool package's browser entry exports, and what the page gives it. Types only: import
// them with `import type`. This file sits outside src/ because the server's tsconfig has no DOM.
// See docs/architecture.md#frontends.
//
// The entry is a native ES module the page imports from the package's own directory, under the
// page's unchanged Content-Security-Policy: no inline <style> or style="" markup (linked CSS and
// element.style writes work), no eval or runtime template compilers, no inline event attributes,
// same-origin images only, and no bare import specifiers or import maps. Bundle the framework.

/** What the page tells one mounted card about where it is. Each mount gets its own. */
export interface HostContext {
	/** The package's name, such as "github". */
	readonly package: string;
	/** The session the card belongs to. */
	readonly session?: string;
}

export interface Mounted {
	/** Called once, when the card leaves the page. The page removes the container afterwards. */
	dispose(): void;
}

/**
 * Renders one card into `container`, an element the page owns and never detaches while the card
 * is shown, with class "ext ext-<package>". Everything inside it is the package's. Card data never
 * changes, so there is no update: the page mounts a card once and disposes it once.
 */
export type CardMount = (container: HTMLElement, card: { readonly id: string; readonly data: unknown; readonly createdAt: string; readonly context: HostContext }) => Mounted;

/** The entry module's default export: a mount for every card kind the manifest declares. */
export interface BrowserExtension {
	readonly cards?: Readonly<Record<string, CardMount>>;
}
