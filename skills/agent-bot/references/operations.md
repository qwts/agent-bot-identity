# Operations

Use this reference for setup, minting, diagnostics, and identity repair.

## Choose the operation

| Intent | Command |
|---|---|
| Inspect available commands | `agent-bot --help` |
| Configure the current linked worktree | `agent-bot setup-worktree [app-slug]` |
| Mint a short-lived App installation token | `agent-bot mint-token [--app <slug>] [--json]` |
| Diagnose the installation and mapped identities | `agent-bot doctor` |
| Install the CLI and hooks | `agent-bot install [--with-gh-shim]` |
| Install only the fail-closed `gh` shim | `agent-bot install-gh-shim` |
| Restore an App key and issuer from pass-cli | `agent-bot ensure-private-key --app <slug> [--force]` |
| Read an authorized password/API key | `agent-bot secret get --provider <id> --collection <name> --item <title> --field <name> --reason <text>` |

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

Collection and item names must resolve exactly and uniquely. Field names are
case-insensitive exact matches after trimming surrounding whitespace; punctuation
is significant. Qualify a repeated section field, for example
`Production.api key`.

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
