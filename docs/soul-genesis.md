# Soul genesis (v1)

Issue #284 / ADR-0275 decisions 5, 6 and 9.

`mintAgentIdentity({ packagePath, parentId, ... })` computes the starting
revision with `computePackageRevision(packagePath)`. `agent-bot identity spawn
--package PATH` supplies this option in both local and daemon-backed spawning.
The daemon takes the parent from the authenticated binding. Package contents
are hashed, never executed or treated as authority. The claimed manifest
revision is not used as the genesis revision.

## Exact ID encoding

The SHA-256 input is UTF-8 of the following JSON object, with keys sorted by
UTF-16 code units, no whitespace, no BOM, and no trailing newline:

```json
{"nonce":"<64 lowercase hex digits>","parentSoul":null,"revision":"sha256:<64 lowercase hex digits>"}
```

A non-null `parentSoul` is the complete lowercase `agent_<uuid>` string,
JSON-quoted. Encoding uses `canonicalJson` from `soul-package.mjs`. The nonce
is 32 random bytes from Node's `crypto.randomBytes`, encoded as lowercase hex.
Take the first 16 bytes of the hash in digest order. Set byte 6 to
`(byte & 0x0f) | 0x80` (version 8) and byte 8 to `(byte & 0x3f) | 0x80`
(RFC 9562 variant). Format lowercase hex as 8-4-4-4-12 and prefix `agent_`.
This is a custom UUIDv8 SHA-256 layout, not UUIDv5. Each allocation collision
retries with a fresh nonce, at most eight attempts.

Fixed vectors (revision is `sha256:` followed by 64 zeroes; nonce is 64 zeroes):

| Parent | ID |
| --- | --- |
| `null` | `agent_9e735fcf-1896-80dc-9127-6faeead67aed` |
| `agent_11111111-1111-4111-8111-111111111111` | `agent_1df13176-d371-8e3e-850a-0d804b179893` |

## Identity and revision history

The optional identity-row field is `genesis: { revision, parentSoul }`.
It describes birth, independently of later lineage binding or package moves.
The nonce is deliberately not persisted, logged or returned. This prevents
an ID alone from testing guessed package contents. The row already discloses
its starting revision to its authorized reader; nonce privacy does not hide
that metadata. Recomputing an ID requires the original nonce, if retained
privately by a caller using the `nonceFactory` injection; default spawns
intentionally discard it.

New unpackaged souls store `genesis: null`. Pre-existing rows without the
field are read as `genesis: null`; the next normal row mutation persists that
marker. Reading does not rewrite historical files or change their IDs.

`recordAgentPackageRevision(id, packagePath, { appendRevision, stateDir })`
is the integration seam for the sibling revision-chain implementation.
It computes the revision and awaits `appendRevision({ agentId, revision,
genesis })`, including repeated revisions and undo, without reminting or
rewriting identity. The chain owner should call it to record the starting
revision and each subsequent adoption/move, storing events durably and
serializing moves. It rejects a missing writer and propagates storage errors.
Legacy adoption keeps a null genesis and the original ID. This port does not
install packages, switch a running harness, or implement the sibling chain
store or approval workflow.

## Parser audit

Repository searches for `agent_`, UUID bodies and version-restricted regexes
found two Agent ID regex implementations:

- `agent-identity.mjs` accepts versions 1–8 and RFC variant bits. Its registry
  scan uses the same regex. All other runtime consumers (binding, daemon,
  population, spaces, jobs, principals, interaction, adapters, MCP, executor,
  wake and cold-wake settings) delegate to `isAgentId` / `validateAgentId`.
- `agent-backfill.mjs` scans transcript text with an unrestricted hex UUID
  body. Its separate filename UUID parser is also version-independent.

Both are exercised with derived IDs by `tests/soul-genesis.test.mjs`;
CLI/daemon binding round trips are exercised by `tests/agent-spawn.test.mjs`.
Other UUID regexes in jobs, principals, Telegram and ACP parse distinct ID
kinds, not Agent IDs. No parser widening was needed.
