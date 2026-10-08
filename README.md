# paca

Paca is a private web chat about the GitHub issues and Projects of your own repositories, for
you and the few people you configure. You sign in from a phone or browser on your tailnet and ask
what needs attention.
A real model answers from the issues it actually read, with links. When you ask for a new issue,
Paca drafts it on a card, and the issue is created only when you tap **Create issue**.

Paca is experimental. It admits only the accounts listed in its config, runs as one local
process, and depends on the Pi SDK (pi-coding-agent 1.0.3), which changes often.

## What works today

- Sign-in through an OIDC provider (tested with authentik). Only the subjects of configured users
  get a session; every other account is refused.
- Each user has their own sessions, drafts, GitHub scope and GitHub credential. Nobody sees
  or decides another user's sessions or drafts.
- Questions about the open issues and pull requests in the configured GitHub Projects, answered
  with links. Answers come from what the tools read, and data that could not be read is reported
  as unavailable.
- Issue drafts for a configured repository: repository, title and body. **Create issue** creates
  exactly the text on the card; **Dismiss** creates nothing.
- Issue cards: when Paca reads an issue, the answer shows a card with its reference, state,
  title, labels and the time Paca read it. The card shows the issue as it was read, stays put
  while the answer streams, and opens the issue's page.
- GitHub pages: **GitHub** in the side list opens your repositories, an issue search with a
  repository filter, and recent open issues. An issue's page reads it fresh, with its body and
  latest comments. Page URLs can be refreshed and bookmarked.
- Several saved sessions per user. **New session** starts one with its first question; the list
  shows each session with **Answering** while it answers and the number of drafts waiting.
  Sessions answer at the same time, each with its own Stop and limits, and persist across
  reloads, devices and restarts. **Delete** removes a session for good, after a confirmation that
  lists the issues it created or may have created (and, for the operator, the prompts it sent or
  may have sent).
