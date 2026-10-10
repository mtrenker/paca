# Local extensions

A local extension is a private tool package that lives in Paca's data folder instead of its
repository: tools for the model, and optionally cards in the chat and pages in the app. You, or
an agent such as Pi, write it there; Paca loads it at its next start. Nothing is added to Git,
and the container image is not rebuilt ([#19](https://github.com/mtrenker/paca/issues/19)).

This guide is written so an agent can follow it. A local extension is **trusted server code**: it
runs inside Paca's process with Paca's privileges, files and credentials, like an installed
package. Paca does not sandbox, review or approve it. Write only code you would install.

Paca reads local extensions **once, at start**. After every change, restart Paca and reload the
web page ([Update](#update-restart-and-refresh)).

## Where they live

| Folder | Who gets it |
| --- | --- |
| `<data>/local-extensions/<name>/` | every configured user whose `forUser` returns tools |
| `<data>/users/<id>/local-extensions/<name>/` | only the configured user `<id>` |

`<data>` is `.data/` in the checkout for a direct run, `PACA_DATA_DIR` when that is set, and
`/data` in the container. Folders of users that are not in `config.json` are never read.

- A folder is enabled by being there. Rename it to start with a dot (`.dice`) to switch it off,
  or remove it. Files beside the folders are ignored.
- `<name>` is the extension's name: lowercase letters, digits and dashes, starting with a letter,
  and not `paca`, `id`, `subject`, `operator` or `apis`. It must equal the `name` given to
  `defineToolPackage`.
- `<data>/extensions/` is something else: it is reserved for packages' own data later
  ([Architecture](architecture.md#future-extension-storage-not-built)).

## A working example

`dice` gives the model one tool that rolls a die and shows the roll on a card, and adds a
**Dice** page with a button. It imports Paca's host packages, splits its code over two files,
reads a per-user setting and ships plain browser code that needs no build. Paca's tests, browser
check and container check run these exact files.

<!-- file: package.json -->
```json
{
  "name": "dice",
  "private": true,
  "type": "module"
}
```

<!-- file: index.ts -->
```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { defineToolPackage, OperationError } from "@paca/extension";
import { roll } from "./roll.ts";

/** This user's entry under "dice" in config.json; optional. */
interface DiceSettings {
	sides?: number;
}

const valid = (sides: unknown): sides is number => Number.isInteger(sides) && (sides as number) >= 2 && (sides as number) <= 100;

export default defineToolPackage<undefined, DiceSettings>({
	name: "dice",
	browser: {
		dir: new URL("./browser/", import.meta.url).href,
		entry: "index.js",
		styles: ["dice.css"],
		cards: ["roll"],
		pages: { home: { title: "Dice" } },
		nav: { label: "Dice", page: "home" },
	},
	forUser: ({ userSettings, show }) => {
		const sides = userSettings?.sides ?? 6;
		if (!valid(sides)) throw new Error("dice: sides must be a whole number from 2 to 100");
		return {
			tools: [
				defineTool({
					name: "roll_dice",
					label: "Roll dice",
					description: `Rolls the user's ${sides}-sided die once.`,
					parameters: Type.Object({}),
					execute: async (toolCallId, _args, _signal, _onUpdate, ctx) => {
						const value = roll(sides);
						show(toolCallId, ctx, { kind: "roll", data: { sides, value }, fallback: { text: `Rolled ${value} on a d${sides}` } });
						return { content: [{ type: "text", text: `Rolled ${value} on a d${sides}.` }], details: undefined };
					},
				}),
			],
			prompt: `The user's die has ${sides} sides.`,
			labels: { roll_dice: { label: () => "Roll a die" } },
			operations: {
				roll: async (input) => {
					const n = input.sides ?? sides;
					if (!valid(n)) throw new OperationError(400, "Choose 2 to 100 sides.");
					return { sides: n, value: roll(n) };
				},
			},
			scope: { label: "Dice", detail: `d${sides}` },
		};
	},
});
```

<!-- file: roll.ts -->
```ts
export function roll(sides: number) {
	return 1 + Math.floor(Math.random() * sides);
}
```

<!-- file: browser/index.js -->
```js
// Plain DOM, no build step: the page imports this file as it is.
const element = (tag, text, className) => {
	const el = document.createElement(tag);
	el.textContent = text;
	if (className) el.className = className;
	return el;
};

