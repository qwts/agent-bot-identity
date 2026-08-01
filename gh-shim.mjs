export function buildGhShim(tokenTool = null) {
  const tokenSetup = tokenTool
    ? `TOKEN_TOOL="${tokenTool}"
token_tool() { node "$TOKEN_TOOL" "$@"; }`
    : `TOKEN_TOOL="$HOME/.local/bin/agent-bot"
token_tool() { "$TOKEN_TOOL" worktree-token "$@"; }`;
  return `#!/bin/sh
# gh shim — agent bot identity. Managed by install-gh-shim.mjs; do not edit
# in place.
${tokenSetup}
SELF="$0"
case "$SELF" in
  */*) ;;
  *) SELF=$(command -v -- "$SELF" 2>/dev/null) || SELF="$0" ;;
esac
SELF_REAL=$(readlink -f -- "$SELF" 2>/dev/null) || SELF_REAL=$SELF
SELF_DIR=$(dirname -- "$SELF_REAL")
REAL=""
OLDIFS=$IFS; IFS=:
for d in $PATH; do
  [ "$d" = "$SELF_DIR" ] && continue
  [ -x "$d/gh" ] || continue
  CAND="$d/gh"
  CAND_REAL=$(readlink -f -- "$CAND" 2>/dev/null) || CAND_REAL="$CAND"
  [ "$CAND_REAL" = "$SELF_REAL" ] && continue
  REAL="$CAND"; break
done
IFS=$OLDIFS
[ -z "$REAL" ] && { echo "agent-bot gh shim: real gh not found on PATH" >&2; exit 127; }

AGENT_CONTEXT=""
[ "$CLAUDECODE" = "1" ] && AGENT_CONTEXT=1
[ -n "$CLAUDE_CODE_ENTRYPOINT" ] && AGENT_CONTEXT=1
[ -n "$AI_AGENT" ] && AGENT_CONTEXT=1
[ -n "$GH_AGENT_APP" ] && AGENT_CONTEXT=1
if [ -z "$AGENT_CONTEXT" ]; then
  env | grep -q '^CODEX_' && AGENT_CONTEXT=1
fi

TERRITORY_HINT=""
# The .<tool>/worktrees segment is the signal, not the root above it: a boot
# volume too small for agent worktrees pushes them onto /Volumes/<drive>, which
# says nothing about who owns the work.
case "$PWD" in
  */.claude/worktrees/*|*/.codex/worktrees/*|\
  */.cursor/worktrees/*|*/.vscode/worktrees/*)
    TERRITORY_HINT=1
    ;;
esac
if [ -z "$TERRITORY_HINT" ] && command -v git >/dev/null 2>&1; then
  HELPERS=$(git config --get-all credential.helper 2>/dev/null || true)
  case "$HELPERS" in
    *git-credential-bot.mjs*|*agent-bot*credential*) TERRITORY_HINT=1 ;;
  esac
fi

TERRITORY_SLUG=""
AGENT_SLUG=""
if [ ! -e "$TOKEN_TOOL" ] || ! command -v node >/dev/null 2>&1; then
  if [ -n "$AGENT_CONTEXT$TERRITORY_HINT" ]; then
    echo "agent-bot: token helper or Node is unavailable — refusing stock human gh" >&2
    exit 1
  fi
else
  TERRITORY_SLUG=$(token_tool --slug 2>/dev/null) || {
    echo "agent-bot: territory detection failed — refusing stock human gh" >&2
    exit 1
  }
  AGENT_SLUG=$(token_tool --agent-slug 2>/dev/null) || {
    echo "agent-bot: agent detection failed — refusing stock human gh" >&2
    exit 1
  }
  [ -n "$AGENT_SLUG" ] && AGENT_CONTEXT=1
fi

# Agent processes may use gh only from configured bot territory. Outside it,
# fail before stock gh can exercise the human's stored credentials. A real
# human shell has no agent-only marker and keeps the stock passthrough.
if [ -n "$AGENT_CONTEXT" ] && [ -z "$TERRITORY_SLUG" ]; then
  echo "agent-bot: \${AGENT_SLUG:-detected agent} is outside bot territory — refusing stock human gh" >&2
  echo "Create or use a linked bot worktree, then retry." >&2
  exit 1
fi

TOKEN_LOGIN=""
if [ -n "$GH_TOKEN" ] && [ -n "$TERRITORY_SLUG" ]; then
  TOKEN_LOGIN=$("$REAL" api graphql -f "query={viewer{login}}" --jq .data.viewer.login 2>/dev/null) || {
    echo "agent-bot: could not resolve explicit GH_TOKEN identity" >&2
    exit 1
  }
  if [ "$TOKEN_LOGIN" != "\${TERRITORY_SLUG}[bot]" ]; then
    echo "agent-bot: explicit GH_TOKEN is $TOKEN_LOGIN, expected \${TERRITORY_SLUG}[bot] — refusing identity crossover" >&2
    exit 1
  fi
fi

# gh whoami: who will gh act as HERE, stated plainly. In bot territory an
# explicit GH_TOKEN must resolve to that same bot; otherwise bot territory is
# local/no-network and true human territory asks GitHub through stock gh.
if [ "$1" = "whoami" ]; then
  if [ -n "$GH_TOKEN" ]; then
    LOGIN="$TOKEN_LOGIN"
    if [ -z "$LOGIN" ]; then
      LOGIN=$("$REAL" api graphql -f "query={viewer{login}}" --jq .data.viewer.login 2>/dev/null) || {
        echo "agent-bot: could not resolve explicit GH_TOKEN identity" >&2
        exit 1
      }
    fi
    [ -n "$LOGIN" ] || {
      echo "agent-bot: explicit GH_TOKEN returned no identity" >&2
      exit 1
    }
    echo "$LOGIN — explicit GH_TOKEN"
    exit 0
  fi
  if [ -n "$TERRITORY_SLUG" ]; then
    echo "\${TERRITORY_SLUG}[bot] — bot territory"
    exit 0
  fi
  echo "$("$REAL" api user --jq .login 2>/dev/null || echo 'unknown') — human territory, gh is stock"
  exit 0
fi
if [ -z "$GH_TOKEN" ] && [ -e "$TOKEN_TOOL" ] && command -v node >/dev/null 2>&1; then
  TOKEN=$(token_tool) || {
    echo "agent-bot: token mint failed in a bot worktree — refusing to run gh as the human" >&2
    exit 1
  }
  if [ -n "$TOKEN" ]; then GH_TOKEN="$TOKEN"; export GH_TOKEN; fi
fi
exec "$REAL" "$@"
`;
}
