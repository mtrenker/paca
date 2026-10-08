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
| 1 | Shared types ship only what cards use. `BrowserManifest` has `dir`, `entry`, `styles` and `cards`; `ExtensionInfo` has `name`, `entry`, `styles` and `cards`; `HostContext` has `package` and `session`; `BrowserExtension` has `cards`. Increments 2 and 3 add `pages`, `nav`, `call`, `href`, `navigate` and `propose` as the contract defines them | Each addition is additive and every consumer is in this repository, so nothing unused ships and nothing changes shape later |
| 2 | Until the issue page exists, the issue card's title links to the issue on GitHub (`rel="noreferrer"`, new tab). Increment 2 points it at the issue page through `context.href` | The contract's card links to the issue page, which is increment 2 |
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
