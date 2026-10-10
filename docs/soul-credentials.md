# Soul credentials

A soul that acts as a GitHub App keeps that App's key in its own key store
(#383). Agents never touch the store: the daemon and the mint path read it and
hand the soul short-lived installation tokens.

## Declaration

`soul.json` names the App and the store, never the key:

```json
{
  "credentials": {
    "github": { "app": "you-claude-agent", "store": "keychain" }
  }
}
```

`store` is `keychain` (the macOS default), `file` (the default elsewhere),
`pass-cli` (opt-in Proton Pass), or `keyd` (agent-bot-keyd, below).
The platform default is unchanged; select pass-cli in this per-soul declaration
or migrate with `--to pass-cli`.
Any other key, under `credentials` or `credentials.github`, fails validation,
so a key cannot be packaged by mistake. `soul spawn` copies the declaration
into every instance. The key is not copied.

### Provider secrets (`credentials.secrets`)

A soul whose harness talks to a model provider declares the secret that
provider needs beside the App declaration (#583 slice 4):

```json
{
  "credentials": {
    "github": { "app": "you-claude-agent", "store": "keychain" },
    "secrets": { "github-models": { "store": "keychain" } }
  }
}
```

`credentials.secrets.<name>` accepts `store` only (`keychain`, `file` or
`pass-cli`; not `keyd`, which never returns a value). The same store
implementations keep these under the same per-soul namespace: Keychain
service `agent-bot.soul.<agentId>`, account `secret/<name>`; file
`.soul-state/credentials/secret-<name>.json` (`.dpapi` on Windows, same
0700/0600 owner checks); Proton Pass note `agent-bot.soul.<agentId>/secret/<name>`.
The owner stores the value with `agent-bot soul secret <soul> set <name>`
(value on stdin); `harnesses.<h>.provider.credential` names it; at launch
it goes into that harness's environment only. See
[soul-providers.md](soul-providers.md).

## Stores

- **keychain**: a generic password in the login keychain, service
  `agent-bot.soul.<agentId>`, account `github-app/<slug>`. It is written and
  read with `/usr/bin/security`. The secret is passed on `security -i`'s
  stdin, never on a command line. The value is base64 of
  `{appId, privateKeyPem}`.
- **file**: `<soul>/.soul-state/credentials/github-app-<slug>.json`. The
  directory is 0700 and the file 0600, both owned by this user. A read refuses
  a link, a loosened mode or another owner. `.soul-state/` is never packaged,
  exported or hashed into a revision. On Windows the same store keeps
  `github-app-<slug>.dpapi` instead, encrypted with DPAPI for this account on
  this machine through PowerShell on stdin; see [Windows](windows.md).

- **pass-cli**: one note item per soul/App credential in the existing
  **Agent Identities** vault. Its exact title is
  `agent-bot.soul.<agentId>/github-app/<slug>`: the Keychain service and
  account joined by `/`. For example,
  `agent-bot.soul.agent_44444444-4444-4444-8444-444444444444/github-app/you-claude-agent`.
  The note contains the same base64 JSON credential as the other stores,
  including `webhookSecret` when present. Creation uses
  `pass-cli item create note --from-template -` with the template on stdin;
  no key is put on argv or in a temporary file. Requires pass-cli with note
  template support, an existing authorized session, and write access to the
  vault. The store never logs in, unlocks, or creates a vault automatically.
  Vault/title ambiguity and missing, locked, malformed, or unreadable items
  fail closed. Reads resolve and validate stable vault/item IDs. A write of
  the same credential is idempotent; a different existing value is refused
  and preserved, since the CLI's field-update interface puts values on argv.
  The owner must explicitly remove that item before migrating a replacement.
  The internal delete operation trashes then deletes the selected item;
  migration never deletes a source or destination item.

Only owner/daemon processes can use the pass-cli store; soul-marked callers
are refused before any provider call. As with Keychain, confinement is the
cooperative boundary, not an OS-level restriction on every process in the
account. Provider error output and nested errors are not exposed.

`ensure-private-key`, the reconciler, and mint resolution read an existing
pass-cli soul declaration directly. Preparation reports its non-file location
as `pass-cli:Agent Identities/agent-bot.soul.<agentId>/github-app/<slug>`.
App `connect --pass-cli ITEM` remains a separate import operation using the
shared pass-cli runner: it restores into the App-scoped private file store
(or an already declared App Keychain store), with the issuer in
`identityApps[slug].id`. It never creates or writes the legacy folder.
An interrupted legacy publication is retained for owner inspection; its
backups are not replayed or deleted.

### Host credential names (#676)

The names above are the defaults. A host that embeds agent-bot sets two
variables in the daemon's own service unit (written there by `agent-bot
daemon install`, as `AGENT_BOT_SERVICE_LABEL` is):

- `AGENT_BOT_CREDENTIAL_NAMESPACE` replaces the `agent-bot` prefix, so items
  become `<ns>.soul.<agentId>`, `<ns>.app.<slug>` and the pass-cli title
  `<ns>.soul.<agentId>/github-app/<slug>`. Letters, digits, dots,
  underscores and hyphens, at most 64.
- `AGENT_BOT_CREDENTIAL_VAULT` replaces the **Agent Identities** vault for
  soul notes and for `connect --pass-cli` imports. Letters, digits, spaces,
  dots, underscores and hyphens, at most 64, with no space at either end.

Unset or empty, every name is exactly as before. A malformed value refuses
with `usage` when a store is built, before any store call. A store reads only
the names its own environment resolves: a miss under a host's names never
falls back to the defaults or to another host's names, so keys written under
the defaults stay where they are until they are moved explicitly. keyd's
`agent-bot.keyd.*` items are named by keyd and do not follow (#594).

Two things help a host that changes its names:

- `agent-bot doctor` reports `credential.names`: a warning when this shell's
  `AGENT_BOT_CREDENTIAL_NAMESPACE` or `AGENT_BOT_CREDENTIAL_VAULT` resolves
  to a different name than the installed daemon unit's, since the CLI and the
  daemon would then look under different names. Unset and the default agree.
- `agent-bot identity migrate-credentials --all --from-namespace OLD` (or
  `--soul ID`) copies, as the owner, each soul's App key and declared provider
  secrets, and with `--all` each managed App key, from the `OLD` names to the
  ones this environment resolves. Each copy is read back from its new name and
  compared; a different value already under the new name is reported, never
  overwritten; the old items are never deleted. Only Keychain and pass-cli
  items are named by namespace; file and keyd stores are skipped.
  `--from-vault OLD` does the same for pass-cli notes kept in an old vault,
  alone or with `--from-namespace`; only pass-cli is named by vault, so other
  stores are skipped. `--dry-run` lists what would be copied, and the output
  names items, never values.

### What the Keychain access list can and cannot enforce

A Keychain item's trusted-application list names executables, not scripts:

- The item is created by `security`, so `security` is trusted by default.
- The daemon is a Node script that reads through `security`.
- The only executables the list could name are `security` and `node`.
  Trusting `node` would trust every Node script in the account.

**What it does not do.** The Keychain does not lock the item to the daemon.
Any process in the owner's account that runs `security find-generic-password`
can read it.

**What it does give:**

- the item is encrypted at rest;
- it cannot be read while the login keychain is locked;
- it is not a plain file in any directory an agent works in.

**What keeps souls out.** Confinement denies souls the `security` and
`pass-cli` executables and every credential path ([confinement](confinement.md)).
That is a cooperative hook, not an OS boundary.

Locking the item to a signed binary is what the `keyd` store does.

## agent-bot-keyd (#397)

GeniusBar ships `agent-bot-keyd`, a native MCP server signed with the app's
Developer ID. It holds souls' App keys and signs App JWTs; agent-bot keeps
the policy. Homebrew and Linux installs have no keyd and keep the stores
above.

- **Keys.** keyd creates a login-keychain item per key with the Security
  framework (service `agent-bot.keyd.<agentId>`, account `github-app/<slug>`,
  the same value encoding). An item created this way trusts only its
  creator's designated requirement: keyd's Team ID and identifier. `security`,
  `node` and every script get the system's allow/deny prompt instead of a
  silent read. keyd never returns a key, over any channel.
- **Sockets.** `<state>/keyd/` (0700) under agent-bot's state directory
  (`$XDG_STATE_HOME/agent-bot` or `~/.local/state/agent-bot`) holds
  `keyd.sock` (MCP: `credential`, `git_credential`) and `owner.sock` (owner
  operations), both 0600. keyd also checks each peer's user ID. Every call
  leaves a receipt in `keyd/audit.jsonl`, never a secret.
- **Who may mint: daemon-signed grants.** keyd mints only on a grant the
  daemon signed with its account Ed25519 key (the vouch key), which keyd
  pinned in its own Keychain item on the first import:
  `v1.<base64url(payload)>.<base64url(signature)>`, with payload
  `{v, aud: "agent-bot-keyd", agentId, app, tool, iat, exp, nonce, apiBase,
  installationId, owner, host}`. A grant lives 60 seconds and names one tool;
  keyd spends each nonce once. Grants rather than keyd calling the daemon
  back: keyd needs no daemon credential and no network path to it, and the
  check is one signature.
- **Souls.** A turn of a soul whose `store` is `keyd` gets keyd's relay,
  `agent-bot-keyd mcp`, as an MCP server, with allow rules for
  `mcp__agent-bot-keyd__credential` and `__git_credential`. For each call the
  relay sends `POST /v0/keyd/grant {tool}` with the soul's binding proof (the
  same proof every binding route takes). The daemon checks the binding, the
  `github-identity` gate, that the soul's App is the declared one and that
  keyd holds it, receipts a `credential-grant`, and signs. The relay forwards
  the call with the grant to `keyd.sock`. The relay never opens the Keychain.
- **The daemon's own mints.** `/v0/credential`, and through it the git
  credential helper and `mint-token` run in a keyd soul's worktree, sign a
  grant in-process and call keyd's `credential` tool.
- **Owner operations.** `owner/import`, `owner/remove` and `owner/pin` go
  to `owner.sock`, and keyd asks the owner itself (Touch ID or the login
  password, through LocalAuthentication) before changing anything. A
  different daemon key is refused until the owner pins it.

What this does not stop: a process in the owner's account that can read the
daemon's vouch key file can sign grants and get tokens, never keys.
Confinement denies souls `vouch-key.pem` and keyd's directory and sockets in
every tool; like the rest of confinement, that is a cooperative hook.

The grant, owner-presence and key-pinning protocol as implemented, with the
test behind each invariant, is in [keyd protocol](keyd-protocol.md).

```sh
agent-bot keyd install --bin PATH [--json]   # GeniusBar runs this at setup
agent-bot keyd status [--json]              # and whether keyd is the pinned version (#767)
agent-bot keyd uninstall [--json]            # the Keychain items stay
```

`install` writes a launchd agent (`AGENT_BOT_KEYD_SERVICE_LABEL`, default
`dev.qwts.agent-bot.keyd`; GeniusBar uses `app.geniusbar.keyd`) that runs
`agent-bot-keyd serve`.

## Resolution at mint

For an App slug, the mint path (`mint-token`, the git credential helper, the
daemon's `/v0/credential`) checks these places in order:

1. **The selected soul's keyd store.** A keyd declaration for the selected
   soul always stays with the signed helper.
2. **Managed App store.** Apps registered through the [managed App API](identity-apps.md)
   use the same readable backends with an App namespace.
3. **The soul's store.** The selected soul, else any declaring soul in the
   census. An unreadable store fails closed rather than falling back.
4. **The legacy `~/.config/<slug>/{app-id,private-key.pem}`.** The issuer
   prefers `identityApps[slug].id`; the legacy `app-id` is a read fallback. The first use
   prints a one-time deprecation notice on stderr.

`GH_APP_ID` with `GH_APP_PRIVATE_KEY` or `GH_APP_PRIVATE_KEY_PATH` keeps
working as before. Nothing in this path prints, logs, audits or returns key
material. No agent-facing command or MCP tool returns a key.

## Mint receipts (#107)

Every mint through the daemon's `/v0/credential`, every `agent-bot
mint-token` mint attempt and every owner-approval refusal in `mint-token`
appends a `credential-mint` receipt to the interaction home's `audit.jsonl`.
A `mint-token` run that stops before that, at `--help` or an argument error
such as an unknown option, mints nothing and writes no receipt. A receipt carries no token, key, or
error text. Besides `at`, `event`, `agentId` (daemon only), `operation` and
`decision`, it adds two optional fields that older readers can ignore:

- `appSlug`: the App the mint was for, once one is known.
- `reason`: a fixed code for the outcome.

| `operation` | `decision` | `reason` |
| --- | --- | --- |
| `tier1-app-token` | `granted` | `bound-soul-own-app` |
| `tier1-app-token` | `denied` | `no-live-binding`, `soul-retired`, `no-transcript-locator`, `github-identity-off`, `no-github-app` |
| `tier1-app-token` | `failed` | `identity-unreadable`, `mint-failed` |
| `mint-token` | `granted` | `owner-approved`, `bound-soul-own-app` (a bound checkout's own App, through the daemon), or the selector: `explicit-app`, `env-app`, `env-credential`, `ambient-app` (checkout pin, the soul's managed App from `AGENT_BOT_ID` or the worktree's Agent ID, account, or harness) |
| `mint-token` | `denied` | `owner-approval-refused` |
| `mint-token` | `failed` | `no-app-selected`, `mint-failed` |
| `mint-token`, `signed-commit`, `gist-handoff` | `approved` | `owner-presence`, `owner-consent` |
| `mint-token`, `signed-commit`, `gist-handoff` | `denied` | `owner-gate-refused` |

A caller with a soul marker (#775) — a binding, an Agent ID, or a stated App
(`GH_AGENT_APP`, the checkout pin, an agent account) — that asks `mint-token`,
`signed-commit` or the gist handoff for another App, sets a `GH_AGENT_APP`
override, or passes `--permissions` goes through the owner gate
(Touch ID through agent-bot-keyd, else the administrator dialog) first. The
gate's answer is receipted (with the soul's `agentId` when it has one) as `approved` or
`denied`; a decline or a headless run mints nothing. A bound checkout's own App
always comes from the daemon.

A `mint-token` receipt is best effort: if it can't be written, the command
warns on stderr and the mint goes ahead as before. A `mint-token` run for a
keyd-held key also leaves the daemon's own `tier1-app-token` receipt.

`/v0/credential` mints only for a soul with a transcript locator, on its
binding or its record (#107).

## App reconcile at bind (#107)

A bind can name the App the session was explicitly run as (`GH_AGENT_APP`, or
the checkout's pin). When it differs from the App the soul's record names, the
daemon reconciles the record:

- If the organization profile maps the soul's harness to that App, the record
  is updated. The mapping must come from the validated profile in the runtime
  config, and the App must be one of its active identities for that harness.
  A hand-written `apps` entry doesn't count, so the owner is asked.
- Otherwise the owner's selection wins once the owner verifies it with Touch
  ID through agent-bot-keyd, or the macOS dialog where keyd can't ask. If
  nobody verifies, the record stays as it was and the daemon keeps minting the
  recorded App. The bind still succeeds.

A session that resumes on a binding left by an earlier one states its App
through that binding (`POST /v0/binding/app`), with the same rules.

The bind result's `app` field says what happened. After a reconcile, the MCP
`bind` tool repins the checkout. Run `agent-bot setup-worktree` in that
checkout to refresh its commit identity and credential helper. A soul whose
key agent-bot-keyd holds changes App only through the keyd owner workflow.

Each outcome appends an `app-record-reconcile` receipt with `operation`
`bind`, the claimed App as `appSlug`, and the recorded App in `detail`:

| `decision` | `reason` |
| --- | --- |
| `granted` | `org-mapping-agrees`, `owner-verified` |
| `denied` | `owner-not-verified`, `keyd-held` |
| `failed` | `record-write-failed` |

## Migrating

```sh
agent-bot identity migrate-credentials --all --dry-run
agent-bot identity migrate-credentials --soul AGENT_ID|NAME [--json] [--principal-stdin]
agent-bot identity migrate-credentials --all --to keyd
agent-bot identity migrate-credentials --soul AGENT_ID --to pass-cli --dry-run
agent-bot identity migrate-credentials --soul AGENT_ID --to pass-cli
```

Owner only, through the owner gate: a caller with any soul marker is refused,
dry run included. For each soul with a GitHub App (declared, or the census
`appSlug`), the command:

1. verifies the source key live with an App JWT against `GET /app`, proving
   GitHub accepts it without minting an installation token;
2. copies it into the soul's store;
3. reads it back and requires an exact match to the verified credential;
4. if the soul had no declaration, writes one into `soul.json` as a new
   revision;
5. copies public `app-id`, `bot-uid` and `bot-avatar-url` into the config's
   `identityApps[slug]` record as `id`, `botUid` and `botAvatarUrl`, preserving
   existing authoritative values and store/installation fields. This also
   runs for keys migrated earlier. `--all` includes configured Apps without
   souls for metadata migration.

Each migration leaves a `credential-migrate` audit receipt with no key
material. The report retains `souls`, `removableLegacyKeys` and `deleted: []`,
and adds one `apps[]` row per slug:

- `slug`, `metadata: {status, fields}`: status is `migrated`,
  `already-migrated`, `would-migrate` (dry run), or `failed`; fields are the
  public config field names copied or proposed.
- `legacyFolder`, `legacyFolderExists`, `legacyFolderRemovable`.
- `remainingFiles`: names still blocking removal. Unknown files, directories,
  symlinks, unreadable entries and conflicting metadata block removal.
- `removalCommand`: shell-quoted owner command when removable, otherwise null.

`doctor --json` includes the same folder fields in `machine.apps[]`; text
output prints them and the owner command. A nonexistent folder reports
`legacyFolderExists: false`, `legacyFolderRemovable: false` and no command.
All souls using a shared App must have an independent credential before its
legacy key is removable; selecting just one soul cannot bypass this check.
A keyd declaration records a completed owner import; doctor does not read the
keyd key. A dry run never declares a legacy key removable.

Doctor's `credential.key_store` check (#110) reports, per configured App, the
store kinds recorded for its key: `identityApps[slug].store` for a managed
App, and each declaring soul's `store` (or the platform default). It reads no
store, so a locked store does not change it. It also reports
`legacy_key_file` from an `lstat` of `~/.config/<slug>/private-key.pem`; the
file is never opened. A remaining legacy file is a warning whose action is
this command, never a failure, and doctor deletes nothing. Migration keeps
the legacy copy too, so the warning stays until the owner runs the
`removalCommand` above once `legacyFolderRemovable` is true.

The command never deletes the folder or its contents. Inspect the report and
run `removalCommand` yourself only when `legacyFolderRemovable` is true.
Public metadata has one source of truth per App, even when several souls use
it. Readers prefer config and fall back by missing field while legacy files
exist. An App record with only public metadata does not declare a managed
key store or hide an existing per-soul key.

`--to keyd` takes each soul's key from its current store, or the legacy
folder, verifies it live, and hands all of them to keyd in one
`owner/import`, so the owner answers one prompt. The first import also pins
the daemon's grant key. Only after keyd stores and reads back every key does
`soul.json` say `store: keyd`. The old copies stay where they were.

`--to pass-cli` takes the credential from the soul's current readable store,
then the managed App store or legacy folder if no current credential exists.
It verifies the source, creates and reads back the note, then publishes
`store: "pass-cli"` as a soul revision. Existing file/Keychain/legacy copies
are retained. A failed verification, write, readback, or revision update does
not change the declaration. A keyd-held key cannot be exported this way.
The normal report names `store: "pass-cli"` and uses `would-migrate`,
`migrated`, `already-migrated`, or `failed` like the other stores. An already
selected pass-cli store with a missing item can also be populated from the
managed/legacy source by migration; ordinary reads never fall back on that
missing item. Dry runs never write or perform live verification.
