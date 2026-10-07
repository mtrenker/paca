# Herdr agents (operator only)

`@paca/extension-herdr` lets the operator ask Paca about the coding agents running in their
[Herdr](https://herdr.dev) and send one an exact prompt after approving it in chat
([#14](https://github.com/mtrenker/paca/issues/14)). This page records the decisions behind it and
how to run it. It was designed against Herdr 0.9.3 (socket protocol 22).

## What it can do

Three tools, and nothing else:

| Tool | Socket methods | What it does |
| --- | --- | --- |
| `list_agents` | `agent.list` | The agents in scope: pane, kind, name, status, working directory |
| `read_agent_output` | `agent.get`, `agent.read` | What one agent in scope shows on its screen now, at most 200 lines and 8,000 characters |
| `propose_prompt` | `agent.get` | Stores a prompt for one agent in scope as a card; sends nothing |

Approving the card sends the prompt with `agent.get` and `agent.prompt`. There is no tool for any
other method: no raw keys or terminal input, no shell commands, no starting, closing or renaming
agents, panes or workspaces, no configuration, no events. The socket client in the package knows
only these four method names.

Reads use Herdr's `visible` source, the screen as it is. Herdr 0.9.3 answers a `recent` read of an
idle full-screen agent (Claude Code, Codex) by sending mouse-wheel events into the agent's terminal
to scroll back through its history and then scrolling down again. That is input to the agent, so
Paca never asks for it; the cost is that it sees only what is on screen, not older scrollback.

## Trust boundary

**Paca holds host terminal control.** Herdr's socket has no permissions of its own: any process
that can connect can call every method, including `pane.send_text`, `agent.start` and
`server.stop`, which means running commands as the host user. Mounting the socket read-only does
not change that, because a read-only bind mount only stops changes to the socket file, not
connecting to it and writing requests. The method list above is a restriction in Paca's code, not
a boundary Herdr enforces. Whoever controls Paca's server process (a bug, a compromised dependency,
another tool package) can control the host's terminals.

This is accepted for the operator's own Paca, on the operator's own machine, because the operator
already has that control. A method-filtering bridge on the host would make it a real boundary; it
is not part of this increment. Consequences:

- Only the user marked `"operator": true` can have Herdr tools. Config with `herdr` settings on any
  other user is refused at start, so the mistake is loud.
- Never mount the host's home or Herdr config directory, or the Docker socket. Mount only the socket
  file (see [Run it](#run-it)).
- Terminal output is untrusted. It can contain secrets and text written to steer a model. The read
  tool labels it as untrusted evidence and bounds it, the persona tells the model never to follow
  instructions in it, and a prompt it suggests still needs the operator's approval of the exact
  text. Output the model read is stored in the operator's conversation like any tool result; Paca
  never logs output or prompts.

## Scope

The operator lists directories in `users[].herdr.roots`. An agent is in scope when its pane's
working directory (`cwd`) is one of them or inside one, and so is the directory of its foreground
process (`foreground_cwd`) when Herdr reports it. Pane ids, workspace ids and labels are not used
for scope: ids are ephemeral and labels are anyone's to change. Every tool and every approval
checks scope in code against a fresh `agent.get`; an agent outside it is reported as not found,
the same as a missing one. The model is told the roots, but nothing depends on it respecting them.

## Which agent the card means

Herdr has no way to say "send this only if the pane still holds the same agent": `agent.prompt`
takes a `target` (a pane id or a unique agent name), the `text` and an optional wait, nothing else.
Paca therefore pins the agent itself, as closely as the API allows:

- The proposal stores the pane id plus the identity Herdr reported when it was proposed: the
  `terminal_id`, the agent kind (`agent`) and, when Herdr has one, the native session reference
  (`agent_session`). `terminal_id` is new for every terminal Herdr creates, including terminals it
  restores after a restart, so a closed and reopened pane or a restarted Herdr never matches.
- On approval Paca calls `agent.get` for the pane and refuses, sending nothing, when the agent is
  gone, out of scope, has a different terminal, kind or session, or is blocked. The card says the
  agent changed and nothing was sent; that outcome is `failed`.
- Only then does it call `agent.prompt` with the pane id (never a name). Herdr itself refuses a
  blocked agent, an agent still launching, or a pane whose foreground process is no longer the
  agent, again before any input.
- The response names the agent Herdr typed into. If its `terminal_id` differs from the approved
  one, the outcome is `unknown` and the card says so.

**Accepted race:** between Paca's `agent.get` and Herdr handling `agent.prompt` (a few
milliseconds on one machine), the pane could get a new occupant of the same kind in the same
terminal, for example after `/new` in an agent that reports no session. Herdr's own foreground check
and the post-send identity check narrow this; nothing closes it without a compare-and-send method
in Herdr.

## Approval and outcomes

The prompt goes through the same durable approval as GitHub drafts (see
[Architecture](architecture.md#tool-packages)): the host stores the exact proposal, the card shows
it, and approval claims it in one commit before the package's action runs once. Duplicate approvals
find it claimed. The model can never send; only the operator's button can.

The prompt itself is checked before it is stored: 1 to 4,000 characters, and nothing the card
cannot show: no control characters except line feeds, no Unicode format characters (bidirectional
marks, zero-width, tag and soft-hyphen characters), lone surrogates, line or paragraph separators,
or unassigned code points. Herdr writes the text into the terminal as given (inside bracketed paste
when the agent enabled it) and then presses Enter, so an escape character could otherwise end the
paste early and type keys the card never showed, and an invisible character would be typed
without the operator having seen it.

Outcomes:

| Card | Stored status | Meaning |
| --- | --- | --- |
| Prompt submitted | `created` | Herdr accepted the prompt and pressed Enter. **Submitted, not completed**: Paca does not follow what the agent does next |
| Not sent | `failed` | Nothing reached the terminal: Paca refused a changed or missing agent, the socket was unreachable before the request was written, or Herdr refused before typing (`agent_not_found`, `agent_target_ambiguous`, `agent_blocked`, `agent_not_ready`, `empty_agent_prompt`) |
| Outcome unknown | `unknown` | It may have been typed: a timeout, a dropped connection or an unreadable response after the request was written, any other Herdr error such as `agent_prompt_failed`, a different terminal in the response, or Paca restarting mid-send |

An unknown prompt is never sent again, automatically or by approving the card again; the operator
looks at the agent in Herdr and asks for a new proposal if needed. The socket request id is a fresh
random id per request; Herdr does not treat it as an idempotency key, so retrying would type the
prompt twice.

`created` is the stored success status for every write action, so drafts written before this change
keep their meaning. A prompt has no link; its card names the pane instead.

## Socket client

- One connection per request, newline-delimited JSON, as Herdr's [socket API](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.3/docs/next/website/src/content/docs/socket-api.mdx) describes.
- Deadlines: 5 seconds for reads, 15 seconds for a prompt, from connecting to the response line.
- A response line over 1 MiB ends the connection and counts as unavailable (for a read) or unknown
  (for a prompt).
- Errors carry Herdr's error code and a short message, never the request, the prompt or output.

## The card

A prompt card is the GitHub draft card with different words. It shows, in order: "Prompt for an
agent", the agent kind and pane (`claude in w7:p5`, plus its Herdr name when it has one), the
working directory, and the exact prompt in a monospace block. **Send prompt** sends it; **Dismiss**
sends nothing. The note under the buttons says that sending types the text into that agent and
presses Enter, after checking it is still the same agent. Afterwards the card reads "Prompt
submitted", "Not sent" with the reason, "Outcome unknown" with where to look, or "Dismissed".

The page picks the words by the draft's action (`github.create_issue`, `herdr.send_prompt`); a
draft without an action is a GitHub issue draft, as before.

## Run it

Config, for the operator only:

```json
{
  "extensions": {
    "@paca/extension-github": { "piClean": "/opt/pi-clean" },
    "@paca/extension-herdr": { "socket": "/run/herdr.sock" }
  },
  "users": [
    {
      "id": "martin",
      "subject": "<subject>",
      "operator": true,
      "github": { "...": "..." },
      "herdr": { "roots": ["/home/<you>/code"] }
    }
  ]
}
```

Outside a container, `socket` is the host path, normally `~/.config/herdr/herdr.sock` written out in
full. In a container, mount just the socket file, read-only (which, as above, still allows control):

```sh
-v /home/<you>/.config/herdr/herdr.sock:/run/herdr.sock:ro
```

- **UID:** Herdr creates the socket with mode 0600 for the host user. Paca runs as uid 1000, so this
  works only when the host user is uid 1000. Do not loosen the socket's mode to make it work.
- **Herdr restarts:** a restarted Herdr server creates a new socket file, and the container keeps
  the old, dead one. Paca then reports Herdr as unavailable. Recreate the Paca container
  (`docker rm -f paca` and start it again) after restarting Herdr. Proposals made before the
  restart are refused as changed, because restored terminals get new ids.
- **Not Herdr's config:** never mount `~/.config/herdr`, the home directory or the Docker socket.

## Not built

A method-filtering host bridge, an event dashboard, waiting for an agent to finish, raw keys,
starting or closing agents, panes and workspaces, and Herdr server administration.
