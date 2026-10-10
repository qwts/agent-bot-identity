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

agent-bot, the issuer, sets a 60-second lifetime and a fresh nonce. It keeps
no record of grants and does not check them again.

**keyd-side** (the verifier, `grant::verify` in
[grant.rs](https://github.com/qwts/GeniusBar/blob/363f52c590efe5df8cb75490ca81667e74425cf8/keyd/src/grant.rs#L74-L130) at the commit linked above) has its own,
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
([grant.rs](https://github.com/qwts/GeniusBar/blob/363f52c590efe5df8cb75490ca81667e74425cf8/keyd/src/grant.rs#L50-L65), [#L126](https://github.com/qwts/GeniusBar/blob/363f52c590efe5df8cb75490ca81667e74425cf8/keyd/src/grant.rs#L126)). Spent nonces
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

**keyd-side** ([server.rs](https://github.com/qwts/GeniusBar/blob/363f52c590efe5df8cb75490ca81667e74425cf8/keyd/src/server.rs#L378-L462)): `items` must hold 1 to
64 keys, otherwise the whole import is refused. Since agent-bot does not split
the call, `--all` with more than 64 movable souls fails for all of them.
keyd asks the owner (Touch ID or the login password), pins `daemonKey` on the
first import and refuses a different one until the owner pins it with
`owner/pin`. `agent-bot keyd status` reports keyd's `pinned` flag.
agent-bot's tests prove the key is sent, not that keyd pins it.

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
([presence.rs](https://github.com/qwts/GeniusBar/blob/363f52c590efe5df8cb75490ca81667e74425cf8/keyd/src/presence.rs#L25))
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

1. If `<state>/keyd/presence.pub` holds a well-formed key (base64 of 32
   bytes), use it. Nothing else is checked, and the binary is not consulted
   again.
2. Otherwise, if the keyd install record (`<state>/keyd/keyd.json`) names an
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
   `presence-unavailable` and the owner gate uses the administrator dialog.

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
   where none was pinned before is not a loosening.
4. Only then run `<bin> presence-key` (15-second timeout). If the output is
   a well-formed key, write it to `presence.pub` and the signer to
   `presence.signer`, and use it. Both files are left at mode 0600, whether
   new or replacing a pin that did not parse (#746).
5. Any other failure along the way pins nothing and returns `null`, which
   `keydPresence` reports as `presence-unavailable`.

The key is never taken from the socket. A file in `presence.pub` that does
not parse as a key is treated as no pin, and step 2 runs again.

The requirement is checked only when a key is pinned. A host that pinned its
key before #594 keeps that pin, and the Team ID and identifier apply the next
time it pins, for example after `presence.pub` is removed. Such a pin has no
`presence.signer`, so its next pin counts as a first pin.

### Known gaps

Current behaviour, recorded here and not changed by this page:

- `identity migrate-credentials --to keyd --all` sends every key in one
  import, and keyd refuses more than 64, so a host with more than 64 movable
  souls cannot complete that import.

## App-level keys (#110)

The owner chose (#110, 2026-10-09) to let keyd hold **App-level keys**: one
key per GitHub App, keyed by the App's slug, shared by every soul that acts as
that App. They sit alongside the per-soul keys, which keep their item names,
messages and grant format. This slice is **keyd-side only**: agent-bot does
not yet send any of the messages below. Recording `store: keyd` for an App,
minting through keyd by App, and falling back to the file or Keychain store
with a stated reason when keyd is not verified are slice 2 of #110.

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

## Conformance matrix

Tests named here are `node:test` titles, or Rust test functions under
`keyd/` (`cargo test`) where the path is a `.rs` file. "keyd-side" rows with
"none here" have no test in this repository yet.

| Invariant | Issuer | Verifier / entry point | Test |
| --- | --- | --- | --- |
| A grant has exactly the 12 payload keys, `aud: agent-bot-keyd`, `exp − iat = 60`, a fresh nonce, a known tool | `signKeydGrant` | keyd | `tests/keyd.test.mjs`: "a grant carries exactly the fields keyd accepts, for 60 seconds, signed by the vouch key" |
| The signature covers the payload segment; nonce is 18 bytes; absent targets are `null`; `iat` rounds down | `signKeydGrant` | keyd | `tests/keyd.test.mjs`: "a grant signs its payload segment, with an 18-byte nonce and null for absent targets" |
| The daemon's own mint signs a `credential` grant with the vouch key and calls `keyd.sock` | `mintViaKeyd` | keyd `credential` | `tests/keyd.test.mjs`: "the daemon mints for a keyd soul by calling credential with its own grant" |
| `/v0/keyd/grant` refuses no binding (401), an unknown tool (400) and a soul whose key is not in keyd (409); signs for the bound soul; receipts each answer without the grant | daemon | `POST /v0/keyd/grant` | `tests/keyd.test.mjs`: "the daemon grants keyd calls only to a bound keyd soul, and receipts each answer" |
| Outside the daemon a keyd soul's token comes only through `/v0/credential` on its binding | daemon | `mintThroughDaemon` | `tests/keyd.test.mjs`: "a keyd soul resolves to keyd with no key, and mint goes through keyd"; "a bound keyd soul's mint through the daemon keeps the installation id" |
| The import sends every key in one owner call, with the daemon key to pin | `importIntoKeyd` | keyd `owner/import` | `tests/keyd.test.mjs`: "the owner import sends every key at once with the daemon key to pin" |
| keyd pins the daemon key on first import and refuses another | keyd-side | keyd | none here |
| keyd spends each grant nonce once, and accepts `exp > now`, `iat ≤ now + 30`, `0 ≤ exp − iat ≤ 120` | keyd-side | keyd | none here |
| keyd accepts 1 to 64 import items | keyd-side | keyd | none here |
| keyd holds App-level keys under their own item, apart from souls' items, and removing one leaves the other | keyd-side | `Store` | `keyd/src/store.rs`: `memory_store_round_trips`, `keychain_store_round_trips_in_a_temporary_keychain` |
| `keyScope` absent or `soul` reads the soul's key, `app` the App-level key; any other value is refused | keyd-side | `grant::verify` | `keyd/src/grant.rs`: `accepts_a_grant_the_daemon_signed`, `reads_the_key_scope_and_refuses_an_unknown_one` |
| An `app` grant mints with the App-level key for `credential` and `git_credential`; a soul grant never sees it, and an `app` grant never falls back to the soul's key | keyd-side | keyd `credential`, `git_credential` | `keyd/src/server.rs`: `imports_an_app_level_key_and_mints_with_it_only_for_an_app_grant`, `an_app_grant_never_falls_back_to_a_soul_key` |
| `owner/app-import`, `owner/app-remove` need consent and a matching pin; import checks every item first; `owner/app-status` says only whether the key is held; none is on the soul channel | keyd-side | keyd owner channel | `keyd/src/server.rs`: `app_level_owner_operations_need_consent_and_a_matching_pin` |
| Souls are denied `vouch-key.pem` and keyd's sockets in every tool | — | confinement hook | `tests/soul-credentials.test.mjs`: "confinement denies a soul its key store, the legacy folder and secret-store CLIs in every tool" |
| `action` in an assertion is SHA-256 hex, matching keyd | keyd | `actionDigest` | `tests/owner-presence.test.mjs`: "the action digest matches keyd (sha256 hex)" |
| An assertion verifies only for its key, action, nonce, audience and prefix | keyd | `verifyPresence` | `tests/owner-presence.test.mjs`: "an assertion verifies only for its key, action, nonce and time" |
| Lifetime `0 < exp − iat ≤ 120`; skew 30 s on both sides; integer times; `kind: presence`; `v: 1` | keyd | `verifyPresence` | `tests/owner-presence.test.mjs`: "an assertion is accepted for up to 120 s of lifetime and 30 s of skew, and no more" |
| keyd issues assertions for 60 s | keyd-side | — | none here |
| Audience, unavailable RPC code and the code-signing requirement (Team ID and identifier) | — | `owner-presence.mjs` constants, `developerIdRequirement` | `tests/owner-presence.test.mjs`: "the presence contract constants keyd and agent-bot share" |
| The signer comes from the environment, then the config; the Team ID has no default and empty is unset | — | `keydSigner` | `tests/owner-presence.test.mjs`: "the keyd signer comes from the environment, then the config; the Team ID has no default (#594)" |
| With no Team ID configured nothing is verified, run or pinned | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "with no keyd Team ID configured nothing is verified, run or pinned" |
| An organization profile names a specific signer, projects it into config, and can never set `any-developer-id` | — | `validateOrganizationProfile`, `organizationProfileToConfig` | `tests/owner-presence.test.mjs`: "the organization profile names the keyd signer and never loosens it" |
| Pinning under `any-developer-id`, or another signer than the last pin, needs the owner's approval and is receipted; refused, nothing runs and the gate refuses with `keyd-signer-unverified` | — | `pinnedPresenceKey`, `presenceOrConsent` | `tests/owner-presence.test.mjs`: "pinning under any Developer ID needs the owner and leaves a receipt", "pinning again under another team than the pin was taken under needs the owner", "an unapproved signer refuses the owner action with its code, never falling back to the dialog" |
| Only an explicit `any-developer-id` restores the requirement from before #594 | — | `developerIdRequirement` | `tests/owner-presence.test.mjs`: "only an explicit any-developer-id brings back the requirement from before #594" |
| A malformed signer is refused and pins nothing; the binary is verified against the configured signer before it runs | — | `keydSigner`, `pinnedPresenceKey`, `loadConfig` | `tests/owner-presence.test.mjs`: "a malformed keyd signer is refused, so nothing reaches the code-signing requirement", "the binary is verified against the configured team and identifier before it is run"; `tests/config.test.mjs`: "loadConfig accepts a keyd Team ID and identifier and rejects anything else (#594)" |
| Each request carries a fresh agent-bot nonce; a socket without keyd's key, or an assertion for another nonce, is refused | — | `keydPresence` | `tests/owner-presence.test.mjs`: "keydPresence asks keyd with the action and a fresh nonce, and checks the answer" |
| The presence key is pinned from the signed binary once, the pin file 0600, never from the socket | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "the presence key is pinned from the signed binary, once, and never from the socket", "a corrupt pin is replaced from the binary and left owner-only" |
| No record, an unsigned binary (never run) or a malformed answer pins nothing | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "no keyd, an unsigned keyd or a malformed answer pins nothing" |
| An unparseable pin file is pinned again from the signed binary | — | `pinnedPresenceKey` | `tests/owner-presence.test.mjs`: "a pin that does not parse as a key is pinned again from the signed binary" |
| `presence-unavailable` vs `owner-declined` (timeout included) | — | `keydPresence` | `tests/owner-presence.test.mjs`: "keydPresence tells \"nobody can be asked\" apart from \"the owner said no\"" |
| The administrator dialog only when keyd cannot ask; a refusal is final | — | `presenceOrConsent` | `tests/owner-presence.test.mjs`: "the gate asks keyd first and falls back to the administrator dialog only when keyd cannot ask"; "with no keyd installed the gate uses the administrator dialog, as before"; `tests/owner-gate.test.mjs`: "revision edit treats keyd refusal as final, without reaching the terminal-only dialog fallback" |
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
   runtime has no built-in Team ID (#752). With none configured, the owner
   gate uses the administrator dialog.
5. **Loosening.** The environment and config may name a specific signer
   freely. Accepting any Developer ID, or pinning under another signer than
   the last pin, needs the owner's verification and leaves a receipt.
