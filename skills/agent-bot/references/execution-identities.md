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
