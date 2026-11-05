# Operations

Use this reference for setup, minting, diagnostics, and identity repair.

## Choose the operation

| Intent | Command |
|---|---|
| Start a task or create/reuse a bound soul worktree | `agent-bot start [--branch <branch>] [--repo <path\|owner/name>] [--name <worktree-name>] [--no-enroll] [--json]` |
| Bootstrap from a fresh source checkout | `./agent-bot bootstrap --repair --machine-only [--with-gh-shim] [--json]` (profile from the selected organization), or `--profile <path\|->` |
| Inspect available commands | `agent-bot --help` |
| List or inspect deterministic workflows across soul, sop-cache, bundled, and remote tiers | `agent-bot workflow [list\|show <name>\|sync] [--soul ID] [--remote] [--source TIER] [--json]` |
| Configure this checkout's bot identity (`[deprecated]` for routine startup; prefer `agent-bot start`) | `agent-bot setup-worktree [app-slug]` |
| Mint a short-lived App installation token | `agent-bot mint-token [--app <slug>] [--json]` |
| Diagnose the installation and mapped identities | `agent-bot doctor [--json]` |
| Repair and verify an installed setup | `agent-bot bootstrap [--machine-only\|--worktree-only] [--json]` |
| Restore a deleted runtime config from the selected organization | `agent-bot bootstrap --repair [--scope-app <slug>] [--json]` |
| Install the CLI, hooks, and identity-daemon supervisor | `agent-bot install [--with-gh-shim]` |
| Unload the identity-daemon supervisor | `agent-bot daemon disable` |
| Supervise an embedded host's own runtime (re-run after update or move) | `AGENT_BOT_SERVICE_LABEL=<label> agent-bot daemon install [--json]` |
| Install only the fail-closed `gh` shim | `agent-bot install-gh-shim` |
| Authenticate GitHub in server mode (the default) | Run `agent-bot start [--branch <branch>]`, `cd` into the bound worktree, and use plain `git`/`gh` directly (do **not** run `agent-bot mint-token` in a soul-bound checkout) |
| Enroll a headless VM or CI runner with the identity server (no browser; server token fixes harnesses and lifetime) | `AGENT_BOT_SERVER=https://agents.true-line.ai AGENT_BOT_ENROLL_TOKEN=<token> agent-bot server enroll --harness <slug>` |
| Enable the `github-identity` add-on headlessly during bootstrap or install | `AGENT_BOT_ENABLE_FEATURES=github-identity agent-bot bootstrap --profile <path> --with-gh-shim --machine-only` (or `--features github-identity`) |
| Restore an App key and issuer from pass-cli (legacy local custody only) | `agent-bot ensure-private-key --app <slug> [--force]` |
| Read an authorized password/API key | `agent-bot secret get --provider <id> --collection <name> --item <title> --field <name> --reason <text>` |

## Bootstrap a fresh machine

Treat **“install agent bot identities”** as a request for the complete
configured identity roster and organization-owned harness tooling, not only
the identity for the agent currently running.

An uninstalled or ephemeral session — cloud offload, a fresh host, or this
checkout opened before bootstrap — is already under identity policy.
Committed hooks refuse human-attributed commits and GitHub writes unless the
actor is in `AGENT_BOT_UNMANAGED_AUTHORS`, else the config's
`settings.unmanagedAuthors` (nobody while neither is set); reads
and uncommitted edits are allowed. `doctor` reports `identity.class` and
does not install. Publishing as the bot still requires the durable journey
below.

