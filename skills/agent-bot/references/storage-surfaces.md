# Storage surfaces

Use this reference when deciding where a file belongs. Every artifact an agent
produces lives on exactly one of three surfaces, and picking the wrong one
either loses the artifact with the session or pollutes Git territory.

## Pick the surface

| Surface | Use for | Lifetime |
|---|---|---|
| Worktree | Git work only: code, tests, docs, and anything that ships in a commit or PR | Torn down after the task; only committed history survives |
| Scratchpad | Session-ephemeral working files: intermediate outputs, temporary scripts, downloaded inputs | Dies with the session or its context window |
| Agent Space | Durable per-soul belongings that must outlive context compaction and worktree teardown: notes, long-running task state, accumulated learnings | Persists per `agent_<uuid>` until explicit retirement |

Decide by lifetime, not convenience. If the artifact belongs in the
repository's history, commit it in the worktree. If it is only needed to
finish the current session, keep it in the scratchpad and let it die. If it
must still exist for a future session of the same soul, put it in the Agent
Space; do not park durable notes in a scratchpad or an uncommitted worktree
file, because both disappear.

The canonical lifetime, path-policy, territory, and ownership rules are
defined by
[ENG-0172](https://github.com/qwts/playbook-engineering/blob/main/docs/decisions/ENG-0172-agent-space-is-durable-per-soul-storage.md).
Link that contract; do not restate or fork its rules here or in harness docs.

## Resolve the space through the runtime

Never construct, guess, or hard-code a raw Agent Space filesystem path. Use
the stable commands, which apply the user's configured root policy:

```bash
agent-bot space ensure   # resolve and initialize the current soul's space
agent-bot space path     # print the existing space path without creating it
agent-bot space show     # inspect marker metadata for a known space
```

`ensure` prints only the absolute space path on success and fails non-zero
from a human primary checkout or when no Agent ID is resolvable. See
[execution-identities.md](execution-identities.md) for identity resolution and
the population census.

## Keep the boundaries

- Agent Space is not bot territory: never run Git or `gh` operations from it,
  and never commit its contents into a repository.
- No secrets on any surface. Credentials come from an authorized
  `agent-bot secret get` read at time of use and are never persisted.
- Scratchpad and worktree territory rules are unchanged by Agent Space;
  primary checkouts stay human.

<!-- conformance: edits to this skill must keep the worktree / scratchpad /
     Agent Space distinction, the stable `agent-bot space` commands, and the
     ENG-0172 pointer. tests/skill.test.mjs enforces this. -->
