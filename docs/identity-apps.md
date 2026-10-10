# Managed GitHub Apps

The `github-identity` add-on must be enabled. With it off, list returns an
empty array; mutations other than `addon` return `identity-app-disabled`. No
SOP is required.
Naming and persona policy come from the caller. Mutations use the owner gate:
a soul cannot authorize them, and the owner must present a principal with
`--principal-stdin` or approve the native consent prompt.

```sh
agent-bot identity apps list --json
agent-bot identity app create --manifest [--name NAME] [--org ORG] [--open] [--json]
agent-bot identity app connect --id ID (--key-file PATH | --pass-cli ITEM) [--json]
agent-bot identity app rotate-key SLUG (--key-file PATH | --pass-cli ITEM) [--json]
agent-bot identity app assign SLUG (--harness H | --soul AGENT_ID) [--json]
agent-bot identity app remove (SLUG | APP_ID) [--json]
agent-bot identity addon github-identity on|off [--json]
```

`addon` is the owner switch for the add-on itself: it writes
`features.github-identity` in the runtime config (the same key a hand edit
sets) and returns `{addon:"github-identity", enabled, changed}`. It works
while the add-on is off and is owner-gated like every App mutation: a soul
cannot run it, and it needs the owner's principal or consent. Turning it off
stops every App token mint on the machine (see the README's `features`).
The other add-on, `persona-accounts`, has its own switch: `agent-bot sandbox on|off`.

`list` is offline: no mint, provider restore, or installation fetch. Each row
has `slug`, `botLogin`, `issuerPresent`, `keyPresent`, `key`, `installations`,
`harnesses`, `souls`, and `liveMint`. `key` is `{fingerprint, updatedAt}` for a
managed App (the stored private key's public SHA256 fingerprint and the ISO
time connect/rotation stored it; `updatedAt` is `null` for keys stored before
this field), otherwise `null`. Installations cached by connect/rotation
are `{id, account, repositorySelection, permissions}` (`all` or `selected`,
and the installation grant as GitHub reports it, permission name → `read`,
`write` or `admin`; `null` for a row cached before the grant was kept);
otherwise `[]`. The plain listing prints each one as
`installed:<account>(<selection>; <name>:<level>,…)`.

The grant is the most a token minted on that installation can do. It is not
the bot user's collaborator role on a repository: GitHub checks that role, not
the grant, for things like `@dependabot rebase` ("only users with push access"),
and `<slug>[bot]` has permission `none` unless it is added as a collaborator,
however wide the grant. A wider token does not change that.
Doctor caches only actual live results, never skipped checks. `liveMint` is
`{status:"unknown"}` until then, or `{status:"ready"|"failed", code, checkedAt}`.
A locked/unreadable store or a soul's keyd declaration reports false presence;
this does not prove deletion (a keyd declaration alone does not prove a key
exists). An App whose record says `store: keyd` (#110) reports its key
present: the record is written only after keyd read the key back.
No key, issuer value, webhook secret, JWT, or installation token appears in a
list row. The envelope is `{schemaVersion:1, addons:{"github-identity":true|false}, apps:[...]}`;
`addons` reports whether each add-on this command manages is on, and is present
whether or not it is (with it off, `apps` is `[]`).

`create` starts a ten-minute, one-callback listener on `127.0.0.1` and a random
port. Open its printed `localUrl` (or use `--open`), then submit the local form
and approve on GitHub. The manifest requests Contents, Pull requests and
Issues write permissions, disables webhooks, and requests no user OAuth.
The listener checks the host and state nonce, exchanges the code, and closes.
JSON CLI output is newline-delimited: a pending `{status,localUrl}` followed by
`{id,slug,installUrl,store}` (plus `storeReason` when the key is not in
agent-bot-keyd; see below) or an error. The install URL is the next owner action;
creating an App does not install it. If the bot profile lookup is temporarily
unavailable, the result adds `metadataPending: true`: the one-time App key
and ID are still saved, and setup-worktree backfills UID/avatar on lookup. Cancellation and timeout close the listener.

`connect` verifies the supplied ID/key with `GET /app`, discovers its slug,
and caches installations. It works before installation and can restore an
absent managed credential; a present key requires `rotate-key`. `--pass-cli ITEM`
selects an item title in the existing **Agent Identities** vault: a private-key
attachment or Private Key field. Downloads use a private temporary directory
that is removed on success or failure. No key is copied under `~/.config`.

GitHub documents key generation in the App's **Settings → Private keys** UI,
not a public REST key-generation endpoint. Generate and download a new key
there, then run `rotate-key`. It verifies the App and mints an installation
token before replacing the stored key. Failure leaves the old key in place.
Existing readable legacy/per-soul keys can also rotate into the managed store;
old copies are retained. Success returns `{id,slug,installUrl,store,retired,action}`; `retired` is the old
SHA-256 SPKI public-key fingerprint. **Delete that old key on github.com**;
local retirement does not revoke it. With multiple installations, config
`owner` selects the account for the verification mint.

`assign` accepts managed Apps (connect or rotate legacy credentials first). It
atomically replaces the harness's `apps` override, or updates the
soul's identity and census App metadata with rollback on census failure.
It does not edit the soul package/revision or repin existing worktrees.
Explicit App arguments, `GH_AGENT_APP` and worktree App pins retain priority;
a soul's managed assignment precedes account/harness detection. Doctor includes
managed Apps even before assignment. Restart running sessions that carry an
old explicit App environment or pin after updating those values.

Apps created before a soul exists use the #395 Keychain/file-store machinery
with an App namespace. Config `identityApps[slug]` stores public `id`, `botUid`, `botAvatarUrl`,
store name, fingerprint and installation metadata only. Create and connect
resolve the bot user profile and save its UID and HTTPS avatar at creation;
rotation preserves/refreshes that metadata. The App ID and bot user ID are
different identifiers. Metadata-only records created by migration have no
`store` until an App-scoped key is connected. Several souls can share this
single App metadata record. macOS uses Keychain service
`agent-bot.app.SLUG`; other platforms use private files below identity state
`identity-apps/SLUG/.soul-state/credentials/`.

When agent-bot-keyd is verified (it answers, has pinned this daemon's key and
knows App-level keys), create, connect and rotate-key keep a new key there
instead, as an App-level key (#110), and the record says `store: keyd`; no
readable copy is written, and souls acting as the App mint through keyd. When
keyd is not verified, or is older than #110, the key goes to Keychain or the
file store and `storeReason` says why. Any other keyd refusal fails the
operation and stores nothing, except create's one-time key, which falls back
with the reason. An App already in Keychain or the file store keeps it,
rotation included; a key keyd already holds for an App with no record here is
not replaced. A manifest's webhook secret for a keyd-held App is kept in its
own item beside the key's usual one: Keychain service `agent-bot.app.SLUG.webhook`
(account `github-app/SLUG`), pass-cli note `agent-bot.app.SLUG.webhook/github-app/SLUG`,
or the file `github-app-SLUG.webhook.json` (`webhookSecretKept: true`). The key
item always holds a key. One create, connect, rotate-key or remove
runs per App at a time; another refuses with `identity-app-busy`. Details are in
[keyd-protocol.md](keyd-protocol.md#app-level-keys-110). Managed credentials precede
legacy readable stores. A soul's existing `keyd` declaration remains
helper-owned: connecting/rotating over it or assigning that soul through this
API refuses with `identity-app-keyd-held`. Use the keyd owner workflow.

`remove` forgets a managed App on this machine (named by slug, or by its
numeric App ID when no record has that slug): it deletes the App-scoped
store item (Keychain `agent-bot.app.SLUG` / `github-app/SLUG`, or the private
file below identity state), the config `identityApps[SLUG]` record (public
ID, bot UID/avatar, fingerprint, cached installations) and its doctor cache
row. The App is any slug with an `identityApps` record, including a
metadata-only one with no stored key, and retired or out-of-scope Apps. It
refuses with `identity-app-assigned`, naming each one, while a harness (an
`apps` override or the `prefix` pattern, as list's `harnesses` reports) or a
non-retired soul (list's `souls`) still points at the App: assign them another
App first. There is no `--force`. Nothing on github.com changes (delete the
App or its keys there yourself) and a legacy `~/.config/SLUG` folder is left
alone. If the config write fails, the store item is restored. A locked or
unreadable store refuses with `identity-app-store` and removes nothing.
Success returns names, never contents:

```json
{"slug":"you-claude-agent","id":"123","removed":{"storeItem":{"store":"keychain","name":"agent-bot.app.you-claude-agent/github-app/you-claude-agent","existed":true},"configRecord":true}}
```

`storeItem` is `null` for a metadata-only record; `name` is the file path for
the file store; `existed:false` means the record named a store item that was
already gone.

For a keyd-held App (#110), `remove` sends `owner/app-remove`, so keyd asks
the owner again, then deletes the webhook-secret item and the record;
`removed.keydKey` says whether keyd held the key, `storeItem` is `null` and
`webhookSecretItem` names the webhook item as `storeItem` would. keyd not running, older than
#110, or refusing (the owner declined) fails with `identity-app-keyd-unavailable`
or `identity-app-keyd-refused` and removes nothing. A key keyd holds for a
slug with no record here (a create whose record was never written) is removed
only when that slug is named, after the owner gate and keyd's own prompt; the
result says so with `configRecord: false` and `orphan: true`. A slug that is
neither recorded nor held by keyd is `identity-app-not-found`.

## Daemon contract

All routes use the same loopback-peer and bearer authentication as population
routes; POSTs additionally require the owner gate. Optional `principal` is a
presented owner credential and is never echoed. Request field names:

| Route | Body / result |
| --- | --- |
| `GET /v0/identity/apps` | List envelope above |
| `POST /v0/identity/apps/create` | `{manifest:true, name?, org?, principal?}` → HTTP 202 `{jobId,status:"pending",localUrl}` |
| `GET /v0/identity/apps/jobs/ID` | `{jobId,status,localUrl? ,result?,error?}` |
| `POST /v0/identity/apps/connect` | `{id:"123", keyFile:"/absolute/path"}` or `passCli` instead of `keyFile` |
| `POST /v0/identity/apps/rotate-key` | `{slug, keyFile}` or `{slug, passCli}` |
| `POST /v0/identity/apps/assign` | `{slug, harness}` or `{slug, soul}` |
| `POST /v0/identity/apps/remove` | `{slug}` (a slug or App ID) → the remove result above |
| `POST /v0/identity/apps/addon` | `{name:"github-identity", enabled:true\|false}` → `{addon,enabled,changed}` |

Job status is `pending`, `complete` or `failed`. `result` is the create result;
job `error` is `{code,message}`. Jobs are in memory, expire after one hour,
and disappear on restart. Daemon shutdown cancels listeners; at most 32 jobs
are retained. Key file paths refer to the daemon's host. Unknown fields refuse.

CLI failures are `{error:{code,message}}` with exit 1. Daemon failures are
`{error:message,code}`: 400 invalid input, 403 owner approval required,
404 unknown App/job, 429 full job queue, otherwise 409. Codes start with
`identity-app-`; common suffixes are `disabled`, `invalid`, `owner-required`,
`exists`, `not-found`, `assigned`, `store`, `key-unavailable`, `key-invalid`, `key-unchanged`,
`keyd-held`, `keyd-unavailable`, `keyd-refused`, `busy`, `github`, `installation`, `conflict`, `timeout`, and `cancelled`.
Upstream error bodies and provider output are never reflected.

References: [GitHub manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
[GitHub private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps),
[per-soul stores](soul-credentials.md).

Legacy `~/.config/<slug>` metadata is a read fallback only. Run
`agent-bot identity migrate-credentials --all` to copy it into App records;
the per-App report and doctor name remaining files and provide an owner
removal command once the folder is fully redundant. Nothing in it is deleted by
agent-bot, `identity app remove` included. See [migration report fields](soul-credentials.md#migrating).
