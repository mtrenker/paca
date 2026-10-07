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
| `@paca/extension` | The tool package contract: types and `defineToolPackage` |
| `@paca/extension-github` | The GitHub tool package: Projects overview, issue reads, search, issue drafts |
| `@paca/extension-herdr` | The Herdr tool package, operator only: agent list, screen reads, prompt proposals ([Herdr agents](herdr.md)) |

The split is in code, not in services: the API serves the page from `@paca/web`, and the
container still runs one process. Server code, credentials and tool results never reach the
browser bundle; the page imports types only.

TypeScript runs without a build step on the server: Node 24 strips types, so sources use only
erasable syntax (no enums, namespaces or parameter properties). `npm run typecheck` checks every
package with `tsc`; `npm run build` compiles the page. Tests stay plain `node --test` files.
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
by name (`extensions`); nothing else is loaded, and paths are refused. Packages run as server
code with the server's privileges: they are trusted, not sandboxed.

`forUser` receives the host-authenticated user (their id and whether they are the operator), the
package's settings and that user's settings, and returns Pi tools (`defineTool` from
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

## Future extension storage (not built)

A later package, such as a habit or workout tracker, will need its own data. The constraint for
that work: the host creates a private directory per package and user,
`<data>/extensions/<package>/users/<user id>/` (mode 0700), and passes it to `forUser`. A package
never gets a shared database or another user's directory, and it never stores its data in a
session file. Until then, packages get only a per-user cache directory for files they can
regenerate.
