# Daemon soul revision API

These loopback routes require the daemon's per-start `Authorization: Bearer`
token. Writes additionally require the owner's agent-comms principal credential;
the population bearer, transport principal ID, and soul binding grant no owner
authority. No credential is loaded for the caller.

| Route | Fields | Result (HTTP 200) |
| --- | --- | --- |
| `GET /v0/soul/revisions?agentId=ID` | Agent ID query | `{ schemaVersion: 1, agentId, proposals }`, pending only |
| `POST /v0/soul/revisions/approve` | `agentId`, `proposalId`, `reason`, `principal` | `{ schemaVersion: 1, agentId, record }` |
| `POST /v0/soul/revisions/reject` | Same | Same |
| `POST /v0/soul/revisions/adopt` | `agentId`, `packagePath`, `reason`, `principal` | Same |
| `POST /v0/soul/revisions/edit` | Same; optional `expectedParent` | Same |

POST bodies are JSON objects. `packagePath` names a quiescent local `.soul`
directory readable by the daemon; `reason` is nonempty. `principal` is
`{ principal: "principal_<uuid>", secret, brokerUid, mode: "group" }`.
The existing owner verifier checks broker custody in another account and sends
one authenticated `health` request. Failed verification never falls back to
consent. Successful journal records retain only `{ method: "principal",
principal }` as `authorization`, never the secret.

Listing returns proposal IDs, revision hashes, author, reason, path diff,
`requiresUser`, `status`, and timestamp. It returns no package bytes, filesystem
locations, credentials, or authorization records. Empty/unknown revision chains
return an empty list. See [revision semantics](soul-revisions.md) for stale
parents, rejected proposals, and adoption rules.

Errors are `{ error, code? }`: malformed fields return 400, a missing/invalid
daemon bearer 401, and revision conflicts 409. Missing/invalid owner credentials
return 403 with `code: "owner-credential-required"`. Any `x-agent-binding` or
`x-agent-binding-proof` header, even empty or invalid, returns that same 403
before bearer or principal verification. The CLI also refuses worktree markers;
HTTP does not establish a client's working directory.

For future host consent, send the same POST with `consent: true` instead of
`principal`. This currently returns 501 with `code: "owner-consent-unavailable"`
and changes nothing. It raises no GUI prompt and accepts no client assertion of
approval. A future implementation must authenticate the owner through the
daemon's action-bound Touch ID/password ceremony. Today use the interactive CLI.
Binding headers still refuse this path. Owner-auth and ceremony refusals append
`soul-revision` audit receipts with operation, stable decision code, and Agent ID
when validated; bodies, reasons, headers, and credentials are never audited.

# Delivered aside API

| Route | Authentication | Result (HTTP 200) |
| --- | --- | --- |
| `POST /v0/asides/delivered` | Soul binding, no daemon bearer required | `{ recorded: string[], skipped: [{ id: string, reason: string }] }` |

The loopback caller presents `x-agent-binding: <binding secret>` or, preferably,
`x-agent-binding-proof: <proof>` from `binding-proof.mjs`. A proof covers `POST`,
`/v0/asides/delivered`, and the daemon's host:port; it is fresh and single-use.
The registry determines the soul's Agent ID. A daemon owner bearer alone cannot
report delivery. Missing, invalid, expired, or replayed bindings return HTTP 401
with `{ "error": "missing or invalid agent binding" }`; non-loopback peers return
403 with `{ "error": "loopback peers only" }`.

Request (`Content-Type: application/json`):

```json
{
  "messageIds": ["msg_first", "msg_second"],
  "via": "inbox-read",
  "harnessSessionId": "live-session-id"
}
```

`messageIds` contains 1–200 unique, nonempty strings. `via` is exactly
`inbox-read` or `hook-inject`. `harnessSessionId` is optional; when supplied it
must be a nonempty string. Malformed fields/JSON return HTTP 400 `{ error }`;
the normal daemon body-size limit applies (413). Caller-supplied identity,
message bodies, and peer metadata confer no authority and are ignored.

The daemon uses the same `createCommsRelay().read()` client as cold wake: it
runs `agent-comms inbox read` in the bound soul's worktree with that soul's
binding. Only requested IDs present in that mailbox, with `to.agentId` equal
to the authenticated soul, are recorded. The sender, body, reply-to, and
correlation come from the broker; the team ID comes from the local census.
No mailbox messages are acknowledged by this route. A broker read failure
returns HTTP 502 `{ "error": "could not read soul mailbox" }` with no broker
details exposed and no asides recorded.

For example, a repeat and an unavailable ID alongside a newly delivered ID:

```json
{
  "recorded": ["msg_second"],
  "skipped": [
    { "id": "msg_first", "reason": "already-recorded" },
    { "id": "msg_missing", "reason": "not-in-mailbox" }
  ]
}
```

Skip reasons are `not-in-mailbox`, `not-addressed-to-soul`, `invalid-message`
(missing sender or non-string body), `already-recorded`, and `record-failed`
(journal write failed). Each input ID appears once in either array. Concurrent
and repeated delivery reports append once per soul/message while the bounded
journal retains the incoming aside. This also recognizes an existing cold-wake
`relay-prompt` aside; reshown thread context does not suppress a first delivery.

Agent-comms must report only IDs actually returned to a live session or injected
by its hook, before acknowledging/removing those IDs from the inbox. Break
batches larger than 200 into separate requests. Its internal daemon mailbox read
must not itself trigger a delivery report, or reporting would recurse. An inbox
read alone does not prove that a session consumed the body: the explicit bound
report supplies that assertion, and the daemon verifies mailbox membership.
See [asides](asides.md) for retention and viewing.

