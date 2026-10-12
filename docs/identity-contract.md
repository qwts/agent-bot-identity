# Identity's public contract

This is ADR-0645 migration step 7. It says what the rest of the runtime may
call in identity, in which form, and what identity persists. Soul, host, cli
and comms use only what is listed here. After step 9, identity ships as
`qwts/agent-identity` inside each agent-bot release at a pinned version
(answer 3). Everything here then comes from that pinned package, and nothing
else in identity can be reached.

How identity leaves this repository is
[identity-extraction-plan.md](identity-extraction-plan.md) (step 8).
Background and line references are in
[identity-contract-inventory.md](identity-contract-inventory.md). The owner
decisions that shaped this are recorded there in §8.
`tests/identity-contract.test.mjs` keeps this page in step with the module
map and with identity's record entry.

## How the runtime reaches identity

There are four forms. Each caller uses the one its decision named.

1. **Published entries, in-process.** Each is a file the module map lists
   under `contracts`, with its exact exports and the modules that may import
   it. Widening one is a reviewed map change.
2. **Identity's record entry, out of process.** `identityOp(op, input)` in
   `daemon-client.mjs` runs `identity-entry.mjs <op>` as a child process.
   - It sends one JSON object on stdin and reads `{result}` or `{error}` back.
   - It needs no daemon (owner decision D4, F6 answers Q1 and Q2).
3. **Daemon routes.** The daemon (host) serves them over loopback. It keeps
   the bearer and binding-proof checks and hands identity's routes to
   identity's handler (D5, D6, Q-F9-2).
4. **Wire formats.** Other programs depend on these byte for byte: the
   binding proof, the soul token from `/v0/vouch`, keyd's grant and presence
   formats, and the owner statement.

## Published entries

Every identity file the module map lists under `contracts` has a section
here. The map lists each one's exact exports.

### `identity-format.mjs`

The shared format contract (F1, F4, D2), importable by soul, host, cli and
comms. It holds the Agent ID, principal and transport formats, and the audit
receipt writer. It also holds the git config key names, the owner-credential
refusal, tool-call risk, the git hook names and the credential item names. It
imports only node built-ins and `state-paths.mjs`, so that after extraction a
test can keep it byte-identical with its copy (answer 2).

### `daemon-client.mjs`

The daemon contract (F5, D3), importable by soul, host, cli and comms. It
covers the daemon state file, the loopback client and the health probe. It
also holds `identityOp`, the client for identity's record entry, and
`spawnIdentity` for `agent-bot identity spawn`.

### `identity-presence.mjs`

Pure keyd p1 verification, importable by soul, host, cli and comms. It exports
`actionDigest(action)` (SHA-256 of the exact UTF-8 action) and
`verifyPresence(token, { key, action, nonce, now })`, returning the original
signed payload. `key` is the existing base64-encoded raw Ed25519 public key;
`now` is milliseconds and defaults to `Date.now()`. The caller must obtain the
key from its trusted enrollment or pinned native helper and reconstruct the
exact action and nonce from authenticated saved context. Successful verification
is not enrollment, authorization, nonce consumption or permission to mutate.

The existing p1 signature covers the encoded payload segment. Its audience,
kind, nonce, action digest, maximum 120-second declared lifetime and inclusive
30-second clock skew checks remain unchanged. Existing p1 JSON/base64 decoding
is unchanged; another protocol's stricter canonical JSON and deadline checks
belong to that protocol's binding layer. Callers receiving external frames must
bound their inputs and validate a supplied clock value before calling; broker
bindings must separately enforce their preparation, staging and receipt caps.
The original `owner-presence.mjs`
entry continues to re-export the same functions. This entry and its internal
verification leaf import only Node built-ins and perform no prompt, filesystem,
process launch, key lookup or secret access. Trusted host composition may pass
this fixed implementation to a separate broker binding layer; callers cannot
select a verifier through request data.

The standalone agent-comms broker may consume a reviewed build-time snapshot
of `identity-presence.mjs` and its `identity/presence-verifier.mjs` closure,
byte-identical to a pinned bot source commit. The snapshot records both source
hashes, license and provenance, and mandatory hash/parity tests enforce it.
Agent-bot remains the sole implementation owner; agent-comms makes no local
patches. This is a public verification dependency, with no mutable installed
path lookup, runtime npm dependency or request-selected verifier. A future
extracted identity package may replace the snapshot under this same contract.

