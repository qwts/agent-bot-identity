# keyd grant, owner-presence and trust-bootstrap protocol

This page records what agent-bot does **today** with agent-bot-keyd (#397,
#416, #438), the native helper whose source lives in `keyd/` and which
GeniusBar signs and ships: the grants agent-bot signs, the owner-presence
assertions it verifies, and how each side learns the other's key. It describes current behaviour. The owner's decisions on the
questions #594 raised are recorded at the end, under
[Owner decisions](#owner-decisions-594).

This repository owns this contract; GeniusBar reviews changes to it.

keyd's source lives in this repository under [`keyd/`](../keyd/) (#767),
imported from GeniusBar at `9433009`. CI builds and tests it here unsigned, on
a GitHub-hosted macOS runner. GeniusBar's release job signs and notarizes the
binary with its Developer ID, so no signing secret reaches this repository;
until GeniusBar switches to building from here, the binary it ships is still
built from its own copy. keyd's own side (Keychain items, socket peer checks,
its grant verifier and nonce cache, its presence prompt) is described in
[`keyd/README.md`](../keyd/README.md). Where this page states keyd-side
behaviour it says so; the Rust tests under `keyd/` cover that side, and the
Node suite does not. For key custody and the socket layout see
[soul credentials](soul-credentials.md#agent-bot-keyd-397).

## Trust boundary

keyd holds the keys and signs; agent-bot keeps the policy. Two Ed25519 keys
connect them, one in each direction:

| Key | Held by | Signs | Verified by | How the verifier learns it |
| --- | --- | --- | --- | --- |
| Vouch key (`<state>/vouch-key.pem`, PKCS#8, 0600) | the agent-bot daemon | grants (`v1.`) | keyd | sent with every `owner/import`; keyd-side, keyd pins it on the first one |
| Presence key | keyd, seed in its Keychain | presence assertions (`p1.`), owner key records (`k1.`) | agent-bot | derived from the code-signed keyd binary on every call; `<state>/keyd/presence.pub` caches the last pin, and a disagreement goes to the owner before either is used |

`<state>` is `$XDG_STATE_HOME/agent-bot` or `~/.local/state/agent-bot`.

What this does not stop: a process in the owner's account that can read
`vouch-key.pem` can sign grants and get tokens, never keys. Confinement
denies souls `vouch-key.pem` and keyd's directory and sockets in every tool,
which is a cooperative hook, not an OS boundary
([confinement](confinement.md)).

## Grants (agent-bot → keyd)

### Format

`signKeydGrant` in [keyd-client.mjs](../keyd-client.mjs):

```text
v1.<base64url(payload JSON)>.<base64url(Ed25519 signature of the payload segment)>

payload: { v: 1, aud: "agent-bot-keyd", agentId, app, tool, iat, exp,
           nonce, apiBase, installationId, owner, host }
```

- The signature covers the ASCII bytes of the base64url payload segment as
  sent, not a re-serialization.
- `tool` is `credential` or `git_credential` (`KEYD_TOOL_NAMES`); any other
  name throws before signing.
- `iat` is whole Unix seconds, rounded down; `exp = iat + 60`.
- `nonce` is 18 random bytes, base64url (24 characters), fresh per grant.
- `installationId` is a number, or `null` when absent or empty. `owner` and
  `host` are `null` when absent. Every key is always present.
- `apiBase`, `host` and `owner` come from the daemon's config
  (`grantTarget`); `installationId` from `GH_APP_INSTALLATION_ID`.
- The grant travels in the MCP call's `_meta["agent-bot/grant"]`.

### Lifetime and nonce

agent-bot, the issuer, sets a 60-second lifetime and a fresh nonce. It keeps
no record of grants and does not check them again.

**keyd-side** (the verifier, `verify` in
[keyd/src/grant.rs](../keyd/src/grant.rs)) has its own,
wider envelope. With `now` in whole seconds it accepts a grant only when:

- `exp > now`;
- `iat ≤ now + 30` (`CLOCK_SKEW_SECONDS`);
- `exp ≥ iat` and `exp − iat ≤ 120` (`MAX_LIFETIME_SECONDS`), so a zero
  lifetime is allowed;
- the token is at most 4096 bytes, the payload has no unknown fields, the
  signature verifies under the pinned daemon key, `v` is 1, `aud` and `tool`
  match, `apiBase` is `https://`, and a `git_credential` grant names a host;
- the nonce is 16 to 64 base64url characters and not already spent.

The nonce is spent last, after every other check passes and before the mint
(the `spend` call at the end of `verify` in
[keyd/src/grant.rs](../keyd/src/grant.rs)). Spent nonces
live in an in-memory map and are dropped once their `exp` has passed.

### The 60-second replay window

Because the spent-nonce map is in memory, keyd forgets it when it restarts.
A grant that was already used can then be presented again, and keyd accepts
it while it is still inside keyd's envelope above, that is until its `exp`.
agent-bot issues every grant for 60 seconds, so for a grant agent-bot signed
the window is at most 60 seconds from `iat`. This is the accepted guarantee
(#594): grants stay at 60 seconds or less, and the nonce cache stays in
memory.

- keyd's envelope would accept a lifetime of up to 120 seconds. Only a holder
  of the vouch key can sign such a grant, and that holder can sign a fresh
  grant at any time, so the wider envelope gives it nothing more.
- A nonce spent on a mint that then fails is not refunded. The caller asks
  for a new grant; agent-bot's issuers sign a fresh one per call.

### Issuers

Both issuers sign with the same vouch key (`loadOrCreateVouchKey`), created
once per state directory.

1. **`POST /v0/keyd/grant`** ([agent-daemon.mjs](../agent-daemon.mjs)). A
   soul's `agent-bot-keyd mcp` relay asks with `{ tool }` and the soul's
   binding proof. The route takes no daemon bearer token; the binding is the
   authority. In order:
   - unknown `tool` → 400;
   - no valid binding → 401;
   - the soul's identity or package cannot be read → error, receipt `failed`;
   - `github-identity` off, no App, or the soul's `soul.json` does not declare
     that App with `store: "keyd"` → 409;
   - otherwise the daemon signs a grant for the bound Agent ID and its App and
     answers `{ schemaVersion, grant }`.

   These outcomes leave a `credential-grant` receipt (operation
   `keyd <tool>`, or `keyd unknown`) that never contains the grant: unknown
   tool and no valid binding (`denied`, no Agent ID), an unreadable identity
   or package (`failed`), a 409 refusal (`denied`), and a signed grant
   (`granted`, written after signing). A body that is not valid JSON is
   refused with 400 before any receipt, and a failure while reading the
   config target or signing leaves no receipt.
2. **In-process** (`mintViaKeyd`). The daemon's own `/v0/credential`, and
   through it the git credential helper and `mint-token` in a keyd soul's
   worktree, sign a `credential` grant and call keyd's `credential` tool on
   `keyd.sock`. Outside the daemon, `mintThroughDaemon` asks `/v0/credential`
   on the caller's binding and never holds a key.

### Daemon-key pinning on first import

`identity migrate-credentials --to keyd` (`migrateToKeyd` in
[soul-credential-migration.mjs](../soul-credential-migration.mjs)) collects
every movable soul's key and calls `importIntoKeyd` once, so keyd asks the
owner once. That sends one `owner/import` on `owner.sock` with all the keys
as `items` and `daemonKey`: the vouch key's raw 32-byte Ed25519 public key,
base64. The daemon key is sent on every import. If the call fails, every
soul in it is reported `failed` and no `soul.json` is changed.

**keyd-side** (`owner_import`, `import_entries` and `import_pin` in
[keyd/src/server.rs](../keyd/src/server.rs)): `items` must hold 1 to
64 keys, otherwise the whole import is refused. Since agent-bot does not split
the call, `--all` with more than 64 movable souls fails for all of them.
keyd asks the owner (Touch ID or the login password), pins `daemonKey` on the
first import and refuses a different one until the owner pins it with
`owner/pin`. `agent-bot keyd status` reports keyd's `pinned` flag.
agent-bot's tests prove the key is sent; keyd's tests under `keyd/` prove
it pins it once.

## Owner presence (keyd → agent-bot)

### Request

`keydPresence` in [owner-presence.mjs](../owner-presence.mjs) sends
`owner/presence { action, nonce }` on `owner.sock`, with a 150-second client
timeout. `action` is the one-line summary naming the soul and the change;
`nonce` is 18 fresh random bytes, base64url, generated by agent-bot.

### Assertion format

```text
p1.<base64url(payload JSON)>.<base64url(Ed25519 signature of the payload segment)>

payload: { v: 1, aud: "agent-bot-owner", kind: "presence",
           action: hex(sha256(action UTF-8)), nonce, iat, exp }
```

### Verification

`verifyPresence` accepts an assertion only when all of these hold:

- three segments, the first `p1`, and the signature verifies under the
  pinned presence key;
- `v` is 1, `aud` is `agent-bot-owner`, `kind` is `presence`;
- `action` is the SHA-256 hex of this request's action, and `nonce` is this
  request's nonce;
- `iat` and `exp` are integers with `0 < exp − iat ≤ 120`
  (`MAX_LIFETIME_SECONDS`);
- with `now` in whole seconds, `iat ≤ now + 30` and `now ≤ exp + 30`
  (`CLOCK_SKEW_SECONDS`).

These are the verifier's bounds. **keyd-side:** keyd issues assertions with a
60-second lifetime
(`LIFETIME_SECONDS` in [keyd/src/presence.rs](../keyd/src/presence.rs))
and gives up on the prompt at 120 s. `iat` is the time the owner answered,
not the time the request arrived (#594): stamped at arrival, an approval
slower than 90 s came back already past `exp + 30`. agent-bot keeps no record of used
nonces; an assertion answers one request because the nonce is generated per
request and must match.

### Outcomes

| Result | When | Gate behaviour |
| --- | --- | --- |
| `{ method: 'presence', via: 'agent-bot-keyd' }` | the assertion verifies | approved |
| `presence-unavailable` | no pinned key and none can be pinned; `keyd-unavailable` (no socket, connection closed); keyd answers RPC error `-32001` | the wired owner gate follows the signed-challenge fallback order below |
| `keyd-signer-unverified` | the owner refused a loosened keyd signer | refused, nobody else is asked |
| `presence-pin-mismatch` | the cached presence key disagrees with the code-signed binary and the owner did not approve a re-pin | refused, nobody else is asked |
| `keyd-untrusted` | keyd answers RPC error `-32002`, or `agent-bot-keyd presence-key` exits 3: a pin keyd needs is a Keychain item it does not control (#753) | refused, nobody else is asked; a delegation grant keeps the code |
| `owner-declined` | any other keyd refusal, including `keyd-timeout` | refused, nobody else is asked |
| `presence-invalid` | the assertion does not verify | refused, nobody else is asked |

ADR-0753 extends the fallback in [owner-action.mjs](../owner-action.mjs).
When presence is unavailable and a local SSH owner key is enrolled, an
interactive terminal offers a fresh signed challenge. A verified reply returns
`{ method: 'statement', via: 'ssh', key, fingerprint }`. With no owner keys
enrolled, the administrator dialog remains available. Enrolled keys that this
CLI path cannot use, a noninteractive caller, cancellation or an invalid reply
refuse the action without administrator fallback. Enrollment and removal
never use a challenge; they go through `owner/pins-attest` (below). See [owner statements](owner-statements.md) for the built CLI contract;
daemon decision-route statement fields and inbox delivery remain unimplemented.

Callers ([owner-gate.mjs](../owner-gate.mjs)):

- `assertOwnerAction`, the ordinary owner gate (CLI owner actions,
  `soul revision`), first refuses a caller with soul markers. With a
  presented principal credential it returns once that verifies, and asks for
  no presence. Without one it calls `presenceOrConsent`.
- `confirmOwnerPresence`, used by the daemon's decisions on a soul's waiting
  tool request (`POST /v0/approvals/decide` and
  `POST /v1/proposals/<id>/decision`), always calls `presenceOrConsent`; a
  presented principal is verified as well, never instead (#438).

### Presence-key bootstrap

`pinnedPresenceKey`:

1. Read `<state>/keyd/presence.pub` (base64 of 32 bytes) as a cache of the
   last pin. It is never the pin: a file in this account is one a soul can
   write, so every call goes on to the binary, and a cache that disagrees
   with it is refused rather than used or quietly replaced (#753). A cache
   that does not parse is a damaged pin, not a missing one (step 4).
2. If the keyd install record (`<state>/keyd/keyd.json`) names an
   absolute `bin` and a keyd Team ID is configured, run
   `/usr/bin/codesign --verify --strict -R=<requirement> <bin>`. The
   requirement is a Developer ID Application signature from the configured
   team on the configured identifier (#594), built by
   `developerIdRequirement`:

   ```text
   anchor apple generic and identifier "agent-bot-keyd"
     and certificate leaf[field.1.2.840.113635.100.6.1.13] exists
     and certificate leaf[subject.OU] = "<Team ID>"
   ```

   (one line in practice). `keydSigner` in [config.mjs](../config.mjs)
   resolves each value on its own:

   | Setting | Environment (wins when non-empty) | Config | Organization profile | Default |
   | --- | --- | --- | --- | --- |
   | Team ID | `AGENT_BOT_KEYD_TEAM_ID` | `settings.keydTeamId` | `settings.keyd_team_id` | none |
   | Identifier | `AGENT_BOT_KEYD_IDENTIFIER` | `settings.keydIdentifier` | `settings.keyd_identifier` | `agent-bot-keyd` |

   The Team ID has no built-in default: the runtime names no vendor (#752),
   and the organization profile, projected into the config by `bootstrap`,
   is where an organization names the team that signs its keyd. With no
   Team ID configured nothing is pinned, so `keydPresence` reports
   `presence-unavailable` and the owner gate follows the
   [fallback order above](#outcomes).

   A Team ID is ten characters `A-Z0-9`; an identifier is letters, digits,
   `.` and `-`. In the environment or the config, either may instead be the
   literal `any-developer-id`, which drops that clause; both set to it give
   the requirement from before #594, any Developer ID Application signature.
   An organization profile cannot set it. Unset or empty never means that.
   A malformed value, or a config that does not load, pins nothing, as an
   unsigned binary would. The config is validated as a whole, so a malformed
   `settings.keydTeamId` fails the load even when `AGENT_BOT_KEYD_TEAM_ID` is
   set, unless both values come from the environment.
3. **Loosening needs the owner.** Pinning under `any-developer-id` (either
   value), or under another Team ID or identifier than the last pin was
   taken under (recorded in `<state>/keyd/presence.signer`, mode 0600), asks
   the owner first through the administrator dialog, naming the signer and
   what it replaces. keyd cannot vouch here, since its key is the one being
   pinned. The answer is receipted in the audit log (`event: keyd-signer`,
   `operation: pin-presence-key`, `decision: approved|refused`). Without the
   owner's approval nothing is run or pinned, and `pinnedPresenceKey` throws
   `keyd-signer-unverified`; the owner gate refuses the action with that
   code and does not fall back to another prompt. Setting a specific Team ID
   where none was pinned before is not a loosening. Since #753 every call
   reaches the binary, so this is asked only where the decision is new: when
   the signer differs from the one recorded, or when a loosened signer has
   not been recorded yet. Re-deriving under a signer already on record asks
   nobody.
4. Only then run `<bin> presence-key` (15-second timeout). A well-formed
   answer that disagrees with the cache means one of the two was replaced, so
   neither may be used on its own: the owner is asked through the
   administrator dialog, which a soul cannot answer, and the answer is
   receipted (`operation: repin-presence-key`). The dialog names the cached
   key and the binary's by fingerprint (`SHA256:`, as `ssh-keygen -l` and
   keyd's owner-key prompt print them). Approved, the cache is re-pinned to
   what the binary reports. Refused, or with nobody to ask,
   `pinnedPresenceKey` throws `presence-pin-mismatch`, leaves the cache where
   it can be examined, and the owner gate refuses without another prompt.
   Removing `presence.pub` does not pin again on its own. With no usable
   cache, the binary's key goes to the same dialog when any record of an
   earlier pin is there: a `presence.pub` that does not parse, a
   `presence.signer`, or an `owner/presence` or `owner/pins-attest` receipt
   in keyd's `audit.jsonl`. Only a record that is not there at all (ENOENT)
   counts as none; one that cannot be read, a symlink, a directory or any
   other non-regular file counts as an earlier pin. A well-formed answer that
   agrees, or a first pin with every record absent, is written to
   `presence.pub` with the signer to `presence.signer`. Both files are left
   at mode 0600, whether new or replacing a damaged pin (#746).

   This is detected, not prevented. All three records sit in `<state>/keyd`,
   which confinement denies a soul's tool calls by path only. A process
   running as the owner can remove every one of them, and the next key the
   binary reports, a planted presence seed included, is then pinned silently.
   As with keyd's Keychain lock (#873), the durable answer is the
   data-protection keychain under the signed host app.
5. `presence-key` exiting 3 means keyd's presence seed is a Keychain item
   keyd does not control (#753): `pinnedPresenceKey` throws `keyd-untrusted`,
   pins nothing, and the owner gate refuses without another prompt. Any other
   failure along the way pins nothing and returns `null`, which
   `keydPresence` reports as `presence-unavailable`.

The key is never taken from the socket, and never from the cache alone. A
file in `presence.pub` that does not parse as a key is treated as a damaged
pin, and step 4 asks the owner.

The daemon's autopilot loosening (`daemonModeFor`) and a soul's global
skill change (`agent-bot soul skill load --global`) use
`keydPresenceWithoutDialog`: keyd's own prompt only. Where step 3 or 4
would raise the administrator dialog, they refuse with
`keyd-signer-unverified` or `presence-pin-mismatch` instead, and the action
does not happen.

The requirement is checked on every call, not only when a key is pinned. A
host that pinned its key before #594 has that pin checked against the binary
from #753 on, and a host whose Team ID setting was removed after pinning
falls back to `presence-unavailable` rather than keeping a pin nothing
verifies any more. A pin with no `presence.signer` counts as a first pin.

### Known gaps

Current behaviour, recorded here and not changed by this page:

- `identity migrate-credentials --to keyd --all` sends every key in one
  import, and keyd refuses more than 64, so a host with more than 64 movable
  souls cannot complete that import.

## Owner statement keys (keyd → agent-bot, #753)

The owner chose "keyd signs pins" on
[#753](https://github.com/qwts/agent-bot-identity/issues/753): the keys in
`<state>/owner/keys.json` count only as keyd records them, because anything
running as the owner can write that file. This section is the keyd primitive
and agent-bot's verifier. `owner enroll` and `owner remove` write the pins
only through `owner/pins-attest` (`keydAttestPins`), and every reader trusts
the file only as far as `owner/pins-status` vouches for it, per request
([Readers](#readers)).

### Requests

Both go on `owner.sock` only; `soul.sock` refuses them. `nonce` is agent-bot's,
16 to 64 base64url characters.

- `owner/pins-attest { pins, nonce }`: `pins` is the full key set, 0 to 4
  records as `keys.json` holds them. keyd refuses a malformed set with
  `-32602` without asking. Otherwise, one prompt at a time, it shows the
  owner every key with every field the digest covers: name, kind (ssh
  security key, ssh software key or keyd key), whether a PIN or biometric is
  required, and fingerprint ("agent-bot wants to trust only these keys to
  sign statements as you: yubikey (ssh security key, PIN or biometric
  required, SHA256:…); …", or that every key is being removed). Only on approval does it record `{digest, generation}` with the
  generation one past the last, in its Keychain item (service
  `agent-bot.keyd`, account `owner-pins`), and answer
  `{ attestation }`. A cancel is `-32000`; nobody to ask is `-32001`. Every
  attempt leaves a `keyd-owner` receipt naming the digest. A record that is
  a Keychain item keyd does not control counts as no record, as the daemon
  key does: the prompt adds "This replaces a record of your keys that
  agent-bot-keyd did not make", the generation starts again at 1, and only
  the owner's approval replaces the item with one keyd controls.
- `owner/pins-status { nonce }`: no prompt. Answers `{ attestation }` for the
  record keyd holds: `digest: null` at generation 0 before any approval. A
  record keyd cannot read, generation 0 in a stored record included, is
  `-32000`, never "no keys". A record that is an item keyd does not control
  is `-32002` (untrusted), unsigned, never "no keys" and never a record.

`-32002` is keyd's answer wherever a pin it needs (the presence seed, the
owner key record) is a Keychain item it does not control (#753). agent-bot's
`keydRequest` rejects it with code `keyd-untrusted`, apart from
`keyd-refused`; `keydPresence` and `keydAttestPins` pass that code on, and
the owner gate refuses on it without falling back to another prompt. The
same seed read by `agent-bot-keyd presence-key` exits 3, which
`pinnedPresenceKey` reports as `keyd-untrusted` too.

### Record format

```text
k1.<base64url(payload JSON)>.<base64url(Ed25519 signature of the payload segment)>

payload: { v: 1, aud: "agent-bot-owner", kind: "pins",
           digest: hex(sha256(canonical key set)) or null, generation, nonce, iat, exp }

canonical key set:
  agent-bot owner pins v1\n
  <store> <alg> <fingerprint> <verifyRequired 0|1> <softwareKey 0|1> <name>\n   (one per pin, in order)
```

It is signed with the presence key, under its own prefix and `kind`, so a
record never passes as a presence assertion and an assertion never passes as
a record. keyd stamps `exp` 60 s after `iat`.

### Verification

`verifyPinsAttestation` in [owner-presence.mjs](../owner-presence.mjs) applies
the presence rules (prefix `k1`, `kind: pins`, signature under the pinned
presence key, `v`, `aud`, this request's nonce, `0 < exp − iat ≤ 120`, 30 s of
skew) and requires `generation` to be a non-negative integer, with
`digest: null` exactly at generation 0 and 64 lowercase hex characters
otherwise. It returns `{ digest, generation }`. A reader compares `digest`
with `pinSetDigest` of the file it read. The nonce makes the answer fresh,
so neither an older record nor a file restored from before a change matches.

The trust root is the presence key, so this inherits its bootstrap,
including `presence.pub` being writable by the owner's account.

### Readers

`attestedOwnerKeys` in [owner-presence.mjs](../owner-presence.mjs) is what
every reader of `keys.json` asks before trusting it: `owner verify`, the
owner gate's terminal challenge, and the daemon's decision routes. Each asks
once per request, with the pins it has just read: it takes the presence key
with `pinnedPresenceKeyWithoutDialog` (never the administrator dialog), sends
`owner/pins-status` with a fresh nonce (no prompt; a 10 s timeout), verifies
the answer with `verifyPinsAttestation`, and compares `digest` with
`pinSetDigest` of those pins. Where the organization profile declares the
owner's keys, every one of those pins must also be listed there (more keys
may be listed than a host pins). It answers `{ attested: true, generation }`
only then. Anything else is `{ attested: false, code, reason }`, never a
throw:

| `code` | When |
| --- | --- |
| `presence-unavailable` | no keyd set up here (CI, SSH, a host pinned from the organization profile), keyd not answering, or a keyd that answers `-32601` |
| `keyd-untrusted` | the record (`-32002`) or the presence seed is a Keychain item keyd does not control |
| `presence-pin-mismatch`, `keyd-signer-unverified` | the presence key could not be confirmed without the administrator dialog |
| `pins-invalid` | `-32000` (a record keyd cannot read), or an answer that does not verify |
| `pins-mismatch` | keyd's record is of another key set, or of none (`digest: null`) |
| `pins-stale` | keyd's record is of an older generation than one this process has seen |
| `pins-unlisted` | the organization profile declares owner keys (`settings.ownerKeys`) and a pin, matched by fingerprint, store and alg, is not among them; or the config holding that declaration cannot be read |

On any of these the reader trusts no pin and does what it did before the
pins were vouched for: `owner verify` answers `owner-pins-unprotected`, and
the owner gate keeps keyd presence or the administrator dialog (a refusal
where nobody can see it). An untrusted record is deliberately not a refusal
here, unlike `-32002` from `owner/presence`: it means the pins are not
vouched for, which is where every host stood before #753, while the owner
can still be asked another way.

**Generation.** keyd's record only moves forward in its Keychain item, and an
item keyd does not control is `-32002`, so a record going backwards means
something answered for keyd with an older one. Each process keeps the
newest generation it has seen keyd sign, in memory, and refuses an older
one. agent-bot has no record of the generation that a soul cannot write, so
nothing is persisted: a restart forgets the floor, and a rollback across a
restart is not seen by this check. As with the presence pin, that is
detected, not prevented, until the data-protection keychain under the
signed host app holds the record. A daemon that saw a newer generation keeps
refusing an older one until it restarts, for example after the owner removes
keyd's `owner-pins` item and the record starts again at 1.

**The organization's list.** `settings.ownerKeys` is read from the runtime
config, which anything running as the owner can write, a soul included. A
soul that deletes the setting turns the reader back to keyd's vouching
alone, as before the profile declared keys. That loosens what the
organization asked for, but adds no key: every pin must still be one the
owner approved through keyd with Touch ID. Holding the declaration where a
soul cannot change it needs keyd to record it with the pins, which is not
built.

## Owner statement signing (keyd store, #753)

keyd is the owner's statement store on a Mac (ADR-0753 section 5): it shows
the owner what they are signing and signs only that. It signs with the
owner statement key, an Ed25519 seed of its own in keyd's Keychain item
(service `agent-bot.keyd`, account `owner-statement-key`), made on first use
and never the presence seed, so a presence assertion is never a statement and
either key rotates on its own. Like every item under `agent-bot.keyd`, a
statement key keyd does not control is refused (`-32002`), never used.

Both methods are on `owner.sock` only; `soul.sock` refuses them.

- `owner/statement-key { nonce }`: no prompt. Answers `{ record }`, the key's
  public half as a `k1.` record signed with the presence key, so agent-bot
  pins the key keyd holds and not one a process standing in for the socket
  handed it:

  ```text
  k1.<base64url(payload JSON)>.<base64url(Ed25519 signature of the payload segment)>

  payload: { v: 1, aud: "agent-bot-owner", kind: "statement-key",
             key: base64(raw 32-byte public key), fingerprint, nonce, iat, exp }
  ```

  `fingerprint` is the key's as agent-bot computes it: `SHA256:` and unpadded
  base64 of the SHA-256 of its `ssh-ed25519` wire blob. keyd stamps `exp` 60 s
  after `iat`. A bad nonce is `-32602`.
- `owner/sign { payload }`: `payload` is the base64url payload segment of the
  `s1.` statement or challenge agent-bot built
  ([owner statements](owner-statements.md)). keyd decodes it and applies
  every rule of agent-bot's verifier: exactly the eleven fields, `v: 1`,
  `aud: "agent-bot-owner-statement"`, `kind` `statement` or `challenge`,
  `alg: "ed25519"`, the text rules (at most 500 bytes, no control, line-break
  or bidirectional character), the scope shape for the kind, `action`
  `null` for a statement and a SHA-256 hex digest for a challenge, the
  nonce, and a lifetime of at most 30 days or 15 minutes. It also refuses a
  payload issued more than 30 s in the future, one already expired, one not
  in canonical base64url, and one whose `key` is not its own statement key's
  fingerprint. All of these are `-32602`, before anyone is asked. Then, one
  prompt at a time, keyd asks the owner with its own words for the payload:

  > agent-bot wants you to sign a statement as the owner, for
  > qwts/agent-bot-identity#753, until 2027-01-22 08:00 UTC: “Ship the keyd
  > owner/sign slice.”

  or, for a challenge, "agent-bot asks you to approve a request on studio for
  qwts/x#5, until …: “…”". Only on approval does it answer `{ signature }`,
  the base64url Ed25519 signature of the segment's ASCII bytes exactly as
  sent; agent-bot appends it to make the `s1.` token. A payload that expires
  while the owner is asked is not signed (`-32602`). A cancel is `-32000`;
  nobody to ask is `-32001`; a statement key keyd does not control is
  `-32002`. Every attempt leaves a `keyd-owner` receipt naming the kind and the
  SHA-256 of the segment, never the text.

`owner enroll --store keyd` asks the owner twice, as the owner chose on #753:
once through `owner/sign` for the enrolment challenge that proves keyd holds
the key, and once through `owner/pins-attest` to trust the new key set.

The vectors in `keyd/src/statement.rs` (`matches_the_shared_vectors`: the
seed of 32 bytes of 7, its public key and fingerprint, and the signature of a
fixed statement segment) are shared with agent-bot's tests.

## App-level keys (#110)

The owner chose (#110, 2026-10-09) to let keyd hold **App-level keys**: one
key per GitHub App, keyed by the App's slug, shared by every soul that acts as
that App. They sit alongside the per-soul keys, which keep their item names,
messages and grant format.

### agent-bot's side

`agent-bot identity app create`, `connect` and `rotate-key`
([identity-apps.mjs](../identity-apps.mjs)), after the owner gate:

- **Verified keyd.** `owner/status` answers and `owner/app-status` answers
  with `pinned` and `held` (`appKeydAvailability`,
  [keyd-client.mjs](../keyd-client.mjs)). The key is sent with
  `owner/app-import` (keyd asks the owner again and reads it back), and only
  then does the App's config record say `store: keyd`, with its App ID and
  key fingerprint. No readable copy is written. When no daemon key is pinned
  yet, that import carries `daemonKey` and pins it, as a soul's first
  `owner/import` does: keyd's one owner prompt names the pin, and the result
  says `daemonKeyPinned: true`.
- **Not verified, or `-32601`.** keyd not installed, not running, or from
  before #110: the key goes to the file or Keychain store as
  before, and the result's `storeReason` says why. Validation and pin
  mismatch are refused before consent; an owner decline also occurs before
  keyd writes a pin or App item. After consent, keyd pins first when needed,
  then writes and reads back the App key, so a later RPC or storage error can
  leave a pin or App item behind. `connect` does not locally fall back on a
  non-version import error; `create` keeps GitHub's one-time key in file or
  Keychain with the reason.
- **Existing keys.** An App with a file or Keychain record keeps its store,
  rotation included (`storeReason` says so); moving one is a later, verified
  migration. A key keyd already holds for an App this machine has no record
  of is never imported over. A `store: keyd` App rotates through
  `owner/app-import` (after GitHub accepted the new key) or fails; it never
  leaves keyd. Each operation, `remove` included, holds a per-App lock from
  the keyd probe to the config record, so two never race keyd's import; a
  second refuses (`identity-app-busy`), and the record is re-read under the
  lock.
- **Removing.** `remove` for a `store: keyd` App sends `owner/app-remove`
  after the owner gate (keyd asks again), then drops the record; a key keyd
  no longer holds leaves only the record to drop. A key keyd holds for a slug
  with no record is removed the same way when that slug is named, and the
  result says `orphan: true`. keyd not running, `-32601` or a refusal
  removes nothing.
- **Readers without keyd.** `readManagedAppCredential` refuses a keyd record
  with `managed-app-keyd-held`, so `ensurePrivateKey` and migration fail
  closed instead of reaching an older key.
- **Minting.** `resolveAppCredential` resolves a `store: keyd` App to
  `source: 'keyd'`, `keyScope: 'app'` and the minting soul's Agent ID,
  unless the soul's own soul.json declares keyd (its own key wins). The
  daemon's mint then signs a `keyScope: "app"` grant; outside the daemon the
  token comes from `/v0/credential` on the soul's binding, as for a keyd
  soul.

keyd keeps an App ID and key only, so a manifest's webhook secret is kept
in its own file or Keychain item, `agent-bot.app.<slug>.webhook`
([credential-names.mjs](../credential-names.mjs)), never in a key item
(`webhookSecretKept: true`); `remove` deletes it.

### Item

[store.rs](../keyd/src/store.rs): a login-keychain generic password keyd
creates, service `agent-bot.keyd.app`, account `github-app/<slug>`, value
base64 of `{appId, privateKeyPem}`, the same encoding as a soul's item. A
soul's service is `agent-bot.keyd.<agentId>` and every Agent ID starts
`agent_`, so the two never meet. Removing one never touches the other.

### Owner messages

All on `owner.sock`, alongside the existing ones, which are unchanged
([server.rs](../keyd/src/server.rs)):

| Method | Params | Result | Consent |
| --- | --- | --- | --- |
| `owner/app-import` | `{ app, appId, privateKeyPem, daemonKey? }`, or `{ items: [{ app, appId, privateKeyPem }], daemonKey? }` | `{ stored, pinned }` | one prompt for all items |
| `owner/app-import-new` | same as `owner/app-import` | `{ stored, pinned }` | same consent; atomically refuses existing items instead of replacing them |
| `owner/app-remove` | `{ app }` | `{ removed }` | yes |
| `owner/app-status` | `{ app }` | `{ pinned, held, version }` | no |

`owner/app-import` follows `owner/import`'s rules: 1 to 64 items; each slug
and App ID checked, and a key keyd cannot sign with refused, before the owner
is asked; `daemonKey` pinned on the first import of either kind and a
different one refused until `owner/pin`; each item read back after it is
written and receipted (`operation: owner/app-import item`, no `agentId`). It
also refuses an `items` list that names the same App twice. Refusals are
JSON-RPC error `-32000`, as for the other owner methods, and leave a
`keyd-owner` receipt.

`owner/app-import-new` has the same validation, pin, consent and readback
rules, with create-only storage. It checks for held items before asking,
then uses `SecKeychainAddGenericPassword` for each write; a duplicate item
is refused even if it appeared during consent. It never calls the replacing
`set_generic_password` path. The method is distinct so an older keyd returns
`-32601` instead of ignoring a new flag and overwriting a key. Managed App
migration uses this method exclusively and never retries `owner/app-import`.
Like the existing batch import, this is not a multi-item transaction: an
error on a later item can follow an earlier write or first daemon pin.

A keyd from before #110 answers each of these with `-32601` (method not
found); agent-bot can use that to tell whether App-level keys are available.

### Grants

A grant may carry one more payload field, `keyScope`:

- absent or `"soul"`: keyd mints with the soul's item for `agentId` and `app`,
  exactly as before. agent-bot's grants today never send it, so their 12
  payload keys and keyd's answers are unchanged.
- `"app"`: keyd mints with the App-level item for `app`. `agentId` is still
  required and checked, and it is named in keyd's receipt (`detail:
  App-level key`).
- any other value, `null` included: the grant is refused as malformed.

keyd never falls back from one scope to the other: an `app` grant with no
App-level item fails with `agent-bot-keyd holds no App-level key for <app>`,
even when the soul's own item exists, and a soul grant never reads the App
item. Choosing the scope is policy, so it stays with the daemon that signs
the grant. A keyd from before #110 refuses a grant that names `keyScope`,
since unknown payload fields are refused.

## Version pin (#767)

Each agent-bot release pins the agent-bot-keyd it is built and tested with:
`KEYD_PINNED_VERSION` in `keyd-client.mjs`, which a test keeps equal to
`keyd/Cargo.toml`. A host app bundles exactly that version, the way it pins
the agent-bot component. keyd reports its version in `owner/status`.

- `agent-bot keyd status --json` adds `expectedVersion` (the pin, also when
  keyd is down) and `versionMatches` (`true`, `false`, or `null` when no keyd
  reported a version). The text form prints the update to make on a mismatch.
- `agent-bot doctor` reports `keyd.version`: `ready` on the pin,
  `keyd-version-mismatch` (warning) on any other or a missing version, and
  `keyd-not-running` (warning) when keyd is installed but silent. Without
  keyd the check is `not_applicable`.

A mismatch is reported, not refused: a keyd that lacks a method refuses that
call itself (for example a keyd from before #110 and App-level keys), so
nothing falls back silently. 0.2.0 is the first pinned version, the keyd with
App-level keys; GeniusBar's keyd from before the move reports 0.1.0.

## Conformance matrix

Tests named here are `node:test` titles, or Rust test functions under
`keyd/` (`cargo test`) where the path is a `.rs` file.

| Invariant | Issuer | Verifier / entry point | Test |
| --- | --- | --- | --- |
| A grant has exactly the 12 payload keys, `aud: agent-bot-keyd`, `exp − iat = 60`, a fresh nonce, a known tool | `signKeydGrant` | keyd | `tests/keyd.test.mjs`: "a grant carries exactly the fields keyd accepts, for 60 seconds, signed by the vouch key" |
| The signature covers the payload segment; nonce is 18 bytes; absent targets are `null`; `iat` rounds down | `signKeydGrant` | keyd | `tests/keyd.test.mjs`: "a grant signs its payload segment, with an 18-byte nonce and null for absent targets" |
| The daemon's own mint signs a `credential` grant with the vouch key and calls `keyd.sock` | `mintViaKeyd` | keyd `credential` | `tests/keyd.test.mjs`: "the daemon mints for a keyd soul by calling credential with its own grant" |
| `/v0/keyd/grant` refuses no binding (401), an unknown tool (400) and a soul whose key is not in keyd (409); signs for the bound soul; receipts each answer without the grant | daemon | `POST /v0/keyd/grant` | `tests/keyd.test.mjs`: "the daemon grants keyd calls only to a bound keyd soul, and receipts each answer" |
| Outside the daemon a keyd soul's token comes only through `/v0/credential` on its binding | daemon | `mintThroughDaemon` | `tests/keyd.test.mjs`: "a keyd soul resolves to keyd with no key, and mint goes through keyd"; "a bound keyd soul's mint through the daemon keeps the installation id" |
| The import sends every key in one owner call, with the daemon key to pin | `importIntoKeyd` | keyd `owner/import` | `tests/keyd.test.mjs`: "the owner import sends every key at once with the daemon key to pin" |
| The first `owner/import` or `owner/app-import` pins `daemonKey` in that owner's consent; later imports reuse it, and a different key requires `owner/pin` | keyd-side | keyd `owner/import`, `owner/app-import`, `owner/pin` | `keyd/src/server.rs`: `pins_the_daemon_key_exactly_once`, `owner_operations_need_consent_and_a_matching_pin`, `app_level_owner_operations_need_consent_and_a_matching_pin`, `the_first_app_import_pins_the_daemon_key_under_its_one_consent` |
| keyd spends each grant nonce once, and accepts `exp > now`, `iat ≤ now + 30`, `0 ≤ exp − iat ≤ 120` | keyd-side | `grant::verify` | `keyd/src/grant.rs`: `spends_each_nonce_exactly_once`, `accepts_a_grant_only_inside_the_documented_envelope`, `accepts_a_fresh_grant_once`; `keyd/src/server.rs`: `refuses_calls_without_a_valid_grant` |
| keyd accepts 1 to 64 import items | keyd-side | keyd `owner/import`, `owner/app-import` | `keyd/src/server.rs`: `imports_one_to_sixty_four_items_and_refuses_zero_or_sixty_five` |
| keyd holds App-level keys under their own item, apart from souls' items, and removing one leaves the other | keyd-side | `Store` | `keyd/src/store.rs`: `memory_store_round_trips`, `keychain_store_round_trips_in_a_temporary_keychain` |
| Every entry of a keyd item's access list names keyd's own code; an item made with the framework's default access does not pass, an App key is re-made locked with its value intact, and every `agent-bot.keyd` account is refused | keyd-side | `store::keychain` | `keyd/src/store.rs`: `keychain_items_trust_only_keyd` (`KEYD_KEYCHAIN_TESTS=1`) |
| A daemon key pinned before the lock reads as unpinned, not as an error: both status calls answer, and `owner/pin` asks the owner and replaces the item with one keyd controls | keyd-side | `Store::pinned_key`, keyd `owner/pin`, `owner/status`, `owner/app-status` | `keyd/src/server.rs`: `owner_pin_upgrades_a_legacy_pin` (`KEYD_KEYCHAIN_TESTS=1`) |
| Managed App migration never replaces a late-created App item; create-only storage has one winner | keyd-side, `migrateKeyLocked` | `owner/app-import-new` | `keyd/src/server.rs`: `create_only_app_import_refuses_an_item_added_during_consent`, `create_only_app_import_adds_once_and_never_rotates`; `keyd/src/store.rs`: `simultaneous_create_only_writes_have_one_winner`; `tests/identity-apps.test.mjs`: "App migration uses create-only import and preserves a late keyd item and the source on refusal" |
| `keyScope` absent or `soul` reads the soul's key, `app` the App-level key; any other value is refused | keyd-side | `grant::verify` | `keyd/src/grant.rs`: `accepts_a_grant_the_daemon_signed`, `reads_the_key_scope_and_refuses_an_unknown_one` |
| An `app` grant mints with the App-level key for `credential` and `git_credential`; a soul grant never sees it, and an `app` grant never falls back to the soul's key | keyd-side | keyd `credential`, `git_credential` | `keyd/src/server.rs`: `imports_an_app_level_key_and_mints_with_it_only_for_an_app_grant`, `an_app_grant_never_falls_back_to_a_soul_key` |
| `owner/app-import` needs consent, pins the daemon key if absent, and refuses a different existing pin; `owner/app-remove` needs consent but does not require a daemon-key pin; import checks every item first; `owner/app-status` returns `pinned`, `held`, and `version`; these methods are owner-channel only | keyd-side | keyd owner channel | `keyd/src/server.rs`: `app_level_owner_operations_need_consent_and_a_matching_pin`, `the_first_app_import_pins_the_daemon_key_under_its_one_consent` |
| An App-scope grant adds `keyScope: "app"`; a soul grant keeps its 12 keys; another scope is refused | `signKeydGrant` | keyd | `tests/keyd.test.mjs`: "an App-scope grant adds keyScope app; a soul grant keeps its 12 keys; another scope is refused" |
| App-key availability requires a running keyd that returns boolean `pinned` and `held` from `owner/app-status`; an unpinned keyd returns `pins: true` as a hint that the import will pin this daemon key; `-32601` identifies an older keyd | `appKeydAvailability` | keyd owner channel | `tests/keyd.test.mjs`: "keyd is verified for App keys when it runs and knows owner/app-status; an unpinned keyd pins on the import" |
| A `store: keyd` App mints through the daemon with an App-scope grant naming the bound soul | `resolveAppCredential`, `mint`, `mintViaKeyd` | keyd `credential` | `tests/keyd.test.mjs`: "a soul whose App keyd holds App-level mints with an App-scope grant naming the soul" |
| New App keys use verified keyd. For a new App, create/connect fall back with a reason when keyd is unavailable or predates #110. An owner decline occurs before pin or App-key writes; later import errors may follow a pin or key write. Connect does not locally fall back on non-version import errors, while create keeps GitHub's one-time key in file/Keychain with a reason. A keyd-held App rotates only in keyd and fails if keyd cannot take it; existing file/Keychain keys never move, and an unrecorded held key is never replaced | `identityAppOperation` | keyd `owner/app-import` | `tests/identity-apps.test.mjs`: "with keyd verified, connect keeps the key in keyd, records store keyd, and mints with an App-scope grant", "with keyd not verified, connect uses the file or Keychain store and says why", "an older keyd (-32601) falls back with its reason; any other keyd refusal stores nothing" (mocked import error; no keyd side effect exercised), "existing App keys are untouched: a file-store App rotates in its store, and a key keyd holds unrecorded is never replaced", "a keyd-held App rotates in keyd, and fails rather than leaving keyd when it cannot", "create keeps the one-time key in keyd when verified, and never loses it to a keyd refusal" |
| create into keyd keeps the webhook secret in its own `.webhook` file or Keychain item, and writes no key item | `persist`, `managedAppWebhookItem` | — | `tests/identity-apps.test.mjs`: "create into keyd keeps the webhook secret in its own file, and no key item is written", "… own Keychain item, …" |
| remove of a keyd-held App sends `owner/app-remove` and removes nothing when keyd is unavailable, older or refuses; an orphaned keyd key is removed only when named, after the owner gate | `remove`, `removeAppFromKeyd` | keyd `owner/app-remove` | `tests/identity-apps.test.mjs`: "remove sends owner/app-remove for a keyd-held App, …", "removing a keyd-held App removes nothing …", "an orphaned keyd key is removed only when named, …" |
| One App operation at a time; readers that cannot mint through keyd fail closed on a keyd record | `withAppOperationLock`, `readManagedAppCredential` | — | `tests/identity-apps.test.mjs`: "one operation per App at a time: …", "readers that cannot mint through keyd fail closed on a keyd-held App" |
| Souls are denied `vouch-key.pem` and keyd's sockets in every tool | — | confinement hook | `tests/soul-credentials.test.mjs`: "confinement denies a soul its key store, the legacy folder and secret-store CLIs in every tool" |
| `action` in an assertion is SHA-256 hex, matching keyd | keyd | `actionDigest` | `tests/owner-presence.test.mjs`: "the action digest matches keyd (sha256 hex)" |
| An assertion verifies only for its key, action, nonce, audience and prefix | keyd | `verifyPresence` | `tests/owner-presence.test.mjs`: "an assertion verifies only for its key, action, nonce and time" |
| Lifetime `0 < exp − iat ≤ 120`; skew 30 s on both sides; integer times; `kind: presence`; `v: 1` | keyd | `verifyPresence` | `tests/owner-presence.test.mjs`: "an assertion is accepted for up to 120 s of lifetime and 30 s of skew, and no more" |
| keyd issues assertions for 60 s from the owner's answer, good on agent-bot's clock from 30 s before to 90 s after | keyd-side | keyd `owner/presence` | `keyd/src/presence.rs`: `issues_for_sixty_seconds_within_the_documented_skew`; `keyd/src/server.rs`: `presence_is_stamped_when_the_owner_answers` |
| The owner key set digest is the same in keyd and agent-bot | keyd | `pinSetDigest` | `keyd/src/pins.rs`: `digests_the_canonical_key_set`; `tests/owner-presence.test.mjs`: "the owner key set digest matches keyd" |
| An owner key record verifies only for its key, nonce and time; `k1`/`pins` and `p1`/`presence` never pass for each other | keyd | `verifyPinsAttestation`, `verifyPresence` | `keyd/src/pins.rs`: `signs_under_its_own_prefix_and_kind`; `tests/owner-presence.test.mjs`: "an owner key record verifies only for its key, nonce and time, and is never a presence assertion" |
| `owner/pins-attest` records the key set only on the owner's approval, naming every key, one generation up each time; a decline or nobody to ask changes nothing; `owner/pins-status` signs the record without a prompt | keyd-side | keyd `owner/pins-attest`, `owner/pins-status` | `keyd/src/server.rs`: `records_the_owner_keys_only_when_the_owner_approves`; `keyd/src/pins.rs`: `names_every_key_in_the_prompt` |
| A record keyd does not control is no record to `owner/pins-attest`, replaced only on approval from generation 1, and `-32002` to `owner/pins-status`; a presence seed keyd does not control signs nothing and answers `-32002` | keyd-side, `keydRequest` | keyd `owner/pins-attest`, `owner/pins-status`, `owner/presence` | `keyd/src/server.rs`: `an_untrusted_owner_key_record_is_reported_and_replaced_only_with_approval`, `an_untrusted_presence_seed_signs_nothing`; `keyd/src/store.rs`: `an_untrusted_pin_is_typed_not_absent`; `tests/keyd.test.mjs`: "keydRequest speaks newline-delimited JSON-RPC and reports keyd refusals and absence" |
| A malformed set or nonce is refused without asking; an unreadable record is an error, not "no keys"; both methods are owner-channel only | keyd-side | keyd `owner/pins-attest`, `owner/pins-status` | `keyd/src/server.rs`: `refuses_malformed_owner_key_requests_without_asking`; `keyd/src/pins.rs`: `refuses_malformed_key_sets`; `keyd/src/store.rs`: `memory_store_round_trips` |
| A reader trusts `keys.json` only on a request where `owner/pins-status`, freshly signed under the pinned presence key, records exactly that set at a generation no older than this process has seen; any other answer keeps presence or the dialog and never throws | agent-bot | `attestedOwnerKeys` | `tests/owner-presence.test.mjs`: "attestedOwnerKeys vouches only for the exact pins keyd recorded, freshly signed and not older than seen"; `tests/owner-statement.test.mjs`: "the owner gate ignores a forged pin keyd does not vouch for, and asks the dialog", "verify reads a token, a file or stdin and answers in JSON"; `tests/owner-challenge-route.test.mjs`: "the ledger asks keyd about the pins it read, on each request, and keeps the dialog when keyd stops vouching" |
| `owner enroll` and `owner remove` write the pins only after keyd records the whole new set for a fresh nonce; no keyd, an older keyd (`-32601`), a decline, or a record of another set changes nothing; a change while the owner was asked refuses with `owner-keys-changed`; a soul caller is refused before keyd is asked | — | `keydAttestPins`, `ownerCommand` | `tests/owner-presence.test.mjs`: "keydAttestPins asks keyd to record the whole key set and checks the record is that set"; `tests/owner-statement.test.mjs`: "enroll pins a security key after a proof of possession and keyd recording the whole new key set", "enroll and remove change no pins when keyd cannot ask, the owner declines, or the key cannot prove possession", "pins are written under a lock, only if they are still the set keyd was shown", "a soul cannot enrol or remove an owner key, and keyd is never asked" |
| Audience, unavailable RPC code and the code-signing requirement (Team ID and identifier) | — | `owner-presence.mjs` constants, `developerIdRequirement` | `tests/owner-presence.test.mjs`: "the presence contract constants keyd and agent-bot share" |
| The signer comes from the environment, then the config; the Team ID has no default and empty is unset | — | `keydSigner` | `tests/owner-presence.test.mjs`: "the keyd signer comes from the environment, then the config; the Team ID has no default (#594)" |
| With no Team ID configured nothing is verified, run or pinned | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "with no keyd Team ID configured nothing is verified, run or pinned" |
| An organization profile names a specific signer, projects it into config, and can never set `any-developer-id` | — | `validateOrganizationProfile`, `organizationProfileToConfig` | `tests/owner-presence.test.mjs`: "the organization profile names the keyd signer and never loosens it" |
| Pinning under `any-developer-id`, or another signer than the last pin, needs the owner's approval and is receipted; refused, nothing runs and the gate refuses with `keyd-signer-unverified` | — | `pinnedPresenceKey`, `presenceOrConsent` | `tests/owner-presence.test.mjs`: "pinning under any Developer ID needs the owner and leaves a receipt", "pinning again under another team than the pin was taken under needs the owner", "an unapproved signer refuses the owner action with its code, never falling back to the dialog" |
| Only an explicit `any-developer-id` restores the requirement from before #594 | — | `developerIdRequirement` | `tests/owner-presence.test.mjs`: "only an explicit any-developer-id brings back the requirement from before #594" |
| A malformed signer is refused and pins nothing; the binary is verified against the configured signer before it runs | — | `keydSigner`, `pinnedPresenceKey`, `loadConfig` | `tests/owner-presence.test.mjs`: "a malformed keyd signer is refused, so nothing reaches the code-signing requirement", "the binary is verified against the configured team and identifier before it is run"; `tests/config.test.mjs`: "loadConfig accepts a keyd Team ID and identifier and rejects anything else (#594)" |
| Each request carries a fresh agent-bot nonce; a socket without keyd's key, or an assertion for another nonce, is refused | — | `keydPresence` | `tests/owner-presence.test.mjs`: "keydPresence asks keyd with the action and a fresh nonce, and checks the answer" |
| The presence key is derived from the signed binary on every call, the pin file 0600 is a cache, never the pin, and never from the socket | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "the presence key comes from the signed binary every time, and the pin file is only a cache", "a corrupt pin is replaced from the binary and left owner-only" |
| A cached key the binary disagrees with is put to the owner: approved it re-pins, refused it is receipted, left in place, and never falls back to the dialog | — | `pinnedPresenceKey`, `presenceOrConsent` | `tests/owner-presence.test.mjs`: "a pin the owner will not re-pin is refused, not used and not replaced", "a pin the owner approves is re-pinned from the signed binary", "a pin mismatch refuses the owner action with its code, never falling back to the dialog" |
| No record, an unsigned binary (never run) or a malformed answer pins nothing | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "no keyd, an unsigned keyd or a malformed answer pins nothing" |
| An unparseable pin file is a damaged pin: pinned again from the signed binary only with the owner's approval; a record that cannot be checked counts as an earlier pin | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "a corrupt pin is replaced from the binary only with the owner, and left owner-only", "a pin record that cannot be checked counts as a pin, never as a first pin" |
| `presence-unavailable` vs `owner-declined` (timeout included) | — | `keydPresence` | `tests/owner-presence.test.mjs`: "keydPresence tells \"nobody can be asked\" apart from \"the owner said no\"" |
| The administrator dialog only when keyd cannot ask and no owner keys are enrolled, or the trust-root command disables challenges; a refusal is final | — | wired `presenceOrConsent`, `assertOwnerAction` | `tests/owner-statement.test.mjs`: "hosts with no enrolled owner keys retain the existing administrator fallback", "challenge refusal, cancellation, and disabled challenge paths never approve or fall through"; `tests/owner-gate.test.mjs`: "revision edit treats keyd refusal as final, without reaching the terminal-only dialog fallback" |
| An SSH reply answers one pending CLI challenge, binding the raw-action digest and separately rendered summary, host, key, nonce and expiry; current pins are rechecked after waiting | owner SSH signer | `verifyOwnerChallenge`, wired owner gate | `tests/owner-statement.test.mjs`: "an owner challenge binds the displayed action summary and can be answered once by an enrolled SSH key", "the owner-action presence wrapper checks presence once before the challenge flow", "owner challenge refuses keyd-only pins and rechecks SSH pins after waiting" |
| `owner/sign` signs exactly the segment it was sent, with the owner statement key and never the presence key, only on the owner's approval of keyd's own words for the payload; nobody to ask is `-32001`, a decline `-32000` | keyd-side | keyd `owner/sign` | `keyd/src/server.rs`: `signs_a_statement_only_when_the_owner_approves`; `keyd/src/statement.rs`: `matches_the_shared_vectors`, `reads_a_statement_and_a_challenge`; `keyd/src/store.rs`: `memory_store_round_trips` |
| A payload agent-bot's verifier would refuse, an expired one, or one naming another key is `-32602` without asking; a statement key keyd does not control signs nothing (`-32002`); both methods are owner-channel only | keyd-side | keyd `owner/sign`, `owner/statement-key` | `keyd/src/server.rs`: `refuses_owner_sign_requests_without_asking`; `keyd/src/statement.rs`: `refuses_what_agent_bot_would_refuse`; `keyd/src/store.rs`: `an_untrusted_pin_is_typed_not_absent` |
| `owner/statement-key` reports the statement key, made on first use apart from the presence seed, in a `k1.` record signed with the presence key for agent-bot's nonce, without a prompt | keyd-side | keyd `owner/statement-key` | `keyd/src/server.rs`: `reports_the_statement_key_signed_with_the_presence_key`; `keyd/src/statement.rs`: `signs_its_key_record_with_the_presence_key` |
| A decision on a soul's tool request always asks presence; a principal is checked as well, never instead | — | `confirmOwnerPresence`, `/v0/approvals/decide`, `/v1/proposals/<id>/decision` | `tests/owner-gate.test.mjs`: "a decision on a soul tool request asks for presence even when a principal verifies (#438)"; `tests/agent-approvals.test.mjs`: "the daemon token alone cannot decide: a refused owner gate decides nothing on either route (#438)" |

## Owner decisions (#594)

The owner decided these on 2026-10-09
([#594](https://github.com/qwts/agent-bot-identity/issues/594)).

1. **Contract ownership.** agent-bot-identity owns the grant and presence
   contract, and this page is its record. GeniusBar reviews changes to it as
   the native-helper side.
2. **Replay across keyd restart.** The window is documented, not closed:
   grants stay at 60 seconds or less and keyd's nonce cache stays in memory.
   See [the 60-second replay window](#the-60-second-replay-window).
3. **Presence-key trust pinning.** The code-signing requirement names the
   Team ID and the identifier, so any other Developer ID signature is no
   longer accepted. GeniusBar must sign keyd with that identifier. See
   [presence-key bootstrap](#presence-key-bootstrap). Pin corruption is
   handled as before (step 2 runs again); an existing pin is not re-checked.
4. **Where the Team ID lives.** The organization profile names it; the
   runtime has no built-in Team ID (#752). With none configured, presence is
   unavailable; ADR-0753 extends the gate's [fallback order](#outcomes) with
   signed challenges for enrolled SSH keys.
5. **Loosening.** The environment and config may name a specific signer
   freely. Accepting any Developer ID, or pinning under another signer than
   the last pin, needs the owner's verification and leaves a receipt.
