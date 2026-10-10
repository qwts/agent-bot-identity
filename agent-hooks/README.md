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

The runner also includes a soul write confinement check independent of these
executables, so a project's hook directory does not replace it. It defaults
to warn: outside file tool writes are logged and allowed, and check errors
allow. Explicit owner-selected deny fails closed; off skips the check.
Existing executable verdicts keep their usual fail modes. See
[confinement](../docs/confinement.md) for allowed roots, reports and coverage.

The runner also has a built-in identity check on `pre-command` (#749). When a
session stated a bot identity (`GH_AGENT_APP`, a checkout pin, or an agent
account) and its checkout's committer is still the human because worktree
setup failed or never ran, a `git commit` or `git push` is denied, and so
is any other git command that writes commits (`merge`, `rebase`,
`cherry-pick`, `revert`, `am`, `commit-tree`). The denial
names the setup failure and the fix. The check follows the repository git
will write, not the session's directory: `cd`, `git -C`, `--git-dir`,
`--work-tree`, `GIT_DIR`, `sh -c`, `eval`, command substitutions and git
aliases are resolved, and quoting and backslash escapes are removed the way
the shell removes them. When a stated bot's command reaches a repository
the check cannot place, or hides its command word behind a variable,
substitution or glob, it is denied too. Bound means the commit's author
and committer are exactly `<slug>[bot]` as git resolves them for that
command, so `--author`, `-c user.name` and `GIT_AUTHOR_NAME` count, and any
other `[bot]`-looking name is not a binding. `hooks/pre-commit` and `hooks/pre-push`
apply the same rule as the git backstop. Because those hooks are the
backstop, a stated bot may not skip them, even in its bound worktree:
`--no-verify` (or `commit -n`), a `core.hooksPath` override (`-c`,
`--config-env`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_KEY_n`, or an
`include.path` that could set it) and a `git config` write of
`core.hooksPath` (or removing or renaming the section holding it) are
denied. A checkout pin is a stated identity, so a bypass that reaches a
pinned checkout is denied even from the delegate. Script files,
stdin-fed shells, language interpreters and common task runners (`node`,
`python3`, `npm`, `make`) are opaque to the scan, so a stated bot whose
checkout is not bound is denied them too. In its bound worktree it runs
them as before, and the git hooks cover any git they run. This check is
not a sandbox: keeping human GitHub credentials out of bot processes and
server-side repository rules are still needed. Neither is a command
that relocates the global config (`GIT_CONFIG_GLOBAL`, `HOME`); a bound
worktree keeps its `core.hooksPath` in worktree config, and an unbound
checkout is refused by the bound-target check.
The human's delegate states no identity, so it is not affected, and neither
is an ordinary human shell.

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

`hook-dialects.mjs` declares the vendor spellings and `sync-hooks.mjs` writes
the Claude, Codex, Cursor, Copilot, and Devin Desktop adapters into the harness
user directory (`~/.claude`, `~/.codex`, `~/.cursor`, `~/.copilot/hooks`,
`~/.windsurf`). Devin CLI consumes the Claude adapter natively; generating a
second Devin CLI file would fire each hook twice. The adapters are not
committed in a repository. A project copy can outrank the user hook.

Generated entries are marker-scoped. Regeneration replaces entries containing
`agent-bot agent-hook` and preserves foreign entries such as Claude's
`WorktreeCreate` hook.

### Soul hooks

A soul declares its own hooks with the same contract in its package's
`hooks/<event>/`, and `agent-bot soul build` renders entries for them into the
soul's *project* hook files, marked `agent-bot soul hook` and run over that
folder. Those are the builder's; the lifecycle adapters above stay with
`sync-hooks.mjs`, and neither strips the other's entries. See
[soul-builder](../docs/soul-builder.md#hooks-378-slice-3).

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

## Remote branch cleanup

The git `pre-push/50-no-force-push` guard allows new branches, fast-forward
updates, and ordinary branch deletion (`git push origin --delete <branch>`).
Branch cleanup does not rewrite a surviving branch's history. Remote
permissions and rulesets remain authoritative for preventing deletion of
protected branches; the local guard does not infer protection from branch names
or decide whether a branch's work is complete.

Non-fast-forward updates and deletion of non-branch refs, including tags,
remain blocked. Every update in a multi-ref push is checked, even after an
allowed branch deletion.

## When agent-bot is not installed

The generated configs are committed, so they run for anyone who clones the
repo — a cloud offload, a fresh host, or this checkout opened before
bootstrap. A missing `~/.local/share/agent-bot/agent-hook` is not a license
to run without identity policy. Adapters enter an explicit **uninstalled**
mode (ENG-0128): they refuse `git commit`, `git push`, and GitHub writes
as the human. An unmanaged session may publish only when the actor is in
`AGENT_BOT_UNMANAGED_AUTHORS` (default `ai9d` when unset): git author for
commits (`--author` or `GIT_AUTHOR_*`, never committer identity; amend and
reuse require `--reset-author` or an explicit `--author`), and the
authenticated `gh` login for pushes and `gh` writes. Reads and uncommitted
working-tree edits proceed. Cursor blocking events still print `{}` on
allow so `failClosed` does not treat silence as a denial.

That mode does not require `pass-cli`, a supervisor, or a finished durable
bootstrap. Publishing as the bot still does. Doctor reports the class as
`identity.class` (`durable` or `uninstalled`) and does not install or
migrate.

On a host the owner will keep, finish the durable bootstrap so the installed
runner takes over. Policy that must hold everywhere still belongs in a
harness event *and* in `pre-commit` / `pre-push`.
