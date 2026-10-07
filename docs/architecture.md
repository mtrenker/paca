# Architecture

Paca is one Node process that serves a web page, keeps one private conversation per user and
offers the model tools from trusted tool packages. This page records the decisions that are not
obvious from the code ([#9](https://github.com/mtrenker/paca/issues/9)).

## Packages

An npm workspace under `packages/`:

| Package | What it holds |
| --- | --- |
| `@paca/api` | The server: sign-in, users, conversations, approvals, limits, HTTP and SSE routes |
| `@paca/web` | The page: HTML, CSS and `app.ts`, compiled to `dist/app.js` for the browser |
| `@paca/contracts` | Types the API and the page both use: page state and session info. Types only |
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
- **One store per user.** Each user has their own Pi Durable harness and SQLite file, so their
  conversation, stream, drafts and approvals are separate files and separate commit lines. A
  draft id from another user is simply not found. Per-answer limits are per user.
- **Tool packages are instantiated per user** with that user's identity and settings, including
  their own GitHub credential and repository scope. The model only sees tools bound to the user
  whose conversation it runs in.
- **GitHub access is per user.** A user gets GitHub tools only with their own token
  (`github.tokenEnv`), or when the operator grants them the server's `gh` login explicitly
  (`github.serverLogin: true`). The server login is not a default for everyone. Child processes
  never inherit `PACA_*` variables, so one user's token does not reach another user's `gh`.

## Pre-refactor data stays with the operator

The single-user data has no owner field; it belonged to whoever `oidc.allowedSubject` named. It
stays exactly where and as it is: the user marked `"operator": true` (in an old config, the
`allowedSubject`) uses `<data>/paca.sqlite`. Every other user gets `<data>/users/<id>/paca.sqlite`,
created empty. No file moves and no stored format changes, so there is no migration to recover
from, and the previous image can still open the operator's data. The only addition to stored
drafts is an optional `action` field; a draft without it is a GitHub issue draft, as before.

## Tool packages

A tool package is a trusted npm package installed with Paca whose default export is
`defineToolPackage({ name, forUser })` from `@paca/extension`. The config lists enabled packages
by name (`extensions`); nothing else is loaded, and paths are refused. Packages run as server
code with the server's privileges: they are trusted, not sandboxed.

`forUser` receives the host-authenticated user (their id and whether they are the operator), the
package's settings and that user's settings,
and returns Pi Durable tools and prompt sections plus labels for the page. Tools run through Pi
Durable's own extension mechanism (`defineExtension`), with Paca's run limits and tool allowlist
as hooks around them.

Writes are not tools. A package declares named write actions; its tools may only **propose** one
through the host. A proposal is a target, a title and a body, shown exactly on the card, plus
optional `expect` facts the action checks before writing, such as which agent the user saw. The
host stores the exact proposal, shows it as a card, and on approval claims it in one commit before
calling the package's action once. The action reports `created` (it happened: an issue was
created, a prompt was submitted; a link is optional), `failed` (nothing was written) or `unknown`;
anything it throws counts as `unknown`, which is never sent again. Duplicate protection, exact
content and outcomes stay host code. The page words a card by its action; stored drafts keep the
field name `repository` for the target, so existing drafts are unchanged.

A minimal package, `@example/paca-clock`, installed as a workspace package or npm dependency and
enabled with `"extensions": { "@example/paca-clock": {} }`. Users get it only with settings under
its name, for example `"clock": { "timeZone": "Europe/Vienna" }`:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { defineToolPackage } from "@paca/extension";

export default defineToolPackage<{}, { timeZone: string }>({
	name: "clock",
	forUser: ({ userSettings }) =>
		userSettings && {
			tools: [
				defineTool({
					name: "current_time",
					description: "The current date and time in the user's time zone.",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: new Date().toLocaleString("en-GB", { timeZone: userSettings.timeZone }) }] }),
				}),
			],
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
never gets a shared database or another user's directory, and it never stores its data in the
chat state. Until then, packages get only a per-user cache directory for files they can
regenerate.
