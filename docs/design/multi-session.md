# Multi-session design

Status: accepted and implemented. On 2026-10-07 Martin accepted three choices: Pi SDK sessions
with a small Paca store, permanent delete refused while busy, and converting existing
conversations ([accepted choices](#accepted-choices)). He accepted the page at its UI checkpoint
on the same day ([implementation notes](#implementation-notes)). Written against 5f84ef9; the
issue is [#13](https://github.com/mtrenker/paca/issues/13).

**Terms.** *Session*: the product object, one saved chat with its transcript, drafts and
running state; `sessions.ts` holds a user's sessions. *AgentSession* and *SessionManager*: the
pi-coding-agent SDK objects for one live conversation and its JSONL file. *Sign-in session*:
`auth.ts`, `GET /api/session`. Durable's `Session`: a harness's commit line.

**Evidence.** S: read in the pinned 1.0.3 source. T: observed in a [probe](#probes-run) or an
existing Paca test. Prefixes: `agent/` is `@earendil-works/pi-coding-agent/dist/core/`, `core/`
is `@earendil-works/pi-agent-core/dist/`, `ai/` is `@earendil-works/pi-ai/dist/`, `durable/` is
`@earendil-works/pi-durable/dist/`. Unprefixed paths are Paca's.

## Requirements

- A user starts, resumes and deletes sessions, any number of them.
- Several sessions of one user answer at once, with no per-user cap. Per session the page shows
  whether it is answering and how many drafts wait, and Stop acts on that session only.
- Each answer stops at 12 model requests, 30 tool calls or 3 minutes, or on Stop.
- A draft is written at most once, exactly as shown, and only after approval; a write cut off by
  a restart becomes `unknown` and is never resent. A retried question is answered once.
- Users never see or act on each other's sessions. The model gets only Paca's tools: no coding
  tools and nothing discovered on disk.

How Paca meets these today is not binding.

## The two smallest viable designs

Neither runtime can list or delete sessions the way the product needs (Durable has no list on
`Harness` and no conversation delete, durable/types.d.ts:600-629, 755-786; the SDK has no
delete). So both designs get the same per-user catalogue, `users/<id>/paca.db` (node:sqlite)
with a `sessions` table that holds the list and the deletion state. Both also open a session's
runtime object only when it is first resumed or asked.

| | Durable: one store per session | Pi SDK: one JSONL per session |
| --- | --- | --- |
| Storage | `users/<id>/sessions/<uuid>.sqlite`, each one harness and root conversation opened by `openPaca`; drafts and request ids stay in that store | `users/<id>/sessions/<time>_<uuid>.jsonl` from `SessionManager.create(cwd, dir, { id })` (agent/session-manager.js:692-713); `requests` and `drafts` tables join the catalogue |
| Create | Insert the row, open a new store, `root()` (durable/harness/harness.js:193-232). T: B | Insert the row, then `createAgentSession`; the file appears with the first message (agent/session-manager.js:791-813). T: D |
| List | One catalogue query plus the running set; Paca copies the waiting-draft count into the row when drafts change | One catalogue query plus the running set; waiting drafts counted in `drafts` |
| Resume | Open the store on first use; `openPaca` ends a leftover run (agent.ts:117-132). T: `agent.test.js:93-107` | `SessionManager.open(file)` and `createAgentSession` on first use. T: D |
| Delete | No conversation delete (durable/types.d.ts:600-629, 784). Close the harness, which joins live tasks and checkpoints the WAL (durable/harness/scheduler.js:549-557; harness.js:207-210; durable/storage/sqlite/node.js:133-145), then remove the files. T: B | `abort()` and `dispose()` the AgentSession, remove the file, delete the rows. The SDK has no delete either; Pi's CLI removes the file (pi-coding-agent `dist/modes/interactive/components/session-selector.js:550-583`). T: D |
| Concurrency | A harness per session. T: B | An AgentSession per session; aborting one leaves the other. T: D |
| Live state | `viewState` per conversation into today's `uiState` (view.ts:66-147). T | `subscribe()` events and `session.messages` (agent/agent-session.d.ts:361, 431) into a rewritten `uiState` over the same pi-ai message types. S |
| Limits | Existing `beforeRequest` and `beforeTool` hooks (agent.ts:89-107). T: `agent.test.js:52-71` | Inline extension: `tool_call` returns `{ block, reason }` (agent/extensions/types.d.ts:1052-1060); `turn_start` counts requests and calls `ctx.abort()` (types.d.ts:236-242, 1177). T: D. The timer and Stop call `session.abort()` |
| Approval claim | One commit on the store's line (agent.ts:169-198). T | `UPDATE drafts SET status = 'creating' WHERE id = ? AND status = 'proposed'` on node:sqlite's synchronous connection; the propose tool inserts the row keyed by tool call id. S |
| Retried question | `requestId` dedup inside `submit` (durable/harness/submissions.js:117-124). T | `INSERT OR IGNORE INTO requests` before `prompt()`, which takes no request id (agent/agent-session.d.ts:165-177). S |
| Pi defaults off | Paca installs only its own extensions (agent.ts:109-113). T | `DefaultResourceLoader` with every `no*` flag, `systemPrompt`, `appendSystemPrompt: []` and an inline extension; `SettingsManager.inMemory`; a `tools` allowlist; `agentDir` an empty Paca directory (agent/resource-loader.d.ts:70-122; agent/sdk.js:69-81, 144-148). T: D |

## Evaluation

| Criterion | Durable | Pi SDK |
| --- | --- | --- |
| Lifecycle fit | Shaped for many conversations per store, so erasing needs a store per session. With the catalogue and lazy opening, create, list and resume match the Pi design; delete closes the harness (join, checkpoint) before removal. Durable's resumption of interrupted work goes unused: Paca aborts it at every open | One AgentSession per conversation and one file per session is the SDK's documented model (pinned docs/sdk.md:28-56); delete disposes, then removes the file, as Pi's CLI removes files |
| Crash mid-answer | Run state and partial output (committed every 100 ms, durable README:303) survive. The run would resume, so Paca aborts it and posts a notice (agent.ts:125-132). T | Nothing resumes. The file holds the question, not the partial answer (T: D). Paca adds the notice when it opens a session whose transcript ends in an unanswered question or tool call (`appendCustomMessageEntry`, agent/session-manager.d.ts:286). A dangling tool call gets a synthetic error result on the next request (ai/api/transform-messages.js:124-150). Reopen and continue: T: D |
| Crash mid-approval | `creating` becomes `unknown` when the store opens (agent.ts:117-123). T | The same rule on `paca.db` at start. Same safety. S |
| Where invariants live | Admission, transcript and draft claim commit together in the session store (T); the catalogue holds only list and deletion state | Claim, dedup, list and deletion state are single statements in `paca.db`, apart from the transcript. A crash between the `requests` row and the persisted question turns the retry into a no-op (accepted, [open risks](#open-risks)). S |
| Compaction | Automatic, as tasks (durable README:335-365) | Automatic, inside AgentSession; `prompt()` rejects while it runs (agent/agent-session.js:1498-1500), answered as busy |
| Tool packages | Already typed on Durable (packages/extension/src/index.ts:9; packages/extension-github/src/index.ts:5, 56, 82-116) | Port to `ToolDefinition` with `execute(toolCallId, params, signal, onUpdate, ctx)` (agent/extensions/types.d.ts:439-492); sections become prompt text; `propose` takes the tool call id. GitHub logic (github.ts) is unchanged |
| Ambient Pi behavior | None | With every `no*` flag, `reload()` still reloads settings and resolves packages (agent/resource-loader.js:362-363), so isolation rests on in-memory settings and an empty `agentDir`. Probe D: only Paca's tool active, no coding preamble, nothing written under `HOME`. A call to an inactive tool returns "Tool X not found" (core/agent-loop.js:482-486). The prompt always carries a `cwd` line (agent/system-prompt.js:105) |
| Resources | Only sessions in use are open, each about 3 descriptors, 0.35-0.7 MB and 2-4 ms to open (T: C) | Only sessions in use have an AgentSession; no handles while idle (each entry is an `appendFileSync`, agent/session-manager.js:812) |
| Debugging | JSON inside SQLite rows; needs `sqlite3` and the schema | One JSONL per session, readable with `jq`; `pi --session <path>` opens it (pinned docs/sessions.md:54) |
| Maintenance | "The API changes without notice between releases" (durable README:3); 1.0.0 on 2026-10-01, four releases | The SDK the Pi CLI runs on, with a documented session format (docs/session-format.md). Frequent releases (285 since 0.10.0 in 2025-11); one breaking change since 0.87.1, a provider rename (CHANGELOG.md:10-12) |
| Paca-owned code | The catalogue, lazy opening, close-then-remove, the waiting-count copy. agent.ts, view.ts and their tests stay | The catalogue with `requests` and `drafts`, admission, claim and recovery on them, the limits extension, the crash notice, a new `uiState`, the tool contract port, new tests. pi-durable stays only for converting old data |

## Rationale

Pi SDK sessions were chosen. With the same catalogue and lazy opening, both designs deliver the
lifecycle, so the choice does not rest on Durable lacking a list. It rests on three things:
- **Dependency maturity.** pi-durable 1.0.0 shipped on 2026-10-01 and says its API "changes
  without notice".
  The Pi SDK is what the Pi CLI runs on; it ships often, but its session API and file format are
  documented, and its one breaking change since 0.87.1 did not touch them.
- **Operability.** Martin can read any session with `jq` or open it in Pi, instead of decoding
  JSON from SQLite rows.
- **Where the invariants live.** The ones Paca must keep (a draft written once, a question
  answered once, no delete during a write, no id reused during a delete) become single statements
  in one small Paca store, instead of being split between Durable's commit line and a catalogue.
  Paca also stops carrying a runtime whose main feature, resuming interrupted work, it switches
  off.

What Durable does better, and what this gives up: Durable commits admission, transcript and
draft claim together, so a retry is never lost and drafts never disagree with the transcript.
Partial answers survive a crash, and today's agent.ts, view.ts and tests carry over, so Durable
is the smaller change now. The Pi design accepts losing an in-flight partial answer, a rare
no-op retry and a larger one-time rewrite.

## Chosen design

```
<data>/users/<user id>/paca.db                          sessions, requests, drafts
<data>/users/<user id>/sessions/<time>_<uuid>.jsonl     one Pi session file per session
<data>/users/<user id>/pi/                              empty agentDir, nothing to discover
<data>/users/<user id>/legacy/<session id>.sqlite       inert copy of a converted legacy store
```

- **Store.** `sessions(id, file, title, created_at, last_activity, state, legacy_file)` with
  `state` `active` or `deleting`, the first question as title, and `legacy_file` naming the
  retained copy a session was converted from (otherwise null); `requests(session_id, request_id)`;
  `drafts(id, session_id, action, repository, title, body, status, created_at, decided_at,
  number, url, error)`. The operator's sessions live under `users/<operator id>/` too.
- **Runtime.** A user host maps id to `{ agent?: AgentSession, busy }`. An AgentSession is made
  on first resume or question and kept until delete or shutdown. Each gets the shared
  ModelRuntime (models.ts:8), the configured model, the user's package tools as `customTools`
  and `tools`, the loader above with persona and package sections as `systemPrompt`, the limits
  extension, and in-memory settings.
- **Asking.** In one synchronous step Paca checks `state = 'active'` and not `busy`, sets `busy`,
  and inserts the request (a duplicate answers 202 with `duplicate: true`); then `prompt()`, and
  `busy` clears when it settles. A busy session, or one compacting, answers 409.
- **Limits.** Counters reset on `agent_start`. Over 30 tool calls a call is blocked with a reason
  the model sees; the 13th model request is cut by `ctx.abort()` before it is sent (T: D); the
  3-minute timer and Stop call `abort()`. The reason is appended as a custom message and shown as
  a notice.
- **Start-up.** Before the server listens: legacy conversion ([Migration](#migration)),
  `creating` drafts become `unknown`, and rows in `deleting` finish their deletion. A session's
  interrupted-answer notice is added when it is first opened.
- **Routes and page.** `GET /api/events?session=<id>` streams `sessions` (the list) and `state`
  (that session's `PageState`), and `gone` on delete. `POST /api/sessions { id, text, requestId }`
  takes a lowercase UUID v4 made by the page (otherwise 400). The other routes are
  `POST /api/sessions/<id>/messages`, `stop`, `delete`, `drafts/approve` and `drafts/dismiss`.
  A session id is only looked up in the signed-in user's rows; create is the one route that turns
  a validated UUID into a file name. The old routes answer 410 "Paca was updated. Reload the
  page." The page lists sessions with a running marker and the count of drafts waiting, and has
  New session and delete with a confirmation; the open id is in the URL. The list, the
  confirmation and the phone view need a UI checkpoint before the page work is finished; this
  is an implementation requirement.
- **`npm run ask`.** It moves to the same runtime: one AgentSession with
  `SessionManager.inMemory()` (agent/session-manager.d.ts:386), Paca's tools, limits and
  isolation. Its proposals are stored nowhere, since ask has no approval path (ask.ts). The old
  `ask.sqlite` stays untouched and is no longer read.
- **Docs.**
  - README: "What works today", "How it works" (Tools and Limits), "Where data and credentials
    live" (`ask.sqlite` and the new files), the `npm run ask` section and "Stop and reset".
  - docs/architecture.md: "Users and isolation", and "Tool packages" with its clock example,
    since packages move to `ToolDefinition`.
  - docs/container.md: the data table, backup, upgrade (conversion and its log lines) and
    rollback, and reset text.

## Migration

Accepted: convert. The volume of existing data is unknown and was not inspected. Existing data
is Durable stores on the two paths today's code opens: `<data>/paca.sqlite` (operator) and
`<data>/users/<id>/paca.sqlite`. Where a store is missing, today's code creates an empty one
(config.ts:91-94; users.ts:50-53). Their entries carry pi-ai `Message` values
(durable/types.d.ts:278), the same values a Pi session stores.

**Conversion.** At start, before the server listens, each store on those paths becomes one
session:
1. Open and close it with Durable's storage API only, with no harness. A killed writer's WAL is
   folded into the main file, and `-wal` and `-shm` disappear (T: E). If either remains, Paca
   stops with an error naming the file.
2. Rename it to `users/<id>/legacy/<session id>.sqlite`, one atomic rename inside `<data>`. If
   the rename fails, Paca stops with an error and nothing is converted.
3. Read it there with `scanEntries`, `findDocument` and `document` (durable/types.d.ts:816-830;
   T: E on the fixture). That yields the root conversation's user, assistant and tool-result
   messages in order, including turns a compaction hid (durable/storage/sqlite/storage.js:203-234),
   and the drafts. Write the messages with `SessionManager.appendMessage`; `paca.notice` entries
   become custom messages.
4. In one `paca.db` transaction, insert the drafts with status, link and error, and the
   `sessions` row with `legacy_file` set to the retained path.

A store with no messages and no drafts (today's code creates one for every user) moves to
`legacy/empty-<time>.sqlite` and gets no session. Conversion drops Durable internals (`pi.live`,
`pi.usage`, the provider session id), tasks, old request ids and compaction summaries.
pi-durable stays a dependency for this adapter. Conversion logs one line per store (its path,
the new session id, and the number of messages and drafts), so Martin can follow progress in the
container log.

**Restart.** A store still on a discovery path starts again at step 1. A `legacy/<uuid>.sqlite`
that no row names was interrupted between steps 2 and 4: Paca removes any session file with
that id and redoes steps 3 and 4. So a second start converts nothing. And because the server
starts only after conversion, no converted draft can be approved while a copy is discoverable.

**Retained copy.** `legacy/<session id>.sqlite` keeps the store's records as they were, though
its bytes change (WAL mode, checkpoint; T: E). It is inert: the previous image never opens it,
and the new runtime reads it only during conversion. Deleting the converted session removes it
with any `-wal` and `-shm` (deletion contract, item 1).

**Duplicate write through the old image: closed.** Approving a converted draft and then running
the previous image over the same data cannot send the draft again. The old image finds no store
on its paths, creates an empty conversation and never sees that draft. Anything asked there
lands in a new `paca.sqlite`, which the next upgrade converts into another session.

**Supported rollback.** Restore the backup taken before the upgrade into an empty volume and
start the old tag (docs/container.md, "Upgrade" step 1 and its rollback sentence). This is not a
writable return to the converted state: everything after the backup is gone. Accepted failure
mode: restoring any backup, in any version, forgets the approvals made after it, so a draft
approved in the new runtime is `proposed` again. Paca cannot know this, so docs/container.md
must tell Martin to search GitHub for a restored draft's repository and title before approving
it.

**Diagnosis.**
- `users/<id>/legacy/` holds one retained copy per converted session, named by its session id;
  `sqlite3 users/<id>/paca.db "select id, title, legacy_file from sessions"` maps them.
- A conversion error stops the start and names the file and the step: fix the cause (space,
  permissions) and start again.
- A `paca.sqlite` on a discovery path after the upgrade was written by an old image.

**Stop condition.** This closes the design. Reopen it only if an acceptance check contradicts a
claim here, a pinned Pi or Durable upgrade changes an API it cites, or the accepted choices
change.

## Deletion contract

1. Delete erases the session file and its `sessions`, `requests` and `drafts` rows (accepted
   choice 2). Nothing is hidden or recoverable. Deleting a converted session also removes the
   retained copy named in `legacy_file`, with any `-wal` and `-shm`.
2. Delete is refused with 409 while the session is answering or one of its drafts is `creating`.
   The check and the mark are one synchronous step: Paca reads `busy`, then runs
   `UPDATE sessions SET state = 'deleting' WHERE id = ? AND state = 'active' AND NOT EXISTS
   (SELECT 1 FROM drafts WHERE session_id = ? AND status = 'creating')`. Asking checks `state`
   and sets `busy` in one step, and the claim's `UPDATE` also requires an `active` session. With
   no `await` inside any of them, delete, ask and claim cannot interleave, so a sent write always
   gets its outcome recorded.
3. Order: mark `deleting`, end open streams with `gone`, `abort()` and `dispose()` the
   AgentSession, remove the file, then delete the rows in one transaction. A live SessionManager
   that writes after removal recreates the file as a line without a header (T: D), so removal
   comes only after `dispose()`.
4. **Same-id race.** The id stays reserved by its `deleting` row until the last step. A create
   naming it answers 409 "That session is being deleted" and opens nothing. A delete re-runs the
   remaining steps (item 5), and the other routes answer 404. After the rows are gone every route
   answers 404, and a create starts a new session. Regression check: hold the deletion at file
   removal and send a create with the same id; expect 409, no AgentSession and no file. Release;
   the file and rows are gone, and the same create then makes one session with one turn.
5. If removal fails, the request answers 500 and the row stays `deleting`. The steps after the
   mark are idempotent: a missing file counts as removed and deleting absent rows is a no-op. A
   repeated delete re-runs them, and every start finishes `deleting` rows, since the user asked
   for the deletion.
6. The confirmation lists the session's `created` drafts (with links) and `unknown` drafts (with
   check links) and says Paca keeps no record of them. Deleting never calls GitHub or undoes a
   write; proposed drafts go away unapproved.
7. Other sessions keep answering. Other users, `ask.sqlite`, `session.key`, the config and the
   caches are untouched.

## Acceptance checks

Run `npm run typecheck` and `npm test`; check the page with `npm run preview` (two synthetic
users). Tests use the faux provider and stub write actions.

| Check | Expected |
| --- | --- |
| Start | A create with a new UUID and a question: 202, one row, and after the first message one `<time>_<uuid>.jsonl`. The same request repeated or sent twice at once gives one row and one question. A bad id (`legacy`, `../x`, upper case) gets 400 and nothing is written. |
| Resume | After a restart over the same data dir, the list comes from `paca.db`. Opening a session shows transcript, drafts and outcomes, and a proposed draft is approvable once. A session killed mid-answer shows the interrupted notice once, and a `creating` draft becomes `unknown` and is not resent. |
| Concurrent | Two sessions with held faux answers both show running. A question to a running session gets 409, to an idle one 202. Stop in one leaves the other answering. |
| Limits | The 31st tool call is blocked with a reason; the 13th model request is never sent and a notice says why; 3 minutes stops the answer. Each session counts its own. |
| Isolation | Another user's or an unknown id gets 404 on every route and calls nothing; a draft id from one session is not found under another. Only Paca's tools are active, the system prompt is Paca's alone, and tools run as the owner. |
| Delete | An idle session's file and rows are gone, an open stream gets `gone`, later requests get 404, and the write stub is never called; another session's answer completes. |
| Deletion safety | 409 while answering and while a draft is `creating`. Approve and delete started together end as "created, delete refused" or "approve refused, nothing sent", never "sent, no record". Question and delete together end as "answering, delete refused" or "question refused". The same-id race check in the deletion contract (item 4) passes. A delete whose file removal fails (stubbed) answers 500, and a second delete finishes it. |
| Legacy | With fixture `pre-refactor.sqlite` as `<data>/paca.sqlite`, after start nothing is left at that path. `users/<operator id>/legacy/<id>.sqlite` holds the fixture's records, read back through the storage API. The operator has one session with the three fixture turns, the created draft's link, and the proposed draft approvable once. A second start converts nothing. A conversion interrupted after the rename (transaction stubbed to throw), then restarted, gives one session and no stray session file. An empty legacy store moves to `legacy/empty-<time>.sqlite` unlisted; a user without one gets nothing; the other user sees nothing. |
| Rollback | After conversion, approve the proposed draft (write stub called once). Then open `<data>/paca.sqlite` with pi-durable as the previous image does (`Harness.open`, `root()`, the `paca.drafts` document): it is a new, empty store, so the old approval handler finds no draft to send, and the stub is not called again. A manual run of the 5f84ef9 image over the same data shows the same. Started again, the new code moves the store the old code created aside as empty, or converts it into a second session if a question was asked there; the first session is unchanged. |
| Upgrade | Old routes answer 410 and call nothing. The origin, CSRF and identity tests cover the new routes. |

## Accepted choices

Accepted by Martin on 2026-10-07:
1. **Runtime:** Pi SDK sessions (AgentSession and SessionManager, one JSONL file per session)
   with the per-user Paca store.
2. **Delete policy:** permanent. Delete erases the session file, its rows and draft records,
   and any retained legacy copy, and it is refused while the session is answering or creating
   an issue. Paca keeps no record of a deleted session's created or unknown issues; GitHub
   keeps the issues.
3. **Existing data:** convert each legacy Durable store once, under the migration contract.

## Non-goals

Scheduler, branching and forking, import and export, agent fleets, renaming, search, archive or
undo, a per-user cap on concurrent answers, a drafts view across sessions, notifications,
steering or follow-up while answering, sessions for `npm run ask`. Pi CLI compatibility is a
debugging aid, not a requirement.

## Probes run

In `/tmp/paca-sessions-opus/probe/`, with the @earendil-works packages at Paca's lockfile
versions, Node 26.10.0, the faux provider, temp directories, and no real model, credentials or
Paca data. Scripts and outputs (`probe-*.out.*`) are kept there.

- **A** `node probe-a-one-harness.mjs`: one Durable harness ran two conversations at once;
  busy, request ids and abort were per conversation; `harness.scanConversations` does not exist
  (listing goes through `tx.scanConversations`); a retired document left the conversation and its
  entries in the file.
- **B** `node probe-b-file-per-session.mjs`: two harnesses on two files answered at once; one was
  aborted, closed and its files removed while the other finished; its stale handle was refused.
- **C** `node --expose-gc probe-c-open-cost.mjs N` (10, 100, 300): about 3 descriptors,
  0.35-0.69 MB and 2-4 ms per open idle store.
- **D** `node probe-d-pi-sdk.mjs` (pi-coding-agent 1.0.3; `HOME` and `PI_CODING_AGENT_DIR` in
  the temp dir). Only `read_issue` was active, the prompt had no coding preamble, `HOME` was never
  created and `agentDir` held only the probe's `auth.json`. No file existed before the first
  message. Two AgentSessions answered at once; a second `prompt()` to a busy one was rejected
  ("Agent is already processing"). A tool limit of one blocked the second `read_issue`; a request
  limit of two aborted the third turn before the provider saw it (last message `error`, "This
  operation was aborted"). Aborting A left B answering. `SessionManager.list` showed 3 sessions,
  and a reopened one had its messages. Removing A's file left B unaffected, and a write through
  A's stale SessionManager recreated the file as one headerless `custom` line. After SIGKILL
  mid-stream the file held the header entries, the system message and the question but no
  partial answer; the reopened session was idle and answered the next question.

- **E** `node probe-e-legacy-move.mjs`: a writer killed after committing left its data only in
  the WAL (main file 4 KB, WAL 233 KB). A storage-only open and close folded it in and removed
  `-wal` and `-shm`. After a rename, the file read back its entry and proposed draft through the
  storage API. A /tmp copy of `pre-refactor.sqlite` read back 13 entries and both drafts the same
  way, twice, although its bytes changed.

Limitations: the faux provider and Node 26.10 (the image runs 24.21). Real settings and packages
were not loaded. The Paca store, claim and admission are a static design, not a prototype.
Pi's compaction was not exercised.

## Open risks

- **Isolation depends on configuration.** The loader still reloads settings and resolves packages
  even with every `no*` flag. A test must pin the active tools and the system prompt.
- **Pi SDK churn.** pi-coding-agent ships often. Exact pins and the acceptance tests guard
  upgrades.
- **Catalogue and session files can diverge.** A file without a row is ignored and logged; a row
  whose file was never written opens as an empty session.
- **Crash loss.** A crash loses the in-flight partial answer, and a crash between admission and
  the question makes a retry a no-op. That no-op is accepted: the question does not appear, so
  the user sees it was lost and asks again. Matching request rows to transcript entries at start
  would add code for a window of milliseconds.
- **Concurrency costs.** Model spend grows with concurrent answers (each one is bounded). A
  user's sessions share one GitHub tool instance and its cache file (github.ts:91-114), which is
  low risk and already true within one answer.
- **Delete is irreversible.** The confirmation is the only guard.
- **Restoring a backup re-opens approvals made after it.** This is accepted, and the procedure
  says to check GitHub first ([Migration](#migration)).
- **A long first start can look unhealthy.** Conversion runs before the server listens, and the
  image's health check allows a 30 s start period and three 30 s retries (Dockerfile:89-90).
  With unknown data volume, a long conversion can be reported unhealthy. A supervisor that
  restarts unhealthy containers would restart it mid-conversion; the documented
  `--restart unless-stopped` restarts only on exit (docs/container.md:86). Accepted: conversion
  survives restarts (Restart, above), and its log lines show progress.

## Review history

- **Round 1 (Fable), on the Durable-only record:** six findings, all confirmed and fixed (client
  ids as file names, the delete mark and `close()` semantics, a wrong `users.test.js` citation,
  missing container.md and `openUsers` notes, title drift, a UI checkpoint). The validated-UUID
  create and the UI checkpoint carry over.
- **Coordinator verification, round 1:** deletion freed the id before close and unlink, so a
  retried create could open a store about to be removed. Disposition: the id stays reserved by
  its `deleting` row until the last step (deletion contract, item 4), with a regression check.
- **Martin's review:** migration cost is no reason to rule out JSONL. The record was rewritten
  as an equal comparison with migration in its own section.
- **Round 2 (Fable):** probe D re-ran identically and sampled citations held. Seven findings:
  - Fixed: the catalogue and lazy opening for both designs (the choice rests on maturity,
    operability and where invariants live), `legacy_file`, repeatable delete, the docs list, and
    the Durable follow-up note.
  - The compaction claim stands, with a citation.
  - The no-op retry is accepted as a risk.
  - No reachable safety blocker remained.
- **Coordinator verification, round 2:** probe D reproduced. An unchanged legacy store left on
  its path stays approvable by the previous image after the new runtime created its draft.
  Disposition:
  - Conversion folds and moves each store off the old image's paths before the server starts
    (probe E).
  - The only supported rollback is restoring the pre-upgrade backup. Its forgotten approvals are
    an accepted, documented failure mode.
  - The Legacy and Rollback acceptance checks cover it.
- **Accepted (2026-10-07):** Martin accepted Pi SDK sessions with the Paca store, permanent
  delete refused while busy, and conversion.

## Fable final review (2026-10-07)

Reviewed the migration and recovery contract against the code and the complete supported
contract. The previous image discovers stores only at `<data>/paca.sqlite` and
`users/<id>/paca.sqlite` (config.ts:91-94, users.ts:50-53); the rename moves both out of reach
before the server listens, so the duplicate write through the old image is closed. The only
supported rollback is the pre-upgrade backup, as docs/container.md already states, and its
forgotten approvals are recorded as an accepted failure mode with the check-GitHub procedure.
Probe E re-ran with identical output. The accepted choices are recorded without re-asking, the
deletion contract covers the retained copy, and the Legacy and Rollback checks are concrete.
Three routine findings (the fate of `npm run ask`, the health check during a long first start,
one wrapped line) were confirmed and fixed by Opus. No reachable safety blocker remains. The
catalogue, claim, admission and conversion are a static design, not tested code; the issue
draft says so and is not agent-ready because of the UI checkpoint.

## Implementation notes

Recorded after the design was accepted; they refine it without changing the contract.

- **UI checkpoint, accepted 2026-10-07.** On a wide screen the session list is a sidebar beside
  the open session; on a phone it is its own screen, with a back link that shows a dot when
  another session is answering or has drafts waiting. Each row shows the first question,
  **Answering**, the number of drafts waiting and the last activity. **New session** is the list's
  primary action. **Delete** is only in the open session's one-line header, and its confirmation
  lists the session's created issues (with links) and unknown outcomes (with check links). The open
  session is `?session=<id>` in the URL.
- **Where the request limit counts.** The design counted model requests on `turn_start`. Pi's
  compaction summaries (and their retries) call the model without a turn, so Paca counts at the
  session's stream function instead (`agent.ts`): `AgentSession` hands `agent.streamFunction` to
  every turn, every automatic retry (a new turn) and every compaction call
  (`agent-session.js:2111`). Providers do not retry on their own unless settings ask them to
  (`provider-retry.js`: `maxRetries ?? 0`). Faux-provider tests check a tool loop (the 13th request
  never reaches the provider) and a compaction (every request the provider saw was counted); a
  separate check showed both automatic retries counted. A model request while no answer runs is
  refused, and cache warming is off.
- **When counters reset.** A new counter starts with every admitted question, not on
  `agent_start`, so a retry inside one answer cannot reset it.
- **Delete waits for an open in progress.** Delete awaits the session's `AgentSession` if it is
  still opening, then disposes it, before removing the file, so a late write cannot recreate it.
- **Conversion order.** An empty store is detected after the move (step 2) and then renamed to
  `legacy/empty-<time>.sqlite`, so the previous image's paths are empty in every case.
