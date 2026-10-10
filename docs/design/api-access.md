# Calling an API as the signed-in user: the contract

Written by Claude Opus 5.5 on 2026-10-10 for [#21](https://github.com/mtrenker/paca/issues/21), on
top of `b8cffeb`, before the code that depends on it. [Architecture](../architecture.md) describes
what is built.

## Supersedes the separate Connect design

The first draft of this work gave every API its own OAuth client, a **Connect** flow, a
confirmation of the downstream account and a Connections page. Martin rejected it: the APIs sit
behind the same authentik provider Paca signs in with, so Paca uses the access token from that
sign-in. The Connect flow, the account confirmation, the per-API client secret and the Connections
page are gone, not kept as an alternative. The issue body still describes the old direction; this
record and Martin's clarification decide.

Kept from the agreed decisions: access and refresh tokens live in server memory only and are never
persisted. After a restart a user signs in to Paca again to get them back; sessions, drafts and
outcomes survive in `paca.db`; missing credentials never cause a write to be sent again.

## What an API must accept

Paca sends the **access token authentik issued to Paca's own OAuth client** at sign-in, as
`Authorization: Bearer`. It never sends an ID token or the session cookie. So an API is supported
only when it:

- validates bearer tokens from Paca's issuer: signature, expiry and issuer (JWKS or introspection);
- validates the audience and accepts Paca's client among the audiences it trusts;
- decides what the caller may do from the token's subject and scopes.

A shared issuer alone does not establish this: an API that trusts the issuer but expects its own
client as the audience will (rightly) refuse Paca's token. Do not work around that by switching
off the API's audience check, which would make it accept tokens issued to any client of the
provider. An API that requires its own audience does not fit this design; it needs token exchange
or resource indicators, which Paca does not do.

Before configuring a real API, check on the provider and the API that:

- Paca's authentik provider has scope mappings for the API's scopes, and `offline_access` if
  refresh tokens are wanted, and its token answer grants them;
- the API's configuration lists Paca's client as an accepted audience, and checks the scopes;
- the access token's lifetime suits the API (without a refresh token the grant ends a minute
  before it).

Paca was checked only against synthetic services (`test/container/fake-api.mjs`), not a live
authentik or a real API.

## Configuration

```json
"oidc": { "issuer": "https://<oidc-provider>/<issuer-path>/", "clientId": "<client id>", "scopes": ["offline_access"] },
"apis": {
  "notes": {
    "label": "Example API",
    "url": "https://<api host>/v1/",
    "scopes": ["notes.read", "notes.write"],
    "extensions": ["example-notes"]
  }
},
"users": [{ "id": "alex", "subject": "<subject>", "apis": ["notes"] }]
```

- Sign-in asks for `openid profile`, then `oidc.scopes`, then every API's `scopes`. The same
  request goes out for every user, since the user is known only afterwards.
- A user gets an API only when their entry lists it, and an extension only when the API lists the
  extension's name. Nothing is on by default.
- `url` is fixed, `https:`, without credentials, query or fragment, and ends with `/`.
- No client secret, audience or issuer per API: they are Paca's own.

## Lifetime

One grant per Paca user, from that user's latest sign-in, in memory. All of that user's devices
and sessions share it, as they share their tools.

