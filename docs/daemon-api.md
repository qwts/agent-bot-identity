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