- For the operator only, optionally: the coding agents running in their
  [Herdr](https://herdr.dev), in configured directories. Paca lists them, reads what one shows on
  screen, and proposes an exact prompt on a card; **Send prompt** types it into that agent once.
  See [Herdr agents](docs/herdr.md), including why this gives Paca control of the host's
  terminals.

Not available yet: editing issues, labels, assignees, milestones and Project fields such as
priority ([#6](https://github.com/mtrenker/paca/issues/6)).

## How it works

- **Sign-in:** Paca is an OIDC client using the authorization code flow with PKCE. Sessions are
  signed `__Host-` cookies valid for 12 hours. Every POST needs the right `Origin` and a CSRF
  token.
- **Sessions:** each session is a Pi SDK session (`AgentSession`), saved as one JSONL file you can
  read with `jq` or open with `pi --session <file>`. A small SQLite store per user, `paca.db`,
  holds the session list, request ids, drafts and deletion state. Questions are POSTs; the page
  receives the session list and the open session's whole state over SSE, and a reconnect starts
  from a fresh snapshot.
- **Code:** an npm workspace of TypeScript packages: the API, the page, shared types, the tool
  package contract and the GitHub tool package. [Architecture](docs/architecture.md) records the
  decisions behind the split, user isolation and tool packages.
- **Models:** Paca loads models through Pi's own `ModelRuntime`. It uses the same credentials,
  `models.json` and default model as the `pi` CLI, so any provider Pi supports should work,
  including Anthropic, OpenAI and llama.cpp. Paca has been tried only with Pi's `openai-codex`
  provider.
- **Tools:** tool packages enabled in the config give the model its tools, and nothing else does:
  Pi's coding tools are off, and Pi discovers no extensions, skills, prompt templates, context
  files or settings on disk. The system prompt is Paca's own. The GitHub package gives four tools
  and no shell, file or generic API access:
  - `portfolio_overview` reads the configured Projects through pi-clean's `github-planning.mjs`
    `snapshot` and `groom`;
  - `read_issue` reads one issue with its comments and shows its card;
  - `search_issues` searches issues;
  - `draft_issue` stores a draft for you to decide on. It cannot create anything.

  Each tool refuses repositories outside the user's configured Projects and runs `gh` or Node
  with fixed arguments, without a shell, as that user.
- **Cards and pages:** a tool package can ship browser code that renders cards in the chat and
  pages of the app. A tool stores a small projection of what it read (at most 1 KiB) with the
  session in `paca.db`; pages read fresh data through the package's read-only operations, as the
  signed-in user. The page imports the package's prebuilt module from Paca itself, under the same
  Content-Security-Policy, and mounts each card once. Only users with that package's tools get
  its files and operations. When a frontend is off or fails, cards show plain text with a link
  and pages say they are unavailable. See [Architecture](docs/architecture.md#frontends).
- **Creating an issue:** **Create issue** sends only the draft's id. The server creates the stored
  draft of the signed-in user with one `gh api --method POST repos/<owner>/<repo>/issues`, with
  that user's GitHub credential. It claims the draft with one conditional update in `paca.db`
  first, so repeated taps, a second device or a reconnect cannot send it twice. The outcome is one
  of:
  - **created:** the card links to the new issue;
  - **failed:** GitHub answered with HTTP 4xx, or `gh` did not start. Nothing was created;
  - **unknown:** anything else, such as a timeout, a 5xx, an unreadable answer or a restart
    during the call. The card links to the repository's issues so you can check. Paca never
    sends an unknown draft again.
- **Limits:** each answer is limited to 12 model requests, 30 tool calls and 3 minutes, and has a
  Stop button. Pi's automatic retries and the summaries of automatic compaction count as model
  requests too. A session answers one question at a time; a user's sessions can answer at the same
  time, with no limit on how many, so model spend grows with the sessions answering at once. If
  Paca restarts during an answer, nothing resumes: the partial answer is lost, and the session
  says so when it is next opened.

### Where data and credentials live

All runtime data is in `.data/` in the checkout, which Git ignores:

- `config.json`: your configuration;
- `users/<id>/paca.db`: that user's session list, request ids, drafts with their outcomes, and
  deletion state. The operator's is here too;
- `users/<id>/sessions/<time>_<session id>.jsonl`: one Pi session file per session;
- `users/<id>/legacy/`: the conversation from before multiple sessions, kept after it was
  converted (see [Upgrade](docs/container.md#upgrade)); `empty-<time>.sqlite` files there were
  empty;
- `users/<id>/pi/`: an empty directory Paca gives Pi as its agent directory, so it finds nothing;
- `session.key`: the key that signs session cookies, created on first start;
- `users/<id>/github-workflow.json`, `models-store.json`: generated caches.

A `paca.sqlite` from an earlier version is converted into a session at start and moved into
`legacy/`. An `ask.sqlite` from an earlier version is no longer read.

Credentials stay on the server. The OIDC client secret comes from the environment, model
credentials from Pi, and GitHub access from each user's own token, or from your local `gh` login
for the users you grant it. The browser only gets a session cookie. Conversation text and tool
results are sent to your model provider. `gh` and the collector run without any `PACA_*`
variable, so they never see the client secret or another user's token.

## Prerequisites

- **Node.js 24** or newer.
- **GitHub CLI** (`gh`). Each user needs a GitHub token of their own, or the operator grants
  them the server's `gh` login explicitly. Reading private repositories and creating issues needs
  the `repo` scope (`public_repo` covers only public repositories); reading Projects needs
  `read:project`. Paca uses each token as is, so it can do far more than Paca's handlers allow. A fine-grained token limited to the configured
  repositories would be narrower, but Paca has not been tested with one, and reading Projects
  owned by a user account may still need a classic token.
- **Pi** with credentials for at least one model, set up with `pi` (`/login`) or the provider's
  environment variable. Paca reads Pi's agent directory, `~/.pi/agent` unless
  `PI_CODING_AGENT_DIR` points elsewhere. OAuth logins refresh there, under Pi's file lock.
- A checkout of [pi-clean](https://github.com/mtrenker/pi-clean), for `scripts/github-planning.mjs`.
  Paca was built against pi-clean revision `8921989`. The container image already includes it.
- An **OIDC provider** with a confidential client for Paca, and **HTTPS** in front of Paca. Paca
  listens on `127.0.0.1` unless `PACA_HOST` says otherwise; the examples use `tailscale serve`.
- Optional: [Proton Pass CLI](https://protonpass.github.io/pass-cli/) (`pass-cli`), as one way to
  deliver the client secret without writing it to disk.

## Install

```sh
git clone https://github.com/mtrenker/paca.git
cd paca
npm ci
npm run build    # compiles the page; npm start also does this
npm test
```

## Configure

1. Create `.data/config.json` with mode 0600 (`mkdir -m 700 .data` first):

   ```json
   {
     "publicUrl": "https://<host>:<https-port>",
     "port": 4302,
     "oidc": {
       "issuer": "https://<oidc-provider>/<issuer-path>/",
       "clientId": "<client id>"
     },
     "model": "<provider>/<model id>",
     "extensions": {
       "@paca/extension-github": { "piClean": "/absolute/path/to/pi-clean" }
     },
     "users": [
       {
         "id": "<your id>",
         "subject": "unknown",
         "operator": true,
         "github": {
           "projects": [{ "owner": "<owner>", "number": 1, "repository": "<owner>/<repo>" }],
           "serverLogin": true
         }
       }
     ]
   }
   ```

   - `publicUrl` is the HTTPS address you open. The OIDC client's redirect URI is
     `<publicUrl>/auth/callback`.
   - `port` is the local port. Use a different one for each checkout you run at the same time.
   - `model` is optional. Without it Paca uses Pi's default model.
   - `extensions` lists the tool packages Paca loads, by npm package name, with their settings.
     Only packages installed with Paca can be listed; they run as trusted server code. Remove an
     entry to turn its tools off for everyone.
   - `"disableFrontends": ["@paca/extension-github"]` (optional, top level) turns off the browser
     code of listed packages: their cards show plain text, their pages and side-list link are
     gone, and their tools keep working. Each entry must be a package under `extensions`.
   - Each `users` entry is one person: an `id` (lowercase letters, digits and dashes, used in
     data paths), their OIDC `subject`, and their settings for each tool package under the
     package's name. `operator: true` marks you: the operator owns the conversation from before
     multi-user support (converted into one of their sessions) and is the user of `npm run ask`.
   - `"herdr": { "roots": ["/absolute/dir"] }` on the operator, with
     `"@paca/extension-herdr": { "socket": "/absolute/path/to/herdr.sock" }` under `extensions`,
     turns on the Herdr tools for agents working in those directories. Only the operator can have
     them; read [Herdr agents](docs/herdr.md) first.
   - Each `github.projects` entry names a Project and the one repository that user may read and
     create issues in for it.
   - Each user's GitHub access is their own: `"tokenEnv": "PACA_GH_TOKEN_<NAME>"` names an
     environment variable holding their token (it must start with `PACA_`), or
     `"serverLogin": true` lets them use the server's `gh` login. A user with neither gets no
     GitHub tools, and Paca refuses to start if a named token is not set.
   - A config from before multi-user support (`oidc.allowedSubject`, `github` and `piClean` at
     the top level) still works unchanged: it is read as one operator using the server's `gh`
     login. Change to `users` when you add a second person.
   - `PACA_DATA_DIR` moves `.data/`, and `PACA_CONFIG` points at another config file.
   - `PACA_HOST` changes the listen address from `127.0.0.1`, and `PACA_PORT` overrides `port`.
     The container image sets both; leave them unset for a direct run.

2. Make the client secret, and each user's GitHub token, available when Paca starts. With
   Proton Pass, put references in `.data/secrets.env` (mode 0600):

   ```sh
   PACA_OIDC_CLIENT_SECRET="pass://<vault>/<item>/<field>"
   PACA_GH_TOKEN_<NAME>="pass://<vault>/<item>/<field>"
   ```

3. Pin each account. A `subject` of `unknown` refuses everyone. Start Paca (see
   below) and sign in once. Paca refuses you and logs:

   ```text
   paca: refused sign-in for subject "<sub>" (username "<username>") from <issuer>
   ```

   Check that the username is the account that should use Paca before you copy the subject into
   that user's `subject`. Your browser may still be signed in to the provider as someone else, so
   never pin a subject just because it was the first one refused. Then restart Paca.

## Run

Check that the port is free, then start each process in the foreground in its own terminal:

```sh
ss -ltn | grep -q ':4302 ' && echo "4302 is busy" || echo "4302 is free"

pass-cli run --env-file .data/secrets.env -- npm start     # or: PACA_OIDC_CLIENT_SECRET=... npm start
tailscale serve --https=8443 http://127.0.0.1:4302          # HTTPS on the tailnet name
```

`npm start` logs `paca: listening on http://127.0.0.1:<port>` when it is ready. Open `publicUrl`
on a phone or browser on the tailnet.

To ask one question from the terminal as the operator, without sign-in or a server, run the
following. It uses the same tools, limits and isolation as the web chat in a session kept only in
memory, needs no web settings in the config, and spends one real model answer. It cannot create
issues: a draft made there is printed and then forgotten, and the web page never shows it.

```sh
npm run ask -- "What needs attention across my projects?"
```

### Run in a container

The image `ghcr.io/mtrenker/paca` (linux/amd64) runs Paca with `gh` and the pi-clean collector
included. Configuration, credentials and data come in at runtime through one volume and
environment variables. See [Run Paca in a container](docs/container.md) for setup, start, stop,
backup and upgrade.

## Stop and reset

Press Ctrl-C in both terminals. `tailscale serve` without `--bg` removes its route when it stops;
check with `tailscale serve status`.

To remove one session, use **Delete** in the page. To start over for one user, stop Paca and
delete `.data/users/<id>/`. Either way this deletes the sessions **and** the record of every draft
and its outcome. Before you delete, check on GitHub every draft whose outcome is unknown, and note
the links of issues Paca created. Afterwards Paca has no record left to stop you from creating
the same issue again.

## Test

```sh
npm run typecheck
npm test
```

To test the container image, see [Test the image](docs/container.md#test-the-image).

The tests use fakes for the model, GitHub and the OIDC provider. Apart from local test servers,
they make no network calls. They cover:

- refused identities, forged and expired sessions, and the `Origin` and CSRF checks;
- two users: neither can read the other's sessions, stream or drafts, approve the other's
  drafts or use the other's GitHub scope or token;
- sessions: start, resume after a restart, two answering at once, Stop and limits per session,
  a draft id or unknown id refused under another session, and old routes answering 410;
- deleting: files and rows removed, the open stream ended, refusal while answering or creating,
  approval or question racing a delete, a create held during a delete, and a failed file removal;
- converting the conversation from before multiple sessions (a synthetic fixture written by the
  old code): turns, drafts and outcomes kept, an interrupted conversion, an empty store, and the
  previous image finding nothing to approve again;
- only Paca's tools and prompt with decoy Pi resources on disk, and enabled tool packages loaded
  by name;
- the per-answer limits (including compaction requests), duplicate requests, a crash mid-answer,
  and the snapshot on reconnect;
- issue drafts: drafting without writing, creating exactly the stored draft once (even with
  simultaneous approvals), dismissal, failed versus unknown outcomes, and a restart during a
  create.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Paca is released under the [MIT License](LICENSE).
