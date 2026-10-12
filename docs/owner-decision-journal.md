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
local revision writer (`soul-revisions.mjs`) now emits the optional
`ownerDecision` linkage, with `authorization:{method:"owner-decision"}`, when
an owner-decision operation passes it, and returns that record's journal
sequence. Records stay `schemaVersion 1`, per the owner's decision. The
revision completion (below) publishes this slot.

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

## Prepared response (disabled composition)

`identity/owner-decision-prepared.mjs` composes the daemon's
`owner-decision-prepared` response against agent-comms
[`0686f2c`](https://github.com/qwts/agent-comms/tree/0686f2c135f39aa71ca51da23ff6e39d1af5d415/docs)
(#204). It is pure: no transport, route, signing or journal write.

- **Inputs.** The caller supplies the custody-verified saved admission and the
  nonce it generated once. For a staged action, it also supplies the public
  `{stagingId,kind,contentDigest,expiresAt}` of the daemon's own immutable
  stage descriptor, never request input. The stage must match the action
  exactly: same staging ID, `package` or `webhook` by operation, and the
  action's package or configuration digest. An unstaged action requires
  `stage:null`.
- **Deadline.** `exp` is exactly
  min(acceptedAt+180, preparedAt+180, stage.expiresAt), using the broker's
  original `acceptedAt`, which is never refreshed. These refuse as
  `preparation-stale` rather than extending anything: clock-window violations
  (more than 30 s of skew), an expired window or stage, and unsafe arithmetic.
- **Outputs**, deterministic so a duplicate never regenerates anything:
  - the exact public challenge, whose canonical bytes are daemon slot 3,
    unchanged by #204;
  - the stage retained in slot 6;
  - the request fields
    `{requestId,payloadDigest,daemonKey,daemonEpoch,watchId,nonce,preparedAt,exp,stage}`.

  Both the challenge cap and the broker's 32768-byte `{challenge,stage,v:1}`
  wrapper cap are checked before anything could be published.

The tests compose all eight shared `preparedWrapperBounds` vectors from the
vendored budget fixture (agent-comms `0686f2c`) to their exact challenge, stage
and wrapper bytes and hashes.

## Typed effect evidence and request phases

`identity/owner-decision-evidence.mjs` validates the typed records in the
later slots, against agent-comms
`docs/owner-decision-effect-evidence.md` and
`tests/fixtures/owner-decisions/effect-evidence-v1.json` at `f42c05b` (vendored
and pinned by SHA-256). It holds strict codecs and bindings for:

- the preparation (slot 6), bound to the acceptance and action, including the
  stage and the exact `exp`;
- the one successful check (slot 7);
- the effect records: `refused` (slot 8), `entered` (slot 9) and
  `completed` (slot 10).

It also has the agent-comms owner-local reconciliation classification.
Nothing here writes, applies, verifies a signature or grants authority.

The store reads each request as one graph.

Every binding comes from the signed action:
- the preparation's expected proposal, head and destination must be the ones
  the action names;
- `entered` must describe the transition to exactly what the action asks for:
  the approved proposal revision, `sha256:<packageDigest>` for adopt and edit,
  or for cold-wake the requested setting and webhook, with `settingsDigest`
  checked as well;
- the linked event's identifiers come from the action and acceptance, never
  from the preparation, and a revision event must record the completed
  `afterRevision`.

**Before any effect has entered**, every slot is either empty or a committed
typed record bound to this request, and the graph is one of these phases:

| State | What the graph holds |
| --- | --- |
| `admitted` | The admission records only. |
| `preparing` | A preparation without its challenge. |
| `prepared` | The challenge, byte-for-byte the one the preparation implies. |
| `authorizing` | Presence and/or receipt. |
| `released` | The one successful check. |
| `refused` | A proven pre-effect refusal, reported with its `refusalReason` and public `outcome:{code, effectDigest}`. |

Anything else refuses as `storage-failed`.

**Once `entered` holds anything but a clean partial write**, the request is
`applied` only if the whole graph validates:
- preparation, challenge, presence, receipt and check are present;
- `entered` and `completed` are bound to them;
- a revision also has its linked authoritative event, matching
  `completed.journalRecordDigest`, while cold-wake has none.

Then `outcome` is `{code:"applied", effectDigest}`. Everything else, damage
included, is `indeterminate` with `effectDigest:null`.

**`effectDigest` mapping**, agreed with the agent-comms coordinator:
- normal applied: SHA-256 of the canonical `completed` record;
- final pre-effect refusal: SHA-256 of the canonical `refused` record;
- early preparation refusal: null;
- indeterminate, from this producer: null. Entered evidence is never reported
  as an `effectDigest`. The broker's codec may accept a non-null indeterminate
  value, and we don't narrow it.

`preparationDigest` is SHA-256 of the exact canonical slot-6 bytes. Neither
`d1` nor the check carries it; the daemon links it.

**Final-refusal reasons**, per agent-comms `77bb19c` (#212). All 34 shared
`effect-outcomes-v1.json` mappings are vendored and tested.

| Reason | Public code |
| --- | --- |
| `expired` | `deadline-expired` |
| `expected-state-changed`, `proposal-not-pending`, `stage-invalid`, `target-unavailable`, `validation-failed` | `validation-refused` |
| `trust-unavailable` | `authority-refused` |
| `storage-unavailable` | `storage-refused` |

`storage-refused` is emitted only for a durably recorded refusal. Failing to
record one stays `storage-failed` or uncertain.

Not yet validated here: the presence and receipt token signatures (the
receipt verifier is C2), the live revision journal behind the linked event,
and the reconciliation pairs and local outcome slot.

### C2 contract (from the agent-comms coordinator, recorded for the writer)

- **Relay events.** Each one is a single bounded line on the existing NDJSON
  account watch. There is no transport acknowledgement. The prepared, check
  and result requests are the protocol responses. A lost socket never replays
  to another watch.
- **The check.** `mayApply:true` belongs to one live awaiting check, and the
  broker persists the release before replying, so a lost reply counts as
  released or uncertain. The final synchronous entry rechecks
  `now < receipt.exp`, trust readiness and the expected state after acquiring
  the locks. There is no extra grace interval, and a saved check is never
  replayed.
- **Presence.** `presenceKey` pins the separately owner-enrolled native p1
  key. The existing p1 protocol and audience stay as they are. The action
  text and `actionDigest` come from shared action vectors.
- **Results.** A result is authenticated against the current pairing and the
  saved binding:
  - an identical retained result returns `recorded:false` with the current
    state;
  - a different one is a conflict;
  - when the broker is unavailable, the exact report is kept for explicit
    retry without any effect;
  - receipt expiry doesn't block reporting an executed result.
- **Early refusal.** It sends `receiptDigest:null` and `effectDigest:null`,
  with the fixed outcome and the saved binding. No prepared event is sent.
- **Cancel.** Cancel wins only before the broker's durable authorization.
  After that, the daemon's cancel event is a hint and never effect authority.

## Watch identity for relay intake

`owner-decision-watch.mjs` is the comms-side dependency for any
owner-decision relay intake (agent-comms#77).

- **Recording.** The broker's account-watch `ready` event carries `watchId`,
  `daemonEpoch` and `daemonKey`, per agent-comms `a6e9901` (#210). `daemonKey`
  is SHA-256 of the exact daemon vouch SPKI DER bytes presented at pairing,
  never of the PEM. The supervisor records these once per socket, in memory
  only, and only if the fields are well formed and `daemonKey` equals the
  value we compute ourselves from our own vouch key.
- **When nothing binds.** An old broker's bare `ready` binds nothing,
  silently, and so does a daemon with no expected key configured. Wake and
  launch keep working either way. Partial or malformed fields, or a
  `daemonKey` that isn't ours, also bind nothing but are surfaced as an
  `owner-watch-identity` error in the watch's `lastError`. They are never a
  silent no-op.
- **First ready only.** The identity binds at the first `ready` of a socket.
  A repeated `ready` or `{ok:true}` on the same socket never replaces or
  clears it, and is surfaced as an `owner-watch-identity` error. The expected
  key must be an Ed25519 vouch key, 44 SPKI DER bytes.
- **Reconnects.** A reconnect drops the identity, and nothing is replayed.
  `watchIdentity()` exposes the live identity; `daemon status` output is
  unchanged.
- **Intake.** `ownerDecisionIntakeBound` accepts an `owner-decision-prepare`,
  `owner-decision` or `owner-decision-cancel` event only when its three
  bindings equal the socket's identity exactly.
- **Still disabled.** Intake doesn't happen yet. Every owner-decision event is
  dropped before the wake path, and an event that isn't bound to the socket's
  identity is surfaced as an error, and the daemon doesn't pass its expected
  `daemonKey` yet, so no identity is bound in production.

## Prepare-side target resolution

`owner-decision-target.mjs` (soul) resolves an owner decision's target at
prepare time. It is disabled, with no route or transport.

- **How it resolves.** By Agent ID, from this daemon's own local state: the
  population census (`showSoul`) and the identity record (`identityOp('read')`),
  read before any lock is taken. It never consults comms hub membership or
  receive allowlists. The account must equal the daemon's own paired account.
- **One refusal.** A target is refused if any of these hold:
  - the Agent ID or account is malformed;
  - it belongs to another account;
  - it is missing from the census;
  - it is retired in the census or in its identity record;
  - its identity record names a different soul;
  - either read fails.

  Every such case gets the same frozen early refusal:
  `{state:"refused", receiptDigest:null, outcome:{code:"validation-refused", effectDigest:null}}`,
  with no detail.
- **Same work every time.** Every case does exactly one census read and one
  identity read. A malformed Agent ID reads a fixed placeholder, never its
  input.
- **Fixed reads only.** `resolveOwnerDecisionTarget` is the only export
  that resolves. It performs only its fixed census and identity-entry reads,
  and no read function or read result can be injected: classification is
  internal.
- **Caller attaches the binding.** The refusal carries no request binding. C2's
  `owner-decision-result` caller attaches the saved acceptance binding
  `{requestId, payloadDigest, daemonKey, daemonEpoch, watchId}` itself when it
  reports the refusal.
- **What it doesn't promise.** The timing is equal in kind (local reads, no
  network), not constant-time. A resolved target only means "local and live
  at prepare time". Final entry rechecks under its locks, through the
  in-process identity read that is still pending an owner decision.

## d1 receipt verification (disabled)

`identity/owner-decision-receipt.mjs` verifies one broker d1 receipt, as
specified in agent-comms `docs/owner-decisions.md`. The tests check it against
the issuer vectors at `c7f7ea0` (#213) and their source `v1.json`, both
vendored and pinned. It only verifies: no slot write, release or route.

A receipt verifies only if all of these hold:
- **Token form.** ASCII, at most 4096 bytes, of the form `d1.<payload>.<signature>`.
  Both segments are canonical unpadded base64url, and the payload is exact
  canonical JSON with the 14 fields.
- **Audience.** `aud` is `agent-comms-owner-decision`.
- **Clock.** `0 < exp - iat <= 60`, `iat <= now + 30` and `now < exp`. This
  matches all eight shared clock cases.
- **Keys.** `brokerKey` equals the active receipt pin's key ID, and the
  signature verifies under that pin. `presenceKey` equals the active presence
  pin's key ID.
- **No aliases.** The receipt, presence and vouch (`daemonKey`) key IDs are
  pairwise distinct.
- **Saved challenge.** The request, principal, account, soul, operation,
  payload digest and nonce equal the saved challenge (slot 3). Its `daemonKey`
  is ours, and `exp` is no later than the challenge's.
- **The p1.** `presenceDigest` is SHA-256 of the exact p1 token, and `exp` is
  no later than the p1's stated expiry.

The p1 signature and action-text verification belongs to the native presence
verifier, a separate slice that needs shared action vectors.

## Action decoding and native p1 verification (disabled)

`identity/owner-decision-action.mjs` is the daemon's own implementation of the
owner-decision action grammar: agent-comms `docs/owner-decisions.md` and
`docs/owner-decision-wire.md` at `9edd21b`. It imports no agent-comms code.

- **Decoding.** `decodeOwnerDecisionAction(bytes)` takes the exact action
  bytes. It enforces the strict canonical encoding:
  - at most 32 KiB, with nesting at most 8 deep;
  - sorted ASCII keys and no whitespace;
  - safe integers only, with no `-0`;
  - strings of Unicode scalar values only (no unpaired surrogates);
  - every alternate spelling refuses.

  It then validates the typed operation, rebuilds the exact one-line text the
  owner's native presence signs, and returns `payloadDigest` and
  `actionDigest`. The text refuses, and is never truncated, past 400 Unicode
  scalars or past 500 UTF-8 bytes.
- **Display rejections.** A reason, and the rebuilt display text, refuse any
  scalar in the agent-comms owner-display rejection policy: every Unicode
  17.0.0 Cc, Cf, Zl and Zp code point. That covers controls, bidi overrides
  and isolates, zero-width characters, the BOM, tag characters, and the line
  and paragraph separators.
  - The policy is a frozen literal table of 25 inclusive ranges
    (`OWNER_DISPLAY_REJECTED_RANGES`), never an ambient `\p{}` property, and
    it equals `display-rejections-v1.json`. That file is vendored from
    agent-comms `62aaba9` (merged #221, reviewed signed head `cb7b8e9`),
    SHA-256 `2c2c7b75…`.
  - The decoder is still disabled: nothing here enables owner decisions at
    runtime.
  - Everything else is kept exactly, with no trimming or normalization:
    right-to-left scripts, combining marks, variation selectors, and a
    literal `\u202E` written as text.
- **Verifying.** `verifyOwnerDecisionPresence(p1, { actionBytes, nonce, trust,
  nowMilliseconds })` verifies the p1 against the active presence pin from
  `readOwnerDecisionTrust`. That pin is the future native signer, which trust
  readiness already refuses to be keyd's legacy seed. Its key ID is recomputed
  from its key. The check uses agent-bot's existing keyd p1 semantics,
  unchanged: audience `agent-bot-owner`, kind `presence`, at most a 120-second
  lifetime, 30-second skew. The p1 must sign this action's text and the
  challenge nonce, which must be exactly 32 bytes in canonical base64url.
- **Replay protection keys on the nonce.** Any future replay protection must
  key on the nonce, never on `presenceDigest`. Flipping the unused trailing
  bits of the signature's base64url gives a different token, and so a
  different `presenceDigest`, that still verifies.

The tests reproduce every category in the shared `v1.json` vectors: positive,
display boundaries, serialization, negative encodings, primitives and native
clock cases.

## Final-entry identity port (disabled)

The locked final entry can't launch a process or await, so it reads identity
through an in-process port instead of `identityOp('read')`.

- **The port.** `owner-decision-identity-port.mjs` (host) builds a frozen
  `{ kind: "owner-decision-identity-read-v1", read(id) }`. It uses identity's
  already-published `readAgentIdentity` (`identity-host.mjs`) in its new
  opt-in `custody: "strict"` mode.
- **Strict custody.** The record file is opened without following a link.
  Through the same descriptor it must be a regular file with one link, owned by
  this uid, writable by neither group nor others, the same object as its
  name, and at most 64 KiB. It then passes the
  same `validateIdentity`. Every existing caller keeps the default read
  unchanged, and `identity-soul.mjs` is untouched.
- **Trusted parents.** No-follow covers only the record's final path
  component, so `stateDir` and its parent directories must themselves be
  trusted (owned by this account or root, not writable by others).
- **The locked resolver.** `resolveOwnerDecisionTargetLocked` (soul) takes only
  that port. It checks the port's exact frozen shape, does the same fixed
  census read, and calls `read` synchronously. Each of these gives the same
  uniform target refusal: a missing or malformed port, a result that is a
  promise or thenable, or any strict-custody failure (symlink, extra hard link,
  foreign owner, oversize, invalid record).

## Effect-entry gate (disabled)

`owner-decision-effect-gate.mjs` (host) is the consumption point before any
owner-decision effect. It composes identity's trust readiness, native p1
verification and the request journal, now exported through `identity-host.mjs`,
with soul's locked target resolution. There is no route.

**Inside the journal's exclusive lock, in order, synchronously:**
1. The journal requires the request to be exactly `released`. A request that
   is already entered, applied or refused is consumed and refuses
   (`conflict`).
2. Re-read the current trust. It refuses with `trust-unavailable` if:
   - no pair is ready;
   - the stored receipt's `brokerKey` and `presenceKey` are not the active
     pair's key IDs, which the gate recomputes from the active public keys
     (or the stored receipt is unreadable);
   - the active pair was enrolled at or after this request's `preparedAt`
     (daemon wall-clock seconds; equality refuses).

   Then the stored d1 itself is re-verified with `verifyOwnerDecisionReceipt`
   under the current receipt pin: its signature, the acceptance `daemonKey`,
   the exact saved challenge and the stored p1. A receipt planted in the
   journal without passing intake (a bad or forger's signature, another
   challenge, request or p1) refuses with `validation-failed`, even when it
   names the right key IDs.

   The verifier's clock is the receipt's own `iat`, so the receipt is checked
   as it was issued. Entry is not tightened: the receipt's `exp` is at most
   the p1's, and the p1's re-verification on the daemon clock (with its skew)
   stays the only freshness bound. Checking the receipt against the daemon
   clock would cut entry short, by the p1 skew or by a receipt that expires
   before its p1.
3. The presented p1 must be exactly the one stored for the request, so an
   alias with flipped signature bits refuses. It is re-verified against the
   active presence pin, the preparation's own nonce and the daemon's clock.
   Failures refuse with `validation-failed`.
4. Re-resolve the target through the strict identity port. A target that is
   no longer live refuses with `target-unavailable`.
5. The journal builds the `entered` record itself, from the saved preparation
   and action, and publishes it to slot 9.

**What covers revoke, rotate and re-enroll.** The timestamp alone does not:
both sides are wall-clock seconds, so an enrollment in the preparation's own
second, or one stamped earlier after a clock rollback, would pass it.
- A revocation with nothing re-enrolled leaves no ready pair, so trust readiness
  refuses.
- A rotation of either key, in any second and across a clock rollback, is
  caught by the receipt key binding.
- A re-enrollment of the same pair is caught by the trust version binding
  (owner decision Q3). The v2 preparation records the active enrollment's
  chain version as `trustVersion`, and entry requires the current version to
  equal it, in any second and across a clock rollback. The timestamp layer
  remains as a second check. A v1 preparation has no version and never
  enters.

**Completion through the gate.** An `entered` result is frozen and carries
`complete(result)`, bound to the store instance that entered and to that
instance's one-shot entry handle. The raw handle isn't exposed.
- It completes only this request. A request ID inside `result` is ignored.
- It works once. A second call throws `owner-journal-entry-required`.
- Every journal refusal is thrown as the journal's own error.
- A refusal from the gate carries no completer.
- If the caller crashes or drops it, nothing can complete the request: a
  later gate call is consumed, and recovery reports `effect-uncertain`.
- A storage failure poisons the completer's instance, so the request stays
  `effect-uncertain`.

**What consumption means.** Durable `entered` is consumption. It is keyed per
request by the daemon-generated nonce in its preparation, never by
`presenceDigest`. A crash after it is `effect-uncertain`. Every refusal writes
nothing. No effect runs here.

## Effect completion and final refusal writers (disabled)

The journal store has two more writers, reachable only through the store that
`identity-host.mjs` exports, the same way `enterEffect` is. There is no route.
Each runs under the journal's exclusive lock and refuses a busy lock without
waiting. It reads and validates the whole request graph, flushes what it read,
and only then publishes one slot. The store builds and binds each record
itself, from the saved records and the signed action. Nothing changes in the
persisted format.

- **`completeEffect(entry, result)`** publishes slot 10, `completed`.
  - **Same instance only.** `entry` is the one-shot handle that `enterEffect`
    returned from this same store instance. It is unforgeable: held only in
    this instance's memory, keyed to the request and its entered-record
    digest. No request ID is accepted. It refuses (`storage-failed`,
    `owner-journal-entry-required`) without a live handle: none, a lookalike
    object, one from another instance on the same journal, one from before a
    crash or reopen, or one already used.
  - **Never after a crash.** An entered request that the entering instance
    did not complete stays `effect-uncertain` forever. Recovery and every new
    instance can never complete it, so nothing records an effect it did not
    see run.
  - **Consumption.** The handle is consumed once the write starts. A
    completion refused before then (busy lock, bad input) leaves it usable.
    The entered record must still be the one the handle entered.
  - `result` is `{at}`, no earlier than the entered `at`. For a revision it
    also carries what the effect reports: `journalSeq`, `journalRecordDigest`
    and `working`, which is null unless the entered record applies.
  - A cold-wake request is then `applied`. A revision stays `indeterminate`
    until its linked authoritative event is present, as the reader already
    requires. That event's writer is a separate slice.
  - Like every writer, it refuses (`storage-failed`, `owner-journal-corrupt`)
    while an unknown or excess entry is in `requests/`. That refusal is a
    storage failure and poisons the instance. The handle is not consumed,
    but the instance holding it refuses until reopened, and a reopened one
    has no handle, so the request stays `effect-uncertain`.
  - It refuses (`conflict`) if `completed` already holds anything.
  - It refuses (`storage-failed`) if the `entered` record is damaged or
    changed, or a cold-wake request carries a linked event.
  - Through the effect-entry gate, completion is the gate's bound
    `complete(result)` (below).
- **`refusePreEffect(requestId, {code, at})`** publishes slot 8, the final
  pre-effect refusal.
  - It is legal from `preparing`, `prepared`, `authorizing` or `released`. It
    binds the SHA-256 of the saved receipt whenever one is saved, including
    in `authorizing` before the successful check, and `null` only when none
    is. The reader requires exactly that.
  - `code` is one of the eight final-refusal reasons. The request is then
    `refused` with the mapped public outcome.
  - It refuses (`conflict`) once the request has entered, is applied, or is
    already refused.
  - It refuses (`storage-failed`) for an admitted request.

Malformed input refuses as `bad-request` and writes nothing. A refused
transition doesn't poison the store instance; a storage failure does.

**After a crash between writes:**
- A completion body without its trailer is `effect-uncertain`, and is never
  completed again: the handle is gone.
- A committed completion is `applied` (cold-wake).
- A refusal body without its trailer refuses as found, and the request can no
  longer enter.
- A committed refusal is `refused`, with its mapped outcome.

## Check intake writers (disabled)

Two more journal store writers carry a prepared request to `released`. Like
the effect writers, they are reachable only through the store `identity-host.mjs`
exports, with no route. Each one:
- scans `requests/` first inside the journal lock;
- reads and validates the whole graph;
- flushes what it read;
- refuses a busy lock without waiting.

No persisted format changes.

- **`recordDecision(requestId, {presenceToken, receiptToken, trust, nowMilliseconds})`**
  publishes slot 4 `presence`, then slot 5 `receipt`.
  - It is legal only from `prepared`.
  - It verifies the p1 with `verifyOwnerDecisionPresence`, against the saved
    action, the preparation's own nonce and the presence pin in `trust`.
  - It verifies the d1 with `verifyOwnerDecisionReceipt`, against the receipt
    pin, this daemon's key from the acceptance, the exact saved challenge and
    that p1.
  - A verification failure refuses (`owner-journal-intake-refused`) with the
    verifier's reason as `refusal`, and writes nothing. The request is
    otherwise `authorizing`.
  - It refuses (`conflict`) if presence or receipt already holds anything, or
    the request is released, refused, entered or applied.
  - It refuses (`storage-failed`) for an admitted or preparing request.
- **`recordSuccessfulCheck(requestId, {check, nowMilliseconds})`** publishes
  slot 7, the one successful check, canonically.
  - It is legal only from `authorizing` with both presence and receipt.
  - The check must decode as a released `mayApply:true` check naming exactly
    the acceptance binding and the saved receipt's digest. Otherwise it
    refuses as `bad-request`.
  - It must be unexpired now (`now < exp`, in seconds). Otherwise it refuses
    with `refusal:"check-expired"`.
  - The request is then `released`. A saved check is a conflict, never
    replaced or replayed.

Malformed input refuses before the lock. A refused intake doesn't poison the
instance; a storage failure (an unknown `requests/` entry included) does.

**After a crash between writes:**
- With presence committed but no receipt, the request is `authorizing` with
  no successful check possible. Intake again is a conflict, and a final
  pre-effect refusal ends it.
- A receipt or check body without its trailer refuses as found.
- A committed check is `released`.

## Before wiring

These are open items for whoever wires the disabled owner-decision pieces to a
route. None is built here.

- **Revision-journal custody and the domain lock.** The revision port checks
  custody of the record and its fixed ancestry, but not macOS ACLs, which
  Node can't read without exec or native code. It doesn't hold the revision
  lock: the effect step must append the record and the completion must read
  it back under one domain lock, against the expected state the preparation
  recorded. That atomicity, and integrating the expected-state check, are a
  separate acceptance item. Anyone who can write the revision journal or the
  daemon journal directly can still plant a record or slot 13; only custody
  protects against that, as with slots 2 and 7.
- **Working digests are mechanism only.** An applying edit's `working`
  digests are the completion caller's assertion. Nothing derives them yet
  from validated actual state, independent of the linked head, so they are
  not proof.
- **One state tree.** The effect-entry gate derives every location from the
  daemon's environment, but the resolvers don't all honour the same
  overrides:
  - `stateDirectory()`, which holds identities and revisions, honours
    `AGENT_BOT_STATE_HOME` and `QWTS_AGENT_STATE_HOME`;
  - `populationFile()` honours `AGENT_BOT_POPULATION_PATH`;
  - the comms credential honours `AGENT_BOT_COMMS_DAEMON_PATH`;
  - the trust store and the journal honour only `XDG_STATE_HOME` and `HOME`.

  Wiring must pin these at daemon start, or make the overrides consistent,
  so that identities, revisions and the census can't sit in a different
  tree from trust and the journal.
- **Custody of the comms pairing credential.** The gate takes the daemon's
  account from the comms pairing credential, which `loadCommsCredential`
  reads on POSIX non-blocking as a regular file only, but still following
  links. Before wiring, that read needs custody: no-follow, owned by this
  uid, mode 0600.
- **Authenticate the check's source.** The slot-7 successful check is unsigned
  JSON from the caller. Before calling `recordSuccessfulCheck`, wiring must
  authenticate its source as the broker, by its peer uid on the connection.
  The journal checks only that the check names the saved binding.
- **Pass current trust to intake.** `recordDecision` verifies against the pins
  its caller passes, so wiring must pass the current pins from
  `readOwnerDecisionTrust`.
  - Forged pins (a forger's key under the real key ID) fail at intake,
    because both verifiers recompute key IDs.
  - Stale pins after a rotation get through intake. The effect-entry gate,
    which reads real trust, then refuses with `trust-unavailable` and never
    enters.
- **Torn intake slots use a slot until a cleanup path exists.** A torn body in
  slot 4, 5 or 7 leaves the request refusing as `owner-journal-unsupported-phase`.
  That fails closed: it never releases or enters. But the request keeps its
  charged directory until a reviewed cleanup path exists. That path is an
  open item.
- **A preparation written around the writer.** The writer records only the
  live trust version, so a caller can't preset a future one. A preparation
  written straight into the journal, bypassing the writer, could still claim
  any version. As with slot 7, only the daemon's custody of its own journal
  protects against that.
- **The check's expiry is not bounded by the receipt or preparation.**
  `check.exp` is checked only against the daemon clock at intake. The gate's
  re-verification of p1 freshness at entry is what bounds the window in
  which a released request can enter.
- **The successful check isn't re-verified at entry.** It's unsigned, so
  there is nothing to re-verify; only the daemon's custody of its own journal
  protects slot 7. Entry does re-verify the stored p1 and d1. A slot-7 check
  planted next to a genuine p1 and d1 that the broker never released would
  still enter. Authenticating the check's source at intake, the first item
  above, is the only defence before wiring.

## Reconciliation pairs (disabled)

Slots 11 and 12 hold the reconciliation pairs from agent-comms d071a9b:
`observation-pair` is the indeterminate observation, and `terminal-pair` is the
immutable applied or refused resolution. Each is exactly canonical
`{preimage, record, v:1}`: the reconciliation record, at most 2048 bytes; its
revision or cold observation preimage, at most 2048 bytes; at most 256 wrapper
bytes; and at most 4352 bytes in all. `observedDigest` is the SHA-256 of the
canonical preimage. The six typed pairs are in the vendored
`journal-budget-v1.json`.

**Binding** (`bindReconciliationPair`). A pair binds to:
- the acceptance's payload and original daemon key and epoch; the pair codec
  binds the request ID to the frame;
- the saved preparation's `effectId`, or null when no preparation exists;
- its proof: `basisDigest` is the SHA-256 of the exact completed record for
  applied, of the exact pre-effect refused record for refused, and null for
  an indeterminate observation;
- the operation's preimage kind: cold state for `cold-wake.set`, otherwise a
  revision observation whose working digests are present exactly for an
  applying edit.

The reporting daemon key and epoch, and the observed state, are the
ceremony's own.

**Writers.** Both are disabled with no route, and both are store methods
reachable through the host contract. Each runs under the journal lock:
- the request scan comes first;
- then the whole-graph read and the recovery flush;
- then one publication.

The same bytes again are an idempotent duplicate. Anything else already in
the slot is a conflict: replacing an observation is a separately reviewed
recovery. A refused write doesn't poison the instance.
- **`recordObservationPair`** is legal only when the request is indeterminate
  after entry, with a readable or absent preparation. Applied, refused, or a
  terminal pair already present is a conflict.
- **`recordTerminalPair`** is legal only for an applied request, with its
  completed basis, or a refused request, with its pre-effect refused basis.
  Entered without completion never justifies refused.

**Reader.**
- A terminal pair beside a pre-effect refusal must bind to it; otherwise the
  request refuses as corrupt.
- Beside an applied effect, a mismatched pair leaves the request
  indeterminate.
- A terminal pair before entry, with no refusal, refuses as an unsupported
  phase.
- Beside an entered-only request, a terminal pair leaves it indeterminate,
  which fails closed.
- An observation pair leaves the request indeterminate, as before.

## Preparation writer and trust version (v2, disabled)

`recordPreparation(requestId, {preparation})` writes the v2
preparation (owner decision Q3; agent-comms `effect-evidence-v2.json` at
bf0b705, vendored), then the exact prepared challenge it implies.
- **What the record holds.** The v1 fields plus `trustVersion`: the active
  trust enrollment's chain version, an odd integer from 1 to 1023. The caller
  never supplies it. The store reads live trust itself:
  - it calls `readOwnerDecisionTrust` for this journal's namespace, on the
    daemon's own trust store, resolved from its launch env and home the
    same way `readOwnerDecisionTrustObservation()` does, never a store the
    caller names;
  - it takes the trust lock inside the journal lock, and refuses rather than
    waits;
  - it records that version.

  No ready active pair, a busy or damaged trust store, or another namespace
  refuses with `owner-journal-trust-unavailable` and writes nothing. A
  `trustVersion` in the call or inside `preparation` refuses. The store adds
  `v:2`, `kind` and `trustVersion`, and binds the record to the admission
  and action.
- **What stays the same.** The challenge never carries `trustVersion`.
  Downstream effect and reconciliation records stay v1, bound to the v2
  preparation's digest.
- **Phases.** Legal from `admitted`, or from `preparing` with the same
  preparation, which finishes its challenge after a crash. The same
  preparation again is an idempotent duplicate. A different preparation, or
  any later phase, is a conflict.
- **Locking.** It runs under the journal lock: the request scan first, the
  recovery flush before writing, and a busy lock refuses. A refused input
  doesn't poison the instance.

The decoder accepts v2 and keeps v1 for the vendored v1 vectors. The
effect-entry gate requires the current chain version to equal the
preparation's `trustVersion`, so a v1 preparation never enters.

**One trust store by construction.** The preparation writer and the
effect-entry gate both take no trust root, env or home. Each reads the
daemon's own store, resolved from its launch environment and home, so they
read the same store as the trust observation. A second, custody-valid store
under the same namespace can't be selected through either.

## Local lifecycle outcome, slot 14 (draft, disabled)

`identity/owner-decision-local-outcome.mjs` drafts the producer-owned
validation of daemon slot 14, `local-lifecycle-outcome`. It's pure: no
writer, route or reader integration yet.

**Shape.** The record is agent-comms' exact outcome object (d071a9b, "Exact
administrative records"): `{v:1, kind:"outcome", requestId, payloadDigest,
state, receiptDigest, outcome:{code, effectDigest}, source,
reportingDaemonKey, reportingDaemonEpoch, at}`. It's strict canonical JSON, at
most 4096 bytes. This isn't the broker's lifecycle validator. In this daemon
slot:
- `source` is always `daemon`, with a reporting key and epoch;
- the reporting key must be this daemon's key from the acceptance, and the
  epoch never goes back;
- `requestId` and `payloadDigest` are the acceptance's;
- `receiptDigest` is the saved receipt's, or null when none exists. The
  context requires none before the decision arrives (admitted, preparing,
  prepared) and one from released onward (released, indeterminate, applied).
  In authorizing the presence may arrive without its receipt, and a refusal
  may come before the receipt, so both may be either.

**Context.** The finding comes from the request's validated journal graph,
using the effect-outcomes-v1 mapping, never from the record:

| Phase | Allowed (`state`, `code`, `effectDigest`) |
| --- | --- |
| admitted | refused with validation-refused, authority-refused or deadline-expired (null): before a valid preparation, no record exists |
| preparing, prepared, authorizing | none: from preparing on, a refusal must be proven by the durable `effect.refused` record (phase refused); a missing completion proves nothing |
| released | indeterminate, effect-uncertain (null): released without effect proof |
| refused | refused, with the mapped code of the refused record's reason and that record's digest |
| indeterminate | indeterminate, effect-uncertain (null) |
| applied | applied, with the completed record's digest |

Storage-refused exists only with its durable refusal digest. The daemon
never reports `cancelled` or `expired` in slot 14; the broker owns those, and
a deadline passing is refused / `deadline-expired`. If a broker cancellation
is ever needed locally, it belongs in separately typed local bookkeeping.

**Local outcome, not a wire result.** Slot 14 is the daemon's local record.
- A normal broker-reportable result stays bound to the exact original
  `daemonKey`, `daemonEpoch` and watch binding, with its saved receipt.
- A local observation under a current epoch greater than or equal to the
  acceptance's needs explicit projection or reconciliation, never direct
  forwarding.
- A corrupt graph with an unrecoverable receipt may keep only a
  conservative local indeterminate diagnostic. It is never a normal broker
  result with a null receipt.

The vectors stay draft and claim no wire conformance.

**Vectors.** The draft semantic vectors are
`tests/fixtures/owner-decisions/local-lifecycle-outcome-v1-draft.json`: 10
positive and 34 negative. Each carries its context, the exact record bytes,
their SHA-256 and the SHA-256 of the slot-14 frame for a fixed namespace and
request.

## Exact byte input (disabled decoders)

Every owner-decision decoder that takes bytes reads only the input's intrinsic
bytes, through `identity/owner-decision-bytes.mjs`. It applies to:
- the frame codec and reconciliation pairs;
- preparation and effect records;
- the action decoder;
- the linked event;
- the trust observation validator;
- the slot-14 local outcome.

It checks the view's intrinsic `[[TypedArrayName]]` and byte length, using
%TypedArray%.prototype getters by `Reflect.apply`, then decodes a private
bounded copy. An input's own `length`, `byteLength`, `buffer`, `byteOffset`,
`subarray` or `slice` is never read. So an oversized view that claims to be
small can't pass a cap, a misleading property can't change what's decoded,
and a Proxy, a lookalike or another typed array isn't bytes.

## Revision completion with the linked event (disabled)

A revision completes through the gate's bound `complete({at, journalSeq,
working})`. The gate builds its identity port and its revision-journal port
(`owner-decision-revision-port.mjs`, read-only) itself, over the daemon's
own state directory, resolved from its launch env and home as the trust root
is. It takes no port from its caller, so neither the bytes nor the port that
reads them can come from a caller. The store's
`completeEffect(entry, result, {readLinkedEvent})` then does this:
- **Reads the bytes itself.** It reads the exact revision-journal record at
  `journalSeq` through the port, for the action's soul. It never accepts
  linked-event bytes, or a `journalRecordDigest`, from the caller.
- **Verifies them.** They must be this request's linked authoritative event
  (`verifyLinkedEvent`): the operation, the proposal and the exact
  five-field linkage. The event's revision must be the entered transition's.
  `journalRecordDigest` is the SHA-256 of those bytes.
- **Writes in order.** It consumes the one-shot handle, publishes slot 13
  (the linked event), then publishes slot 10 (completed). The request is
  then `applied`.

A read or verification refusal writes nothing and keeps the handle for an
explicit retry. Once writing starts, the handle is gone: a failure in or
between the two publications is never retried, and the request stays
`effect-uncertain`. A linked event already present refuses. Cold-wake is
unchanged, with no linked event.

**After a crash between slot 13 and slot 10.** The request stays
indeterminate. Following agent-comms' owner-decision-locking contract, the
only way forward is explicit owner-local reconciliation:
- **Record-only operations** (approve, reject, adopt, and edit with apply
  false). Only an authenticated owner-local ceremony may produce the missing
  typed completed record. It builds it from the retained entered record, the
  validated linked event and the immutable package, after a resync and
  verified matching actual state, and reserves slot 10 to write it.
- **What that record carries.** The exact `journalSeq` and
  `journalRecordDigest`. The public `effectDigest` and the terminal pair's
  `basisDigest` stay the SHA-256 of those completed bytes.
- **Never automatic.** It is never run automatically and never replays the
  consumed completer.
- **Applying edits and cold-wake** need whole-effect proof and otherwise stay
  uncertain.

The record-only half is now a disabled writer (see "Record-only
reconciliation" below). Until the daemon verifies actual state, matching
from a ceremony's preimage is mechanism-only.

**Port custody.** For `<stateDir>/soul-revisions/<agentId>/<seq>.json`:
- The fixed ancestry (the state directory, `soul-revisions/` and the agent
  directory) must be real directories, owned by this uid, with no group or
  world write.
- The agent ID must be a soul ID and the sequence a safe integer, so neither
  can name another file.
- The record must be the file the name points to, opened no-follow, with one
  link, owned by this uid, no group or world write, and 1 to 16384 bytes.
- The open is no-follow and non-blocking, so a FIFO at the path, even one
  swapped in after the name check, opens at once. The opened file must then
  be a regular file with one link before the read.
- The read is exact. Afterwards its size, mtime, link count, owner and mode,
  and named identity must be unchanged, and so must the device and inode of
  every directory in the fixed ancestry.
- macOS ACLs aren't checked (see Before wiring).

## Record-only reconciliation (disabled)

`reconcileOwnerDecisionRecordOnly({requestId})` (host,
`owner-decision-reconcile.mjs`) completes a record-only revision that crashed
between slot 13 and slot 10. It has no route and nothing calls it. Like the
gate, it takes only the request ID. The journal root, the namespace (from
`readOwnerDecisionTrust()`), the state directory and the clock are the
daemon's own.

**Steps**
1. `readRecordOnlyReconcilable(requestId)`, under the journal lock, refuses
   anything but one of these:
   - a record-only revision (approve, reject, adopt, or edit with apply
     false) that entered with a non-empty slot 13 and an empty slot 10;
   - one already completed but without its terminal pair (a crash between
     the two writes).
   An applying edit, a cold-wake request or a request without slot 13 refuses
   `owner-journal-transition-refused`. A slot 10 that isn't a valid
   completion, or a request already settled, is `owner-journal-conflict`.
   This happens before any ceremony.
2. The owner ceremony: the existing local owner gate (`revisionOwnerGate`),
   naming the request and soul. The gate is async, and the reconciler
   awaits it: nothing below runs until presence or consent is proven. A
   refusal, thrown or rejected, writes nothing (`ceremony-refused`). The
   completion time is taken after the ceremony.
3. For a revision that changes the head, the stored package at the entered
   after-revision must still validate to it (`package-invalid`).
4. A resync through the daemon's read-only revision port: the record in the
   soul's revision journal whose exact bytes are slot 13 gives `journalSeq`
   (`linked-event-missing` if none). The current head and proposal form the
   ceremony's preimage. That match is mechanism-only, not daemon-verified
   actual state.
5. `reconcileRecordOnlyCompletion`, under the journal lock:
   - It refuses a non-empty slot 12, or a non-empty slot 10, as
     `owner-journal-conflict`.
   - It re-reads the linked event at `journalSeq`. That event must be
     exactly slot 13's bytes and verify as this request's
     (`verifyLinkedEvent`), and a revision's must name the entered
     after-revision. Otherwise it refuses `owner-journal-linked-event-refused`.
   - It builds the typed completed record from the retained entered record:
     `journalSeq`, `journalRecordDigest` (SHA-256 of slot 13), `working`
     null, and a time not before entry.
   - It writes slot 10, then the terminal pair (slot 12, finding `applied`,
     basis the completed record). For one already completed, it writes the
     pair only. Nothing is ever overwritten.

**auditId.** The owner chose, in session on 2026-10-12, to mint the
`auditId` per ceremony (a random UUID). The terminal pair is the durable
record, with no separate audit record type.

**Crash between slot 10 and the pair.** The request reads `applied` (slot 10
alone is a valid completion). A retried reconciliation writes only the
pair. Once the pair exists, a further one is a conflict, refused before any
ceremony.

The store's early checks of `at`, `auditId` and `preimage`, and its bind of
the completed record and the pair it builds, are repeated by the encoders
and are self-checks with no separate test.

## What the effect-entry gate takes from its caller

`enterOwnerDecisionEffect({requestId, presenceToken})` takes only the request
it is presented. Everything that names a location of state or proof, an
identity or the clock is derived from the daemon's own launch environment
and home, and any other argument is ignored.

| Input | Source |
| --- | --- |
| The journal | `ownerDecisionJournalRoot()`, the daemon's own root |
| The broker namespace | the daemon's own trust store (`readOwnerDecisionTrust()`) |
| The trust records | the daemon's own trust store |
| The identity and revision-journal ports | built over `stateDirectory()` |
| The census | `populationFile()` |
| The daemon's account | its own comms pairing credential (`loadCommsCredential().account`) |
| The time | `Date.now()` |

The pairing credential is read with the comms client's file-level custody;
on POSIX that is a plain read of the daemon's own state file.

**Still caller-supplied, and why:**
- `requestId` names which request is presented. It only selects a journal
  entry, which must be exactly `released`.
- `presenceToken` is the p1 being presented. It must equal the stored p1 byte
  for byte, and it is re-verified against live trust and the clock.
- The completer's `{at, journalSeq, working}` is what the effect step reports:
  - `at` is a timestamp, bounded to no earlier than entry;
  - `journalSeq` only selects which record the gate's own port reads, and
    those bytes are verified;
  - `working` is mechanism-only, not proof (see Before wiring).

**Non-blocking custody reads.** Every owner-decision custody reader opens its
file no-follow and non-blocking, then checks the opened descriptor before it
reads. So a FIFO at the path refuses at once instead of hanging the daemon.
That covers:
- the revision port;
- the strict identity read;
- the vouch key read, including the trust writer's vouch identity;
- the trust store reads, and keyd's presence pin cache (a deny-list, so
  anything but a regular file there counts as no pin);
- the trust audit append (a FIFO fails the open at once);
- the journal's slot files and directory flushes;
- the comms pairing credential and the soul census read (both still follow
  links, as before).

The pairing credential's no-follow, owner and 0600 checks remain under
Before wiring.
