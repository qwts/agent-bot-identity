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
contract table, with one golden daemon frame hash of our own. They also check
agent-comms' frozen fixed-frame vectors (`fixed-frames-v1/vectors.json` from
agent-comms `9a2ea84`, likewise pinned):
- all 28 daemon frames decode and re-encode byte for byte;
- each of the 20 broker frames is refused in all 14 daemon slots, 280
  refusals in all.

## Storage layout and admission

`identity/owner-decision-journal-store.mjs` is Darwin-only. It refuses on other
platforms with `owner-decision-unsupported`. A store is created once, by
`initializeDaemonJournal(root)`:

```text
<root>/                 0700
  .journal-lock         0600, empty, fixed inode
  requests/             0700
    <64-hex request>/   0700, SHA-256 of {namespaceDigest,requestId,v:1}
      <slot>.record ×14 and scratch.record, 0600, each at its fixed EOF
```

- **Lock.** The lock is the journal's own `O_EXLOCK|O_NONBLOCK` open of that
  fixed inode, checked for identity and ownership. It is never reclaimed,
  unlinked or recreated. Contention refuses, and process death releases it.
  The general `file-lock.mjs` (mkdir, with stale reclaim) is never used here.
- **Namespace.** Each store instance is bound to one enrolled
  `namespaceDigest`, given at construction and never read back from storage.
- **Admission.** Admission checks the daemon acceptance record against the
  exact original action bytes. `payloadDigest` is SHA-256 of those bytes,
  `reservationBytes` is 524288, and requestId, principal, account, soul and
  operation must agree.
  Under the lock it then:
  1. charges and flushes the request directory;
  2. creates every fixed file exclusively, zero-fills it and flushes it;
  3. revalidates them;
  4. publishes `original-action`, then `acceptance-context`.

  Each publication writes header and body, flushes, writes the trailer,
  flushes again, and then reads the frame back through a separate descriptor.
- **Charging.** Every entry under `requests/` counts toward the 4096-request
  limit, across all namespaces. An interrupted admission leaves an orphan that
  stays charged and is never admitted fresh. An unknown entry refuses every
  write and is left for inspection.
- **After a failure.** After any storage failure the store instance refuses
  until it is reopened.

## Recovery and strict graph refusal

`recover(requestId)` is explicit and schedules nothing: no forward, no
delivery, no check release and no effect. It returns `absent` only when no
directory exists. Otherwise it reads the request as one complete graph.

- **The request ID.** It comes only from `acceptance-context`, never from the
  hashed directory name. Phase one is a context-free integrity peek of that
  frame, and its payload is untrusted. The request ID must be UUIDv4, and its
  directory hash, computed under the store's own enrolled namespace, must
  match. Only then are the frames decoded with the full
  role/slot/request/context binding, and the original action checked against
  the acceptance. Nothing follows from the peek alone.
- **What is accepted.** Two graphs are accepted:
  - `admitted`: the exact committed admission prefix, meaning
    `original-action` and `acceptance-context` committed, with every later
    slot and scratch all zero;
  - `indeterminate`: that prefix plus nonzero `entered` bytes, committed or
    damaged, that are not a clean partial write. A durable entered record is
    consumption, so the effect may have started. Without validated
    whole-effect completion it reports `outcome:{code:"effect-uncertain",
    effectDigest:null}`. It is never refused, applied or retried. The
    request's later slots are flushed and retained but not yet validated,
    because their typed validators (including completion, and therefore
    `applied`) are a later slice.

  A body-only `entered` with no trailer is a partial write that happened
  before any effect, so it refuses like any other unsupported phase.
- **What refuses.** Each of these refuses as `storage-failed` and is left
  exactly as found:
  - an orphan;
  - any other partial or committed later phase, until its typed validator
    exists;
  - nonzero scratch;
  - a corrupt or foreign-role frame;
  - another request's context;
  - an extra or missing file;
  - a symlink or hard link;
  - a wrong EOF or mode.

  Missing files are never recreated.
- **Duplicates.** Visible committed bytes prove nothing about their final
  flush. Before any acknowledgement, including an exact duplicate admission,
  every committed frame and both directories are flushed again, and the bytes
  must be unchanged. If that flush fails, nothing is acknowledged and the
  prefix stays unsettled. An exact duplicate never writes. Changed input for
  the same request is `conflict`. Later phases, including a duplicate
  preparation, will use the same recovery flush before acknowledging.

Every flush here is node's `fsync`. On Darwin that tries `F_FULLFSYNC` but can
silently fall back, so it is a logical flush only. Results carry
`physicalAllocationSupported:false` and `physicalFlushGuaranteed:false`. Zero
filling is not a physical reservation.

### Error codes

Internal reasons stay in `error.reason`. Callers see only a public code:

| Internal reason | Public code |
| --- | --- |
| `owner-journal-capacity` | `journal-capacity` |
| changed input for an admitted request | `conflict` |
| invalid action or acceptance | `bad-request` |
| non-Darwin platform | `owner-decision-unsupported` |
| busy, corrupt, I/O, flush, orphan, unsupported phase, pending scratch, reopen required | `storage-failed` |

`storage-failed` is a non-authorizing refusal, never proof that an earlier
effect did not enter. Retained state is kept as found. An effect that entered
without whole-effect completion stays `indeterminate` (`effect-uncertain`),
never a terminal refusal.

## Linked authoritative event

`identity/owner-decision-linked-event.mjs` covers slot 13,
`linked-authoritative-event` (16384 bytes). It holds pure checks only. The
local revision writer is unchanged and does not yet emit the `ownerDecision`
field, so nothing validates until a reviewed adapter adds it.

- **Revisions only.** Approve, reject, adopt and edit link one authoritative
  revision-journal event. A cold-wake change has none, so its slot stays
  all-zero.
- **Bounded before entering.** `assertLinkedEventFits` sizes the complete
  event the adapter would append, including approve's copied legacy proposal
  reason, with a worst-case 27-character `at` stamp. If it can't fit, the
  operation refuses (`bad-request`) and the existing local ceremony stays the
  path for that change. Legacy text is never truncated or rewritten.
- **Verified after completion.** `verifyLinkedEvent` accepts only these exact
  bytes: the journal file the caller read under the revision lock, matching
  `completed.journalRecordDigest`, in the writer's own
  `JSON.stringify(record) + '\n'` form. The event must be of the operation's
  kind, for the same proposal, and carry exactly
  `ownerDecision:{requestId,payloadDigest,receiptDigest,effectId,preparationDigest}`.
  A coincidentally matching unlinked legacy event proves nothing.
- **Revision store space.** The journal reservation can't cover the revision
  store, which still publishes with a hard link (#1010). An effect must refuse
  before entering, or stay indeterminate once entered, if that store hits
  ENOSPC.
