# Execution identities

Use execution identities to bind a commit or PR back to the agent transcript
that produced it. Agent IDs are private `agent_<uuid>` values recorded locally
and attached to commits through an `Agent-Identity:` trailer.

## Choose the subcommand

```bash
agent-bot identity ensure
agent-bot identity spawn
agent-bot identity bind
agent-bot identity record
agent-bot identity finalize
agent-bot identity show
agent-bot identity current
```

Inspect `agent-bot identity <subcommand> --help` before invoking a mutation.
Use `current` for the active worktree and `show` for a known identity. Use
`ensure` during normal worktree initialization; use `spawn` only when starting
a distinct execution identity intentionally.

## Maintain provenance

1. Keep the worktree's `agentBot.agentId` pin aligned with the active task.
2. Bind provider transcript metadata through the runtime adapters; do not put
   private transcript content into Git commits or public GitHub fields.
3. Preserve the `Agent-Identity:` trailer when amending or replaying commits.
4. Finalize or record the identity according to the command help after the
   task's durable artifacts exist.
5. Resolve provenance through the local identity record, not by guessing from
   bot username or branch name.

Do not expose private identity records, transcript URLs, session tokens, or
provider metadata in public issue or PR comments. Report only the Agent ID
when the user explicitly requests it and the destination is appropriate.

## Resolve the Agent Space

Agent Space lifecycle, path policy, territory, and ownership are defined by
[ENG-0172](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0172-agent-space-is-durable-per-soul-storage.md).
Do not store secrets or credentials there or treat its path as bot territory.
Keep this skill focused on the installed runtime operation.

Hooks and scripts should resolve and initialize the current soul's space with:

```bash
agent-bot space ensure
```

On success, stdout contains only the absolute space path. Use `--json` when
the caller needs marker metadata or whether the space was created. `ensure`
accepts no positional Agent ID: it resolves the environment identity first,
then the worktree pin, and fails non-zero if neither is present. It also
refuses to create from a human primary checkout even when an Agent ID is
injected.

## Inspect the local population

The population census is a secret-free aggregate index; identity JSON remains
the provenance source of truth. List the census or inspect one known soul with:

```bash
agent-bot population list [--status <status>] [--app <slug>] [--json]
agent-bot population show <agent-id>
```

Do not put credentials, private key material, transcript contents, or arbitrary
identity fields into population records. The public row contains only the
Agent ID, App slug, parent ID, status, Agent Space path, optional transcript
locator, and last-seen timestamp.
