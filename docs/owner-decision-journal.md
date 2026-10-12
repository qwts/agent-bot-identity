# Owner-decision daemon journal (disabled)

The daemon-side producer for [agent-comms#77](https://github.com/qwts/agent-comms/issues/77)
owner decisions, tracked in #1007. It implements the agent-comms contract at
[`6b90f82`](https://github.com/qwts/agent-comms/tree/6b90f825b5651a50718046379e5adbea193cbabf/docs)
(`owner-decision-journal-{records,capacity,recovery,fixed-slots}.md`).

**It is disabled.** Nothing here adds a route or an activation path, and it doesn't
replay automatically or fall back to an earlier permission state. No daemon
request reaches it. Enabling it needs the agent-comms conformance gates and a
separately reviewed native allocator/full-flush helper, neither of which is in
this repository.

## Authority is not stored here

A committed journal frame is storage integrity, never authorization. The
principal-global `ownerOperations` list in agent-comms is inert and is never
#77 authority. When the daemon later gains a live owner-decision check, it must
require an exact principal/account/soul/operation `ownerGrants` entry
(ADR-0077 §2) and an independently current target grant, checked at that moment.

## Frame codec

`identity/owner-decision-journal-frame.mjs` is the daemon's own codec. It never
imports the broker codec, and its producer role is the literal `daemon`, not an
option. A broker-role or role-free frame fails the context digest, even when its
checksums have been recomputed.

- Fourteen fixed slots (u16 IDs 1–14) at the contract caps. The files are
  `<slot>.record` plus `scratch.record`: 15 names. Each frame is a 128-byte
  header, the payload padded to its cap, and a 128-byte commit trailer.
- The context digest is SHA-256 of canonical
  `{namespaceDigest,requestId,role:"daemon",slot,v:1}`. The request directory
  name is SHA-256 of canonical `{namespaceDigest,requestId,v:1}`. That name is
  never parsed back into a request ID.
- `observation-pair` and `terminal-pair` hold exactly canonical
  `{preimage,record,v:1}`: record ≤2048 bytes, preimage ≤2048 bytes, wrapper
  ≤256 bytes, 4352 in all. SHA-256 of the canonical preimage must equal
  `observedDigest`.
  - An observation's finding is `indeterminate`. Only there may `effectId` and
    `basisDigest` be null.
  - A terminal pair's finding is `applied` or `refused`.
- An all-zero slot is `empty`: no committed record, never proof that no effect
  happened. A valid body without its trailer is `uncommitted`. Anything else
  refuses with one fixed diagnostic.

The tests check the codec against the six shared paired vectors in
`tests/fixtures/owner-decisions/journal-budget-v1.json`, a byte-for-byte copy
pinned by SHA-256, and against a frame layout rebuilt independently from the
contract table. One golden daemon frame hash is ours; agent-comms has not yet
published daemon frame vectors, so interoperability is not claimed until they
are cross-checked.
