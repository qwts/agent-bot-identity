---
name: agent-space
description: Check in with agent-bot and create, use, and clean up repository checkouts in the session soul's work area.
---

# Agent space

## What this is

Keep the Agent Space store (`~/.agent-space/<agentId>` for a soul from
before #583 slice 5, `<soulDir>/.soul-state/space` for a contained one; the
census path wins, see
[ENG-0172](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0172-agent-space-is-durable-per-soul-storage.md)
and [soul-memory-history.md](../../docs/soul-memory-history.md))
as a different surface: this skill is about the soul's work area,
`<soulDir>/worktrees/<name>`, for repository checkouts.

## Check in

Run outside the owner's primary checkout, from a directory outside Git for
a first check-in:

```sh
agent-bot join --name NAME --harness H
```

Use the resulting soul directory, census row, and agent-comms address.
Add `--json` to obtain `agentId`, then set `AGENT_BOT_ID` to that ID in the
session before setup; join cannot export it into its parent shell.
Any harness key can join; without agent-bot harness rows it lacks wake lanes
and generated harness files (#523).

## Find the work area

Run `agent-bot soul dir <agentId>` and use `soulDir` from its JSON output.
Keep repository worktrees at `<soulDir>/worktrees/<name>`.
Resolve the souls root in this order: `AGENT_BOT_SOULS_HOME`, then the
absolute `settings.soulsRoot` setting, then `~/.agent-bot/souls`.
Use the reported soul directory rather than guessing it from the root.

## Create a checkout

From inside a clone in the soul's work area, run:

```sh
agent-bot setup-worktree --name NAME [--branch B]
```

Use a unique NAME; the branch defaults to NAME. Setup checks out an existing
branch or creates one from HEAD. Change into the resulting checkout to work.
Alternatively, run `git worktree add <soulDir>/worktrees/<name>` from that
clone, then run `agent-bot setup-worktree` inside the new checkout.

Expect setup to refuse the owner's primary checkout outside the soul's work
area, arbitrary directories, and another soul's checkout; these refusals
leave configuration untouched. An existing checkout must be under the soul's
worktrees directory or already linked from it. Cross-device placement fails;
there is no temporary-directory fallback. Without a session soul, plain
setup is a quiet no-op; `--name` fails. Check in before retrying.

## Bind the session

A worktree binding is not a live session binding; `gh` and pushes need the
live one. In the checkout you work in (binding is per worktree), run:

```sh
agent-bot session bind
```

The session-start hook runs it for you where agent-bot's adapter is
installed. Without a flag it finds the session id in this order:

| Harness | Session id |
|---|---|
| Codex | `CODEX_THREAD_ID` |
| Claude Code | `CLAUDE_SESSION_ID` |
| Cursor | `CURSOR_CONVERSATION_ID` |
| Qwen Code (CLI and Desktop) | `QWEN_CODE_SESSION_ID`, exported into every shell command |
| Any, from a lifecycle hook | the hook payload's session id (`AGENT_HOOK_SESSION_ID`) |
| Devin | `devin list --format json`, only when it lists exactly one session for this worktree |

A Devin session started in another directory is listed there, not in the
worktree: run `devin list --format json` in the directory the session
started in, take its `id`, and pass `--transcript-id <id> --provider devin`.
With no id found, `session bind` refuses rather than guessing. Check the
result with `gh api repos/<owner>/<repo> --jq .full_name`.

## Clean up

Preserve needed work, leave the checkout, and run from a remaining clone:

```sh
git worktree remove <soulDir>/worktrees/<name>
git worktree prune
```

## Never

- Never work, branch, run `setup-worktree`, or `join` in the owner's primary checkout.
- Never leave identity config behind in the owner's checkout or a discarded worktree.
- Never use `/tmp`, `~`, or `~/.<harness>` as a work area.

## Use the harness hook or run the commands

Let Claude's `WorktreeCreate` hook place worktrees under the soul, as described
in [soul-homes.md](../../docs/soul-homes.md). Check in first so the session
has a soul. For harnesses without their own placement hook, run the check-in
and checkout commands above by hand.