| Event | What happens |
| --- | --- |
| **Sign-in** | The access token, refresh token (if any), expiry and granted scopes are kept for the user the ID token's subject names, replacing that user's earlier grant |
| **Scopes missing** | Sign-in still works for the chat. An API whose scopes the token answer lacks is **not granted** for this sign-in, and one log line names the missing scopes. Signing in again does not help; the provider's settings must change. A token answer without `scope` counts as everything asked for (RFC 6749, 5.1) |
| **Access token expires** | Refreshed before use when it expires within 60 seconds and there is a refresh token: one refresh per user at a time, which concurrent requests wait for. A rotated refresh token replaces the old one, and a request that still holds the old grant (a read whose 401 arrives late) uses the renewed one instead of refreshing again. Without a refresh token the grant ends 60 seconds before the access token expires, and the API's state says so from then on, so an approval waits instead of failing |
| **Refresh refused** | The grant ends: the provider answered with a refusal (a 4xx such as `invalid_grant`) or with tokens that fail validation. A refresh that got no answer, timed out, or got an answer saying the provider is down or overloaded (HTTP 5xx, 408 or 429, also a proxy's page) fails only that request and keeps the grant |
| **Refresh changes identity** | A refreshed ID token naming another subject, or a narrower scope answer, ends the grant |
| **12 hours after the sign-in** | The grant ends with the session cookie that sign-in made, so it never outlives that sign-in |
| **Sign out** | Ends the user's grant on every device. Another device keeps its Paca session and is asked to sign in again before extensions can call the API |
| **Restart** | No grant survives. A user whose cookie is still valid sees **Sign in again**, not a working API |

While a user has no usable grant, the page says so with a **Sign in again** button, which goes
through Paca's ordinary sign-in. With an active provider session that is a redirect and back, no
Connect step and no account choice: the identity is Paca's own.

## The extension capability

`forUser` receives `apis`: only the APIs both this user and this extension are allowed, by name.
Each offers:

- `state()`: `ready`, `sign-in` (no usable grant now) or `not-granted` (this sign-in lacks the
  API's scopes). It is read at call time; nothing is fixed at start.
- `request(path, { method, body, signal, ifMatch })`: one JSON request to `url` + `path` with the
  user's access token, which the extension never sees. It answers `{ status, body }` for any HTTP
  status, without headers.

The host enforces in `request`:

- **Destination.** `path` starts with `/`, has no `//`, dot segments, backslashes or encoded `.`,
  `/` or `\`, and the resolved URL keeps `url`'s origin and path prefix. Anything else is refused
  before a token is touched.
- **Redirects** are never followed: a 3xx answer is an error, so a token never goes to a second URL.
- **Reads** (`GET`) that answer 401 refresh once and retry once.
- **Writes** (every other method) are never retried: not after a 401, a 412, a timeout or a refresh.
- **Headers** are Paca's: `Authorization`, `Accept` and `Content-Type`. There is no header option.
  The one exception is `ifMatch`, for an API that needs a version precondition on writes (added for
  [PR #22](https://github.com/mtrenker/paca/pull/22#issuecomment-6102498753)): exactly one strong
  entity tag, quoted, of visible ASCII and at most 256 characters (`"v42"`), sent unchanged as
  `If-Match` on a write. A weak tag (`W/"…"`), `*`, a list, an unquoted or malformed value, or
  `ifMatch` on a read is refused before sending (`if-match`, `sent: false`), since each would let a
  write go through against a version the user did not approve. The API's answer to a stale version
  (412) or a missing one (428) comes back as it is; Paca never fetches a newer version or resends.
  The extension stores the version it read in the proposal (`expect`), so the user approves an edit
  of that version, and its write action sends exactly that stored value without reading again.
- **Errors** are `ApiError` with `sent: false` when nothing left Paca (no grant, not granted,
  destination refused, refresh failed) and `sent: true` when the request may have reached the API
  (connection lost, redirect, unreadable or oversized answer). A write action maps `sent: false`
  and HTTP 4xx to `failed`, 2xx to `created`, and everything else to `unknown`, which Paca never
  sends again.
- **No fallback.** Without the user's own grant the request fails. Paca never uses the operator's,
  another user's or a service account's token.

## Pending approvals

- A write is proposed as usual, stored exactly, and approved by the same user. The grant always
  belongs to that user's Paca identity, so there is no other account it could silently use.
- Before claiming an approval the host asks the action whether it can run now
  (`WriteAction.ready`). Without a usable grant the approval is refused with "Sign in again, then
  approve", and the draft stays **proposed**: nothing is claimed, nothing becomes `unknown`.
- If the grant ends after the claim, the request is refused before sending and the draft is
  **failed** (nothing was written). A restart during the request makes it **unknown**, as for every
  write today. Duplicate protection, exact content and outcomes are unchanged.

## Secrets stay on the server

Access, refresh and ID tokens and the authorization code never reach the model, tool arguments or
results, cards, operation answers, the page, cookies or logs. Log lines name the user, the API and
an error code or missing scope names only.

## Not in this increment

Persisting grants across a restart (and so key custody), revocation at the provider on sign-out,
per-API audiences, token exchange, resource indicators, client credentials, arbitrary URLs and a
settings redesign.
