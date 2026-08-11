# Operations

Use this reference for setup, minting, diagnostics, and identity repair.

## Choose the operation

| Intent | Command |
|---|---|
| Bootstrap from a fresh source checkout | `./agent-bot bootstrap [--config <path>] [--machine-only] [--with-gh-shim] [--json]` |
| Inspect available commands | `agent-bot --help` |
| Configure the current linked worktree | `agent-bot setup-worktree [app-slug]` |
| Mint a short-lived App installation token | `agent-bot mint-token [--app <slug>] [--json]` |
| Diagnose the installation and mapped identities | `agent-bot doctor [--json]` |
| Repair and verify an installed setup | `agent-bot bootstrap [--machine-only\|--worktree-only] [--json]` |
| Install the CLI and hooks | `agent-bot install [--with-gh-shim]` |
| Install only the fail-closed `gh` shim | `agent-bot install-gh-shim` |
| Restore an App key and issuer from pass-cli | `agent-bot ensure-private-key --app <slug> [--force]` |
| Read an authorized password/API key | `agent-bot secret get --provider <id> --collection <name> --item <title> --field <name> --reason <text>` |

## Bootstrap a fresh machine

Treat **“install agent bot identities”** as a request for the complete
configured identity roster and organization-owned harness tooling, not only
the identity for the agent currently running.

1. Determine who owns organization policy. For `qwts`, read the canonical
   [agent bot organization operations](https://github.com/qwts/playbook-engineering/blob/main/docs/reference/agent-bot-operations.md)
   over HTTPS. Do not assume, search for, or hard-code a local governance
   checkout.
2. Obtain an explicit, secret-free configuration/profile from that owner. If
   it is missing, incompatible, or incomplete, stop before mutation; do not
   infer a roster from the current harness or copy secret material into it.
3. From a primary source checkout, prepare only machine state:

   ```bash
   ./agent-bot bootstrap --config <path> --with-gh-shim --machine-only
   ```

   From a linked agent worktree, the same source launcher may perform the full
   machine and worktree flow by omitting `--machine-only`. Never bind a primary
   checkout as bot territory.
4. After installation, use the stable CLI. If machine preparation happened in
   the primary checkout, enter a linked worktree and finish its binding:

   ```bash
   agent-bot bootstrap --worktree-only
   ```

5. Complete the organization-owned shared skills and harness tooling through
   its governance procedure. The runtime installs its own CLI, hooks, optional
   `gh` shim, credentials, and worktree identity; it does not invent or vendor
   an organization's shared tool catalog.
6. Verify machine readiness and, from a linked worktree, worktree readiness:

   ```bash
   agent-bot doctor --machine-only --json --require-schema-version 1
   agent-bot doctor --json --require-schema-version 1
   ```

Confirm that every expected App row is ready and separately confirm the
organization-owned tooling inventory. Do not report an organization install as
complete when only the current harness is usable.

## Configure safely

1. Confirm the current path is a linked agent worktree. Do not run setup to
   claim a primary checkout for a bot.
2. Inspect `~/.config/agent-bot/config.json` only when configuration is part of
   the request. Map each harness to its App with `prefix` and optional `apps`
   overrides.
3. Run `agent-bot setup-worktree` and keep the resolved App slug shown by the
   command. An explicit slug must belong to the worktree's harness territory.
4. Run `agent-bot doctor` after installation or identity repair.

Resolution order is: explicit App, `GH_AGENT_APP`, worktree
`agentBot.app` pin, then harness mapping. Treat a present but unreadable or
conflicting pin as an error, not as permission to fall through.

## Authenticate GitHub operations

Prefer the installed `gh` shim inside bot territory. Without the shim, mint and
export in two fail-closed steps:

```bash
GH_TOKEN=$(agent-bot mint-token) || exit 1
export GH_TOKEN
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

- detected harness and territory;
- resolved and pinned App slug;
- Git author and committer;
- HTTPS origin and credential helper;
- installed hooks and chained hooks path;
- current execution identity.

Repair the earliest divergent layer. Do not patch later commands with a
different App slug, because that creates split attribution.

`doctor` is a read-only query and has no repair mode. Use `bootstrap` for the
explicit, idempotent repair boundary. Automation should use
`doctor --json --require-schema-version 1` or the equivalent bootstrap flags;
the report separates machine from worktree readiness and contains no mint
token or key material. A primary checkout is intentionally not applicable for
worktree identity and must never be claimed by a repair command.
