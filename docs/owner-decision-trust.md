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
- An active pin equal to it refuses (`owner-decision-unsupported`). `service.brokerUid` is the broker's
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
