export const GH_SHIM_MARKER = '# gh shim — agent bot identity. Managed by install-gh-shim.mjs';

export function buildGhShim(tokenTool = null, { psPath = '/bin/ps', lsofPath = '/usr/sbin/lsof' } = {}) {
  const tokenSetup = tokenTool
    ? `TOKEN_TOOL="${tokenTool}"
TOKEN_REQUIRES_NODE=1
token_tool() { node "$TOKEN_TOOL" "$@"; }
token_mint_app() { node "$TOKEN_TOOL" --mint-app "$1"; }
token_expand_inbox_query() { node "$TOKEN_TOOL" --expand-gh-inbox-query "$1" "$2"; }
token_enrich_pr_view() { node "$TOKEN_TOOL" --enrich-gh-pr-view "$1"; }`
    : `TOKEN_TOOL="$HOME/.local/bin/agent-bot"
TOKEN_REQUIRES_NODE=""
token_tool() { "$TOKEN_TOOL" worktree-token "$@"; }
token_mint_app() { "$TOKEN_TOOL" mint-token --app "$1"; }
token_expand_inbox_query() { "$TOKEN_TOOL" gh-inbox-query "$1" "$2"; }
token_enrich_pr_view() { "$TOKEN_TOOL" gh-pr-view-json; }`;
  return `#!/bin/sh
${GH_SHIM_MARKER}; do not edit in place.
${tokenSetup}
SELF="$0"
case "$SELF" in
  */*) ;;
  *) SELF=$(command -v -- "$SELF" 2>/dev/null) || SELF="$0" ;;
esac
INVOKED_DIR=$(dirname -- "$SELF")
SELF_REAL=$(readlink -f -- "$SELF" 2>/dev/null) || SELF_REAL=$SELF
SELF_DIR=$(dirname -- "$SELF_REAL")
candidate_is_shim() {
  CANDIDATE_REAL=$(readlink -f -- "$1" 2>/dev/null) || CANDIDATE_REAL="$1"
  [ "$CANDIDATE_REAL" = "$SELF_REAL" ] && return 0
  /usr/bin/head -c 512 "$1" 2>/dev/null \
    | /usr/bin/grep -Fq ${JSON.stringify(GH_SHIM_MARKER)}
}
REAL="$AGENT_BOT_REAL_GH"
if [ -n "$REAL" ]; then
  [ -f "$REAL" ] && [ -x "$REAL" ] || {
    echo "agent-bot gh shim: AGENT_BOT_REAL_GH is not executable: $REAL" >&2
    exit 127
  }
  ! candidate_is_shim "$REAL" || {
    echo "agent-bot gh shim: AGENT_BOT_REAL_GH resolves to an agent-bot shim — refusing recursive dispatch" >&2
    exit 127
  }
fi
[ -n "$REAL" ] || for CAND in \
  "$INVOKED_DIR/gh.agent-bot-real" "$SELF_DIR/gh.agent-bot-real" \
  "$INVOKED_DIR/gh.bak" "$SELF_DIR/gh.bak"; do
  [ -f "$CAND" ] && [ -x "$CAND" ] || continue
  CAND_REAL=$(readlink -f -- "$CAND" 2>/dev/null) || CAND_REAL="$CAND"
  [ "$CAND_REAL" = "$SELF_REAL" ] && continue
  ! candidate_is_shim "$CAND" || {
    echo "agent-bot gh shim: $CAND resolves to an agent-bot shim — refusing recursive dispatch" >&2
    exit 127
  }
  REAL="$CAND"; break
done
OLDIFS=$IFS; IFS=:
for d in $PATH; do
  [ -n "$REAL" ] && break
  [ "$d" = "$SELF_DIR" ] && continue
  [ -f "$d/gh" ] && [ -x "$d/gh" ] || continue
  CAND="$d/gh"
  CAND_REAL=$(readlink -f -- "$CAND" 2>/dev/null) || CAND_REAL="$CAND"
  [ "$CAND_REAL" = "$SELF_REAL" ] && continue
  ! candidate_is_shim "$CAND" || {
    echo "agent-bot gh shim: $CAND resolves to an agent-bot shim — refusing recursive dispatch" >&2
    exit 127
  }
  REAL="$CAND"; break
done
IFS=$OLDIFS
[ -n "$REAL" ] || for CAND in /opt/homebrew/opt/gh/bin/gh /usr/local/opt/gh/bin/gh; do
  [ -f "$CAND" ] && [ -x "$CAND" ] || continue
  CAND_REAL=$(readlink -f -- "$CAND" 2>/dev/null) || CAND_REAL="$CAND"
  [ "$CAND_REAL" = "$SELF_REAL" ] && continue
  ! candidate_is_shim "$CAND" || {
    echo "agent-bot gh shim: $CAND resolves to an agent-bot shim — refusing recursive dispatch" >&2
    exit 127
  }
  REAL="$CAND"; break
done
[ -z "$REAL" ] && { echo "agent-bot gh shim: real gh not found on PATH" >&2; exit 127; }

# Experimental Codex desktop compatibility. Native GitHub operations are
# direct children of the desktop bundle, whereas agent shell commands have a
# shell or sandbox process in between. The explicit override exists for tests
# and diagnostics because this first-party implementation detail is not a
# supported Codex extension API.
CODEX_DESKTOP_CONTEXT=""
[ "$AGENT_BOT_CODEX_DESKTOP" = "1" ] && CODEX_DESKTOP_CONTEXT=1
if [ -z "$CODEX_DESKTOP_CONTEXT" ] && [ -x /bin/ps ]; then
  CODEX_DESKTOP_PARENT=$(/bin/ps -p "$PPID" -o command= 2>/dev/null || true)
  case "$CODEX_DESKTOP_PARENT" in
    /Applications/ChatGPT.app/Contents/*|/Applications/Codex.app/Contents/*)
      CODEX_DESKTOP_CONTEXT=1
      ;;
  esac
fi
if [ -n "$CODEX_DESKTOP_CONTEXT" ]; then
  CODEX_DESKTOP_GH=1
  export CODEX_DESKTOP_GH
fi

# Claude Desktop polls GitHub liveness with one exact command, and it exports
# the agent markers (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, AI_AGENT) into its own
# children — so the app's housekeeping probe is indistinguishable from an agent
# shell by environment alone, and enforcement refuses it. The app then reports
# that nonzero exit to the user as "the GitHub CLI is not logged in".
#
# This is the human's own application asking for the human's own token, so the
# probe delegates to stock gh rather than minting a bot identity. That makes
# this gate a credential boundary, so it takes no input the caller controls:
# there is deliberately no environment override here, unlike the Codex desktop
# path above, because reaching stock gh with a bot identity resolved prints
# the human's token rather than minting a bot's.
#
# ps alone cannot carry the gate. Its command and comm fields are both read
# from the process arguments, which any caller can set when it execs, so ps is
# only a cheap pre-filter. The kernel-mapped text file cannot be set that way,
# so lsof confirms what the parent actually is before the token is released.
#
# This raises the cost of misuse; it is not a sandbox. The shim is found
# through PATH, so a caller that names the real gh by absolute path bypasses
# every rule here. The guarantee is against default and inadvertent use of the
# human credential, not against a hostile process.
CLAUDE_DESKTOP_CONTEXT=""
if [ -x ${psPath} ] && [ -x ${lsofPath} ]; then
  CLAUDE_DESKTOP_PARENT=$(${psPath} -p "$PPID" -o comm= 2>/dev/null || true)
  case "$CLAUDE_DESKTOP_PARENT" in
    /Applications/Claude.app/Contents/*)
      CLAUDE_DESKTOP_TEXT=$(${lsofPath} -p "$PPID" -a -d txt -Fn 2>/dev/null \
        | sed -n 's/^n//p' | head -1)
      case "$CLAUDE_DESKTOP_TEXT" in
        /Applications/Claude.app/Contents/*)
          CLAUDE_DESKTOP_CONTEXT=1
          ;;
      esac
      ;;
  esac
fi
# Only the single probe shape passes; every other command from the app still
# falls through to normal identity resolution.
if [ -n "$CLAUDE_DESKTOP_CONTEXT" ] && [ "$#" -eq 4 ] && \
   [ "$1" = "auth" ] && [ "$2" = "token" ] && \
   [ "$3" = "--hostname" ] && [ "$4" = "github.com" ]; then
  exec "$REAL" "$@"
fi

token_tool_available() {
  [ -e "$TOKEN_TOOL" ] || return 1
  [ -z "$TOKEN_REQUIRES_NODE" ] || command -v node >/dev/null 2>&1
}

# Agent context: the process carries an agent-only marker, or names an agent
# account through AGENT_BOT_ACCOUNT. It decides one thing only — whether a
# MISSING token tool fails closed, because a bot that cannot mint must not
# fall through to a stored human login. Who gets a token is the token tool's
# answer: it classifies the real account by an exact roster match through the
# shared runtime (ENG-0339), never by a shell glob on the account name, so
# shell and JS cannot disagree about what an agent account is. In the owner's
# account an agent marker alone confers nothing: a harness that was not told
# to be the bot is the human's delegate and gets stock gh.
AGENT_CONTEXT=""
[ "$CLAUDECODE" = "1" ] && AGENT_CONTEXT=1
[ "$CURSOR_AGENT" = "1" ] && AGENT_CONTEXT=1
[ "$COPILOT_AGENT" = "1" ] && AGENT_CONTEXT=1
[ "$DEVIN_AGENT" = "1" ] && AGENT_CONTEXT=1
[ "$WINDSURF_AGENT" = "1" ] && AGENT_CONTEXT=1
[ "$MUSE_AGENT" = "1" ] && AGENT_CONTEXT=1
[ -n "$CLAUDE_CODE_ENTRYPOINT" ] && AGENT_CONTEXT=1
[ -n "$AI_AGENT" ] && AGENT_CONTEXT=1
[ -n "$GH_AGENT_APP" ] && AGENT_CONTEXT=1
[ -n "$AGENT_BOT_ACCOUNT" ] && AGENT_CONTEXT=1
if [ -z "$AGENT_CONTEXT" ]; then
  env | grep -q '^CODEX_' && AGENT_CONTEXT=1
fi

# A checkout configured as a bot — a pin or the bot credential helper in its
# git config — is a stated identity. With the token tool missing it fails
# closed too, rather than degrading to the human. The directory the checkout
# sits in is not a signal (ENG-0339 supersedes ENG-0045).
IDENTITY_HINT=""
if command -v git >/dev/null 2>&1; then
  PIN=$(git config --get agentBot.app 2>/dev/null || git config --get qwts.agentApp 2>/dev/null || true)
  [ -n "$PIN" ] && IDENTITY_HINT=1
  HELPERS=$(git config --get-all credential.helper 2>/dev/null || true)
  case "$HELPERS" in
    *git-credential-bot.mjs*|*agent-bot*credential*) IDENTITY_HINT=1 ;;
  esac
fi

# SLUG: the bot this invocation acts as — explicit GH_AGENT_APP, the pin, the
# account — or empty for the human persona. AGENT_SLUG: the agent process the
# environment describes, used only by the Codex desktop path below.
SLUG=""
AGENT_SLUG=""
if ! token_tool_available; then
  if [ -n "$AGENT_CONTEXT$IDENTITY_HINT" ]; then
    echo "agent-bot: token helper or Node is unavailable — refusing stock human gh" >&2
    exit 1
  fi
else
  SLUG=$(token_tool --slug 2>/dev/null) || {
    echo "agent-bot: identity resolution failed — refusing stock human gh" >&2
    exit 1
  }
  AGENT_SLUG=$(token_tool --agent-slug 2>/dev/null) || {
    echo "agent-bot: agent detection failed — refusing stock human gh" >&2
    exit 1
  }
fi
CHECKOUT_SLUG="$SLUG"

# The native desktop UI acts as the configured Codex App by caller identity
# rather than by cwd or account.
if [ -n "$CODEX_DESKTOP_CONTEXT" ]; then
  # Installing the toolkit must remain inert until Codex has an App mapping.
  # Delegate unchanged so the native desktop UI keeps its existing identity.
  [ -n "$AGENT_SLUG" ] || exec "$REAL" "$@"
  SLUG="$AGENT_SLUG"
fi

TOKEN_MINTED_BY_SHIM=""
if [ -n "$CODEX_DESKTOP_CONTEXT" ] && [ -z "$GH_TOKEN" ]; then
  # PR operations normally have a checkout cwd, so reuse the same private
  # per-checkout token cache as agent shells only when that checkout resolves
  # to the configured Codex App. A Codex window may inspect another harness's
  # pinned worktree; its cached token must never cross that identity boundary.
  TOKEN=""
  if [ -n "$CHECKOUT_SLUG" ] && [ "$CHECKOUT_SLUG" = "$SLUG" ]; then
    TOKEN=$(token_tool) || {
      echo "agent-bot: Codex desktop token lookup failed — refusing stock human gh" >&2
      exit 1
    }
  fi
  # Root-level identity probes and foreign-harness worktrees have no compatible
  # cache, so mint the selected Codex App explicitly.
  if [ -z "$TOKEN" ]; then
    TOKEN=$(token_mint_app "$SLUG") || {
      echo "agent-bot: Codex desktop token mint failed — refusing stock human gh" >&2
      exit 1
    }
  fi
  [ -n "$TOKEN" ] || {
    echo "agent-bot: Codex desktop token mint returned empty — refusing stock human gh" >&2
    exit 1
  }
  GH_TOKEN="$TOKEN"
  export GH_TOKEN
  TOKEN_MINTED_BY_SHIM=1
fi

# An explicit GH_TOKEN must belong to the bot this invocation acts as: a
# human token inside a bot identity, or another bot's token, is crossover.
TOKEN_LOGIN=""
if [ -n "$GH_TOKEN" ] && [ -n "$SLUG" ] && [ -z "$TOKEN_MINTED_BY_SHIM" ]; then
  TOKEN_LOGIN=$("$REAL" api graphql -f "query={viewer{login}}" --jq .data.viewer.login 2>/dev/null) || {
    echo "agent-bot: could not resolve explicit GH_TOKEN identity" >&2
    exit 1
  }
  if [ "$TOKEN_LOGIN" != "\${SLUG}[bot]" ]; then
    echo "agent-bot: explicit GH_TOKEN is $TOKEN_LOGIN, expected \${SLUG}[bot] — refusing identity crossover" >&2
    exit 1
  fi
fi

# GitHub App installation tokens cannot call REST /user, but Codex uses that
# endpoint as an identity probe and expects the REST user schema. Try the probe
# unchanged first. If GitHub rejects it, fetch the App's real bot account from
# /users/<slug>[bot], which already has the exact user-shaped response Codex
# expects; do not invent or translate fields locally.
if [ -n "$CODEX_DESKTOP_CONTEXT" ] && [ "$#" -eq 4 ] && \
   [ "$1" = "api" ] && [ "$2" = "user" ] && \
   [ "$3" = "--hostname" ] && [ "$4" = "github.com" ]; then
  DESKTOP_USER=$("$REAL" "$@" 2>/dev/null)
  DESKTOP_USER_STATUS=$?
  if [ "$DESKTOP_USER_STATUS" -eq 0 ] && [ -n "$DESKTOP_USER" ]; then
    printf '%s\n' "$DESKTOP_USER"
    exit 0
  fi
  exec "$REAL" api "users/\${SLUG}[bot]" --hostname github.com
fi

# gh whoami: who will gh act as HERE, stated plainly. With a bot identity an
# explicit GH_TOKEN must resolve to that same bot; otherwise a bot identity is
# answered locally with no network, and the human persona asks GitHub through
# stock gh.
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
  if [ -n "$SLUG" ]; then
    echo "\${SLUG}[bot] — bot identity"
    exit 0
  fi
  echo "$("$REAL" api user --jq .login 2>/dev/null || echo 'unknown') — human persona, gh is stock"
  exit 0
fi
# A bot identity mints; a failed mint aborts rather than running gh as the
# human. No identity is the delegate: stock gh, untouched.
if [ -z "$GH_TOKEN" ] && [ -n "$SLUG" ]; then
  TOKEN=$(token_tool) || {
    echo "agent-bot: token mint failed for \${SLUG}[bot] — refusing to run gh as the human" >&2
    exit 1
  }
  [ -n "$TOKEN" ] || {
    echo "agent-bot: token mint returned empty for \${SLUG}[bot] — refusing to run gh as the human" >&2
    exit 1
  }
  GH_TOKEN="$TOKEN"
  export GH_TOKEN
fi

# Codex's native Pull Requests UI uses one exact ten-argument GraphQL search
# shape for its authored, reviewed, and review-requested inbox lanes. Preserve
# that command and replace only the @me identity predicate with the cached
# App-installation repo scope. Native PR state and sort filters remain.
if [ -n "$CODEX_DESKTOP_CONTEXT" ] && [ "$#" -eq 10 ] && \
   [ "$1" = "api" ] && [ "$2" = "graphql" ] && \
   [ "$3" = "-f" ] && [ "$5" = "-f" ] && \
   [ "$7" = "-F" ] && [ "$8" = "first=50" ] && \
   [ "$9" = "--hostname" ] && [ "\${10}" = "github.com" ]; then
  case "$6" in
    searchQuery=is:pr*)
      EXPANDED_SEARCH_QUERY=$(token_expand_inbox_query "$6" "$SLUG") || {
        echo "agent-bot: could not expand Codex Pull Requests inbox query" >&2
        exit 1
      }
      exec "$REAL" "$1" "$2" "$3" "$4" "$5" "$EXPANDED_SEARCH_QUERY" \
        "$7" "$8" "$9" "\${10}"
      ;;
  esac
fi

# The branch row is already constrained to one exact head branch and repo.
# Remove only its @me author filter so a branch PR remains visible when another
# configured agent App created it. This does not broaden the row to other
# branches or repositories.
if [ -n "$CODEX_DESKTOP_CONTEXT" ] && [ "$#" -eq 12 ] && \
   [ "$1" = "pr" ] && [ "$2" = "list" ] && [ "$3" = "--head" ] && \
   [ -n "$4" ] && [ "$5" = "--author" ] && [ "$6" = "@me" ] && \
   [ "$7" = "--state" ] && [ "$8" = "all" ] && [ "$9" = "--json" ] && \
   [ "\${10}" = "number,url,state,headRefName" ] && \
   [ "\${11}" = "--repo" ] && [ -n "\${12}" ]; then
  exec "$REAL" "$1" "$2" "$3" "$4" "$7" "$8" "$9" \
    "\${10}" "\${11}" "\${12}"
fi

# gh's PR JSON represents GitHub App actors as app/<slug> but omits their
# avatarUrl. Codex's PR detail schema accepts avatarUrl on these actor objects,
# so enrich only the native seven-argument detail request. Keep the successful
# original JSON if parsing or the local bot-user cache cannot enrich it.
if [ -n "$CODEX_DESKTOP_CONTEXT" ] && [ "$#" -eq 7 ] && \
   [ "$1" = "pr" ] && [ "$2" = "view" ] && [ -n "$3" ] && \
   [ "$4" = "--json" ] && [ -n "$5" ] && [ "$6" = "--repo" ]; then
  case "$7" in
    github.com/*/*)
      DESKTOP_PR_JSON=$("$REAL" "$@")
      DESKTOP_PR_STATUS=$?
      if [ "$DESKTOP_PR_STATUS" -ne 0 ]; then
        [ -z "$DESKTOP_PR_JSON" ] || printf '%s\n' "$DESKTOP_PR_JSON"
        exit "$DESKTOP_PR_STATUS"
      fi
      ENRICHED_PR_JSON=$(printf '%s\n' "$DESKTOP_PR_JSON" | token_enrich_pr_view)
      if [ "$?" -eq 0 ] && [ -n "$ENRICHED_PR_JSON" ]; then
        printf '%s\n' "$ENRICHED_PR_JSON"
      else
        printf '%s\n' "$DESKTOP_PR_JSON"
      fi
      exit 0
      ;;
  esac
fi
exec "$REAL" "$@"
`;
}
