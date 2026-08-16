# agent-hooks

One folder of executables that fire at agent lifecycle points, on every
harness. Drop a script in, `chmod +x`, done — no JSON to edit, no sync to run.

> Not to be confused with `hooks/`, which is this repo's **git** hooks.

## Adding a hook

```sh
cat > agent-hooks/pre-command/50-no-force-push <<'EOF'
#!/bin/sh
case "$AGENT_HOOK_TOOL_COMMAND" in
  *"git push"*--force*) echo "agents may not force-push" >&2; exit 2 ;;
esac
EOF
chmod +x agent-hooks/pre-command/50-no-force-push
```

That is live in Claude Code, Codex, Devin CLI, Cursor, Copilot and Devin
Desktop. Nothing is regenerated: the harness configs wire every event
unconditionally to one runner, because they describe *harnesses* — which change
rarely — not *hooks*, which change constantly.

Files run in lexicographic order, so `10-` runs before `50-`. A file that is
not executable never runs.

## Events

| Event | Fires | Blocking |
|---|---|---|
| `session-start` | agent session begins | no |
| `session-end` | session ends | no |
| `prompt-submit` | user prompt submitted | yes |
| `pre-tool-use` | before any tool call | yes |
| `pre-command` | before a shell command | yes |
| `pre-file-write` | before a file write | yes |
| `post-tool-use` | after a tool call | no |
| `agent-stop` | agent finished responding | yes |
| `pre-commit` | git commit (the universal backstop) | yes |
| `pre-push` | git push (the universal backstop) | yes |

`pre-commit` and `pre-push` are served by the git layer, which has no vendor, no
drift and an exit-code channel that cannot fail open. **Policy that must hold
everywhere belongs in a harness event *and* in one of those two** — that is what
covers Devin Desktop's weak channel and Devin cloud's absent one.

### Generated adapters

`hook-dialects.mjs` declares the vendor spellings and `sync-hooks.mjs` generates
the checked-in Claude, Codex, Cursor, Copilot, and Devin Desktop adapters. Devin
CLI consumes the Claude adapter natively; generating a second Devin CLI file
would fire each hook twice. `npm test` runs `node sync-hooks.mjs --check`, so a
hand-edited adapter cannot drift from the shared table.

Generated entries are marker-scoped. Regeneration replaces entries containing
`agent-bot agent-hook` and preserves foreign entries such as Claude's
`WorktreeCreate` hook.

## The contract

Your script gets these, so a five-line `sh` hook never parses JSON:

| Variable | Notes |
|---|---|
| `AGENT_HOOK_EVENT` | canonical event name |
| `AGENT_HOOK_HARNESS` | `claude`, `codex`, `cursor`, `copilot`, `devin-desktop`, `git` |
| `AGENT_HOOK_BLOCKING` | `1` when a denial will actually stop the action |
| `AGENT_HOOK_SESSION_ID` | normalized across `session_id` / `conversation_id` / `trajectory_id` |
| `AGENT_HOOK_CWD` | |
| `AGENT_HOOK_TOOL_NAME` | |
| `AGENT_HOOK_TOOL_COMMAND` | set when the tool is a shell tool |
| `AGENT_HOOK_TOOL_PATH` | set when the tool is a file tool |
| `AGENT_HOOK_PROMPT` | set on `prompt-submit` |
| `AGENT_HOOK_MODEL` | where the harness sends one — Codex and Cursor do, Claude Code does not |
| `AGENT_HOOK_GIT_STDIN` | raw ref-update lines on `pre-push` |

The normalized envelope also arrives as JSON on stdin, including `raw` — the
verbatim vendor payload, for the day a vendor ships a field the table does not
model yet.

Say your verdict with an exit code:

| Exit | Meaning |
|---|---|
| `0` | allow / no opinion |
| `2` | **deny** — stderr is the reason shown to the agent |
| anything else | error |

Optionally, one line of stdout for a richer verdict:

```sh
echo 'agent-hook: {"decision":"ask","reason":"needs a human"}'
```

## Fail mode is the event's, not yours

On a blocking event, a hook that errors, times out or prints garbage **denies**.
On an advisory event it warns on stderr and the action proceeds.

There is nothing to declare, so nothing can be declared wrong — and there is no
opt-out variable, because the party who would set it is the party the guard is
for. (`git push --no-verify` still skips git hooks entirely; no client-side hook
can prevent that, which is why the branch ruleset is the real enforcement and
this layer is the fast, informative one.)

Filtering happens **inside** your hook, using the variables above. Devin
Desktop has no matcher field at all, so no declarative matcher could work
everywhere; hooks fire more often and the contract stays one contract.

## When agent-bot is not installed

The generated configs are committed, so they run for anyone who clones the
repo — a cloud offload, a fresh host, or this checkout opened before
bootstrap. A missing `~/.local/share/agent-bot/agent-hook` is not a license
to run without identity policy. Adapters enter an explicit **uninstalled**
mode (ENG-0128): they refuse `git commit`, `git push`, and GitHub writes
as the human. An unmanaged session may publish only when the actor is in
`AGENT_BOT_UNMANAGED_AUTHORS` (default `ai9d` when unset): git author for
commits, `gh` login for pushes and `gh` writes. Reads and uncommitted
working-tree edits proceed. Cursor blocking events still print `{}` on
allow so `failClosed` does not treat silence as a denial.

That mode does not require `pass-cli`, a supervisor, or a finished durable
bootstrap. Publishing as the bot still does. Doctor reports the class as
`identity.class` (`durable` or `uninstalled`) and does not install or
migrate.

On a host the owner will keep, finish the durable bootstrap so the installed
runner takes over. Policy that must hold everywhere still belongs in a
harness event *and* in `pre-commit` / `pre-push`.