1. Determine who owns organization policy. For `qwts`, read the canonical
   [agent bot organization operations](https://github.com/qwts/qwts-agent-org/blob/main/docs/agent-bot-operations.md)
   over HTTPS. Do not assume, search for, or hard-code a local governance
   checkout.
2. Obtain an explicit, secret-free versioned profile from that owner. If
   it is missing, incompatible, or incomplete, stop before mutation; do not
   infer a roster from the current harness or copy secret material into it.
3. From the owner's account, prepare only machine state. Bootstrap
   installs the CLI and loads the identity-daemon supervisor (`daemon start`
   is recovery; `daemon disable` unloads it):

   ```bash
   ./agent-bot bootstrap --repair --machine-only --with-gh-shim
   ```

   `--repair` fetches the profile from the organization selected in
   `~/.config/agent-sop/config.toml`; with a profile file in hand, use
   `--profile <path>` instead. Do not pre-fetch it with `gh api … > file`: a
   failed fetch leaves an empty file.

   From a checkout that resolves a bot identity — any checkout in the agent's
   own account, or one with `GH_AGENT_APP` or a pin — the same source launcher
   may perform the full machine and checkout flow by omitting `--machine-only`.
   Never bind the human's own checkout on harness detection alone.
4. After installation, use the stable CLI. If machine preparation happened in
   the owner's account, finish the binding from the agent account:

   ```bash
   agent-bot bootstrap --worktree-only
   ```

   On native Windows, start source bootstrap with `node agent-bot.mjs`
   instead of `./agent-bot`. Installation creates a `.cmd` launcher and a
   matching Git-shell launcher without symlink privileges, and registers the
   current user's PATH. Use a new terminal or the full `.cmd` path afterward.
   Keep the source checkout in place. Foreign or incomplete launcher pairs
   are refused. See [Windows installation](../../../docs/windows.md).

   On Windows, run `join` and `setup-worktree` from the soul's private work
   area after installing agent-comms and configuring its broker. The runtime
   uses junctions for existing space and checkout directory aliases. A moved
   checkout can retain foreign mutation ACLs; repair only the agent-owned
   checkout's custody rather than loosening binding validation. Native storage
   requests have a separate deadline from quick daemon health probes.

   On headless Linux environments without a user `systemd --user` / D-Bus
   session (CI runners, containers, disposable VMs), `agent-bot install` and
   `scripts/linux-bundle/install.sh` write the unit files without aborting and
   fall back to detached startup. Start the daemon and `agent-comms` broker
   directly without `systemd` (run `agent-bot daemon stop` first when restarting
   an already-running detached daemon):

   ```bash
   agent-bot daemon start --daemonize
   AGENT_COMMS_SHARED_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/agent-comms" \
     nohup agent-comms broker run --single-account >/dev/null 2>&1 &
   ```

5. Complete the organization-owned shared skills and harness tooling through
   its governance procedure. The runtime installs its own CLI, hooks, optional
   `gh` shim, credentials, and worktree identity; it does not invent or vendor
   an organization's shared tool catalog.
6. Verify machine readiness and, from a checkout with a bot identity, worktree
   readiness:

   ```bash
   agent-bot doctor --machine-only --json --require-schema-version 1
   agent-bot doctor --json --require-schema-version 1
   ```

The profile must validate before mutation, every active harness must have an
active default, and retired identities must not appear in the reconciliation
roster. `--profile -` reads JSON from stdin. Use the mutually exclusive
`--config` option only for a legacy already-projected runtime config.

If `~/.config/agent-bot` was deleted, run `agent-bot bootstrap --repair` from
the agent account instead of hunting for a profile file. It reads the profile
the selected organization names (`~/.config/agent-sop/config.toml`
`[repos] org`, then `org.json` `organization.profile`) at the resolved commit,
scopes it to the account's App, and reports that commit in `bootstrap.repair`.
A surviving config always wins; `--profile` stays the explicit override.

Confirm that every expected App row is ready and separately confirm the
organization-owned tooling inventory. Do not report an organization install as
complete when only the current harness is usable.

## Configure safely

1. **Primary one-command workflow (`agent-bot start`):** From any checkout of
   the target repository (or passing `--repo <path|owner/name>`), run:

   ```bash
   agent-bot start --branch <branch>
   ```

   `agent-bot start` auto-detects the harness and session transcript ID,
   resolves the agent's canonical long-lived soul, creates or reuses a linked
   soul worktree under `<soulDir>/worktrees/<repo>-<branch>` branched from
   `origin/HEAD` (`origin/main`), configures Git attribution and hooks, binds
   the session at the daemon (`<git-dir>/agent-binding.json`), and verifies
   server-mode readiness (automatically initiating `--add-harness` device scope
   expansion if needed). Then `cd` into the printed worktree path and run plain
   `git` and `gh` directly.
2. **Legacy manual plumbing (`[deprecated]` — use `agent-bot start` instead):**
   Direct calls to `agent-bot join --name NAME --harness HARNESS [--soul AGENT_ID]`,
   `agent-bot setup-worktree`, and `agent-bot session bind` (or the MCP `bind`
   tool) are the low-level steps that `agent-bot start` performs automatically.
   A conflicting App, soul pin or binding fails closed. A primary checkout
   outside the soul remains protected; unattended setup does not adopt a human
   checkout from harness detection.
3. Run `agent-bot doctor` after setup or recovery.

For an older session whose join omitted the App, running `agent-bot start` (or
rerunning `join` and `setup-worktree`) fills missing App metadata from
configured resolution and preserves the soul and binding. Do not ask the owner
to assign the App for every session or retry mint before correcting this layer.
An existing different assignment, retired identity or revoked binding is never
overridden. Details and the supported sequence are in
[joining](../../../docs/joining.md).

Resolution is shared with token minting: explicit App, `GH_AGENT_APP`, the
checkout's `agentBot.app` pin, managed soul assignment, configured account,
then harness mapping for deliberate CLI calls. Present but unreadable or
conflicting pins are errors. Directory names never select identity.

## Onboard an agent GitHub App

Onboarding a new harness or App spans four governed surfaces: CI policy
(`qwts/qwts-agent-ci` / `qwts-agent-ci`), the development environment and
organization governance (`qwts/qwts-agent-org`, `qwts/agent-sop`), the identity
runtime and `gh` shim (`qwts/agent-bot-identity`), and machine setup
(`qwts/managed-machine`). Walk and verify each step in order:

1. **Server mode first (`agent-bot start` + plain `git`/`gh`).** Run
   `agent-bot server status` or `agent-bot start [--branch <branch>]`. When the
   device is enrolled, App keys live on the identity service
   (`agents.true-line.ai`) and the device mints short-lived repo-scoped tokens
   per operation through the daemon — do **not** reach for `pass-cli`,
   `agent-bot ensure-private-key`, or standalone `agent-bot mint-token`. Inside
   a soul-bound worktree prepared by `agent-bot start`, `git` and `gh` mint
   automatically through the credential helper and `gh` shim (a bound member
   gets a credential reference, not a raw token, so standalone `mint-token` is
   refused in soul-bound checkouts). If the device is not yet enrolled for the
   App slug, `agent-bot start` automatically initiates
   `agent-bot server enroll --add-harness <slug>` (or run
   `agent-bot server enroll --all-configured` to enroll all active configured
   harnesses at once). Failures: `credential-unavailable`, `device-revoked`
   (re-enroll with `agent-bot server enroll --force`, an owner action),
   `outcome-unknown` (`agent-bot server reconcile`). `--permissions` is
   unavailable in server mode. See `docs/server-mode.md`.

   **Legacy local custody (off by default; only if `legacyLocalCustody` is
   opted in and server mode is not used — `AGENT_BOT_LEGACY_LOCAL_CUSTODY=1` /
   `settings.legacyLocalCustody`, opt-in expires 2027-01-31; unopted calls fail
   `legacy-local-custody-off`).** For locally stored
   Apps (`file`, `keychain`, `pass-cli`, or legacy
   `~/.config/<slug>/{app-id,private-key.pem}`), confirm `pass-cli` is signed in
   with access to the `Agent Identities` vault, then run:

   ```bash
   agent-bot ensure-private-key --app <slug>
   ```

   This imports the App ID and private key from Proton Pass into the managed
   `file` or `keychain` credential store (or legacy
   `~/.config/<slug>/{app-id,private-key.pem}`). Distinguish using `pass-cli`
   to import a key into a readable `file`/`keychain` store from retaining
   `store: "pass-cli"` as the credential backend:
   - For `agent-bot-keyd`-backed Apps (`store: "keyd"`, shipped with GeniusBar),
     `ensure-private-key` does not apply (`keyd-held`) and `mint-token` routes
     through `mintThroughDaemon`, which rejects an unbound caller (`only a bound
     soul can get a token for it, through the daemon`).
   - For `store: "pass-cli"` backends, `passCliStore` in
     `identity/soul-credentials.mjs` refuses any soul-marked caller — including
     `GH_AGENT_APP=<slug>` — before any provider call (`owner-only`: `soul
     credential stores are unavailable to a soul caller`).
   - For both `store: "keyd"` and `store: "pass-cli"`, establish a live daemon
     binding (`<git-dir>/agent-binding.json`) in a linked worktree first via
     `agent-bot start --branch <branch>` (or legacy `agent-bot join --name NAME
     --harness HARNESS --soul AGENT_ID --json` followed by `session bind` / the
     MCP `bind` exchange) before attempting step 2.
   - **Legacy `setup-worktree` note (when server mode is off):** `agent-bot setup-worktree`
     only mints a bind token (`prepareWorktreeBinding`) and calls
     `reconcileAppCredentials` (`ensurePrivateKey`) before writing GitHub
     worktree attribution (`agentBot.app`, `user.name`, `user.email`,
     `core.hooksPath`, `credential.helper`). When server mode is off,
     `ensurePrivateKey` throws `keyd-held` for `store: "keyd"` and
     `passCliStore` throws `owner-only` when soul markers are present unless
     the credential is imported into a readable `file` or `keychain` store.
2. **Verify GitHub authentication.**
   - **Server mode (and soul-bound checkouts):** Run `agent-bot start --branch <branch>`,
     `cd` into the bound worktree, and verify with plain `gh`:

     ```bash
     gh api graphql -f 'query={viewer{login}}' --jq .data.viewer.login
     ```

   - **Legacy local custody only (when server mode is off):** In the owner's
     account without server mode, `agent-bot mint-token --app <slug>` from an
     unpinned context with no stated identity fires the owner-approval gate and
     asks the owner through agent-bot-keyd on every call. When the credential
     was imported into a readable `file` or `keychain` store (or legacy
     `~/.config/<slug>`) and server mode is off, state the identity via
     `GH_AGENT_APP=<slug>` to verify minting before binding:

     ```bash
     GH_TOKEN="$(GH_AGENT_APP=<slug> agent-bot mint-token)" || exit 1
     export GH_TOKEN
     login="$(/opt/homebrew/bin/gh api graphql -f 'query={viewer{login}}' --jq .data.viewer.login)" || { unset GH_TOKEN; exit 1; }
     unset GH_TOKEN
     [ "$login" = "<slug>[bot]" ] || exit 1
     ```

3. **Install the `gh` shim, configure worktree attribution, and verify readiness.**
   Ensure the fail-closed `gh` shim is installed (`agent-bot install-gh-shim` or
   `agent-bot bootstrap --with-gh-shim`), run `agent-bot start --branch <branch>`
   to link the worktree, write GitHub attribution, and establish
   `<git-dir>/agent-binding.json`, and run
   `agent-bot doctor --json --require-schema-version 1`.
4. **Confirm CI policy (`qwts-agent-ci`).** Every bot-authored commit must be
   Web-Flow signed (`agent-bot signed-commit`), attributed to `<slug>[bot]`,
   and accompanied by any repository-required checks (such as a `changes/`
   changelog fragment in `qwts/agent-bot-identity`).

## Authenticate GitHub operations

Inside a bound soul worktree prepared by `agent-bot start`, use plain `git` and
the installed `gh` shim directly (it is stock `gh` for the human persona).
Understand the shim's token rules:

- In an unpinned context with no soul marker, inherited `GH_TOKEN` values are
  not treated as a bound bot identity.
- Whenever any soul marker (`GH_AGENT_APP`, `agentBot.app`, `AGENT_BOT_ID`,
  `agentBot.agentId`, or `<git-dir>/agent-binding.json`) is present, the shim
  sets `SOUL_BOUND=1`, unsets any inherited `GH_TOKEN`, and requires a live
  daemon binding (`<git-dir>/agent-binding.json`, established by
  `agent-bot start`) to mint a token per operation through `worktree-token`.
- **Never run `agent-bot mint-token` (or `GH_AGENT_APP=<slug> agent-bot mint-token`)
  in server mode or inside a soul-bound worktree** — soul-bound checkouts refuse
  standalone `mint-token` and authenticate `git`/`gh` per operation through the
  daemon.

`store: "keyd"` and `store: "pass-cli"` credential backends have no unbound
`GH_AGENT_APP` workaround (`mintThroughDaemon` rejects unbound callers and
`passCliStore` refuses soul-marked callers such as `GH_AGENT_APP` with
`owner-only`); always establish `<git-dir>/agent-binding.json` in a linked
worktree via `agent-bot start --branch <branch>` so minting runs through
`/v0/credential` on the daemon.

Only under legacy local custody (when server mode is off) when the credential
lives in a readable `file` or `keychain` store (or legacy `~/.config/<slug>`) —
including keys imported from Proton Pass via `ensure-private-key` into `file` or
`keychain` — and you are operating without a live daemon binding, mint with
`GH_AGENT_APP=<slug>`, verify the bot login via GraphQL, and invoke the real
`gh` binary (for example `/opt/homebrew/bin/gh`) in fail-closed steps:

```bash
GH_TOKEN=$(GH_AGENT_APP=<slug> agent-bot mint-token) || exit 1
export GH_TOKEN
login=$(/opt/homebrew/bin/gh api graphql -f 'query={viewer{login}}' --jq .data.viewer.login) || exit 1
[ "$login" = "<slug>[bot]" ] || exit 1
```

Do not combine the command substitution with `export`: many shells return the
status of `export`, masking a failed mint. Do not unset `GH_TOKEN` to expose a
stored human `gh` login from an agent session.

Treat JSON mint output as secret-bearing. Never echo, persist, or include the
token in issue comments, PR bodies, logs, or summaries.

## Read an authorized secret

Use an explicit secure-store provider and selectors. The first provider is
`proton-pass`, which requires an installed, already-authenticated `pass-cli`
session:

```bash
VALUE=$(agent-bot secret get \
  --provider proton-pass \
  --collection "Agent Identities" \
  --item anthropic \
  --field "api key" \
  --reason "Use the Anthropic API for this task") || exit 1
export VALUE
```

The agent-bot config must already map a harness to an App; without that opt-in,
retrieval remains inert. Collection and item names must resolve exactly and
uniquely. The requested field selector is trimmed, then matched exactly and
case-insensitively against provider labels; whitespace in provider labels and
all punctuation remain significant. Qualify a repeated section field, for
example `Production.api key`.

Always supply a concrete `--reason`. The Proton adapter passes it to the
audited item read as `PROTON_PASS_AGENT_REASON`, without adding it to argv.
For a Proton session with an item-only grant, select the explicit virtual
collection `--collection @item-shares`; the item title must uniquely identify
one direct share. A normal collection requires permission to list the named
vault and its active item summaries.

Only successful stdout contains the value, with no added newline. Every failure
has empty stdout and a non-secret stderr diagnostic. Never echo, log, cache,
write, or include the value in agent output. Do not ask `agent-bot` to log in to
the provider or try another store. Shell command substitution strips trailing
newlines; use the raw stdout stream when exact multiline bytes matter.

This command reads password/API-key fields only. It does not replace or call
`ensure-private-key`, whose job is GitHub App key-file provisioning.

## Diagnose mismatches

Run `agent-bot doctor`, then compare:

- detected harness, account, and worktree layout;
- resolved and pinned App slug;
- Git author and committer;
- HTTPS origin and credential helper;
- installed hooks and chained hooks path;
- identity daemon supervisor and health;
- resolved Agent Space root and census agreement;
- current execution identity.

Repair the earliest divergent layer. Do not patch later commands with a
different App slug, because that creates split attribution.

`doctor` is a read-only query and has no repair mode. Use `bootstrap` for the
explicit, idempotent repair boundary. Automation should use
`doctor --json --require-schema-version 1` or the equivalent bootstrap flags;
the report separates machine from worktree readiness and contains no mint
token or key material. A checkout with no bot identity is intentionally not
applicable for worktree identity and must never be claimed by a repair
command; a primary checkout in an agent account is verified like any worktree.


## Recover after an upgrade or a daemon restart

Every agent on the machine shares one daemon and one `gh` shim, so when
either breaks, all agents lose GitHub access together. Recognize it by
errors that name a Cellar version that no longer exists (`Cannot find
module '/opt/homebrew/Cellar/agent-bot/<old>/…'`), by `session bind`
reporting `no bind token is minted for this worktree` right after
`setup-worktree` printed `bind token minted`, or by `no usable binding … for
<slug>` in a worktree that worked before (#1179).

Recover in this order, verifying each step before the next:

1. **Shims.** Run `agent-bot install-gh-shim`. It rewrites the PATH shim and
   the Codex runtime shim to the installed release. Releases with #1176
   record the stable `opt` path, so an upgrade no longer needs this step;
   `agent-bot doctor` flags a shim that still records a missing or
   versioned-Cellar module as `shim.gh` before any `gh` call is made.
2. **Daemon (owner).** Compare `agent-bot --version` with the running
   daemon: `ps -axo pid,ppid,command | grep agent-daemon.mjs`. If the daemon
   runs an older Cellar path, the owner restarts it with
   `launchctl kickstart -k gui/$(id -u)/dev.qwts.agent-bot.daemon` and stops
   any orphaned old `agent-daemon.mjs` (parent pid 1). The restart affects
   every agent on the machine, so ask the owner rather than running it
   unprompted.
3. **Each worktree, for each agent.** A restart drops existing live
   bindings and unspent bind tokens. Re-run `agent-bot start`:

   ```bash
   agent-bot start --branch <branch>
   gh whoami   # expect the worktree's bot identity
   ```

   (Or with the legacy `[deprecated]` commands: run `agent-bot setup-worktree <app-slug> --name <worktree name> --branch <branch>` followed by `agent-bot session bind`.)
   `setup-worktree` printing `not a live session binding` is expected; the
   `session bind` that follows establishes it. A `session bind` alone after
   a restart fails, because the token it needs was minted before the
   restart.

Never work around a failed bind with the owner's own `gh` login, a copied
token or a shared credential. Report the failing step instead.

## Discover current governance

Read-only: `agent-bot sop --json` resolves the selected org and SOP once for
this operation. Bare repositories in `~/.config/agent-sop/config.toml` follow
their current default branches. Explicit `@ref` selections stay binding;
legacy `org.json` SOP refs are provenance baselines. Record both resolved
SHAs. `agent-bot skill <name> --json` repeats discovery at use and reads its
catalog plus SOP-owned relative entries at one immutable SOP SHA. Installed
bundled skills remain offline and version-paired.

If discovery fails, stop the dependent operation and report the error. Retry
is a fresh read, safe after connectivity or configuration is repaired; do
not label a previous snapshot current. Fresh discovery does not activate
policy hooks, personas, or change launch snapshots. Review and activate
those through their existing owner-gated workflows.

`agent-bot workflow` (`list`, `show <name>`) resolves deterministic workflows
offline across `soul` (`<soul>/workflows/<name>.toml`) → `sop-cache`
(`<state>/sop-cache/<commit>/workflows/<name>.toml`, using
`<state>/sop-last-good.json`) → `bundled` (`workflows/<name>.toml`), reporting
`activeSource`, `shadowedSources`, referenced `sop` documents, and ordered
non-executable `steps`. Pass `--remote` to compare local tiers against the live
remote SOP commit, or run `agent-bot workflow sync` to cache the remote SOP
commit locally.

- `gh issue create --parent` for an issue in another repository fails for GitHub Apps with `Resource not accessible by integration (addSubIssue)` — a GitHub Apps limitation, not a shim bug. The hosted `agents.true-line.ai` MCP has no `bind` tool; binding a session is only on the local `agent-bot mcp`.
