---
type: patch
---

- Automatically initiate `agent-bot server enroll --add-harness <appSlug>` during `agent-bot start` when a device or harness scope is not yet enrolled on `agentBotServer` (with `--no-enroll` to disable), and support `--worktree` / `--worktree-dir` aliases for `--name` (`#1362`).
- Add `agent-bot server enroll --all-configured` to enroll all active configured `config.apps` slugs in a single device-grant flow (`#1362`).
- Auto-detect OpenCode sessions (`OPENCODE=1`, `OPENCODE_CLIENT`, `OPENCODE_SESSION_ID`, `opencode-cli` process ancestry) and auto-discover the active OpenCode SQLite session transcript from `~/.local/share/opencode/opencode.db` during `agent-bot start` (`#1362`).
- Remove legacy standalone `agent-bot mint-token` task instructions from `skills/agent-bot/SKILL.md` and `skills/agent-bot/references/operations.md` so agents use `agent-bot start` + plain `git`/`gh` inside the bound soul worktree (`#1362`).
