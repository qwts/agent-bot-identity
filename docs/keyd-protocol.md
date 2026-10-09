# keyd grant, owner-presence and trust-bootstrap protocol

This page records what agent-bot does **today** with agent-bot-keyd (#397,
#416, #438), the signed native helper GeniusBar ships: the grants agent-bot
signs, the owner-presence assertions it verifies, and how each side learns the
other's key. It describes current behaviour only. It proposes nothing and
settles none of the open questions at the end; those are tracked in #594.

keyd's own side (Keychain items, socket peer checks, its grant verifier and
nonce cache, its presence prompt) lives in GeniusBar's
[keyd README](https://github.com/qwts/GeniusBar/blob/363f52c590efe5df8cb75490ca81667e74425cf8/keyd/README.md).
Where this page states keyd-side behaviour it says so, and nothing in this
repository tests it. For key custody and the socket layout see
[soul credentials](soul-credentials.md#agent-bot-keyd-397).

## Trust boundary

keyd holds the keys and signs; agent-bot keeps the policy. Two Ed25519 keys
connect them, one in each direction:

| Key | Held by | Signs | Verified by | How the verifier learns it |
| --- | --- | --- | --- | --- |
| Vouch key (`<state>/vouch-key.pem`, PKCS#8, 0600) | the agent-bot daemon | grants (`v1.`) | keyd | sent with every `owner/import`; keyd pins it on the first one |
| Presence key | keyd, seed in its Keychain | presence assertions (`p1.`) | agent-bot | pinned in `<state>/keyd/presence.pub` from the code-signed keyd binary |

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

agent-bot sets the 60-second lifetime and a fresh nonce. It keeps no record
of grants and does not check them again. **keyd-side:** keyd checks the
signature against its pinned daemon key and spends each nonce once, in an
in-memory replay cache
([grant.rs](https://github.com/qwts/GeniusBar/blob/363f52c590efe5df8cb75490ca81667e74425cf8/keyd/src/grant.rs#L50)).

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

   Every outcome leaves a `credential-grant` receipt (`denied`, `failed` or
   `granted`, operation `keyd <tool>`) that never contains the grant.
2. **In-process** (`mintViaKeyd`). The daemon's own `/v0/credential`, and
   through it the git credential helper and `mint-token` in a keyd soul's
   worktree, sign a `credential` grant and call keyd's `credential` tool on
   `keyd.sock`. Outside the daemon, `mintThroughDaemon` asks `/v0/credential`
   on the caller's binding and never holds a key.

### Daemon-key pinning on first import

`importIntoKeyd` (`identity migrate-credentials --to keyd`) sends every key
in one `owner/import` call on `owner.sock`, with `daemonKey`: the vouch
key's raw 32-byte Ed25519 public key, base64. It is sent on every import.
**keyd-side:** keyd asks the owner (Touch ID or the login password), pins
`daemonKey` on the first import and refuses a different one until the owner
pins it with `owner/pin`. `agent-bot keyd status` reports keyd's `pinned`
flag. agent-bot's tests prove the key is sent, not that keyd pins it.

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
([presence.rs](https://github.com/qwts/GeniusBar/blob/363f52c590efe5df8cb75490ca81667e74425cf8/keyd/src/presence.rs#L54))
and gives up on the prompt at 120 s. agent-bot keeps no record of used
nonces; an assertion answers one request because the nonce is generated per
request and must match.

### Outcomes

| Result | When | Gate behaviour |
| --- | --- | --- |
| `{ method: 'presence', via: 'agent-bot-keyd' }` | the assertion verifies | approved |
| `presence-unavailable` | no pinned key and none can be pinned; `keyd-unavailable` (no socket, connection closed); keyd answers RPC error `-32001` | `presenceOrConsent` falls back to the administrator dialog |
| `owner-declined` | any other keyd refusal, including `keyd-timeout` | refused, nobody else is asked |
| `presence-invalid` | the assertion does not verify | refused, nobody else is asked |

Callers: every owner gate through `presenceOrConsent`
([owner-gate.mjs](../owner-gate.mjs)), including the CLI owner actions and
`soul revision`, and the daemon's decisions on a soul's waiting tool request
(`POST /v0/approvals/decide` and `POST /v1/proposals/<id>/decision`), which
go through `confirmOwnerPresence` and ask for presence even when a principal
credential verifies (#438).

### Presence-key bootstrap

`pinnedPresenceKey`:

1. If `<state>/keyd/presence.pub` holds a well-formed key (base64 of 32
   bytes), use it. Nothing else is checked, and the binary is not consulted
   again.
2. Otherwise, if the keyd install record (`<state>/keyd/keyd.json`) names an
   absolute `bin`, run
   `/usr/bin/codesign --verify --strict -R=<requirement> <bin>` with
   `DEVELOPER_ID_REQUIREMENT`:

   ```text
   anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists
   ```

   This accepts any Developer ID Application signature; it names no Team ID
   and no identifier.
3. Only if that passes, run `<bin> presence-key` (15-second timeout). If the
   output is a well-formed key, write it to `presence.pub` (0600) and use it.
4. Any failure along the way pins nothing and returns `null`, which
   `keydPresence` reports as `presence-unavailable`.

The key is never taken from the socket. A file in `presence.pub` that does
not parse as a key is treated as no pin, and step 2 runs again.

## Conformance matrix

Tests named here are `node:test` titles. "keyd-side" rows are GeniusBar
behaviour with no test in this repository.

| Invariant | Issuer | Verifier / entry point | Test |
| --- | --- | --- | --- |
| A grant has exactly the 12 payload keys, `aud: agent-bot-keyd`, `exp − iat = 60`, a fresh nonce, a known tool | `signKeydGrant` | keyd | `tests/keyd.test.mjs`: "a grant carries exactly the fields keyd accepts, for 60 seconds, signed by the vouch key" |
| The signature covers the payload segment; nonce is 18 bytes; absent targets are `null`; `iat` rounds down | `signKeydGrant` | keyd | `tests/keyd.test.mjs`: "a grant signs its payload segment, with an 18-byte nonce and null for absent targets" |
| The daemon's own mint signs a `credential` grant with the vouch key and calls `keyd.sock` | `mintViaKeyd` | keyd `credential` | `tests/keyd.test.mjs`: "the daemon mints for a keyd soul by calling credential with its own grant" |
| `/v0/keyd/grant` refuses no binding (401), an unknown tool (400) and a soul whose key is not in keyd (409); signs for the bound soul; receipts each answer without the grant | daemon | `POST /v0/keyd/grant` | `tests/keyd.test.mjs`: "the daemon grants keyd calls only to a bound keyd soul, and receipts each answer" |
| Outside the daemon a keyd soul's token comes only through `/v0/credential` on its binding | daemon | `mintThroughDaemon` | `tests/keyd.test.mjs`: "a keyd soul resolves to keyd with no key, and mint goes through keyd"; "a bound keyd soul's mint through the daemon keeps the installation id" |
| The import sends every key in one owner call, with the daemon key to pin | `importIntoKeyd` | keyd `owner/import` | `tests/keyd.test.mjs`: "the owner import sends every key at once with the daemon key to pin" |
| keyd pins the daemon key on first import and refuses another | keyd-side | keyd | none here |
| keyd spends each grant nonce once | keyd-side | keyd | none here |
| Souls are denied `vouch-key.pem` and keyd's sockets in every tool | — | confinement hook | `tests/soul-credentials.test.mjs`: "confinement denies a soul its key store, the legacy folder and secret-store CLIs in every tool" |
| `action` in an assertion is SHA-256 hex, matching keyd | keyd | `actionDigest` | `tests/owner-presence.test.mjs`: "the action digest matches keyd (sha256 hex)" |
| An assertion verifies only for its key, action, nonce, audience and prefix | keyd | `verifyPresence` | `tests/owner-presence.test.mjs`: "an assertion verifies only for its key, action, nonce and time" |
| Lifetime `0 < exp − iat ≤ 120`; skew 30 s on both sides; integer times; `kind: presence`; `v: 1` | keyd | `verifyPresence` | `tests/owner-presence.test.mjs`: "an assertion is accepted for up to 120 s of lifetime and 30 s of skew, and no more" |
| keyd issues assertions for 60 s | keyd-side | — | none here |
| Audience, unavailable RPC code and the code-signing requirement string | — | `owner-presence.mjs` constants | `tests/owner-presence.test.mjs`: "the presence contract constants keyd and agent-bot share" |
| Each request carries a fresh agent-bot nonce; a socket without keyd's key, or an assertion for another nonce, is refused | — | `keydPresence` | `tests/owner-presence.test.mjs`: "keydPresence asks keyd with the action and a fresh nonce, and checks the answer" |
| The presence key is pinned from the signed binary once, 0600, never from the socket | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "the presence key is pinned from the signed binary, once, and never from the socket" |
| No record, an unsigned binary (never run) or a malformed answer pins nothing | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "no keyd, an unsigned keyd or a malformed answer pins nothing" |
| An unparseable pin file is pinned again from the signed binary | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "a pin that does not parse as a key is pinned again from the signed binary" |
| `presence-unavailable` vs `owner-declined` (timeout included) | — | `keydPresence` | `tests/owner-presence.test.mjs`: "keydPresence tells \"nobody can be asked\" apart from \"the owner said no\"" |
| The administrator dialog only when keyd cannot ask; a refusal is final | — | `presenceOrConsent` | `tests/owner-presence.test.mjs`: "the gate asks keyd first and falls back to the administrator dialog only when keyd cannot ask"; "with no keyd installed the gate uses the administrator dialog, as before"; `tests/owner-gate.test.mjs`: "revision edit treats keyd refusal as final, without reaching the terminal-only dialog fallback" |
| A decision on a soul's tool request always asks presence; a principal is checked as well, never instead | — | `confirmOwnerPresence`, `/v0/approvals/decide`, `/v1/proposals/<id>/decision` | `tests/owner-gate.test.mjs`: "a decision on a soul tool request asks for presence even when a principal verifies (#438)"; `tests/agent-approvals.test.mjs`: "the daemon token alone cannot decide: a refused owner gate decides nothing on either route (#438)" |

## Open (owner decision, #594)

These are recorded without answers.

1. **Contract ownership.** Which repository owns the normative grant and
   presence contract, and what role the other plays in reviewing it?
2. **Replay across keyd restart.** keyd's grant nonce cache is in memory and
   the nonce is spent before the downstream mint. What is guaranteed for a
   grant presented again after keyd restarts, and for a nonce spent on a
   mint that then fails?
3. **Presence-key trust pinning.** The requirement accepts any Developer ID
   Application signature, the binary comes from the install record, and the
   pinned `presence.pub` is trusted as found. Is that chain sufficient, and
   how are pin corruption, replacement, keyd updates and re-signing handled?
