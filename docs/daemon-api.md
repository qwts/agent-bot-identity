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
