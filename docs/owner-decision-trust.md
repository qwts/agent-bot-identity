# Owner-decision trust records (disabled)

Part of the [owner-decision daemon journal](owner-decision-journal.md) (#1007).

`identity/owner-decision-trust.mjs` holds the daemon's owner-decision trust
records (ADR-0077 §4–5). They are disabled. No route or command reaches them,
and the writer exists only for the future local owner installation ceremony,
which is not built. A record that merely parses grants nothing. Comms pairing
(`comms-daemon.json`) and the vouch key are separate and untouched.

**Layout.** Everything lives under `$XDG_STATE_HOME/agent-bot/owner-decision-trust/`.
The directory is 0700, and every ancestor must be ours or root's and not
writable by others unless sticky.

| Name | Contents |
| --- | --- |
| `.trust-lock` | One `O_EXLOCK\|O_NONBLOCK` lock covering the namespace, the chain and the audit file. |
| `namespace.json`, `namespace.confirm.json` | The immutable namespace record and its confirmation. |
| `keys/<v10>.json`, `keys/<v10>.confirm.json` | The key chain, versions 1–1024, each with its confirmation. |
| `audit.jsonl` | The dedicated trust audit file. The shared audit log is never used. |

Each file is checked through its opened descriptor: a 0600 regular file with
one link, opened no-follow. Records are exact canonical JSON with no trailing
newline. The byte caps are 1024 for a record, 512 for a confirmation and 512
for an audit line.

**Namespace.** The record is
`{v:1,kind:"owner-decision-broker-namespace",namespaceDigest,enrolledAt,auditId}`.
`namespaceDigest` is the broker's SHA-256 of
`"agent-comms-owner-broker-namespace-v1\n"` followed by its random 32-byte
installation ID. We only ever store the digest. The pinned form is lowercase
64-hex, checked against agent-comms' published derivation vectors
(`broker-namespace-v1.json` from agent-comms `11767ad`, vendored and pinned by
SHA-256). Uppercase and base64 spellings are refused. A raw ID written as hex
also looks like 64-hex, so only the owner ceremony's published digest is ever
enrolled. The record is created once and
never minted, reset or replaced. Re-enrolling the same digest changes nothing,
and a different digest is a `conflict`.

**Key pins.** The chain is hash-linked: version 1 links to the namespace
record's digest, and each later version to its predecessor. There are two
record kinds:
- an enrollment, with `receiptKey`, `presenceKey` and
  `service:{platform:"darwin",brokerUid}`;
- a revocation, with `revokes` and a reason of `rotated`, `compromised` or
  `decommissioned`.

A key is canonical unpadded base64url of exactly 32 bytes and a valid Ed25519
point. Its `keyId` is SHA-256 of the Ed25519 SPKI DER, matching agent-comms.
The receipt and presence keys must differ, and neither may be this daemon's
own vouch key. That key's ID, `daemonKey` (SHA-256 of the vouch SPKI DER), is
derived at enrollment and at every readiness check from this daemon's
existing vouch key: `vouchDaemonKey` in `identity/vouch.mjs`, which reads
`$XDG_STATE_HOME/agent-bot/vouch-key.pem` read-only (the same env and home as
the trust root, never creating a key).
- A caller may pass `daemonKey`, but only as an exact check against the
  derived value. A mismatch refuses with `bad-request`.
- A missing or invalid vouch key refuses with `owner-decision-unsupported`.
  The key is never derived from input.
- An active pin equal to it refuses (`owner-decision-unsupported`).

**Four distinct key roles.** Never confuse these four:

| Key | Role |
| --- | --- |
| The native enrollment key | Used only for enrollment. |
| The native agent-bot-owner p1 signer | The trust record's `presenceKey`. |
| The broker's `receiptKey` | Signs receipts. |
| This daemon's vouch key | The source of `daemonKey`. |

`presenceKey` must pin the future native p1 signer, **never keyd's legacy
presence seed**.
- **Refusal.** An enrollment whose `presenceKey` equals keyd's legacy presence
  key refuses with `bad-request`. Readiness with such an active pin refuses
  with `owner-decision-unsupported`.
- **Where the legacy key comes from.** By default it is read, prompt-free, from
  keyd's cached pin `presence.pub` (`presencePinPath`). A caller or test may
  inject it as `legacyPresenceKey`; `null` means none.
- **The cache is a deny-list only.** A soul could write that file, so it can
  add refusals or miss one, but it never grants trust.
- **Why not re-derive it.** The code-signed re-derivation
  (`pinnedPresenceKey` / `pinnedPresenceKeyWithoutDialog`) is deliberately not
  run in trust checks. It executes `codesign` and the keyd binary, may touch
  keyd's Keychain item, and writes the cache and audit receipts. Its stronger
  check is left to the enrollment ceremony, which independently verifies the
  native signer. `service.brokerUid` is the broker's
own service account: never 0 and never the owner's uid. A stored enrollment
that breaks this rule is refused as damage.

At most one enrollment is ever active:
- a new enrollment is legal only when none is active;
- a revocation must name the active enrollment's digest exactly;
- rotating keys, or changing the service identity, means a revocation followed
  by a new enrollment;
- the namespace and the journal are never touched;
- the last version (1024) is reserved for a terminal revocation, so an
  enrollment is refused at version 1024 or above and every enrollment can be
  revoked. After that terminal revocation, growth stops: there is no new
  namespace, reset or fallback, and owner decisions are unsupported.

**Audit and confirmation.** Each record is published under a fixed
`.pending.json` name: write it and fsync, link it to the final name, fsync the
directory, unlink the pending name, fsync again. Then one line is appended to
`audit.jsonl` and fsynced. Then a confirmation is published:
`{subject:"namespace"|"key",version,recordDigest,namespaceDigest,auditId,auditLineDigest}`.
The audit append is not atomic with the record. The confirmation is what makes
the record usable. Growth is refused while any record lacks one.

**Readiness** is checked on every use, under the lock, and mutates nothing
except the explicit recovery flush. It enumerates with bounded `opendir`
reads, checks custody, fsyncs and rereads every file, replays the whole chain,
and requires every record to have its confirmation plus exactly one matching
audit line. An audit line for a missing record refuses. The public codes are:
- `owner-decision-unsupported`: missing trust, or no active enrollment;
- `storage-failed`: an unconfirmed record anywhere, including a revocation,
  with no fallback to an earlier key. Also a pending file, damage, a custody or
  bounds failure, an illegal transition, or another namespace.

Everything that fails is kept as found.

**Reconcile** is an explicit owner step. Before touching any name it
custody-checks the root, its ancestors and `keys/`. It reads pending files and
their twins only through no-follow descriptors, checked like every other
record and bounded. It makes only three repairs:
- it unlinks a pending name that is a second link to an already published file
  with the same inode and bytes;
- it links a lone pending file whose bytes are exactly the confirmation that
  the one unconfirmed record needs;
- it gives an unconfirmed record its audit line (marked `reconciled` if the
  line was never written), then its confirmation.

It never deletes bytes because they failed to parse. A lone unpublished record
or a torn audit line stays as evidence and refuses.

**Limits, stated honestly:**
- Flushes are node's logical fsync, with no physical guarantee.
- The chain detects gaps, forks and edits inside one snapshot. It cannot detect
  a restore of a complete older snapshot, or deletion of a complete suffix
  (records, confirmations and audit lines). Either could bring back a revoked
  key, so the broker's online revocation check before application stays
  mandatory.

**Namespace-only reader.** `readOwnerDecisionNamespace` exists so a host's
first key enrollment doesn't depend on the key chain it is about to start.
- **What it reads.** It runs under the same exclusive lock and applies the
  same custody, flush and validation as the full reader does for the namespace
  part. It requires `namespace.json`, its confirmation, and exactly one
  matching namespace line in the dedicated audit file.
- **What it never touches.** It never reads `keys/`. So it works before any
  keys exist, between a revocation and the next enrollment, and even while the
  chain is damaged.
- **What it returns.** Only `{namespaceDigest}`: never readiness, pins or
  authority.
- **Failures.** A busy lock, a pending audit or a pending publication refuses
  with `storage-failed` for an explicit retry. It never repairs, replays or
  writes anything.

The full `readOwnerDecisionTrust` stays mandatory for owner-decision
capability and for every trust check. Called with no `root`, it reads this daemon's own store, resolved from
the same env and home as its vouch key. The preparation writer and the
effect-entry gate always call it that way.

## Daemon trust observation (v1, disabled)

`readOwnerDecisionTrustObservation()`, published through `identity-host.mjs`,
returns the daemon source for the native trust ceremony (agent-comms#77, owner
decision Q1). It returns `{observation, observationBytes, observationDigest}`.
The observation is consistency input at observation time. It is never
authority, a live capability or a cross-account transaction, and equal digests
never replace the helper's single-use evidence, owner presence or writer
authority. There is no route.

- **Bytes.** `observationBytes` is the strict canonical JSON, at most 1024
  bytes; the largest valid observation is 999. `observationDigest` is the
  SHA-256 of those bytes, so consumers recompute it. No wire codec is defined.
- **Fields.** Exactly these, and no others:
  - `v:1` and `kind:"owner-decision-daemon-trust-observation"`;
  - `namespaceDigest`;
  - `namespaceRecordDigest`, this daemon's own `namespace.json` digest, never
    compared across stores;
  - `chainVersion`, the number of confirmed key records, 0 to 1024;
  - `headRecordDigest`;
  - `state`, which is `none`, `active`, `revoked` or `revoked-terminal`;
  - `active`, which is null or `{enrollmentDigest, receiptKey, presenceKey,
    service}` with complete KeyPins and full public keys;
  - `daemonKey`, this daemon's vouch key as a complete KeyPin.
- **States.** The state follows the version:
  - 0 is `none`, with the namespace record as head;
  - an odd version is `active`, and the pair is the head enrollment;
  - an even version is `revoked`;
  - 1024 is `revoked-terminal`.

  The producer checks this against the replayed one-active state machine and
  never projects a state it can't prove. A role alias among the receipt,
  presence and daemon keys refuses with `owner-trust-role`.
- **Resolution.** The production export takes no arguments. The root and the
  vouch key come only from the daemon's own `process.env` and home. Tests use
  the internal `observeOwnerDecisionTrust`.
- **Validation.** The producer runs under the exclusive trust lock, with the
  full readiness graph read and its recovery flush. Every record needs its
  confirmation and exactly one audit line. A pending publication, an
  unconfirmed record, damage anywhere in the chain or an impossible state
  refuses, with the same `{code, reason}` values the reader uses. It writes
  and repairs nothing.
- **Validator.** `validateOwnerDecisionTrustObservation(bytes)` is the frozen
  v1 validator. The 16 frozen vectors are vendored in
  `tests/fixtures/owner-decisions/daemon-trust-observation-v1.json`. The
  companion `daemon-trust-observation-v1-negatives.json` adds two exact-byte
  refusals built from the `none` vector:
  - a leading UTF-8 BOM, which must refuse `not-json`;
  - `namespaceDigest` as a one-element array of its valid hex, which must
    refuse `digest`.

  The 16 vectors themselves are unchanged.

## Versioned key writers (V1, disabled)

`enrollKeysV1` and `revokeKeysV1` write key records only against the exact
current observation (owner decision Q2). Each requires
`expectedObservationDigest`, the `observationDigest` its caller observed. The
unversioned `enrollKeys` and `revokeKeys` are retired fail-closed: they refuse
with `owner-trust-api-version` (`bad-request`) and write nothing, so an old
caller can't skip the expectation.

**Order, inside one hold of the trust lock:**
1. Capture the vouch key file's identity: device, inode, size and the
   SHA-256 of its bytes, compared in memory only. `daemonKey` is derived from
   those same bytes, so the pin and the identity can never come from
   different reads.
2. Read the full graph and derive the current observation. Every record must
   be confirmed.
3. Compare its digest with the expectation. A missing or malformed digest is
   `bad-request`; a mismatch is `conflict` (`owner-trust-stale-observation`).
4. Check the transition, pins and capacity.
   - Enroll needs `none` or `revoked` and at most version 1023. Its pins
     must not alias each other or `daemonKey` (`owner-trust-role`), and the
     presence pin must not be keyd's legacy presence key
     (`owner-trust-invalid-input`).
   - Revoke needs `active`, and the named enrollment must be the active one.
5. Re-check the vouch identity immediately before anything is created. A
   change refuses with `owner-trust-vouch-changed` and writes nothing.
6. Publish the record, then append and flush its audit line.
7. Re-check the vouch identity before the confirmation. A change stops with
   `owner-trust-vouch-changed`; the record and audit line stay, and only
   reconcile goes forward.
8. Publish the confirmation, then return the new observation.

Two writers holding the same expectation are serialized by the lock. The
second sees the first's new observation, gets `conflict`, and writes nothing.

**Refusal classes, by how far the write got:**
1. **Before any file:** input, version, expectation, transition, capacity,
   alias and the pre-creation vouch check. Zero writes.
2. **Pending record file:** preserved exactly. Readiness and observation refuse
   with `owner-trust-pending`, and reconcile keeps it as evidence.
3. **Record published, no confirmation:** the record and any audit line stay.
   Readiness and observation refuse. Reconcile first re-derives the vouch
   identity and refuses with `owner-trust-role` if the record's pins alias the
   current `daemonKey`. Only then does it link a staged confirmation that is
   exactly the deterministic one, or append the missing audit line and
   confirm.
4. **Confirmation visible, durability uncertain:** the writer refuses success.
   Only a later locked read with its recovery flush, plus reconcile for a
   leftover second link, settles it.

Nothing rolls back or retries automatically.

**Threat boundary.** The trust lock doesn't cover the vouch key file, and no
re-read is atomic with the write that follows it. The re-checks catch earlier
or accidental changes; they don't stop a same-account writer. That writer is
outside this design's trust boundary (ADR-0003). The broker's online checks and
the helper's independent installation proof remain the controls that matter.