### `identity-host.mjs`

Host's one entry (D5, F9), importable by host only. It holds the binding
registry and the functions host needs in-process: bot checks, principals,
approvals, keyd, vouch, the secret stores and the inbox. With F9 steps 2 to
4 it also holds identity's route handler and identity's half of spawn.

### `identity-cli.mjs`

cli's entry (F13 step 3; the owner's revised Q-F13-3 answer), importable by
cli only. It is in-process, so readiness keeps its injectable probes. It holds
the readiness and doctor probes, the bootstrap actions and the hook fallback.
F8 and F13 step 4 add the owner and principal command functions in the PR
stacked on it.
### `identity-soul.mjs`

Soul's and comms' entry (owner decisions of 2026-10-11), importable by soul and
comms. It is in-process and holds the binding reader, the bot and App resolver,
the vouch key paths, the co-author rules, session grants and comms'
binding-proof signing. Credential custody (F7) and the owner
gate (F8) join it in the PRs stacked on it.

## Record operations

`identityOp` runs these operations of `identity-entry.mjs`. Inputs are data
only: `now` is an ISO timestamp, and `id` fixes a minted Agent ID. Errors
carry `invalid-input`, `unknown-op` or `operation-failed`.

| Operation | Does |
| --- | --- |
| `read` | Reads one identity record. |
| `read-many` | Reads several records, reporting each failure in its place. |
| `current` | The Agent ID this process or checkout runs as. |
| `discover-transcript` | The harness transcript this process runs in. |
| `mint` | Mints an Agent ID. |
| `ensure` | Reuses or mints the identity for a session. |
| `bind-transcript` | Binds a record to its transcript. |
| `record-evidence` | Adds subjects and artifacts to a record. |
| `retire` | Marks a record retired. |
| `finalize` | Marks a record finalized. |
| `initialize-app` | Fills an absent GitHub App on a record. |
| `mint-bind-token` | Writes a worktree's single-use bind token. |

Retire, finalize and `initialize-app` take no callback and have no undo.
- A caller that keeps a second store in step writes its own store first and
  the identity record last, and restores its own store if the identity write
  fails.
- Identity never restores a record a caller hands it (owner decision on
  revert, option 1).

`recordAgentPackageRevision` stays in-process (owner answer on callbacks).

## Daemon routes

Each route's authorization class is in
[daemon-api.md](daemon-api.md#route-authorization). Identity's routes are:

- `POST /v0/bind` (bind token);
- `GET /v0/binding`, `DELETE /v0/binding` and `POST /v0/binding/app`;
- `POST /v0/credential`, the soul's own App token, never a request
  parameter;
- `POST /v0/inbox/take`;
- `POST /v0/grants/request` and `POST /v0/grants/spend`;
- `POST /v0/keyd/grant`, public: keyd's relay calls it;
- `POST /v0/vouch`, public: agent-comms calls it;
- identity's half of `POST /v0/spawn`;
- `GET /v0/identity/apps`, `GET /v0/identity/apps/jobs/{id}` and
  `POST /v0/identity/apps/{action}`.

`POST /v0/register` is soul's route (D6).

## What identity persists

The move changes none of these (ADR-0645 §5). They are listed with their
readers in the inventory:

- the identity records, the binding files and bind tokens, and the daemon
  state file (§4);
- the environment variables (§5);
- the git config keys, the `Agent-Identity` trailer, the Keychain and pass
  item names, keyd's MCP server and tools, and the owner-statement
  namespace (§6).

The `agent-bot` command and its subcommands, the service labels and the
sockets don't change either. Changing any of them is a separate decision,
with a migration and a rollback.

## Assets

The module map's `assets` section assigns identity's non-code files: `keyd/`,
`scripts/ensure-identity.sh`, `wrangler.toml` and the git hooks. The hooks run
soul's steps only through soul's hook adapter, `hooks/soul-hook` (F14).

## Still landing

The open #645 PRs bring the runtime to this contract:

- #951 to #953: identity's route handler, `/v0/register` as a soul route,
  and the spawn split;
- #956 and #964: `identity-cli.mjs`, cli's entry;
- #961 to #963: `identity-soul.mjs`, soul's and comms' entry, with custody
  (F7) and the owner gate (F8);
- #960: the last soul `ensure` import;
- #965: the assets and the hook split.

Each PR that adds a published entry also adds its section above; the test
holds it to that.
