#!/usr/bin/env bash
# Codex (and other harness) startup: land bot identity on a linked worktree,
# then verify the pin, author, credential helper, and execution-identity hooks.
# Point your harness at this script after cloning agent-bot-identity, e.g.:
#
#   AGENT_BOT_HOME=~/Code/agent-bot-identity
#   "$AGENT_BOT_HOME/scripts/ensure-identity.sh"

set -Eeuo pipefail

fail() {
  echo "ERROR: agent identity setup: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "Node.js is required"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  fail "run from a Git worktree"
git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null)" ||
  fail "could not resolve the worktree Git directory"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
  fail "could not resolve the common Git directory"

if [[ "$git_dir" == "$common_dir" ]]; then
  fail "agents must use a linked worktree; refusing to configure a primary checkout"
fi

# The installed location is checked as well as PATH because harness startup runs
# in a non-login, non-interactive shell, which reads .zshenv and nothing else. A
# machine installed before .zshenv registration existed — or running any shell
# other than zsh, which gets no registration at all — has the symlink but not
# the PATH entry.
installed_agent_bot="$HOME/.local/bin/agent-bot"
if command -v agent-bot >/dev/null 2>&1; then
  agent-bot setup-worktree
elif [[ -x "$installed_agent_bot" ]]; then
  "$installed_agent_bot" setup-worktree
elif [[ -n "${AGENT_BOT_HOME:-}" && -f "$AGENT_BOT_HOME/setup-worktree.mjs" ]]; then
  node "$AGENT_BOT_HOME/setup-worktree.mjs"
elif [[ -n "${PLAYBOOK_HOME:-}" && -f "$PLAYBOOK_HOME/tools/agent-bot/setup-worktree.mjs" ]]; then
  node "$PLAYBOOK_HOME/tools/agent-bot/setup-worktree.mjs"
elif [[ -f "$HOME/.config/agent-bot/playbook-home" ]]; then
  legacy_home="$(tr -d '\n' < "$HOME/.config/agent-bot/playbook-home")"
  [[ -f "$legacy_home/tools/agent-bot/setup-worktree.mjs" ]] ||
    fail "deprecated playbook-home pointer does not contain setup-worktree.mjs"
  node "$legacy_home/tools/agent-bot/setup-worktree.mjs"
else
  fail "agent-bot is not installed; run node install.mjs from agent-bot-identity"
fi

agent_id="$(git config --worktree --get agentBot.agentId 2>/dev/null ||
  git config --worktree --get qwts.agentId 2>/dev/null || true)"
agent_app="$(git config --worktree --get agentBot.app 2>/dev/null ||
  git config --worktree --get qwts.agentApp 2>/dev/null || true)"
author="$(git config --worktree --get user.name 2>/dev/null || true)"
helper="$(git config --worktree --get-all credential.helper 2>/dev/null | tail -n 1 || true)"
hooks="$(git config --worktree --path --get core.hooksPath 2>/dev/null || true)"

[[ -n "$agent_id" ]] || fail "setup completed without an agentBot.agentId"
[[ -n "$agent_app" ]] || fail "setup completed without an agentBot.app pin"
[[ "$author" == "$agent_app[bot]" ]] ||
  fail "Git author $author does not match $agent_app[bot]"
[[ "$helper" == *" $agent_app" ]] ||
  fail "credential helper does not resolve the pinned App $agent_app"
[[ -x "$hooks/prepare-commit-msg" ]] ||
  fail "core.hooksPath does not provide the execution-identity commit hook"

echo "==> agent identity: $agent_app[bot] as $agent_id"
