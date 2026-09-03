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

## Read attribution from the census, not the trailer parser

The `Agent-Identity:` trailer is a human-readable breadcrumb, not the
machine-readable record. GitHub's squash merge appends its own
`Co-authored-by:` block after a `---------` separator, which displaces the
trailer out of the message's final paragraph — and git's trailer parser only
reads the final paragraph, so `git log --format='%(trailers:key=Agent-Identity)'`
returns nothing on every squash-merged commit even though the line is present
in the body. No authoring-side change can prevent this: GitHub appends at
merge time, after any trailer we write.

Consumers must therefore:

1. Treat the local identity record and population census as the authoritative
   attribution store (`agent-bot identity show`, `agent-bot population show`).
2. When reading from git at all, scope the read to the commit in question —
   `git show -s --format='%B' <sha>` — and grep it for `^Agent-Identity: `
   instead of using `%(trailers:)`. An unscoped `git log --format='%B'` walk
   matches every agent commit in the history, not the one being resolved.
3. Treat a missing trailer as "ask the census", never as "unattributed". To
   resolve a commit with no trailer, take its author bot (`git show -s
   --format='%ae' <sha>` names the App slug) and list that App's identities
   in the census (`agent-bot population list --app <slug>`); the identity
   records' timestamps and transcript locators narrow it to a conversation.
   A commit that predates identity records, or whose records were made on
   another machine, may be genuinely unresolvable — say so rather than
   guessing from branch names.

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

Do not invent or pass a root. `ensure` applies the user's configured policy and
environment override before the governed default.

On success, stdout contains only the absolute space path. Use `--json` when
the caller needs marker metadata or whether the space was created. `ensure`
accepts no positional Agent ID: it resolves the environment identity first,
then the worktree pin, and fails non-zero if neither is present. The checkout's
directory is not a gate (ENG-0339): a primary checkout with a current Agent ID
creates like any other.

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

In the table view the PARENT column distinguishes two different absences: `-`
means the soul was bound (its transcript is recorded, so lineage was
observable) and genuinely has no parent, while `?` means the soul never bound
and its parent is unknown rather than absent. In JSON both appear as
`parentId: null`; apply the same rule by checking `transcriptLocator`.