# Route authorization

Every daemon route requires a loopback peer. The per-start bearer in
`daemon.json` proves only that the caller is a process in this account: any
same-account process, a soul's shell included, can read it. So the bearer alone
never carries owner authority (#785, owner decision 2026-10-10). Each route
belongs to one class:

- **owner**: bearer plus the owner, asked by the daemon for this action. That's
  presence through keyd (Touch ID, or the password), the admin dialog where
  keyd can't ask, or a verified principal credential where the route accepts
  one. A refusal changes nothing and is receipted.
- **owner-credential**: bearer plus the owner's agent-comms principal
  credential. Presence isn't accepted (see above).
- **bearer**: bearer only. Reads, and infrastructure that bound sessions use.
- **binding**: a soul's live binding (`x-agent-binding` or a proof), or a
  single-use bind token. The binding names the caller; the bearer isn't
  required and grants nothing.
- **principal**: bearer plus an enrolled transport principal, authorized by the
  owner for the soul and operation (`agent-bot principals`).

A soul binding header (`x-agent-binding` or `x-agent-binding-proof`, even an
invalid one) on any owner or owner-credential route is refused with
`owner-credential-required` before anyone is asked. It is receipted as
`owner-route`, or as `soul-revision` or `dream-control` on those routes.

`tests/daemon-route-auth.test.mjs` checks this table and the daemon's
handlers match in both directions. It also checks that a bearer-only caller,
and a soul binding, are refused on each owner route.

| Route | Class | Notes |
| --- | --- | --- |
| `GET /v0/health` | bearer | Status, warm pool, busy souls. |
| `POST /v0/space/ensure` | bearer | Creates a soul's space folder. |
| `GET /v0/space/path` | bearer | |
| `POST /v0/register` | bearer | `setup-worktree` and join record a soul's space and worktree. Open question for the owner, see below. |
| `POST /v0/bind` | binding | Single-use bind token. An App claim that differs from the record asks the owner. |
| `POST /v0/vouch` | binding | |
| `POST /v0/spawn` | binding | |
| `POST /v0/team/start` | binding | |
| `POST /v0/binding/app` | binding | An App change asks the owner. |
| `GET /v0/binding` | binding | |
| `DELETE /v0/binding` | binding | |
| `POST /v0/credential` | binding | The soul's own App token. |
| `POST /v0/inbox/take` | binding | |
| `POST /v0/grants/request` | binding | Approving the grant asks the owner against its digest (#108). |
| `POST /v0/grants/spend` | binding | Spends an already approved grant once. |
| `POST /v0/keyd/grant` | binding | |
| `POST /v0/asides/delivered` | binding | |
| `GET /v0/comms/status` | bearer | |
| `GET /v0/population` | bearer | |
| `GET /v0/soul/revisions` | bearer | |
| `POST /v0/soul/revisions/approve` | owner-credential | |
| `POST /v0/soul/revisions/reject` | owner-credential | |
| `POST /v0/soul/revisions/adopt` | owner-credential | |
| `POST /v0/soul/revisions/edit` | owner-credential | |
| `GET /v0/sandbox` | bearer | |
| `POST /v0/sandbox` | owner | |
| `POST /v0/sandbox/override` | owner | |
| `GET /v0/soul/profile` | bearer | |
| `GET /v0/soul/env` | bearer | |
| `POST /v0/soul/computer-use` | owner | |
| `POST /v0/soul/pause` | bearer | Holds a soul back. An enrolled principal with `cancel` may too. Open question, see below. |
| `POST /v0/soul/resume` | owner | Lifts the hold. An enrolled principal with `cancel` resumes without a prompt, as the owner authorized it. |
| `POST /v0/soul/stop` | bearer | Cancels the running turn. Same as pause. |
| `GET /v0/approvals` | bearer | |
| `POST /v0/approvals/decide` | owner | |
| `GET /v0/soul/dream` | bearer | |
| `GET /v0/soul/dream/history` | bearer | |
| `POST /v0/soul/dream/{action}` | owner | register, pause, unschedule, run-now, cancel, ack-notice. |
| `GET /v0/identity/apps` | bearer | |
| `GET /v0/identity/apps/jobs/{id}` | bearer | |
| `POST /v0/identity/apps/{action}` | owner | create, connect, rotate-key, assign, remove, addon. |
| `POST /v1/sessions` | principal | |
| `POST /v1/sessions/{id}/messages` | principal | |
| `GET /v1/souls/{id}/asides` | principal | |
| `GET /v1/proposals` | principal | |
| `POST /v1/proposals/{id}/decision` | owner | The principal must also be authorized to approve. |
| `GET /v1/invocations/{id}` | principal | |
| `GET /v1/invocations/{id}/events` | principal | |
| `POST /v1/invocations/{id}/cancel` | principal | |
| `GET /v1/invocations/{id}/artifacts` | principal | |

The `/ui` pages use their own browser session and never see the bearer.

**Open for the owner.** These stay bearer-only for now. Each one is a call for
the owner:

- **Pause and stop.** They only hold a soul back, and the CLI and the host app
  use them as an emergency brake that shouldn't wait on Touch ID. Any
  same-account process can still pause or stop a soul.
- **`POST /v0/register`.** Agent sessions call it from `setup-worktree`, so
  gating it would prompt on every worktree. Any same-account process can
  record a space or worktree path for a soul.
- **The principal routes.** A same-account process that knows an enrolled
  principal's transport and provider ID can act as that principal: talk to a
  soul, observe it, cancel. Owner presence on each message would break remote
  transports.
