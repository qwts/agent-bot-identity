# Runtime metrics

Optional, read-only metrics for GeniusBar's companion view
(qwts/agent-comms#86, under ADR-0007 decisions 5 to 8 in qwts/agent-comms).
Messaging never depends on them.

```sh
agent-bot metrics collect [--json]   # read new session-log lines
agent-bot metrics show [--json]      # latest observations, no log reads
```

## Binding

An observation belongs to a soul only through a harness session recorded for
it. There are two sources:

- the `transcript` the soul's identity was minted with;
- the session-start hook `agent-hooks/session-start/30-record-session`, which
  records the session for the worktree's soul. It reads the live binding
  first, then the `agentbot.agentid` worktree pin, and ignores ambient
  `GIT_*` overrides.

Nothing is matched by name, path or model string. A soul whose recorded
sessions have no log is listed under `missing`. Only Claude Code sessions
(`~/.claude/projects/*/<session>.jsonl`, or under `CLAUDE_CONFIG_DIR`) have a
collector so far.

## What is kept

Each soul's latest main-context call is kept: subagent (`isSidechain`) lines
are a different context. Every observation records the metric, the value or
`unknown`, the unit, the scope, the source, whether the value was `reported`
or `configured`, and `observedAt`.

| metric | value |
|---|---|
| `model_reported` | the model the call reported; never identity |
| `context_used_tokens` | input + cache read + cache creation tokens of the last call (`method: last-call-usage`) |
| `context_capacity_tokens` | `unknown` until a documented capacity for the exact model and configuration is configured |
| `output_tokens` | the last call's output tokens |

Nothing else is stored: no message text, tool input, path or raw line.

## Reads

There is one checkpoint per source, made of the file identity and a byte offset:

- A run reads at most 8 MB per source.
- A partial trailing line waits for the next run.
- The checkpoint never passes a line that wasn't handled.
- A new source, or one that was rotated or truncated, starts at its last 8 MB. The history before that is reported as `skippedBytes`.
- Repeated lines for one API message resolve to the latest.

Everything lives in `~/.local/state/agent-bot/metrics/`: `latest.json`, `checkpoints.json` and `sessions.json`. The directory is mode 0700 and the files are 0600.
