// What a tool package's browser entry exports, and what the page gives it. Types only: import
// them with `import type`. This file sits outside src/ because the server's tsconfig has no DOM.
// See docs/architecture.md#frontends.
//
// The entry is a native ES module the page imports from the package's own directory, under the
// page's unchanged Content-Security-Policy: no inline <style> or style="" markup (linked CSS and
// element.style writes work), no eval or runtime template compilers, no inline event attributes,
// same-origin images only, no bare import specifiers or import maps, and no direct fetch: use
// `context.call`. Bundle the framework.

/** What the page gives one mounted card or page. Each mount gets its own. */
export interface HostContext {
	/** The package's name, such as "github". */
	readonly package: string;
	/** The session the card or page belongs to, if any. Links made with `href` keep it. */
	readonly session?: string;
	/**
	 * Calls one of the package's operations (POST /api/ext/<package>/<op>) and resolves with its
	 * JSON. Rejects with Error(message) from the API's `error`, and when the mount is disposed.
	 */
	call(op: string, input?: Record<string, unknown>): Promise<unknown>;
	/**
	 * Submits an exact proposal of one of the package's write actions, which the host stores as a
	 * draft for the user's approval, in `session` or, without one, in a new session; then shows that
	 * session. Retried once on a network failure. Rejects with Error(message), and at once while a
	 * proposal of this mount is pending. Never aborted on dispose: a sent proposal may be stored.
	 */
	propose(action: string, input: Record<string, unknown>): Promise<void>;
	/** The URL of one of the package's pages. Put it on a link with `data-paca-nav` to open it in place. */
	href(page: string, params?: Record<string, string>): string;
	/** Opens one of the package's pages. */
	navigate(page: string, params?: Record<string, string>): void;
}

export interface Mounted {
	/** Called once, when the card or page goes away. The page removes the container afterwards. */
	dispose(): void;
}

/**
 * Renders one card into `container`, an element the page owns and never detaches while the card
 * is shown, with class "ext ext-<package>". Everything inside it is the package's. Card data never
 * changes, so there is no update: the page mounts a card once and disposes it once.
 */
export type CardMount = (container: HTMLElement, card: { readonly id: string; readonly data: unknown; readonly createdAt: string; readonly context: HostContext }) => Mounted;

/**
 * Renders one page into `container`, below the page frame's title. `params` are the URL's query
 * parameters other than page, session and new. Disposed once, when the user navigates away.
 */
export type PageMount = (container: HTMLElement, page: { readonly params: Readonly<Record<string, string>>; readonly context: HostContext }) => Mounted;

/** The entry module's default export: a mount for every card kind and page the manifest declares. */
export interface BrowserExtension {
	readonly cards?: Readonly<Record<string, CardMount>>;
	readonly pages?: Readonly<Record<string, PageMount>>;
}
