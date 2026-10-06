# Managed GitHub Apps

The `github-identity` add-on must be enabled. With it off, list returns an
empty array; mutations return `identity-app-disabled`. No SOP is required.
Naming and persona policy come from the caller. Mutations use the owner gate:
a soul cannot authorize them, and the owner must present a principal with
`--principal-stdin` or approve the native consent prompt.

```sh
agent-bot identity apps list --json
agent-bot identity app create --manifest [--name NAME] [--org ORG] [--open] [--json]
agent-bot identity app connect --id ID (--key-file PATH | --pass-cli ITEM) [--json]
agent-bot identity app rotate-key SLUG (--key-file PATH | --pass-cli ITEM) [--json]
agent-bot identity app assign SLUG (--harness H | --soul AGENT_ID) [--json]
```

`list` is offline: no mint, provider restore, or installation fetch. Each row
has `slug`, `botLogin`, `issuerPresent`, `keyPresent`, `installations`,
`harnesses`, `souls`, and `liveMint`. Installations cached by connect/rotation
are `{id, account, repositorySelection}` (`all` or `selected`); otherwise `[]`.
Doctor caches only actual live results, never skipped checks. `liveMint` is
`{status:"unknown"}` until then, or `{status:"ready"|"failed", code, checkedAt}`.
A locked/unreadable or keyd-only store reports false presence; this does not
prove deletion (a keyd declaration alone does not prove a key exists).
No key, issuer value, webhook secret, JWT, or installation token appears in a
list row. The envelope is `{schemaVersion:1, apps:[...]}`.

`create` starts a ten-minute, one-callback listener on `127.0.0.1` and a random
port. Open its printed `localUrl` (or use `--open`), then submit the local form
and approve on GitHub. The manifest requests Contents, Pull requests and
Issues write permissions, disables webhooks, and requests no user OAuth.
The listener checks the host and state nonce, exchanges the code, and closes.
JSON CLI output is newline-delimited: a pending `{status,localUrl}` followed by
`{id,slug,installUrl}` or an error. The install URL is the next owner action;
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
old copies are retained. Success returns `{id,slug,installUrl,retired,action}`; `retired` is the old
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
`identity-apps/SLUG/.soul-state/credentials/`. Managed credentials precede
legacy readable stores. A soul's existing `keyd` declaration remains
helper-owned: connecting/rotating over it or assigning that soul through this
API refuses with `identity-app-keyd-held`. Use the keyd owner workflow.

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

Job status is `pending`, `complete` or `failed`. `result` is the create result;
job `error` is `{code,message}`. Jobs are in memory, expire after one hour,
and disappear on restart. Daemon shutdown cancels listeners; at most 32 jobs
are retained. Key file paths refer to the daemon's host. Unknown fields refuse.

CLI failures are `{error:{code,message}}` with exit 1. Daemon failures are
`{error:message,code}`: 400 invalid input, 403 owner approval required,
404 unknown App/job, 429 full job queue, otherwise 409. Codes start with
`identity-app-`; common suffixes are `disabled`, `invalid`, `owner-required`,
`exists`, `not-found`, `key-unavailable`, `key-invalid`, `key-unchanged`,
`keyd-held`, `github`, `installation`, `conflict`, `timeout`, and `cancelled`.
Upstream error bodies and provider output are never reflected.

References: [GitHub manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
[GitHub private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps),
[per-soul stores](soul-credentials.md).

Legacy `~/.config/<slug>` metadata is a read fallback only. Run
`agent-bot identity migrate-credentials --all` to copy it into App records;
the per-App report and doctor name remaining files and provide an owner
removal command once the folder is fully redundant. Nothing is deleted by
agent-bot. See [migration report fields](soul-credentials.md#migrating).
