# Identity public-contract inventory

**Status:** Reviewed; owner decisions recorded in §8 (2026-10-11)
**Date:** 2026-10-11
**Issue:** [#645](https://github.com/qwts/agent-bot-identity/issues/645)
**Measured at:** `bea2fcf` (main)

This document lists what the identity module exposes today: to the rest of
agent-bot, and to the outside consumers, GeniusBar and agent-comms. It is the
input to the public contract in
[ADR-0645](decisions/ADR-0645-one-runtime-repository-four-owned-modules.md),
§5 and migration step 7. It is not that contract. Nothing moves, and no name,
path, format or behavior changes, because of it.

[ENG-0128](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0128-agent-bot-runtime-ownership.md)
(amended by qwts/qwts-agent-sop#83) lets identity be extracted into
`qwts/agent-identity` only after three things:

1. its boundary crossings are removed;
2. its public contract is reviewed;
3. a reviewed extraction plan exists, covering history, CI, release, pinning
   and bundling, the `agent-bot` facade and rollback.

This inventory covers the first two:

- §1 to §6 are the surface the contract has to settle;
- §7 lists what still crosses the boundary;
- §8 records the owner's decisions;
- §9 orders the work.

agent-comms stays its own repository, and #737 stays on hold.

## How to read it

**Stability** is one of three values:

- **public:** it must keep working, unchanged, through the extraction (ADR-0645
  §5). That applies when any of these is true:
  - something outside agent-bot uses it: GeniusBar, agent-comms, keyd or the
    `gh-app-hook` Worker;
  - it is persisted on disk, in a Keychain or pass item, in git config or in
    git history;
  - it is written into generated harness or git configuration;
  - it is a command in `PUBLIC_COMMANDS` (`cli/parse.mjs:1`).
- **internal:** only agent-bot uses it. After the extraction it is either
  private to agent-identity, or reached through a daemon route or the shared
  contract file (owner answer 2 on #645).
- **to-be-removed:** an import or re-export that can go away without changing
  behavior or anything persisted.

Nothing here is marked to-be-removed if removing it would change a persisted
format, state path, command name, service label or credential name. Those
need their own migration and rollback (ADR-0645 §3), so they are listed as
public.

**Callers** are cited as `file:line`, at the line where the import statement
starts. Paths are relative to the repository root, and GeniusBar and
agent-comms are cited at their `origin/main` (`4997eae` and `cb0030e`).

**Counts.** These come from `moduleEdges` in `tests/helpers/module-graph.mjs`,
the scanner the boundary test uses, run over `governance/runtime-modules.json`:

- **Size:** identity owns 43 of the 197 runtime files.
- **Inbound imports:** 192 file-to-file edges run from 88 files outside
  identity into 31 identity files.

  | From | Edges | Files |
  | --- | --- | --- |
  | soul | 99 | 52 |
  | host | 46 | 15 |
  | cli | 39 | 14 |
  | comms | 8 | 7 |

- **Outbound imports:** identity imports only `shared`, `harness`, `org` and
  the one listed contract, `soul-app-declarations.mjs`.
- **Tests:** 120 of the 212 test files import an identity file.

The boundary test's `baseline` is empty, so none of the 192 edges breaks an
import rule today. They block the extraction for a different reason: owner
answer 2 says no imports of identity internals remain outside `identity/`. Three
sanctioned contracts remain importable, and none of them is an internal:

- the shared identity-format file (F1, D2);
- the shared daemon contract (F5, D3);
- one published identity entry, the route handler plus the binding registry,
  which only host imports (F9, D5).

ADR-0645
counted 147 edges from 72 files into 24 identity files at `0aae907`.

These counts, the tables in §1 and the appendix are the baseline measured at
`bea2fcf`. Progress against them is tracked in §9.

The full caller list is in the appendix.

## 1. Modules

After the extraction, soul and cli import no identity module, and host imports
only the one published identity entry (D5). Everything else they need comes
through the shared contract files (D2, D3), the daemon routes, or identity's
entry files run as child processes (D4). So the stability of each file below
is the stability of its *current* exports, and none of these files is itself
the host entry. "Disposition" says where its outside callers should go,
and the F numbers point to the follow-ups in §7.

| File | What it is | Stability | Outside callers | Disposition |
| --- | --- | --- | --- | --- |
| `agent-identity.mjs` | Agent ID records: mint, read, finalize, retire, lineage, transcript; ID format; `withLock` | internal, except `mintAgentIdentity`, which GeniusBar's compat driver imports by path (below) | 57 (soul 44, host 8, cli 3, comms 2) | ID format to the contract file (F1); `stateDirectory` re-export goes (F2); `withLock` (F3); record operations through routes (F6) |
| `agent-principals.mjs` | Transport principals, authorization, audit receipts | internal | 26 (soul 18, host 6, cli 2) | `appendAuditReceipt` (F4); principal checks stay with the daemon (F9) |
| `agent-binding.mjs` | Bind tokens, the binding registry, binding files | internal; its files are public (§4) | 12 (soul 5, host 5, cli 2) | `readBinding` and `readBindToken` to the contract file (F1); `mintBindToken` (F6); registry (F9) |
| `daemon-client.mjs` | HTTP client for the daemon, `daemon.json` reader | internal | 13 (soul 6, host 3, cli 3, comms 1) | It carries every daemon call, not only identity's (F5) |
| `resolve-agent.mjs` | Which bot or App a checkout or session is; git config keys | internal; its keys are public (§6) | 11 (soul 5, host 3, cli 2, comms 1) | Key names and `pinnedSlug` to the contract file (F1); bot checks (F9) |
| `owner-gate.mjs` | Owner authorization, soul markers, `owner-credential-required` | internal | 9 (soul 5, cli 2, comms 1) | F8 |
| `credential-names.mjs` | Keychain and pass item names, store kinds, secret-name rule | internal; the names are public (§6) | 6 (soul 3, host 2, cli 1) | Name rules to the contract file (F1, F7) |
| `keyd-client.mjs` | keyd socket client, grant signing, MCP entry, version pin | internal; the keyd protocol is public | 5 (host 4, cli 1) plus a dynamic import in soul | F7, F9 |
| `identity-app-store.mjs` | Managed App metadata and key-store targets | internal | 5 (soul 2, host 1, cli 2) | F7 |
| `soul-credentials.mjs` | GitHub App and secret custody per soul (`resolveAppCredential`) | internal | 4 (soul 3, cli 1) | F7, F12 |
| `vouch.mjs` | Ed25519 soul tokens and the vouch key | internal; the token is public (§3) | 4 (host 2, soul 1, comms 1) | F11 |
| `binding-proof.mjs` | `x-agent-binding-proof` sign and check | **public**: agent-comms keeps a copy (`lib/binding-proof.mjs`) | 3 (host 2, comms 1) | Is already a contract file; add the parity test (F10) |
| `credential-reconciler.mjs` | Reconciles App keys between stores | internal | 3 (cli 2, soul 1) | F7 |
| `git-credential-bot.mjs` | Git credential helper; in-process minting | internal; the helper command is public (§2) | 3 (soul 1, cli 2) | F7 |
| `git-hooks.mjs` | List of git hook names | internal | 3 (cli 3) | F1 or F13 |
| `owner-presence.mjs` | keyd owner presence, pinned attestation | internal | 3 (soul 1, host 1, cli 1) | F8 |
| `owner-statement.mjs` | Owner-signed statements and challenges | internal; the statement format is public | 3 (soul 1, cli 2) | F8 |
| `permission-risk.mjs` | Display risk of a tool call | internal | 3 (host 2, soul 1) | F1 |
| `session-approvals.mjs` | Daemon-lifetime grants | internal | 3 (host 2, soul 1) | F9 |
| `identity-apps.mjs` | `identity app*` operations | internal | 2 (host 1, cli 1) | F9, F13 |
| `install-gh-shim.mjs` | Installs and inspects the `gh` shim | internal | 2 (cli 2) | F13 |
| `mint-token.mjs` | App installation token minting | internal | 2 (host 1, cli 1) | F9, F13 |
| `secret-store.mjs` | Secret provider registry | internal | 2 (host 1, cli 1) | F7 |
| `secret.mjs` | `agent-bot secret`; built-in providers | internal | 2 (host 1, cli 1) | F7 |
| `inbox-probe.mjs` | `doctor --probe-inbox` | internal | 1 (cli) | F13 |
| `inbox-take.mjs` | Takes from the `gh-app-hook` mailbox | internal | 1 (host) | F9 |
| `owner-approval.mjs` | Owner approval for an explicit App mint | internal | 1 (cli) | F13 |
| `secret-providers/pass-cli-credentials.mjs` | pass-cli credential store | internal | 1 (host) | F7 |
| `uninstalled-identity-hook.mjs` | Fallback hook when agent-bot is not installed | internal | 1 (cli) | F13 |
| `git-publish-scan.mjs` | Which repositories a shell command publishes to | internal | 1 (host) | F9 |
| `windows-account-custody.mjs` | Windows SID and ACL custody | internal | 1 (comms) | F11; moved to `shared` (#925) |

GeniusBar's compatibility check loads agent-bot modules by path, from the
agent-bot tree it pins. `scripts/compat-driver.mjs:71` imports
`mintAgentIdentity` from `agent-identity.mjs`; lines 64 to 74 also load
`agent-population.mjs`, `soul-package.mjs`, `soul-revisions.mjs` and
`cold-wake-settings.mjs`. That makes the file path and that export public
until the driver moves onto an identity entry file (F6).

Twelve identity files have no caller outside identity. They are reached only
as commands, as a deployed Worker, or from other identity files:
`agent-audit.mjs`, `ensure-private-key.mjs`, `gh-app-hook.mjs`,
`gh-inbox-query.mjs`, `gh-pr-view-json.mjs`, `gh-shim.mjs`, `owner-text.mjs`,
`secret-providers/pass-cli.mjs`, `secret-providers/proton-pass.mjs`,
`signed-commit.mjs`, `soul-genesis.mjs` and `worktree-token.mjs`.

Identity code that is not a runtime `.mjs` file, and so is not in the module
map (F14):

- `keyd/`: the Rust crate. GeniusBar builds a snapshot of it
  (`scripts/build-keyd.mjs:2`, `keyd/UPSTREAM.md`).
- `hooks/*`: the git hooks, including the `Agent-Identity` trailer.
- `scripts/ensure-identity.sh`.
- `wrangler.toml`: deploys `gh-app-hook.mjs` as a Cloudflare Worker.

## 2. CLI commands

Every command below goes through `cli/dispatch.mjs`. Today `agent-bot` stays
the facade, so each one keeps its name and arguments (ADR-0645 §1).

| Command | Entry | Stability | Callers outside this repository, or persisted |
| --- | --- | --- | --- |
| `identity` (`current`, `show`, `record`, `spawn`, `finalize`, ...) | `cli/identity.mjs` → `identity-entry.mjs` (through `identityOp`) and `daemon-client.mjs` | public | the git hooks run `agent-identity.mjs` directly by path instead (§6) |
| `identity app`, `apps`, `addon` | `cli/identity-apps.mjs` → `identity-apps.mjs` | public | GeniusBar `src-tauri/src/bridge.rs:8274`, `:8285`, `:8304`, `:8336`, `:8353`, `:8366` and `:8385` (list, connect, rotate-key, assign, remove, addon, create) |
| `identity migrate-credentials` | `cli/migrate-credentials.mjs` → `soul-credential-migration.mjs` (soul) | public | owner-run |
| `binding` | `agent-binding.mjs` | public | none found |
| `principal` | `cli/principal.mjs` → `agent-principals.mjs` | public | none found |
| `owner` | `cli/owner.mjs` → `owner-statement.mjs`, `owner-presence.mjs` | public | owner-run |
| `audit` (`list`, `tail`) | `agent-audit.mjs` | public | GeniusBar `bridge.rs:1969` (`audit list --json [--agent ID]`) |
| `mint-token` | `cli/mint-token.mjs` → `mint-token.mjs` | public | documented for people and scripts |
| `signed-commit` | `signed-commit.mjs` | public | agent workflows |
| `secret` | `secret.mjs` | public | |
| `ensure-private-key` | `ensure-private-key.mjs` | public | |
| `install-gh-shim` | `install-gh-shim.mjs` | public | `bootstrap.mjs:21` |
| `credential` | `git-credential-bot.mjs` | internal in `parse.mjs`, but **persisted**: written as `credential.helper` into every bot worktree (`setup-worktree.mjs:423`) | git |
| `worktree-token`, `gh-inbox-query`, `gh-pr-view-json` | identity files of the same name | internal in `parse.mjs`, but **persisted**: called by the installed `gh` shim (`gh-shim.mjs:16`) | the `gh` shim |
| `hook <git-hook>` | `hooks/<name>` | internal in `parse.mjs`, but **persisted**: installed hook stubs run `agent-bot hook <name>` (`install.mjs:251`) | git |

These commands touch identity but are owned elsewhere, so they stay with
agent-bot:

- **soul:** `setup-worktree` and `join`.
- **host:** `daemon` (including `daemon vouch-key`, `agent-daemon.mjs:2476`),
  `keyd` (`keyd-supervisor.mjs`; GeniusBar `bridge/setup.mjs:138` and
  `bridge/services.mjs:149`), `mcp`, `reach-mcp` and `agent-hook`.

The internal commands written into installed artifacts can't be renamed
without a migration. They are as frozen as the public ones.

## 3. Daemon routes

Every route is served by `agent-daemon.mjs` (host), which composes identity
in-process. Each route's class comes from the table in
[daemon-api.md](daemon-api.md#route-authorization). These routes carry
identity semantics:

| Route | Class | Handler | Stability | Callers |
| --- | --- | --- | --- | --- |
| `POST /v0/vouch` | binding | `agent-daemon.mjs:520` | **public** | agent-comms `lib/client.mjs:253` (`aud: agent-comms`); the token is checked by the broker against the key paired by `daemon pair-comms` |
| `POST /v0/bind` | binding (bind token) | `:713` | internal | `daemon-client.mjs:197`, which `setup-worktree` and `soul-join` use |
| `GET /v0/binding` | binding | `:792` | internal | `daemon-client.mjs:201` |
| `DELETE /v0/binding` | binding | `:798` | internal | `daemon-client.mjs:212`, `agent-binding.mjs:405` |
| `POST /v0/binding/app` | binding | `:784` | internal | `daemon-client.mjs:209` |
| `POST /v0/credential` | binding | `:816` | internal | `daemon-client.mjs:217`, `keyd-client.mjs:173` |
| `POST /v0/keyd/grant` | binding | `:1002` | **public** | keyd relay (`keyd/src/relay.rs:22`; the same in GeniusBar's snapshot) |
| `POST /v0/inbox/take` | binding | `:930` | internal | `daemon-client.mjs:222` |
| `POST /v0/grants/request`, `/spend` | binding | `:969`, `:984` | internal | `daemon-client.mjs:227`, `:230` |
| `GET /v0/identity/apps` | bearer | `:555` | internal | none outside this repository; GeniusBar uses the CLI |
| `GET /v0/identity/apps/jobs/{id}` | bearer | `:555` | internal | as above |
| `POST /v0/identity/apps/{action}` | owner | `:555` | internal | as above |

Two routes straddle identity and soul (F9):

- **`POST /v0/register`** (`:689`) writes the soul census (`upsertIdentitySoul`
  in `agent-population.mjs`, soul) on behalf of `setup-worktree` and join.
- **`POST /v0/spawn`** (`:727`) mints a child identity, binds it and runs the
  spawn hook. It is called from `agent-identity.mjs:832`.

The wire contracts agent-comms depends on are already written down: the binding
proof (`binding-proof.mjs`; [daemon-api.md](daemon-api.md)) and the soul token
(`vouch.mjs`, `aud` always `agent-comms`). keyd's grant and presence formats
are in [keyd-protocol.md](keyd-protocol.md).

## 4. Persisted files

All of these are public. Paths are resolved under `XDG_STATE_HOME`, which
defaults to `~/.local/state`, unless stated otherwise.

| File | Defined at | Readers outside identity |
| --- | --- | --- |
| `agent-bot/agent-identities/<agentId>.json`: the identity record. `schemaVersion` 1; status `active`, `finalized` or `retired`; `github.appSlug`; `credentialProvider: worktree-token`; never a credential | `state-paths.mjs:9`, `agent-identity.mjs:126`, `agent-identity.mjs:189` | soul (12 `readAgentIdentity` imports) |
| `<record>.lock/owner`, `.allocation.lock` | `agent-identity.mjs:365`, `:388`, `:393` | every `withLock` caller (F3) |
| `<git dir>/agent-binding.json`, `<git dir>/agent-bindings/<agentId>.json` | `agent-binding.mjs:163`, `:182` | agent-comms `lib/client.mjs:165`; keyd `relay.rs:70`; `AGENT_BOT_BINDING` overrides it |
| `<git dir>/agent-bind-token.json` | `agent-binding.mjs:17` | `setup-worktree`, `soul-join` |
| `agent-bot/bindings.json`: the daemon's binding registry | `agent-daemon.mjs:469` | host only |
| `agent-bot/daemon.json`: daemon port, bearer, `schemaVersion` 1 | `daemon-client.mjs:30` | `daemon-status.mjs` (comms), behind `agent-bot daemon status`, which GeniusBar runs |
| `agent-bot/vouch-key.pem` | `vouch.mjs:31` | `comms-client.mjs:582` loads it to pair its public half (F11) |
| `agent-bot/principals.json` | `agent-principals.mjs:159` (`AGENT_BOT_PRINCIPALS_PATH`) | `agent-web.mjs`, `telegram-adapter.mjs` |
| `agent-bot/interaction/audit.jsonl`, or `$AGENT_BOT_INTERACTION_HOME/audit.jsonl` when that is set | `agent-principals.mjs:255`, `:256`, `state-paths.mjs:20`, `:21` | GeniusBar through `audit list --json` |
| `agent-bot/keyd/` (`keyd.sock`, `owner.sock`, `keyd.json`, `audit.jsonl`, `presence.pub`, `presence.signer`) | `keyd-client.mjs:59`, `owner-presence.mjs:76`, `:82`, `:180` | keyd; GeniusBar keyd `paths.rs` |
| `agent-bot/owner/keys.json`: owner statement keys | `owner-statement.mjs:76` | `owner-action.mjs` (soul) |
| `agent-bot/agent-identities/identity-apps/<slug>…` (`.operation.lock`, `doctor.json`) | `identity-app-store.mjs:15`, `:55`, `:67` | `doctor.mjs` |
| `~/.config/agent-bot/config.json` `identityApps` section (`AGENT_BOT_CONFIG`) | `identity-app-store.mjs:39`, `:106` | the file is `config.mjs`'s (shared) |
| `<soul>/.soul-state/credentials/github-app-<slug>.json` or `.dpapi`, `secret-<name>.json` or `.dpapi`, `github-app-<slug>.webhook.*` | `soul-credentials.mjs:128`, `:219`, `:221`, `:293`, `:312` | inside soul's own layout (F12) |
| `~/.config/<slug>/` (legacy App folder, read and migrated) | `soul-credentials.mjs:132`, `identity-app-store.mjs:157` | `soul-credential-migration.mjs` |
| `.agent-bot-credential-transaction.json` | `ensure-private-key.mjs:163` | none |

## 5. Environment variables

These are read by identity files. "Set by" means a consumer outside identity
sets or reads the same variable.

| Variable | Read at | Stability | Set by, or also read by |
| --- | --- | --- | --- |
| `AGENT_BOT_ID`, `QWTS_AGENT_ID` | `agent-identity.mjs:775`, `owner-gate.mjs:55`, `resolve-agent.mjs:129` | public | agent-comms `lib/client.mjs:190` and `lib/worker/watch.mjs:14`; GeniusBar `scripts/compat-check.mjs:251` |
| `AGENT_BOT_BINDING` | `agent-binding.mjs:157`, `agent-identity.mjs:828`, `keyd-client.mjs:245`, `owner-gate.mjs:56` | public | agent-comms `lib/client.mjs:165`; keyd `relay.rs:72` |
| `AGENT_BOT_PARENT_ID`, `AGENT_BOT_TEAM`, `AGENT_BOT_SQUAD`, `AGENT_BOT_TYPE`, `AGENT_BOT_LEVEL`, and their `QWTS_AGENT_*` twins | `agent-identity.mjs:93` to `:102` | public | agent-comms tests set `AGENT_BOT_PARENT_ID` (`tests/spawn.test.mjs:89`) |
| `AGENT_BOT_TRANSCRIPT_ID`, `AGENT_BOT_TRANSCRIPT_PROVIDER`, `QWTS_AGENT_TRANSCRIPT_*` | `agent-identity.mjs:66`, `:71` | public | harness launchers |
| `CLAUDE_SESSION_ID`, `CODEX_THREAD_ID`, `CURSOR_CONVERSATION_ID` | `agent-identity.mjs:77` to `:86` | public (set by the harnesses) | |
| `AGENT_BOT_STATE_HOME`, `QWTS_AGENT_STATE_HOME` | `state-paths.mjs:12` (shared) | public | |
| `AGENT_BOT_PRINCIPALS_PATH` | `agent-principals.mjs:155` | public | |
| `AGENT_BOT_INTERACTION_HOME` | `state-paths.mjs:21` (shared); identity's audit receipts use it through `auditFile` (`agent-principals.mjs:255`, `:256`) | public | Replaces `$XDG_STATE_HOME/agent-bot/interaction`, the XDG fallback, as the directory for `audit.jsonl` |
| `AGENT_BOT_DAEMON_STATE_PATH` | `daemon-client.mjs:31` | public | |
| `AGENT_BOT_CONFIG` | `identity-app-store.mjs:39`, `ensure-private-key.mjs:382` | public | `config.mjs` (shared) |
| `AGENT_BOT_CREDENTIAL_NAMESPACE`, `AGENT_BOT_CREDENTIAL_VAULT` | `credential-names.mjs:34`, `:35` | public | `daemon-supervisor.mjs:37`, `readiness.mjs:37` |
| `AGENT_BOT_KEYD_SERVICE_LABEL` | `keyd-client.mjs:49` | public | GeniusBar `src-tauri/src/bridge.rs:46`, `bridge/services.mjs:317` |
| `AGENT_BOT_SECURITY_BIN` | `soul-credentials.mjs:154` | internal (tests) | |
| `AGENT_BOT_UNMANAGED_AUTHORS`, `AGENT_HOOK_TOOL_COMMAND` | `uninstalled-identity-hook.mjs:359`, `:24` | public (generated hook adapters) | |
| `GH_AGENT_APP`, `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_PRIVATE_KEY_PATH`, `GH_APP_INSTALLATION_ID` | `mint-token.mjs:137` to `:269`, `git-credential-bot.mjs:143`, `owner-approval.mjs:58`, `resolve-agent.mjs:123`, `keyd-client.mjs:147` | public | |
| `GH_APP_HOOK_INBOX_URL`, `GH_APP_HOOK_INBOX_TOKEN` | `inbox-take.mjs:207`, `:102` | public | |
| `INBOX`, `WEBHOOK_SECRETS`, `INBOX_TOKEN` (Worker bindings) | `gh-app-hook.mjs:776` to `:784` | public (`wrangler.toml`) | |

Identity also reads standard variables: `HOME`, `USER`, `PATH`,
`XDG_STATE_HOME`, `XDG_CACHE_HOME`, `GH_TOKEN`, and `GIT_*` for the publish
scan and the author check.

## 6. Other surfaces

All of these are public.

- **Git config keys:**
  - `agentBot.agentId` and `qwts.agentId`, and the App pins `agentBot.app` and
    `qwts.agentApp` (`resolve-agent.mjs:32`, `:33`);
  - agent-comms reads them (`lib/client.mjs:204`) and blanks them in its worker
    jail (`lib/worker/jail.mjs:21`).
- **`credential.helper`:** each bot worktree's helper entry
  (`setup-worktree.mjs:423`).
- **`Agent-Identity:` commit trailer:** added by `hooks/prepare-commit-msg:34`
  and required by `hooks/pre-commit:35`. It stays in git history.
- **Keychain services and pass-cli titles** (`credential-names.mjs:85` to
  `:128`):
  - `<ns>.soul.<agentId>` / `github-app/<slug>`
  - `<ns>.soul.<agentId>` / `secret/<name>`
  - `<ns>.app.<slug>` / `github-app/<slug>`, and `<ns>.app.<slug>.webhook`
  - `agent-bot.inbox` / `gh-app-hook-inbox-token`
  - `<ns>.human` / `<login>-github-token`
  - the pass vault `Agent Identities`
  - keyd's own `agent-bot.keyd.*` items
- **MCP:** the server name `agent-bot-keyd` and the tools `credential` and
  `git_credential` (`keyd-client.mjs:44`, `:45`). `wake-plane.mjs:18` writes
  them into generated harness configuration.
- **keyd version pin:** `KEYD_PINNED_VERSION` (`keyd-client.mjs:53`), which
  each host bundles (keyd-protocol.md, "Version pin").
- **Owner statements:** the SSHSIG namespace `agent-bot-owner-statement`
  (`owner-statement.mjs:43`). See [owner-statements.md](owner-statements.md).
- **Identity files run by path:** the installed git hooks run identity files
  by their path in the install tree:
  - `agent-identity.mjs` from `hooks/prepare-commit-msg:9`,
    `hooks/post-commit:7` and `hooks/pre-commit:29`;
  - `worktree-token.mjs` and `resolve-agent.mjs` from
    `hooks/agent-context:45` and `:59`.

  The hooks also run `setup-worktree.mjs` (soul) and `config.mjs` (shared),
  so they are not identity-only. These paths have to keep working after the
  move, as ADR-0645 step 9 says old paths do.
- **`gh` shim:** its marker line (`gh-shim.mjs:1`) and the script it installs.
- **Service label:** `app.geniusbar.keyd` and its Homebrew and Linux
  equivalents. These are host-owned, unchanged by ADR-0645 §5.

## 7. Boundary crossings that block extraction

Each of these is a follow-up. The owner's decisions in §8 (D1 to D7) settle
how each one is done, and §9 puts them in order.

- **F1. Shared identity-format contract file.** The pure format helpers move
  into one contract file, owned by identity and listed under `contracts` in
  the module map. Owner answer 2 says a test keeps it byte-identical. The
  helpers are:
  - `validateAgentId` and `isAgentId`, imported 37 and 11 times, from soul,
    host, cli and comms;
  - `AGENT_ID_KEYS`, `PIN_KEYS` and `pinnedSlug`;
  - the binding file readers `readBinding` and `readBindToken`;
  - the credential name rules (`SECRET_NAME`, `CREDENTIAL_STORES`, the
    item-name builders);
  - `ownerCredentialRequired` and `soulMarkers`;
  - `GIT_HOOK_NAMES`;
  - `classifyRisk` and `isComputerUse`;
  - the audit receipt writer (D2, F4).
- **F2. Drop the `stateDirectory` re-export** from `agent-identity.mjs:63`.
  Its 23 importers (soul 19, host 2, cli 2) switch to `state-paths.mjs`
  (shared), which already owns it. This is mechanical, changes no behavior,
  and is the one item that is plainly to-be-removed.
- **F3. Move `withLock` to `shared` (D1).** It is a filesystem mutex, not an
  identity concern, and 19 files import it (soul 17, host 1, comms 1). The
  lock layout (`<record>.lock/owner`) stays as it is.
- **F4. Audit receipts through a shared writer (D2).** `appendAuditReceipt`
  has 24 importers (soul 18, host 4, cli 2). The writer moves into the F1
  contract file. It appends the same `audit.jsonl` lines to the same path,
  so owner CLI actions still receipt while the daemon is down.
- **F5. `daemon-client.mjs` becomes a shared daemon contract (D3).** It
  carries every daemon call: soul revisions, pause and stop, comms status,
  as well as identity's own. `daemon.json` keeps its format.
- **F6. Identity record operations from soul.** Soul modules call these
  directly:
  - `readAgentIdentity` (16 imports), `mintAgentIdentity` (6),
    `retireAgentIdentity` (3), `finalizeAgentIdentity`, `ensureAgentIdentity`,
    `initializeAgentApp`, `recordAgentPackageRevision`, `currentAgentId` (7),
    `discoverTranscript`;
  - `mintBindToken`, from `setup-worktree.mjs:11` and `soul-join.mjs:34`.

  Callers include join, fork, templates, remove, env export, revisions and
  population. Under D4, each goes through a daemon route where the daemon is
  up, or runs the bundled identity entry file as a child process. The
  daemon-down paths, join and `setup-worktree` before the first bind, always
  use the child process. The contract names each route and entry file.
  GeniusBar's `scripts/compat-driver.mjs:71`, which imports
  `mintAgentIdentity` by path, moves onto the same entry file, in a GeniusBar
  PR pinned to the agent-bot release that ships it.
- **F7. Credential custody reached from outside identity.** These callers
  move onto identity operations (D4), or onto the name rules in the F1 file,
  instead of importing the stores:
  - **soul:**
    - `soul-credential-migration.mjs:14` to `:22` reads and writes raw keys;
    - `soul-secrets.mjs:20` and `soul-env.mjs:17` use the secret stores;
    - `soul-providers.mjs:20` and `soul-package.mjs:10` use the name rules
      (F1);
    - `setup-worktree.mjs:14` and `:21` use the reconciler and App metadata;
    - `agent-space-pack.mjs:24` mints in-process through `mintForCaller`.
  - **host:**
    - `telegram-adapter.mjs:54` uses `getSecret`;
    - `grant-github.mjs:21` and `:22` use the pass store and `humanTokenItem`;
    - `daemon-supervisor.mjs:37`.
  - **cli:**
    - `readiness.mjs`, with 16 identity imports;
    - `doctor.mjs:15` and `:16`;
    - `bootstrap.mjs:18` and `:21`;
    - `cli/mint-token.mjs:9` uses `mintForCaller`.
- **F8. Owner authority used by soul and cli.** `owner-action.mjs` (soul)
  composes `owner-gate`, `owner-statement` and `owner-presence` to ask the
  owner (`owner-action.mjs:9` to `:22`). `soulMarkers` is imported by
  `agent-approvals.mjs:21`, `cli/soul-dream.mjs:8`, `soul-computer-use.mjs:8`,
  `soul-stop.mjs:8` and `soul-asides.mjs:275`; it becomes a format helper
  (F1). The challenge flow goes through an identity entry file (D4).
- **F9. Host loads identity through one published entry (D5).**
  - These host files compose identity in-process today:
    - `agent-daemon.mjs`: the binding registry, minting, vouch, keyd,
      principals, inbox, identity apps and session approvals;
    - `agent-hook.mjs:34` to `:38`: the bot checks and the publish scan;
    - `agent-mcp.mjs` and `daemon-mcp.mjs`;
    - `keyd-supervisor.mjs`, `wake-plane.mjs`, `agent-interaction.mjs`,
      `agent-web.mjs` and `telegram-adapter.mjs`.
  - They move onto one identity entry, holding the route handler and the
    binding registry, listed as a contract importable by host only.
  - **Route ownership (D6):**
    - `/v0/register` becomes a soul route;
    - `/v0/spawn` splits: identity mints and binds, then host runs the spawn
      hook.
- **F10. Binding-proof parity test.** `binding-proof.mjs:13` says agent-comms
  carries a byte-for-byte copy of the client half, but no test checks it.
  Add one before the F1 file follows the same pattern.
- **F11. comms reaches identity custody.** These comms files do:
  - `comms-client.mjs:582` loads the vouch *private* key only to pair its
    public half;
  - `comms-windows.mjs:8` uses `windows-account-custody`;
  - `wake-listen.mjs:28` signs proofs, which the F1 file covers;
  - `daemon-status.mjs:10` reads `daemon.json`, which F5 covers.

  The key load should read the public key only, through `daemon vouch-key`
  or a public-key export.

  **Resolved.** comms now gets the vouch public key from the daemon (#920),
  and the owner placed the Windows custody helpers in `shared` (#925). Both
  crossings are gone.
- **F12. Record identity's subtree of the soul layout (D7).** Credential
  files stay under `<soul>/.soul-state/credentials`
  (`soul-credentials.mjs:128`). The layout contract (`soul-env-contract.mjs`)
  records that subtree as identity-owned. Nothing moves.
- **F13. CLI facade files.** These cli files import identity internals:
  - `cli/identity.mjs:17` and `:18`, `cli/mint-token.mjs:7` to `:11`,
    `cli/principal.mjs:7`, `cli/owner.mjs:7` to `:10` and
    `cli/identity-apps.mjs:8`;
  - `cli/dispatch.mjs:5`, `install.mjs:24` and `readiness.mjs:28`, which use
    `GIT_HOOK_NAMES`;
  - `sync-hooks.mjs:27`.

  Under D4, dispatch runs the bundled identity entry files as child
  processes. Command names and arguments don't change.
- **F14. Assign the non-`.mjs` identity assets.** The extraction plan has to
  cover `keyd/`, `hooks/*`, `scripts/ensure-identity.sh`, `wrangler.toml`
  and the 120 test files that import identity, including history, CI and
  release. The hooks run soul and shared files too (§6), so they need an
  owner, or a split, before they move.

## 8. Owner decisions

The owner answered all seven questions on 2026-10-11, each as recommended
([#645 comment](https://github.com/qwts/agent-bot-identity/issues/645#issuecomment-6107132817)).

- **D1. `withLock`** moves to the shared module.
- **D2. Audit receipts** use a shared receipt writer in the shared format
  file. It keeps the same `audit.jsonl` format, so it works while the daemon
  is down.
- **D3. `daemon-client.mjs`** becomes a shared daemon contract.
- **D4. The `agent-bot` facade** reaches identity by running the pinned,
  bundled identity entry files as child processes, including in join and
  `setup-worktree`.
- **D5. The one daemon** loads identity by having host import one published
  identity entry (the route handler and binding registry), listed as a
  contract.
- **D6. Routes:** `/v0/register` becomes a soul route. `/v0/spawn` splits:
  identity mints and binds, then host runs the spawn hook.
- **D7. Credential files** stay under `<soul>/.soul-state/credentials`,
  recorded as an identity-owned part of the soul layout.

None of these changes a state path, file format, command name, service label
or credential name.

## 9. Order of work

There is one PR per step. Each step keeps observable behavior, and each one
that removes edges also removes them from the count here. Steps 1 to 5 are
mechanical moves; steps 6 to 10 change how a module reaches identity.

1. **F2:** drop the `stateDirectory` re-export.
2. **F3 (D1):** move `withLock` to `shared`.
3. **F10:** add the binding-proof parity test.
4. **F1 and F4 (D2):** create the shared identity-format contract file,
   including the receipt writer, and move its callers onto it. This is the
   largest drop in edges.
5. **F5 (D3):** make `daemon-client.mjs` the shared daemon contract.
6. **F12 (D7):** record identity's subtree in `soul-env-contract.mjs`.
7. **F11:** comms reads the vouch public key only; decide where the Windows
   custody helpers live. *Done: #920; custody moved to `shared` in #925.*
8. **F6, F7 and F8 (D4):** define the identity entry files and daemon routes
   for record operations, credential custody and the owner prompt, then
   move soul's and cli's callers onto them.
9. **F9 (D5, D6):** the published host entry, the `/v0/register` move and
   the `/v0/spawn` split.
10. **F13 (D4):** the CLI facade runs the identity entry files.
11. **F14:** assign the remaining assets.

After step 11, nothing outside identity imports identity internals. What
remains is the three sanctioned contracts: the shared format file, the shared
daemon contract and host's one identity entry. The
reviewed contract (ADR-0645 step 7) and the extraction plan (step 8) follow.

**Progress.** Measured with the same scanner after #925, edges into
identity files other than the sanctioned contracts fell from 192 to 156,
from 81 files into 29 files: soul 74, host 42, cli 35, comms 5. Identity owns
43 of 201 runtime files. `windows-account-custody.mjs` is no longer an
identity file, so its rows in §1 and the appendix record the baseline only.

## Appendix: every import of an identity file from outside identity

There are 193 import statements, which make the 192 file edges.
`owner-action.mjs` imports `owner-gate.mjs` twice.

- **`agent-binding.mjs`** (12):
  - soul: `confinement.mjs:14`, `setup-worktree.mjs:11`, `sop.mjs:25`, `soul-join.mjs:34`, `soul-tool-home.mjs:31`
  - host: `agent-daemon.mjs:58`, `agent-hook.mjs:34`, `agent-mcp.mjs:29`, `daemon-mcp.mjs:56`, `metrics.mjs:37`
  - cli: `cli/mint-token.mjs:7`, `readiness.mjs:32`
- **`agent-identity.mjs`** (57):
  - soul: `agent-population.mjs:31`, `agent-space-pack.mjs:22`, `agent-space.mjs:28`, `claude-worktree-create.mjs:33`, `cold-wake-settings.mjs:9`, `confinement.mjs:10`, `executor-contract.mjs:57`, `harness-auth.mjs:14`, `sandbox.mjs:34`, `setup-worktree.mjs:15`, `skill-dream-previews.mjs:8`, `skill-dream-scheduler.mjs:7`, `skill-install.mjs:13`, `skill-learning.mjs:9`, `skill-library.mjs:6`, `skill-status.mjs:9`, `skill-workspace.mjs:17`, `sop.mjs:23`, `soul-asides.mjs:37`, `soul-build.mjs:9`, `soul-comms.mjs:13`, `soul-computer-use.mjs:6`, `soul-credential-migration.mjs:14`, `soul-dir.mjs:4`, `soul-env-export.mjs:46`, `soul-env-migrate.mjs:23`, `soul-env.mjs:12`, `soul-fork.mjs:30`, `soul-home.mjs:12`, `soul-join.mjs:35`, `soul-memory.mjs:19`, `soul-mode.mjs:9`, `soul-model.mjs:9`, `soul-profile.mjs:9`, `soul-remove.mjs:22`, `soul-revisions.mjs:12`, `soul-runtimes.mjs:30`, `soul-stop.mjs:6`, `soul-template-refresh.mjs:15`, `soul-templates.mjs:8`, `soul-threads.mjs:22`, `soul-tool-home.mjs:32`, `spaces-cutover.mjs:25`, `wake-resume.mjs:21`
  - host: `agent-daemon.mjs:64`, `agent-interaction.mjs:71`, `agent-jobs.mjs:33`, `daemon-mcp.mjs:51`, `delegation-grants.mjs:43`, `metrics.mjs:36`, `skill-dream-service.mjs:6`, `telegram-adapter.mjs:50`
  - cli: `cli/soul-dream.mjs:6`, `cli/soul-skill.mjs:9`, `readiness.mjs:33`
  - comms: `wake-dispatch.mjs:44`, `wake-webhook.mjs:19`
- **`agent-principals.mjs`** (26):
  - soul: `cold-wake-settings.mjs:8`, `sandbox-export.mjs:35`, `sandbox-remove.mjs:18`, `skill-workspace.mjs:16`, `soul-computer-use.mjs:5`, `soul-credential-migration.mjs:16`, `soul-env-clean.mjs:22`, `soul-env-export.mjs:48`, `soul-env-migrate.mjs:25`, `soul-fork.mjs:31`, `soul-mode.mjs:8`, `soul-model.mjs:8`, `soul-remove.mjs:21`, `soul-revisions.mjs:17`, `soul-runtimes.mjs:29`, `soul-secrets.mjs:18`, `soul-template-refresh.mjs:17`, `soul-tool-home.mjs:30`
  - host: `agent-daemon.mjs:82`, `agent-interaction.mjs:65`, `agent-web.mjs:33`, `delegation-grants.mjs:42`, `telegram-adapter.mjs:52`
  - cli: `cli/mint-token.mjs:8`, `cli/owner.mjs:7`, `cli/principal.mjs:7`
- **`binding-proof.mjs`** (3):
  - host: `agent-daemon.mjs:91`, `daemon-mcp.mjs:57`
  - comms: `wake-listen.mjs:28`
- **`credential-names.mjs`** (6):
  - soul: `soul-credential-migration.mjs:19`, `soul-package.mjs:10`, `soul-providers.mjs:20`
  - host: `daemon-supervisor.mjs:37`, `grant-github.mjs:21`
  - cli: `readiness.mjs:37`
- **`credential-reconciler.mjs`** (3):
  - soul: `setup-worktree.mjs:14`
  - cli: `bootstrap.mjs:18`, `readiness.mjs:24`
- **`daemon-client.mjs`** (13):
  - soul: `claude-worktree-create.mjs:40`, `setup-worktree.mjs:13`, `soul-computer-use.mjs:10`, `soul-join.mjs:299`, `soul-stop.mjs:5`, `soul-tool-home.mjs:33`
  - host: `agent-daemon.mjs:92`, `agent-mcp.mjs:30`, `telegram-adapter.mjs:49`
  - cli: `agent-approvals.mjs:19`, `cli/identity.mjs:13`, `cli/soul-dream.mjs:7`
  - comms: `daemon-status.mjs:10`
- **`git-credential-bot.mjs`** (3):
  - soul: `agent-space-pack.mjs:24`
  - cli: `cli/mint-token.mjs:9`, `readiness.mjs:35`
- **`git-hooks.mjs`** (3):
  - cli: `cli/dispatch.mjs:5`, `install.mjs:24`, `readiness.mjs:28`
- **`git-publish-scan.mjs`** (1):
  - host: `agent-hook.mjs:38`
- **`identity-app-store.mjs`** (5):
  - soul: `setup-worktree.mjs:21`, `soul-credential-migration.mjs:18`
  - host: `agent-daemon.mjs:108`
  - cli: `cli/identity.mjs:17`, `doctor.mjs:15`
- **`identity-apps.mjs`** (2):
  - host: `agent-daemon.mjs:106`
  - cli: `cli/identity-apps.mjs:8`
- **`inbox-probe.mjs`** (1):
  - cli: `doctor.mjs:16`
- **`inbox-take.mjs`** (1):
  - host: `agent-daemon.mjs:77`
- **`install-gh-shim.mjs`** (2):
  - cli: `bootstrap.mjs:21`, `readiness.mjs:39`
- **`keyd-client.mjs`** (5):
  - soul: `soul-credential-migration.mjs:151`
  - host: `agent-daemon.mjs:75`, `keyd-supervisor.mjs:16`, `wake-plane.mjs:18`
  - cli: `readiness.mjs:31`
- **`mint-token.mjs`** (2):
  - host: `agent-daemon.mjs:74`
  - cli: `cli/mint-token.mjs:10`
- **`owner-approval.mjs`** (1):
  - cli: `cli/mint-token.mjs:11`
- **`owner-gate.mjs`** (9):
  - soul: `owner-action.mjs:20`, `owner-action.mjs:9`, `soul-asides.mjs:275`, `soul-computer-use.mjs:8`, `soul-credential-migration.mjs:21`, `soul-stop.mjs:8`
  - cli: `agent-approvals.mjs:21`, `cli/soul-dream.mjs:8`
  - comms: `owner-principal.mjs:7`
- **`owner-presence.mjs`** (3):
  - soul: `owner-action.mjs:22`
  - host: `delegation-grants.mjs:44`
  - cli: `cli/owner.mjs:9`
- **`owner-statement.mjs`** (3):
  - soul: `owner-action.mjs:10`
  - cli: `agent-approvals.mjs:22`, `cli/owner.mjs:10`
- **`permission-risk.mjs`** (3):
  - soul: `executor-contract.mjs:56`
  - host: `agent-daemon.mjs:81`, `agent-interaction.mjs:72`
- **`resolve-agent.mjs`** (11):
  - soul: `agent-space-pack.mjs:25`, `claude-worktree-create.mjs:36`, `cold-wake-settings.mjs:12`, `setup-worktree.mjs:10`, `soul-join.mjs:41`
  - host: `agent-hook.mjs:37`, `agent-mcp.mjs:32`, `daemon-mcp.mjs:55`
  - cli: `cli/identity.mjs:18`, `readiness.mjs:46`
  - comms: `wake-listen.mjs:29`
- **`secret-providers/pass-cli-credentials.mjs`** (1):
  - host: `grant-github.mjs:22`
- **`secret-store.mjs`** (2):
  - host: `telegram-adapter.mjs:54`
  - cli: `readiness.mjs:56`
- **`secret.mjs`** (2):
  - host: `telegram-adapter.mjs:55`
  - cli: `readiness.mjs:55`
- **`session-approvals.mjs`** (3):
  - soul: `turn-registry.mjs:5`
  - host: `agent-daemon.mjs:83`, `agent-interaction.mjs:29`
- **`soul-credentials.mjs`** (4):
  - soul: `soul-credential-migration.mjs:22`, `soul-env.mjs:17`, `soul-secrets.mjs:20`
  - cli: `readiness.mjs:25`
- **`uninstalled-identity-hook.mjs`** (1):
  - cli: `sync-hooks.mjs:27`
- **`vouch.mjs`** (4):
  - soul: `confinement.mjs:16`
  - host: `agent-daemon.mjs:90`, `keyd-supervisor.mjs:17`
  - comms: `comms-client.mjs:46`
- **`windows-account-custody.mjs`** (1; now `shared`, #925):
  - comms: `comms-windows.mjs:8`
