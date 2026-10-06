# paca

Paca is a private web chat about the GitHub issues and Projects of your own repositories. You sign
in from a phone or browser on your tailnet, ask what needs attention, and a real model answers from
the issues it actually read, with links.

Paca can also draft a new issue for you to create with one tap. It cannot edit issues, labels or
Project priority yet ([#2](https://github.com/mtrenker/paca/issues/2) adds those next).

## How it works

- **Sign-in:** an OIDC client of your identity provider (authentik). Exactly one issuer and subject
  get a session. Sessions are signed `__Host-` cookies, valid for 12 hours, and every POST needs
  the right `Origin` and a CSRF token.
- **Conversation:** [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.0.3
  (experimental) stores it in SQLite, so a reload or another device picks up the same
  conversation. Prompts are POSTs; the page receives the whole conversation state over SSE, and a
  reconnect starts from a fresh snapshot.
- **Models:** Pi's own `ModelRuntime` loads them, with the same credentials, `models.json` and
  default model as the `pi` CLI. Anthropic, OpenAI and llama.cpp all work the way Pi configures
  them (`/login`, provider environment variables, or `/login llama.cpp`). Paca adds no provider
  code.
- **Evidence:** the model has three read tools and nothing else:
  - the whole portfolio, from pi-clean's `github-planning.mjs` `snapshot` and `groom`;
  - one issue with its comments;
  - issue search.

  Each tool runs `gh` or Node with fixed arguments (no shell) and refuses repositories outside the
  configured Projects. A failed read is shown as unavailable, never as an empty project.
- **Issue drafts:** the model's `draft_issue` tool only stores a draft: repository (one of the
  configured ones), title and body. The page shows it as a card with exactly that text. **Create
  issue** sends that stored draft, never content from the request, with one
  `gh api POST repos/<repo>/issues`; **Dismiss** creates nothing.
  - A draft moves from proposed to creating, then created, failed, unknown or dismissed.
  - The claim (proposed → creating) is a single Durable commit, so repeated taps, two devices or a
    reconnect cannot send it twice.
  - Only an HTTP 4xx answer, or `gh` failing to start, counts as **failed** (nothing created).
    Anything else is **unknown**: a timeout, a 5xx, an unreadable answer, or a restart while
    creating. The card then links to the repository's issues to check, and Paca never resends it.
  - The card shows an issue link only when GitHub returned one.
- **Limits:** each answer is limited to 12 model requests, 30 tool calls and 3 minutes, and has
  a Stop button. If Paca restarts mid-answer, the unfinished answer is ended rather than resumed,
  since resuming would spend again outside those limits.

## Configure

Everything private lives in `.data/` in this checkout, which Git ignores. Create
`.data/config.json` with mode 0600:

```json
{
  "publicUrl": "https://<machine>.<tailnet>.ts.net:8443",
  "port": 4302,
  "oidc": {
    "issuer": "https://<authentik>/application/o/<slug>/",
    "clientId": "<client id>",
    "allowedSubject": "<sub claim of your account>"
  },
  "model": "openai-codex/gpt-6-astra",
  "github": {
    "projects": [{ "owner": "<owner>", "number": 11, "repository": "<owner>/<repo>" }]
  },
  "piClean": "/absolute/path/to/pi-clean"
}
```

- `model` is optional. Without it Paca uses Pi's default model.
- GitHub reads use the local `gh` login, which needs the `read:project` scope.
- The authentik provider needs the redirect URI `<publicUrl>/auth/callback`.
- To find `allowedSubject`, set it to `unknown`, sign in once, and copy the subject from Paca's log
  line `refused sign-in for subject ...`. Then restart Paca.

The client secret is never stored in the checkout. Put a Proton Pass reference in
`.data/secrets.env`:

```sh
PACA_OIDC_CLIENT_SECRET=pass://<vault>/<item>/password
```

## Run a preview

Each worktree uses its own port and `.data/`, so previews of different worktrees do not share
state. This worktree uses port **4302**; check that it is free first:

```sh
ss -ltn | grep -q ':4302 ' && echo "4302 is busy" || echo "4302 is free"
```

Start each process in the foreground, in its own visible terminal:

```sh
npm install
pass-cli run --env-file .data/secrets.env -- npm start         # the app on 127.0.0.1:4302
tailscale serve --https=8443 http://127.0.0.1:4302              # HTTPS on the tailnet name
```

Then open `publicUrl` on a phone or browser signed in to the tailnet.

**Stop:** press Ctrl-C in both terminals. `tailscale serve` without `--bg` removes its route when it
stops; check with `tailscale serve status`. To reset the conversation, stop Paca and delete
`.data/paca.sqlite`; this deletes the conversation history.

To ask one question from the terminal (no sign-in, no server, its own conversation store):

```sh
npm run ask -- "What needs attention across my projects?"
```

## Test

```sh
npm test
```

The tests use fakes for the model, GitHub and the identity provider. They cover refused
identities, forged and expired sessions, Origin and CSRF checks, out-of-scope reads, unknown tools,
the per-answer limits, duplicate requests, a crash mid-answer and the snapshot on reconnect. For
issue drafts, they cover:

- drafting without writing;
- approving exactly the stored content, once, even when approvals arrive together;
- dismissal;
- failed versus unknown outcomes;
- a restart in the middle of a create.
