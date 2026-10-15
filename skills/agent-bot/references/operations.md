# Operations

Use this reference for setup, minting, diagnostics, and identity repair.

## Choose the operation

| Intent | Command |
|---|---|
| Bootstrap from a fresh source checkout | `./agent-bot bootstrap --repair --machine-only [--with-gh-shim] [--json]` (profile from the selected organization), or `--profile <path\|->` |
| Inspect available commands | `agent-bot --help` |
| Configure this checkout's bot identity | `agent-bot setup-worktree [app-slug]` |
| Mint a short-lived App installation token | `agent-bot mint-token [--app <slug>] [--json]` |
| Diagnose the installation and mapped identities | `agent-bot doctor [--json]` |
| Repair and verify an installed setup | `agent-bot bootstrap [--machine-only\|--worktree-only] [--json]` |
| Restore a deleted runtime config from the selected organization | `agent-bot bootstrap --repair [--scope-app <slug>] [--json]` |
| Install the CLI, hooks, and identity-daemon supervisor | `agent-bot install [--with-gh-shim]` |
| Unload the identity-daemon supervisor | `agent-bot daemon disable` |
| Supervise an embedded host's own runtime (re-run after update or move) | `AGENT_BOT_SERVICE_LABEL=<label> agent-bot daemon install [--json]` |
| Install only the fail-closed `gh` shim | `agent-bot install-gh-shim` |
| Restore an App key and issuer from pass-cli | `agent-bot ensure-private-key --app <slug> [--force]` |
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

1. Work in an isolated checkout linked to the agent's canonical long-lived
   soul. Reuse the existing soul by passing `--soul AGENT_ID` from an unpinned
   checkout (`agent-bot join --name NAME --harness HARNESS --soul AGENT_ID
   --json`) or running `agent-bot join --name NAME --harness HARNESS --json`
   inside an already-pinned checkout; do not spawn a new task-scoped soul per
   issue or PR. With `github-identity` enabled, join uses the shared resolver
   and configured harness markers to record the App on the soul, including
   template instances. No mapping or an add-on that is off still permits
   hub-only join.
2. Set `AGENT_BOT_ID` from the result and bind with the MCP `bind` tool.
3. Run `agent-bot setup-worktree` in that same linked worktree. It verifies
   credentials and writes Git attribution for the soul's App. A conflicting
   App, soul pin or binding fails closed. A primary checkout outside the soul
   remains protected; unattended setup does not adopt a human checkout from
   harness detection.
4. Run `agent-bot doctor` after setup or recovery.

For an older session whose join omitted the App, rerun the same join command
in its linked checkout after updating the runtime, then rerun setup. Rejoin
fills only missing App metadata from configured resolution and preserves the
soul and binding. Do not ask the owner to assign the App for every session or
retry mint before correcting this layer. An existing different assignment,
retired identity or revoked binding is never overridden. Details and the
supported sequence are in [joining](../../../docs/joining.md).

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

1. **Restore App credentials from `pass-cli`.** Confirm `pass-cli` is signed in
   with access to the `Agent Identities` vault, then run:

   ```bash
   agent-bot ensure-private-key --app <slug>
   ```

   This provisions the App ID and private key into the managed App credential
   store (or legacy `~/.config/<slug>/{app-id,private-key.pem}`).
2. **Verify the first token mint without triggering owner-approval prompts.**
   In the owner's account, `agent-bot mint-token --app <slug>` from an unpinned
   context with no stated identity fires the macOS owner-approval gate and
   prompts for administrator credentials on every call. State the identity via
   `GH_AGENT_APP=<slug>` (or run inside a pinned worktree) to verify minting
   cleanly:

   ```bash
   tok="$(GH_AGENT_APP=<slug> agent-bot mint-token)" || exit 1
   ```

3. **Install the `gh` shim and verify readiness.** Ensure the fail-closed `gh`
   shim is installed (`agent-bot install-gh-shim` or `agent-bot bootstrap
   --with-gh-shim`), link and bind the worktree to the agent's canonical soul,
   and run `agent-bot doctor --json --require-schema-version 1`.
4. **Confirm CI policy (`qwts-agent-ci`).** Every bot-authored commit must be
   Web-Flow signed (`agent-bot signed-commit`), attributed to `<slug>[bot]`,
   and accompanied by any repository-required checks (such as a `changes/`
   changelog fragment in `qwts/agent-bot-identity`).

## Authenticate GitHub operations

Prefer the installed `gh` shim under a bound bot worktree (it is stock `gh` for
the human persona). Understand the shim's token rules:

- In an unpinned context with no soul marker, inherited `GH_TOKEN` values are
  not treated as a bound bot identity.
- Whenever any soul marker (`GH_AGENT_APP`, `agentBot.app`, `AGENT_BOT_ID`,
  `agentBot.agentId`, or `<git-dir>/agent-binding.json`) is present, the shim
  sets `SOUL_BOUND=1`, unsets any inherited `GH_TOKEN`, and requires a live
  daemon binding (`<git-dir>/agent-binding.json`) to mint a token through
  `worktree-token`.

Without the shim — or when operating before a worktree has a live daemon
binding — mint with `GH_AGENT_APP=<slug>`, verify the bot login via GraphQL,
and invoke the real `gh` binary (for example `/opt/homebrew/bin/gh`) in
fail-closed steps:

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
