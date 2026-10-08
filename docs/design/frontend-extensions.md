# Frontend extensions: implementation decisions

The reviewed design contract is in [#17](https://github.com/mtrenker/paca/issues/17). This file
records the choices made while building it that the contract left open or that differ in detail
from it, so a later increment or a reviewer does not have to rediscover them.
[Architecture](../architecture.md#frontends) describes what is built.

## Increment 1: cards

Written by Claude Opus 5.5 on 2026-10-08, implementing increment 1 on top of `2af0fbe`. Pages,
navigation, operations, the framework fixture and page proposals are increments 2 and 3 and are
not built.

| # | Decision | Why |
| --- | --- | --- |
| 1 | Shared types ship only what cards use (increment 2 added pages, nav, `call`, `href` and `navigate`; `propose` waits for increment 3). `BrowserManifest` has `dir`, `entry`, `styles` and `cards`; `ExtensionInfo` has `name`, `entry`, `styles` and `cards`; `HostContext` has `package` and `session`; `BrowserExtension` has `cards`. Increments 2 and 3 add `pages`, `nav`, `call`, `href`, `navigate` and `propose` as the contract defines them | Each addition is additive and every consumer is in this repository, so nothing unused ships and nothing changes shape later |
| 2 | Until the issue page exists, the issue card's title links to the issue on GitHub (`rel="noreferrer"`, new tab). Increment 2 points it at the issue page through `context.href` (done; "Open on GitHub" is on the issue page) | The contract's card links to the issue page, which is increment 2 |
| 3 | The card shows the clock time Paca read the issue ("Read 08:51", or a date), not "5 min ago" | A card is mounted once and never re-rendered, so a relative time would go stale on an open page |
| 4 | `/ext/` answers 404 for any path with dot segments, even one that would resolve to a listed file of the same package: the raw request path must equal the parsed one | The contract says traversal answers 404; the URL parser would otherwise resolve `dist/../app.css` before the lookup |
| 5 | A manifest whose `dir` is the package root itself is malformed. The file map skips symlinks. More than 200 files or 5 MiB refuses the start, like a malformed manifest | The root would list the whole package; a symlink could leave `dir`; the limits are a packaging error, not a missing build |
| 6 | A card for a session that is not active is not stored, and `show` still returns: the insert is guarded by the session row, as `claim` is | A delete never leaves card rows behind; the tool is being aborted anyway |
| 7 | `GitHubAccess` gains a structured `issue(repository, number)`; `read_issue` formats its text with the unchanged `formatIssue` and builds the card from the same read, one `gh` call. `readIssue` stays on the client. `githubTools(github, propose, show?)` takes `show` as an optional third argument | The model's text is unchanged; stubs and callers without cards keep working |
| 8 | `SessionsOptions.tools` receives `showFor(packageName, kinds)` as a second argument, beside `proposeFor` | Additive: existing callers and tests pass one argument unchanged |
| 9 | The page is two modules, `app.js` and `mounts.js`, served as fixed static files | The registry is tested on its TypeScript source with `node --test`, so it is its own file |
| 10 | `npm run ask` drops cards and silences frontend log lines | It prints the answer on stdout and has no page |
| 11 | Preview: the fake `gh` answers `issue view` with a synthetic issue (every third one closed); the fake model reads an issue named as `owner/name#<n>` and streams that answer over four times the model delay; `PACA_PREVIEW_FRONTENDS=off` sets `disableFrontends` with its own data directory | Shows the card while an answer streams, and the fallback, without real GitHub or a restart of the main preview |

Checked at the increment 1 stopping point: `npm run typecheck`, `npm run build`, `npm test` and
`npm run test:container` (image built from a umask-022 copy of the checkout, as
[Test the image](../container.md#test-the-image) asks), plus the synthetic preview in Chromium:
the card appeared before the answer started, stayed the same DOM node with no mutations while
the answer streamed for about 16 seconds, kept keyboard focus on its link, survived a reload, and
caused no CSP violations; with the frontend off it showed its fallback text and `/ext/github/`
answered 404.

## Increment 2: pages, navigation and the framework proof

Written by Claude Opus 5.5 on 2026-10-08, after Martin accepted the cards checkpoint. Page
proposals and the follow-up form are increment 3 and are not built: `HostContext` has no
`propose`, and no package declares `proposals`.

| # | Decision | Why |
| --- | --- | --- |
| 1 | The GitHub home page keeps its search in the page, not in the URL. Refreshing it shows recent open issues again; every result links to its issue page, whose URL is a deep link | A search is not a navigation: it should not remount the page or move focus to the title, which navigation does. Extensions get no history API beyond `navigate` |
| 2 | One page is mounted at a time, keyed by its URL (page, session and sorted parameters). The same URL keeps the mount; any other URL disposes it first. `document.title` becomes "<title> · Paca", and the transcript's `aria-live` is off on a page | Matches the card registry's mount-once rule and keeps a page from being announced as a live region |
| 3 | "Back to session" shows only while the page's session is still in the list; otherwise the header's Back (on a phone) leads to the list | The contract's "page whose session was deleted": the page works, and Back goes to the list |
| 4 | Nav links are created once and only their `href` and `aria-current` change; the session list around them is rebuilt as before | A keyboard user's focus on the nav link survives the session list's SSE updates |
| 5 | A page title has 1 to 60 characters, like a nav label has 1 to 24; an unknown or malformed page name shows the unavailable notice | Bounds the page frame's heading; the failure model treats an unknown page as unavailable |
| 6 | The operation route takes the user's operation through `RouteUser.operation(package, op)` (an own-property lookup, so `constructor` or `__proto__` find nothing) and logs with `RouteUser.id`. The operation's signal also aborts when the browser goes away | Operations close over the user's `forUser` result; log lines name the user as the contract asks |
| 7 | GitHub operations: an out-of-scope repository is 404 "That repository is not in your GitHub scope."; `gh` saying an issue cannot be resolved is 404 "That issue does not exist."; any other `gh` failure is 502 "GitHub could not be read: …"; a bad number, a long search or a `repo:`-style qualifier is 400 | These are conditions the user can read and act on, so they are `OperationError`s and are not logged |
| 8 | Without a query, `issues` runs one `gh search issues --state open --sort updated --order desc --limit 20` over the scope | One call for all repositories, the same JSON fields and scope filter as the search |
| 9 | The browser check runs on Chromium locally through `CHROME_BIN`, at a 1280-pixel viewport, and waits for Preact 11's effect cleanup, which runs just after `render(null)` returns, before checking it ran exactly once | The contract's driver and steps; the side list is beside the session only on wide screens |
| 10 | The fixture's server entry is type-checked by the root `tsconfig.json`; its browser `tsconfig.json` only type-checks (`noEmit`), since esbuild bundles it | `npm run typecheck` covers the fixture as the contract asks, without a second emitter |
| 11 | The preview's fake `gh` answers `search issues` and the open-issue listing with 24 synthetic issues per repository, eight titles repeating, every third one closed | Enough to search, filter and scroll on a phone, without real GitHub |

Checked at the increment 2 stopping point: `npm run typecheck`, `npm run build`, `npm test`,
`npm run test:browser` (Chromium) and `npm run test:container`, plus the synthetic preview through
the tailnet in Chromium: a card opened its issue page in its session, the deep link survived a
reload, the nav carried the open session (and none from the list), a keyboard-only path searched
and opened a result with focus on the page title, history Back and "Back to session" worked, the
phone layout had no horizontal scroll, an out-of-scope deep link answered inline, and there were
no CSP violations. With the frontend off, the nav entry was gone, a GitHub page URL showed the
unavailable notice, and operations answered 404.