export default {
	cards: {
		roll(container, { data }) {
			container.append(element("p", `d${data.sides}: ${data.value}`, "dice-value"));
			return { dispose: () => container.replaceChildren() };
		},
	},
	pages: {
		home(container, { context }) {
			const button = element("button", "Roll a d20", "dice-roll");
			button.type = "button";
			const result = element("p", "", "dice-value");
			result.setAttribute("aria-live", "polite");
			button.addEventListener("click", async () => {
				try {
					const { value } = await context.call("roll", { sides: 20 });
					result.textContent = `You rolled ${value}.`;
				} catch (error) {
					result.textContent = error.message;
				}
			});
			container.append(button, result);
			return { dispose: () => container.replaceChildren() };
		},
	},
};
```

<!-- file: browser/dice.css -->
```css
.ext-dice .dice-value {
	font-size: 1.5rem;
	font-weight: 600;
}
```

Put the five files in `.data/local-extensions/dice/` (everyone) or
`.data/users/<id>/local-extensions/dice/` (one user), restart Paca and reload the page. Ask
"Roll a die": the answer shows a card with the roll. **Dice** in the side list opens the page.

To give one user a d20, add the setting to their entry in `config.json` and restart:

```json
{ "id": "<id>", "subject": "<subject>", "dice": { "sides": 20 } }
```

## The contract

A local extension is a tool package like the installed ones, so the
[tool package contract](architecture.md#tool-packages) and the
[frontend contract](architecture.md#frontends) apply unchanged. In short:

- **Entry.** `index.ts`, or `index.js` when there is no `index.ts`, beside a `package.json` with
  `"type": "module"`. Its default export is `defineToolPackage({ name, forUser, browser? })`.
- **`forUser`** runs once per configured user at start (only for its owner, for a personal one),
  with `user` (`id`, `operator`), `settings` (always `undefined` for a local extension),
  `userSettings` (that user's entry under `<name>` in `config.json`, or `undefined`), `cacheDir`,
  `propose`, `show` and `apis`. Return `undefined` to give this user nothing. Throw for invalid settings:
  the extension is then left out for that user only.
- **Tools** are Pi tools (`defineTool`) with a `name`, `label`, `description`, `parameters` (a
  schema such as `Type.Object({})`) and `execute`. They read. Paca's API has one way to write: a
  named action in `writes` that a tool or page only **proposes**; the user approves the exact
  card, and Paca calls the action once. That is the contract, not a barrier: an extension is
  trusted code and could write files or call services directly, so keep its writes behind
  proposals.
- **Operations** (`operations`) are reads for the extension's cards and pages, bound to the user
  like the tools. Throw `OperationError(status, message)` for an answer the page shows.
- **Browser code** is prebuilt: an ES module and stylesheets in a folder inside the extension,
  imported under the page's Content-Security-Policy (no inline styles or event attributes, no
  bare imports, no direct `fetch`). Plain DOM as above needs no build. A framework needs a
  bundle, which you build: see the Preact fixture in `test/fixtures/extension-preact/` and the
  `build:fixture` script in `package.json`. Types for browser code are in
  `packages/extension/browser/index.ts`: each card kind and page maps to a mount function.

Each user gets only their own extensions' tools, operations, cards and files. Two users can
each have a personal extension with the same name and different code: each one's page loads
their own.

## Calling an API as the user

An API behind Paca's own identity provider can be called with the user's sign-in access token,
when `config.json` lists it under `apis`, names your extension in its `extensions` and lists it in
the user's `apis` ([README](../README.md#configure), [the contract](design/api-access.md)).
`forUser` then gets it in `apis.<name>`:

```ts
const api = apis.notes;
if (!api) return undefined; // this user may not call it
// In a tool or operation: the token is added by Paca and never seen here.
const answer = await api.request("/notes", { signal });
// In a write action, after the user approved the exact proposal: sent once, never retried.
await api.request("/notes", { method: "POST", body: { text: proposal.body } });
```

- `api.state()` is `ready`, `sign-in` (the user must sign in to Paca again, after a restart or a
  sign-out) or `not-granted` (their sign-in lacks the API's scopes). Read it when you need it.
- `request` takes a path below the configured URL only, never follows a redirect, and answers
  `{ status, body }`. It throws `ApiError`: `sent: false` means nothing left Paca, so a write
  did not happen (`failed`); `sent: true` means it may have (`unknown`).
- Give your write action a `ready()` that returns why it cannot run now, such as a needed
  sign-in: the approval is then refused and the proposal waits.

The complete example is `test/fixtures/extension-downstream` in Paca's repository: a read tool,
a proposed note with its write action, and a page.

## Imports and dependencies

- **Paca's packages** `@paca/extension`, `@earendil-works/pi-ai` and
  `@earendil-works/pi-coding-agent` (and their subpaths) always resolve to Paca's own copies,
  wherever the data folder is, like peer dependencies. So `OperationError` is Paca's class and
  the tools are built with the Pi that runs them. Do not bundle copies of them; a copy in the
  extension's `node_modules` is ignored for these names. Paca uses Pi 1.0.3.
- **Your own dependencies** go in the extension's `package.json` and its own `node_modules`.
  Paca never runs `npm`: install them yourself, with Node 24 on linux/amd64 for the container.
  For the container volume, in a throwaway container (needs network access to the registry):

  ```sh
  docker run --rm -v paca-data:/data -w /data/local-extensions/<name> --entrypoint npm \
    ghcr.io/mtrenker/paca:<tag> install --omit=dev <dependency>
  ```

  A dependency is evaluated once per process, like the extension.
- **TypeScript** runs without a build: Node 24 or newer strips the types (the container has Node
  24.21). Use only erasable syntax: no `enum`, `namespace` or constructor parameter properties.
  Write relative imports with their extension (`./roll.ts`), and import types with
  `import type`. Paca does not type-check local extensions. Plain `.js` works too.

## Order, collisions and errors

Paca orders each user's packages as installed packages (in `config.json` order), then global
local extensions, then the user's own, each by folder name. A name belongs to the first package
that loads with it.

A local extension never stops Paca from starting. Whatever goes wrong is logged in one line, and
the extension is left out; everything else loads. The log lines to look for:

| Log line | Meaning and fix |
| --- | --- |
| `paca: local extension local-extensions/dice: loaded with its frontend` | Loaded; without a frontend it says `loaded` |
| `paca: user <id>: github, dice` | What `<id>` gets after binding (`<id> (operator)` for the operator) |
| `... skipped: the name "dice" is taken by <package>` | An installed package or a global extension has the name; rename the folder and `name` |
| `... skipped: it needs a package.json with "type": "module"` | Add or fix `package.json`; `(ENOENT)`, `(EACCES)` or `(not valid JSON)` says why it could not be read |
| `... skipped: ENOENT: ..., stat '...'` (or `ELOOP`, `EACCES`) | The folder is a link to nothing, a link loop, or cannot be searched |
| `... skipped: it needs an index.ts or index.js` | Add the entry file |
| `... skipped: has no default export from defineToolPackage()` | Export `defineToolPackage({ ... })` as the default |
| `... skipped: defineToolPackage names it "x"; use its directory name, "dice"` | Make `name` and the folder name equal |
| `... skipped: browser: <problem>` | Fix the manifest; the problem names the field |
| `... skipped: <error> (file:///...:<line>)` | The code failed to load: a syntax error, a missing import, an error at the top level. Node names no line for a syntax error in a `.js` file; `node --check <file>` does |
| `... skipped for user <id>: <error>` | `forUser` threw for that user, returned a malformed result (such as a tool without `parameters`), or offers a tool name another package already offers them |
| `paca: local extensions in local-extensions skipped: <error>` | The folder cannot be read; in the container it must be readable by uid 1000 (`node`) |
| `paca: extension local-extensions/dice: index.js missing; build the browser code. Cards show text.` | The tools work; cards show their fallback text and the pages are gone until the files exist |

Trusted code can still take Paca down, for example with a top-level `await` that never ends,
`process.exit()` or an error thrown outside a tool call. Switch the extension off by renaming its
folder, then restart. The installed packages keep their stricter rule: a broken one refuses the
start.

## Check before a restart

```sh
npm run check-extensions                                    # direct run
docker exec paca node packages/api/src/check-extensions.ts  # in the running container
```

In a new process, so it sees the files as they are now, this does the tool-package part of a
start: it loads the installed packages and local extensions from the configuration and data
folder and binds them for every configured user. It prints the log lines above and each user's
tools. It exits 1 when a local extension, or a folder of them, was skipped, and fails as a start
would when an installed package refuses its settings. It checks nothing else a start needs, such
as `publicUrl`, sign-in, the client secret or the model, and it starts no server and runs no
tool. Loading and binding do run each extension's own code, its top level and `forUser` with the
user's real `cacheDir`, beside the running Paca, so any side effects of that code happen here
too. Run it with the same environment as Paca (a user's `tokenEnv` must be set), which
`docker exec` has.

## Update, restart and refresh

1. Edit the files, then run the check.
2. Restart Paca: Ctrl-C and `npm start` for a direct run, or `docker restart paca`.
3. Reload the web page, so it loads the new browser code and the new list of extensions.

Sessions survive a restart and use the new tools from their next answer. An answer that is
running during the restart is lost, as for any restart.

To copy an extension into the container's volume, as the `node` user:

```sh
tar -C dice -c . | docker run --rm -i -v paca-data:/data --entrypoint sh ghcr.io/mtrenker/paca:<tag> \
  -c 'mkdir -p /data/local-extensions/dice && tar -x -C /data/local-extensions/dice'
```

## Switch off and remove

Rename the folder to `.<name>` or remove it, then restart. Its tools and pages are gone; cards it
showed earlier show their fallback text. A proposal of it that still waits for approval can no
longer be approved: Paca answers "its tool package is not enabled for you". Data it kept in
`cacheDir` stays until you remove it.

## Test it

- Run the check above after every change.
- For pages without real credentials, put the extension in the preview's data folder (for
  example `.data/preview/local-extensions/dice/` in a checkout) and run `npm run preview` (see
  [CONTRIBUTING](../CONTRIBUTING.md#preview-a-change)): its pages and operations work for the
  synthetic users `martin` and `alex`. The preview's fake model only drafts issues, so it never
  calls your tools or shows their cards (apart from the example's notes tools).
- Test logic that does not import Paca's packages, such as `roll.ts`, with
  `node --test roll.test.ts` in the extension's folder.
- Never test against a real model, GitHub or identity provider, and never against the live
  Paca's data.
