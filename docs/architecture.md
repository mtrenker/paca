# Architecture

Paca is one Node process that serves a web page, keeps private saved sessions per user and
offers the model tools from trusted tool packages. This page records the decisions that are not
obvious from the code ([#9](https://github.com/mtrenker/paca/issues/9)).

## Packages

An npm workspace under `packages/`:

| Package | What it holds |
| --- | --- |
| `@paca/api` | The server: sign-in, users, sessions, approvals, limits, HTTP and SSE routes |
| `@paca/web` | The page: HTML, CSS and `app.ts`, compiled to `dist/app.js` for the browser |
| `@paca/contracts` | Types the API and the page both use: page state, the session list and sign-in info. Types only |
| `@paca/extension` | The tool package contract: types and `defineToolPackage`; browser types in `@paca/extension/browser` |
| `@paca/extension-github` | The GitHub tool package: Projects overview, issue reads, search, issue drafts, and the issue card (`browser/`) |
| `@paca/extension-herdr` | The Herdr tool package, operator only: agent list, screen reads, prompt proposals ([Herdr agents](herdr.md)) |

The split is in code, not in services: the API serves the page from `@paca/web`, and the
container still runs one process. Server code, credentials and tool results never reach the
browser bundle; the page imports types only. A tool package's browser code is a separate module
the page loads at run time ([Frontends](#frontends)).

TypeScript runs without a build step on the server: Node 24 strips types, so sources use only
erasable syntax (no enums, namespaces or parameter properties). `npm run typecheck` checks every
package with `tsc`; `npm run build` compiles the page and the GitHub package's browser entry. Tests stay plain `node --test` files.
`npm run preview` runs the whole app with two synthetic users and fakes (see CONTRIBUTING.md).

## Users and isolation

- **Identity comes from the host.** A user is an entry in `config.json` (`users`), matched by
  the OIDC issuer and subject of the signed session cookie. Nothing a model or a page sends can
  name a user.
- **One directory per user.** Everything of a user is under `users/<id>/`: `paca.db` (session
  list, request ids, drafts, deletion state), one Pi session file per session in `sessions/`, and
  an empty Pi agent directory, `pi/`. The operator's is there too. A session id is only ever
  looked up among the signed-in user's rows, so another user's id, or a draft id from another
  session, is simply not found.
- **Sessions are independent.** Each session in use has its own `AgentSession`, so sessions
  answer at the same time, each with its own Stop and per-answer limits. There is no cap on how
  many of a user's sessions answer at once.
- **Pi finds nothing on disk.** Paca builds each `AgentSession` with every discovery flag of Pi's
  loader off, in-memory settings, the empty `pi/` directory and Paca's own system prompt, and
  allows only the tools of the user's packages (`agent.ts`). Pi's loader still reloads settings
  and resolves packages with discovery off, so `agent.test.js` pins the active tools and the
  prompt against decoy files.
- **Tool packages are instantiated per user** with that user's identity and settings, including
  their own GitHub credential and repository scope. A user's sessions share these tools. The
  model only sees tools bound to the user whose session it runs in.
- **GitHub access is per user.** A user gets GitHub tools only with their own token
  (`github.tokenEnv`), or when the operator grants them the server's `gh` login explicitly
  (`github.serverLogin: true`). The server login is not a default for everyone. Child processes
  never inherit `PACA_*` variables, so one user's token does not reach another user's `gh`.

## Sessions, drafts and deletion

The rules that must not be broken by two requests at once are single statements in `paca.db`
(`store.ts`), checked and written without an `await` in between (`sessions.ts`):

- A question is admitted once per request id, and only while its session is active and not
  answering; anything else answers 409 or is a duplicate.
- A draft is claimed for its one write with `UPDATE ... WHERE status = 'proposed'` while its
  session is active. A claimed write that never got its outcome becomes `unknown` at the next
  start and is never sent again.
- A delete is refused while the session answers or one of its drafts is being created. It marks
  the row `deleting`, ends open streams with `gone`, disposes the `AgentSession`, removes the file
  and any retained legacy copy, then deletes the rows. The row keeps the id reserved until then,
  and every step after the mark can run again: a second delete or the next start finishes one
  that failed. Deleting never calls GitHub.

The transcript is in the session file, apart from these rows. A crash between admitting a
question and writing it to the file makes the retry a no-op; the user sees the question missing.
[The design record](design/multi-session.md) has the full contract, the accepted risks and the
choice of the Pi SDK over Pi Durable.

## Conversations from before multiple sessions

Earlier versions kept one Pi Durable store per user, `<data>/paca.sqlite` for the operator and
`users/<id>/paca.sqlite` for others. Before the server listens, start-up folds each store's WAL,
moves it to `users/<id>/legacy/<session id>.sqlite`, reads it into one session file, and writes
its drafts and session row in one transaction (`legacy.ts`). The old paths are empty afterwards,
so a previous image started on the same data finds no draft to approve again. A store without
messages or drafts moves to `legacy/empty-<time>.sqlite`. Data written before multi-user support
has no owner field; it belonged to the operator and becomes one of the operator's sessions.

## Tool packages

A tool package is a trusted npm package installed with Paca whose default export is
`defineToolPackage({ name, forUser })` from `@paca/extension`. The config lists enabled packages
by name (`extensions`), and paths are refused; the only other packages are
[local extensions](#local-extensions) in the data folder. Packages run as server code with the
server's privileges: they are trusted, not sandboxed.

`forUser` receives the host-authenticated user (their id and whether they are the operator), the
package's settings and that user's settings, the APIs it may call as that user
([APIs called as the user](#apis-called-as-the-user)), and returns Pi tools (`defineTool` from
`@earendil-works/pi-coding-agent`), facts for the system prompt, and labels for the page. Paca
gives these tools to each `AgentSession` as its only tools; its run limits sit around them in an
inline extension and at the session's stream function.

Writes are not tools. A package declares named write actions; its tools may only **propose** one
through the host, passing the tool call's id and context. A proposal is a target, a title and a
body, shown exactly on the card, plus optional `expect` facts the action checks before writing,
such as which agent the user saw. The host stores the exact proposal under the session the tool
runs in, shows it as a card, and on approval claims it in one update before calling the package's
action once. The action reports `created` (it happened: an issue was created, a prompt was
submitted; a link is optional), `failed` (nothing was written) or `unknown`; anything it throws
counts as `unknown`, which is never sent again. Duplicate protection, exact content and outcomes
stay host code. The page words a card by its action; the store keeps the column name
`repository` for the target, and `expect` is a JSON column added to existing stores at start, so
existing drafts are unchanged.

A minimal package, `@example/paca-clock`, installed as a workspace package or npm dependency and
enabled with `"extensions": { "@example/paca-clock": {} }`. Users get it only with settings under
its name, for example `"clock": { "timeZone": "Europe/Vienna" }`:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { defineToolPackage } from "@paca/extension";

export default defineToolPackage<{}, { timeZone: string }>({
	name: "clock",
	forUser: ({ userSettings }) =>
		userSettings && {
			tools: [
				defineTool({
					name: "current_time",
					label: "Current time",
					description: "The current date and time in the user's time zone.",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: new Date().toLocaleString("en-GB", { timeZone: userSettings.timeZone }) }], details: undefined }),
				}),
			],
			prompt: `The user's time zone is ${userSettings.timeZone}.`,
			labels: { current_time: { label: () => "Read the clock" } },
			scope: { label: "Clock", detail: userSettings.timeZone },
		},
});
```

The Paca persona (how to rank work, how to treat terminal output, how to answer on a phone) is
the API's prompt, not part of the packages, so they stay generic sets of scoped tools. Each part
of it appears only for a user with that package's tools.

## Frontends

A tool package may also ship browser code that renders **cards** in the chat and **pages** of the
web app, with one link in the side list, and its pages may propose exact writes for the user's
approval ([#17](https://github.com/mtrenker/paca/issues/17)). The package stays trusted and
installed by the operator; its browser code runs with the page's full authority. An extension's
author picks the framework: the GitHub package uses plain DOM, and a test-only Preact fixture
proves a framework bundle meets the same contract (below).

- **Manifest.** `defineToolPackage({ browser: { dir, entry, styles, cards, pages, nav } })`: a
  file URL of a directory inside the package, the ES module to import and the stylesheets to link
  (relative to `dir`), the card kinds, the pages with their titles, and one side-list link to a
  page that needs no parameters. It is declared in code, never taken from a tool's output. At start
  `extensions.ts` checks it, and a malformed manifest refuses the start. It then lists `dir` once
  into a fixed map of `.js`, `.css` and `.svg` files (no dotfiles or symlinks, at most 200 files
  and 5 MiB). Missing built files log one line and turn that frontend off; `disableFrontends` in
  the config does the same on purpose. Either way the tools keep working, and the package's
  assets, operations and nav link are gone.
- **Serving.** `GET /ext/<package>/<path>` answers only a signed-in user whose page lists the
  package (`SessionInfo.extensions`: packages that gave this user tools and whose frontend is on),
  and only for a path in the map; the path is a key, never resolved on disk, so traversal, encoded
  dots and unlisted files answer 404. Without a sign-in it answers 401. The Content-Security-Policy
  is unchanged: same-origin `import()` passes `script-src 'self'` and linked CSS passes
  `style-src 'self'`. So browser code ships as a bundled ES module with relative imports only, and
  uses no inline styles or event attributes, `eval` or remote resources.
- **Cards.** A tool calls the host's `show(toolCallId, ctx, { kind, data, fallback })`, beside
  `propose`. The host checks the card synchronously (a declared kind, a plain JSON object of at
  most 1 KiB, 1 to 200 characters of fallback text with an optional `https:` link, at most 8 per
  tool call) and a card outside those bounds fails the tool call. It is stored in the user's
  `paca.db` (`cards`) under the session and tool call, never updated, and deleted with the
  session's rows. The page state attaches each card to its tool call's turn; a card whose call is
  not in the branch is dropped. Raw tool results still stay on the server: the projection is a
  deliberate, bounded exception. A card is a snapshot of what Paca read, labeled with the time.
- **Rendering.** The page keeps turns by id, so updates rebuild a turn's text around a container
  for its cards that is never detached. A registry (`packages/web/src/mounts.ts`) mounts each card
  once by id into an element with class `ext ext-<package>`, and disposes it once when its id
  leaves the state or the page navigates; reconnects and restarts replay the same ids, so nothing
  remounts and focus inside a card survives an answer streaming. A package's module and styles
  load the first time one of its cards is shown. Without the package, or when its module or mount
  fails, the card shows its fallback text, and failures go to the browser console only.
- **Pages and navigation.** A page is a URL: `/?page=<package>.<page>&session=<id>&<params>`.
  `page`, `session` and `new` are reserved, and every other parameter goes to the page. `GET /`
  serves the page for any query, so a refreshed or bookmarked page URL works. The side list shows
  each package's nav link above Sessions (on a phone, on the list screen), carrying the open
  session so a page's links stay with it; without an open session it carries none. A page shows
  the manifest's title as its `<h1>`, which takes focus after navigation, then the package's
  container, with "Back to session" while its session exists; the composer is hidden. At most one
  page is mounted, keyed by its URL, and disposed when the user navigates away. Plain clicks on
  same-origin links marked `data-paca-nav` navigate in place; an unknown page, or a package not
  enabled for the user, shows "This page isn't available."
- **Operations.** Pages read fresh data through named reads a package returns from `forUser`
  (`operations`), so they close over that user's credential and scope like the tools. The browser
  calls `POST /api/ext/<package>/<op>` with a JSON object of at most 16 KiB, through the usual
  Origin and CSRF checks, and only for a package the user's page lists. The host aborts an
  operation after 25 seconds (504) and refuses an answer over 512 KiB (502), logging one line for
  either. An `OperationError` reaches the page with its status and message; anything else thrown
  is a 500 with one log line naming the user. Operations only read; writes stay proposals.
- **Page proposals.** A page can propose an exact write without the model: `context.propose(action,
  input)` posts to `/api/sessions/<id>/proposals`. Only an action whose package declares both a
  builder (`proposals`, which validates the input and the user's scope and never writes) and a
  write accepts it; in this work that is GitHub's `create_issue`, built by the same function as
  `draft_issue`. The host checks the built proposal (plain strings, at most 128 KiB, the route's
  own body bound) and admits it in one `paca.db` transaction as the draft `page:<requestId>`:
  the request id is looked up across the user's whole store first, so a repeat, or a retry that
  names another new session, answers with the stored draft, and changed content is a 409.
  Otherwise the draft goes into the open session while it is active, or, with no session open,
  into a new session made in the same transaction ("GitHub: <title>", no file until it is
  opened). The page fixes both ids before its one retry. From there the existing approval card,
  claim, write and `unknown` recovery take over; a delete marked first refuses the proposal, and
  one marked after removes the draft unapproved. A page draft shows in its own turn, before the
  first question asked after it, with "Proposed from a page, not by Paca."; the model is not told.
- **Browser contract.** `@paca/extension/browser` holds types only: the entry's default export
  maps each card kind to `mount(container, { id, data, createdAt, context })` and each page to
  `mount(container, { params, context })`, which return `{ dispose() }`. `context` is per mount:
  `call(op, input)` for operations (aborted when the mount is disposed), `propose(action, input)`
  (not aborted: a sent proposal may be stored), and `href` and `navigate` for the package's own
  pages, keeping the session. The extension owns everything inside the
  container; its CSS is scoped under `.ext-<package>` and may use the page's custom properties.
- **Framework proof.** `test/fixtures/extension-preact` is a Preact package bundled by esbuild,
  never installed or shipped. `npm run test:browser` drives Chrome with `puppeteer-core` against
  the real server and page: its card keeps Preact state and focus across updates and is disposed
  once, its page calls an operation through the host, and nothing violates the CSP.

## Local extensions

Private tool packages in the data folder, written outside Paca's repository, for example by Pi
([#19](https://github.com/mtrenker/paca/issues/19); the author's guide is
[Local extensions](local-extensions.md)). `local-extensions.ts` reads them once at start:
`<data>/local-extensions/<name>/` for every configured user, `<data>/users/<id>/local-extensions/<name>/`
for that user only. The decisions:

- **Same contract, same trust.** A local extension is a `defineToolPackage` default export like an
  installed package, with tools, writes as proposals, operations and an optional prebuilt
  frontend checked by the same code (`checkPackage` in `extensions.ts`). It is not sandboxed or
  reviewed. Its package `settings` are `undefined`; `userSettings` is `users[].<name>`, from the
  user's own keys only.
- **Restart to update.** An edit takes effect at the next start, and the page needs a reload.
  There is no watcher, reload signal or session rebuild; Martin accepted the manual restart.
  `npm run check-extensions` loads and binds the tool packages as a start would, in a new
  process, to check an edit first; it runs the extensions' code but checks nothing else of a start.
- **Skipped, not fatal.** A local extension that fails to load, collides or has a malformed
  manifest is skipped with one log line, and one whose `forUser` throws, returns a malformed
  result (tools need Pi's `name`, `label`, `description`, `parameters` and `execute`) or reuses a
  tool name is left out for that user; the start goes on. Installed packages
  keep refusing the start.
- **Names.** The folder name is the package name. Installed packages come first, then global and
  then personal extensions, each by folder name; a name belongs to the first package loaded with
  it, and a later one is skipped before its code is imported. Users' keys (`id`, `subject`,
  `operator`) and `paca` are refused.
- **Host imports.** `/data` has no `node_modules` above it, so a `module.registerHooks` resolve
  hook, acting only on imports from files under a loaded extension's folder, answers
  `@paca/extension`, `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` (and their
  subpaths) with the URLs Paca itself imports, also for `require`. So `OperationError` and Pi are
  the host's own (`instanceof` holds); every other import resolves as usual, from the
  extension's own `node_modules`. Paca never runs npm.
- **Frontends per user.** Each user's file map is their own (`UserHost.frontends`), not one map by
  package name, because two users' personal extensions may share a name, and so the URL
  `/ext/<name>/`, with different code.

## APIs called as the user

Extensions can call configured APIs as the signed-in user with the access token of their Paca
sign-in ([#21](https://github.com/mtrenker/paca/issues/21)). The contract, with what an API must
accept and why a separate connect flow was dropped, is [API access](design/api-access.md). The
decisions:

- **Paca's own token.** Sign-in asks for each configured API's scopes. `auth.ts` keeps the access
  token, refresh token, expiry and granted scopes; the ID token only identifies the user. The API
  must accept tokens issued to Paca's client.
- **One grant per user, in memory** (`api-access.ts`), from their latest sign-in, shared by their
  devices and sessions like their tools. It ends with that sign-in's 12-hour session, a sign-out
  on any device, a refused refresh or a restart; the page then shows **Sign in again** while the
  cookie still signs the user in. Nothing is persisted, so there is no key to keep.
- **Allowlisted twice.** A user gets an API only when their entry lists it, and an extension only
  when the API lists the extension. `forUser` receives `apis` with `state()` and `request()`;
  the token never reaches the extension, the model, the page or the logs.
- **Requests stay put.** Only paths below the configured URL; no redirects followed; reads retry
  once after a 401 with a refreshed token, writes never. One refresh per user at a time. Headers
  are Paca's, apart from a checked `If-Match` (`ifMatch`, one strong version) on a write.
- **Approvals wait.** A write action may answer `ready` before the claim; the example refuses
  while the user must sign in again, and the draft stays proposed. After the claim, a missing
  grant fails the write before sending; anything that may have reached the API is `unknown`.
- **Example.** `test/fixtures/extension-downstream` (`example-notes`) reads and proposes notes in
  the fake Example API (`test/container/fake-api.mjs`); the preview, tests and container check
  load it as a local extension.

## Future extension storage (not built)

A later package, such as a habit or workout tracker, will need its own data. The constraint for
that work: the host creates a private directory per package and user,
`<data>/extensions/<package>/users/<user id>/` (mode 0700), and passes it to `forUser`. A package
never gets a shared database or another user's directory, and it never stores its data in a
session file. Until then, packages get only a per-user cache directory for files they can
regenerate.
