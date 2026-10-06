# paca

Paca is a private, single-user web chat about the GitHub issues and Projects of your own
repositories. You sign in from a phone or browser on your tailnet and ask what needs attention.
A real model answers from the issues it actually read, with links. When you ask for a new issue,
Paca drafts it on a card, and the issue is created only when you tap **Create issue**.

Paca is experimental. It admits exactly one account, runs as one local process, and depends on
Pi Durable 1.0.3, which is itself experimental.

## What works today

- Sign-in through an OIDC provider (tested with authentik). Exactly one issuer and subject get a
  session; every other account is refused.
- Questions about the open issues and pull requests in the configured GitHub Projects, answered
  with links. Answers come from what the tools read, and data that could not be read is reported
  as unavailable.
- Issue drafts for a configured repository: repository, title and body. **Create issue** creates
  exactly the text on the card; **Dismiss** creates nothing.
- One conversation that persists across reloads, devices and restarts.

Not available yet: editing issues, labels, assignees, milestones and Project fields such as
priority ([#2](https://github.com/mtrenker/paca/issues/2)).

## How it works

- **Sign-in:** Paca is an OIDC client using the authorization code flow with PKCE. Sessions are
  signed `__Host-` cookies valid for 12 hours. Every POST needs the right `Origin` and a CSRF
  token.
- **Conversation:** [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) keeps
  the conversation and the issue drafts in a local SQLite file. Prompts are POSTs; the page
  receives the whole conversation state over SSE, and a reconnect starts from a fresh snapshot.
- **Models:** Paca loads models through Pi's own `ModelRuntime`. It uses the same credentials,
  `models.json` and default model as the `pi` CLI, so any provider Pi supports should work,
  including Anthropic, OpenAI and llama.cpp. Paca has been tried only with Pi's `openai-codex`
  provider.
- **Tools:** the model has four tools and no shell, file or generic API access:
  - `portfolio_overview` reads the configured Projects through pi-clean's `github-planning.mjs`
    `snapshot` and `groom`;
  - `read_issue` reads one issue with its comments;
  - `search_issues` searches issues;
  - `draft_issue` stores a draft for you to decide on. It cannot create anything.

  Each tool refuses repositories outside the configured Projects and runs `gh` or Node with fixed
  arguments, without a shell.
- **Creating an issue:** **Create issue** sends only the draft's id. The server creates the stored
  draft with one `gh api --method POST repos/<owner>/<repo>/issues`. It claims the draft in a
  single Durable commit first, so repeated taps, a second device or a reconnect cannot send it
  twice. The outcome is one of:
  - **created:** the card links to the new issue;
  - **failed:** GitHub answered with HTTP 4xx, or `gh` did not start. Nothing was created;
  - **unknown:** anything else, such as a timeout, a 5xx, an unreadable answer or a restart
    during the call. The card links to the repository's issues so you can check. Paca never
    sends an unknown draft again.
- **Limits:** each answer is limited to 12 model requests, 30 tool calls and 3 minutes, and has a
  Stop button. If Paca restarts during an answer, it ends that answer instead of resuming it,
  because resuming would spend again outside the limits.

### Where data and credentials live

All runtime data is in `.data/` in the checkout, which Git ignores:

- `config.json`: your configuration;
- `paca.sqlite`: the conversation and the issue drafts with their outcomes;
- `ask.sqlite`: conversations from `npm run ask`;
- `session.key`: the key that signs session cookies, created on first start;
- `github-workflow.json`, `models-store.json`: generated caches.

Credentials stay on the server. The OIDC client secret comes from the environment, model
credentials from Pi, and GitHub access from your local `gh` login. The browser only gets a
session cookie. Conversation text and tool results are sent to your model provider.

## Prerequisites

- **Node.js 24** or newer.
- **GitHub CLI** (`gh`) logged in as the account whose issues Paca reads and creates. Reading
  private repositories and creating issues needs the `repo` scope (`public_repo` covers only
  public repositories); reading Projects needs `read:project`. Paca uses this login as is, so the
  token can do far more than Paca's handlers allow. A fine-grained token limited to the configured
  repositories would be narrower, but Paca has not been tested with one, and reading Projects
  owned by a user account may still need a classic token.
- **Pi** with credentials for at least one model, set up with `pi` (`/login`) or the provider's
  environment variable. Paca reads Pi's agent directory, `~/.pi/agent` unless
  `PI_CODING_AGENT_DIR` points elsewhere. OAuth logins refresh there, under Pi's file lock.
- A checkout of [pi-clean](https://github.com/mtrenker/pi-clean), for `scripts/github-planning.mjs`.
  Paca was built against pi-clean revision `8921989`.
- An **OIDC provider** with a confidential client for Paca, and **HTTPS** in front of Paca. Paca
  listens on `127.0.0.1` only; the examples use `tailscale serve`.
- Optional: [Proton Pass CLI](https://protonpass.github.io/pass-cli/) (`pass-cli`), as one way to
  deliver the client secret without writing it to disk.

## Install

```sh
git clone https://github.com/mtrenker/paca.git
cd paca
npm ci
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
       "clientId": "<client id>",
       "allowedSubject": "unknown"
     },
     "model": "<provider>/<model id>",
     "github": {
       "projects": [{ "owner": "<owner>", "number": 1, "repository": "<owner>/<repo>" }]
     },
     "piClean": "/absolute/path/to/pi-clean"
   }
   ```

   - `publicUrl` is the HTTPS address you open. The OIDC client's redirect URI is
     `<publicUrl>/auth/callback`.
   - `port` is the local port. Use a different one for each checkout you run at the same time.
   - `model` is optional. Without it Paca uses Pi's default model.
   - Each `github.projects` entry names a Project and the one repository Paca may read and create
     issues in for it.
   - `PACA_DATA_DIR` moves `.data/`, and `PACA_CONFIG` points at another config file.

2. Make the client secret available as `PACA_OIDC_CLIENT_SECRET` when Paca starts. With Proton
   Pass, put a reference in `.data/secrets.env` (mode 0600):

   ```sh
   PACA_OIDC_CLIENT_SECRET="pass://<vault>/<item>/<field>"
   ```

3. Pin your account. `allowedSubject` starts as `unknown`, which refuses everyone. Start Paca (see
   below) and sign in once. Paca refuses you and logs:

   ```text
   paca: refused sign-in for subject "<sub>" (username "<username>") from <issuer>
   ```

   Check that the username is the account that should use Paca before you copy the subject into
   `allowedSubject`. Your browser may still be signed in to the provider as someone else, so never
   pin a subject just because it was the first one refused. Then restart Paca.

## Run

Check that the port is free, then start each process in the foreground in its own terminal:

```sh
ss -ltn | grep -q ':4302 ' && echo "4302 is busy" || echo "4302 is free"

pass-cli run --env-file .data/secrets.env -- npm start     # or: PACA_OIDC_CLIENT_SECRET=... npm start
tailscale serve --https=8443 http://127.0.0.1:4302          # HTTPS on the tailnet name
```

`npm start` logs `paca: listening on http://127.0.0.1:<port>` when it is ready. Open `publicUrl`
on a phone or browser on the tailnet.

To ask one question from the terminal, without sign-in or a server and in its own conversation
store (`ask.sqlite`), run the following. It needs only `github` and `piClean` in the config, and
it spends one real model answer. It cannot create issues: a draft made there stays in
`ask.sqlite`, and the web page never shows it.

```sh
npm run ask -- "What needs attention across my projects?"
```

## Stop and reset

Press Ctrl-C in both terminals. `tailscale serve` without `--bg` removes its route when it stops;
check with `tailscale serve status`.

To start over, stop Paca and delete `.data/paca.sqlite`. This deletes the conversation **and**
the record of every draft and its outcome. Before you reset, check on GitHub every draft whose
outcome is unknown. After a reset, Paca has no record left to stop you from creating the same
issue again.

## Test

```sh
npm test
```

The tests use fakes for the model, GitHub and the OIDC provider. Apart from local test servers,
they make no network calls. They cover:

- refused identities, forged and expired sessions, and the `Origin` and CSRF checks;
- out-of-scope reads and unknown tools;
- the per-answer limits, duplicate requests, a crash mid-answer, and the snapshot on reconnect;
- issue drafts: drafting without writing, creating exactly the stored draft once (even with
  simultaneous approvals), dismissal, failed versus unknown outcomes, and a restart during a
  create.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Paca is released under the [MIT License](LICENSE).
