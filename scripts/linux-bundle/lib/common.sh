# Shared POSIX helpers for the headless-Linux bundle's install.sh and
# uninstall.sh (ADR-0332 decisions 1 and 2). Sourced, never executed.
#
# Everything here is POSIX sh so the same script runs under dash, bash, busybox
# ash and zsh, and so the tests can drive it against a temp HOME and a fake
# systemctl. Nothing in this file needs root.

# The marker line GeniusBar #41 puts in every wrapper it writes. A file at a
# wrapper path is ours to replace only when it carries this marker; anything
# else is a foreign file the operator must opt into with --replace.
WRAPPER_MARKER='# agent-bot-linux-cli-tool'

# The PATH block markers. uninstall removes exactly this block and nothing else.
PATH_BEGIN='# >>> agent-bot PATH >>>'
PATH_END='# <<< agent-bot PATH <<<'

# The wrappers the bundle provides, one name per line.
#
# Callers iterate it with a here-doc through `read`, never `for x in $LIST`:
# zsh does not word-split an unquoted expansion, so that loop would see the
# whole list as one word there and write exactly one wrapper. install.sh and
# uninstall.sh read it, which is why it looks unused here.
# shellcheck disable=SC2034
WRAPPER_NAMES='agent-bot
agent-comms
node'

DAEMON_UNIT='agent-bot-daemon.service'
BROKER_UNIT='agent-comms-broker.service'

# Read by install.sh, which parses its own flags after sourcing this file.
# shellcheck disable=SC2034
REPLACE_FOREIGN=0
# shellcheck disable=SC2034
MIGRATE=0

say() {
  printf '%s\n' "$*"
}

warn() {
  printf '%s\n' "$*" >&2
}

die() {
  warn "agent-bot bundle: $*"
  exit 1
}

# Tests and CI inject a fake systemctl so a run never touches a real user
# manager. AGENT_BOT_SYSTEMCTL is the only seam for that.
systemctl_cmd() {
  printf '%s\n' "${AGENT_BOT_SYSTEMCTL:-systemctl}"
}

# The process probe is injectable for the same reason: a test must never see the
# developer's own running daemon and decide it is a second pair.
ps_cmd() {
  printf '%s\n' "${AGENT_BOT_PS:-ps}"
}

run_systemctl() {
  # `|| true`: a systemctl that fails because there is no user bus yet must not
  # abort the installer. The unit files are written regardless; only their
  # enablement depends on a working bus, and each caller that needs an answer
  # reads the output of run_systemctl_capture.
  "$(systemctl_cmd)" "$@" > /dev/null 2>&1 || true
}

# The same call for the one place where a refusal must be fatal: starting a unit
# this installer owns. There, an unset user bus is a real failure and the caller
# rolls back rather than reporting an install whose pair never came up.
try_systemctl() {
  "$(systemctl_cmd)" "$@" > /dev/null 2>&1
}

run_systemctl_capture() {
  "$(systemctl_cmd)" "$@" 2>/dev/null | tr -d '[:space:]'
}

# Every path resolves from HOME (or an explicit --prefix) rather than from the
# caller's environment, so a test HOME is fully self-contained.
resolve_prefix() {
  PREFIX=${AGENT_BUNDLE_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-bot}
  BIN_DIR=${AGENT_BUNDLE_BIN_DIR:-$HOME/.local/bin}
  SYSTEMD_USER_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
}

# The install layout the build produces. One directory with no versioned
# segment: the unit files and the wrappers record this path, so it must not
# churn between releases.
#
# shellcheck disable=SC2034  # BUNDLE_NODE, BUNDLE_COMMS, BUNDLE_COMMS_ENTRY,
# shellcheck disable=SC2034  # BUNDLE_AGENT_BOT, WRAPPER_DIR and BUNDLE_MANIFEST
# shellcheck disable=SC2034  # are read by the two scripts that pull this file in.
bundle_paths() {
  BUNDLE_ROOT="$PREFIX/bundle"
  BUNDLE_BIN="$BUNDLE_ROOT/bin"
  BUNDLE_NODE="$BUNDLE_ROOT/node/bin/node"
  BUNDLE_COMMS="$BUNDLE_BIN/agent-comms"
  # The pinned agent-comms entry, which the broker unit execs. It is the file
  # agent-comms' own service installer passes to Node (service-startup.mjs), and
  # the one bin path components.json names.
  BUNDLE_COMMS_ENTRY="$BUNDLE_ROOT/lib/agent-comms/bin/agent-comms.mjs"
  BUNDLE_AGENT_BOT="$BUNDLE_BIN/agent-bot"
  WRAPPER_DIR="$BUNDLE_BIN/wrappers"
  BUNDLE_MANIFEST="$PREFIX/install-manifest"
  INSTALL_STAMP="$BUNDLE_ROOT/.installed"
}

# The generated shell text interpolates these paths, so a path that could close
# a quote or re-expand is refused rather than silently written.
assert_safe_path() {
  case "$2" in
    *'"'*|*'`'*|*'$'*|*'
'*) die "$1 may not contain a quote, a dollar, or a newline: $2" ;;
  esac
}

is_marked_wrapper() {
  grep -qxF "$WRAPPER_MARKER" "$1" 2>/dev/null
}

# A symlink at a wrapper path is never ours: this bundle writes a regular marked
# file, so a link there belongs to another install (a Homebrew keg, a checkout,
# GeniusBar) and needs --replace.
wrapper_is_ours() {
  [ -f "$1" ] || return 1
  [ -L "$1" ] && return 1
  is_marked_wrapper "$1"
}

backup_path() {
  printf '%s.before-agent-bot\n' "$1"
}

# Write one marked wrapper. It execs the bundled binary through the bundled
# Node, so it never depends on the operator's PATH and can never resolve a
# different agent-bot than the one this bundle installed.
write_wrapper() {
  # Locals are prefixed: install.sh calls this from inside its own `name` loop,
  # and an unprefixed assignment here would overwrite the caller's variable and
  # make it write the wrong wrapper next.
  wrapper_name=$1
  wrapper_target=$2
  wrapper_path="$BIN_DIR/$wrapper_name"
  wrapper_backup=$(backup_path "$wrapper_path")
  mkdir -p "$BIN_DIR" "$WRAPPER_DIR"
  if [ -e "$wrapper_path" ] || [ -L "$wrapper_path" ]; then
    if wrapper_is_ours "$wrapper_path"; then
      rm -f "$wrapper_path"
    elif [ "$REPLACE_FOREIGN" = 1 ]; then
      # GeniusBar #41 policy: preserve the foreign file at a known name so
      # uninstall puts it back exactly where it was.
      if [ -e "$wrapper_backup" ] || [ -L "$wrapper_backup" ]; then
        die "$wrapper_backup already exists; move it aside and re-run"
      fi
      mv "$wrapper_path" "$wrapper_backup"
      say "kept the existing $wrapper_path as $wrapper_backup"
    else
      die "$wrapper_path exists and is not an agent-bot bundle wrapper; re-run with --replace to preserve it as $wrapper_backup"
    fi
  fi
  {
    printf '%s\n' '#!/bin/sh' "$WRAPPER_MARKER" \
      '# Written by the agent-bot Linux bundle install. uninstall.sh removes this file.'
    printf 'AGENT_BOT_BUNDLE_ROOT=%s\n' "$BUNDLE_ROOT"
    # The next two lines are wrapper text, not this script: the wrapper expands
    # them at run time, which is the whole point of quoting them here.
    # shellcheck disable=SC2016
    printf '%s\n' 'export AGENT_BOT_BUNDLE_ROOT' \
      'PATH="$AGENT_BOT_BUNDLE_ROOT/bin:$PATH"' 'export PATH'
    case "$wrapper_name" in
      agent-comms|node)
        printf 'exec "%s" "$@"\n' "$wrapper_target"
        ;;
      agent-bot)
        # agent-bot's own launcher resolves Node; point it at the bundled copy
        # so the pair can never straddle two runtimes.
        # shellcheck disable=SC2016
        printf '%s\n' 'AGENT_BOT_NODE="$AGENT_BOT_BUNDLE_ROOT/node/bin/node"' 'export AGENT_BOT_NODE'
        printf 'exec "%s" "$@"\n' "$wrapper_target"
        ;;
      *)
        printf 'exec "%s" "$@"\n' "$wrapper_target"
        ;;
    esac
  } > "$WRAPPER_DIR/$wrapper_name"
  cp "$WRAPPER_DIR/$wrapper_name" "$wrapper_path"
  chmod 0755 "$WRAPPER_DIR/$wrapper_name" "$wrapper_path"
  printf '%s\n' "$wrapper_path"
}

# ~/.local/bin on PATH for a login shell, the way GeniusBar #41 registers it.
# zsh reads ~/.zprofile; sh, bash and dash read ~/.profile.
login_startup_file() {
  if [ -n "${ZDOTDIR:-}" ]; then
    printf '%s\n' "$ZDOTDIR/.zprofile"
  elif [ -n "${SHELL:-}" ]; then
    case "${SHELL##*/}" in
      zsh) printf '%s\n' "$HOME/.zprofile" ;;
      *) printf '%s\n' "$HOME/.profile" ;;
    esac
  elif [ -f "$HOME/.zprofile" ]; then
    printf '%s\n' "$HOME/.zprofile"
  else
    printf '%s\n' "$HOME/.profile"
  fi
}

path_block_present() {
  [ -f "$1" ] && grep -qxF "$PATH_BEGIN" "$1" 2>/dev/null
}

# "Already on PATH" has to recognise the three ways a person writes this
# directory: the expanded absolute path, "$HOME/.local/bin", and "~/.local/bin".
# Missing the latter two would append a second entry for a directory the user
# already registered, which is the duplication this check exists to prevent.
startup_file_has_bin_dir() {
  [ -f "$1" ] || return 1
  startup_expanded=$(sed -e "s|\$HOME|$HOME|g" -e "s|~|$HOME|g" "$1" 2> /dev/null) || return 1
  case "$startup_expanded" in
    *"$BIN_DIR"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Append the marked block once. PATH_BLOCK_RESULT reports which of the three
# outcomes happened and is read by install.sh.
# shellcheck disable=SC2034
ensure_path_block() {
  STARTUP_FILE=$(login_startup_file)
  assert_safe_path "$STARTUP_FILE" "$STARTUP_FILE"
  mkdir -p "$(dirname "$STARTUP_FILE")"
  if path_block_present "$STARTUP_FILE"; then
    # Already registered. Re-report only; rewriting a correct block would churn
    # a file the user also edits.
    PATH_BLOCK_RESULT=already-present
    return 0
  fi
  if startup_file_has_bin_dir "$STARTUP_FILE"; then
    # The user already put this directory on PATH by hand. A managed block
    # would duplicate the entry, so record the decision and change nothing.
    PATH_BLOCK_RESULT=already-on-path
    return 0
  fi
  # A file whose last line has no terminator would swallow the block's first
  # marker; end the line instead of inserting a separator install must later
  # try to remove.
  if [ -s "$STARTUP_FILE" ] && [ -n "$(tail -c 1 "$STARTUP_FILE")" ]; then
    printf '\n' >> "$STARTUP_FILE"
  fi
  {
    printf '%s\n' "$PATH_BEGIN" \
      '# Managed by the agent-bot Linux bundle install. uninstall.sh removes this block.'
    # The case body is PATH-block text that the login shell expands later.
    # shellcheck disable=SC2016
    printf '%s\n' 'case ":$PATH:" in' \
      "  *\":$BIN_DIR:\"*) ;;" \
      "  *) PATH=\"$BIN_DIR:\$PATH\" ;;" \
      'esac' \
      'export PATH' \
      "$PATH_END"
  } >> "$STARTUP_FILE"
  PATH_BLOCK_RESULT=added
}

# Remove exactly the marked block: every line from the opening marker to the
# closing marker, and no other line in the file. An explicit file argument wins
# over the shell heuristic, so a recorded startup file is the one that is edited.
remove_path_block() {
  STARTUP_FILE=${1:-$(login_startup_file)}
  path_block_present "$STARTUP_FILE" || return 0
  TMP_FILE="$STARTUP_FILE.agent-bot.$$"
  awk -v begin="$PATH_BEGIN" -v end="$PATH_END" '
    $0 == begin { inblock = 1; next }
    $0 == end { inblock = 0; next }
    inblock { next }
    { print }
  ' "$STARTUP_FILE" > "$TMP_FILE"
  cat "$TMP_FILE" > "$STARTUP_FILE"
  rm -f "$TMP_FILE"
}

# ADR-0332 decision 2: one broker and one daemon per OS user, from one install.
# The unit names are fixed, so a running pair from another install either owns a
# unit file this install would overwrite, or is a process with no unit at all (a
# Homebrew launchd agent, a container start command, a hand-run foreground
# daemon).
#
# Findings are one line each: `<kind> <unit-or-pid> <evidence>`. They are built
# without pipes feeding loops, so the counters stay in this shell.
detect_foreign_pair() {
  FOREIGN_COUNT=0
  FOREIGN_FINDINGS=''
  SCRATCH="${TMPDIR:-/tmp}/agent-bot-bundle-probe.$$"
  mkdir -p "$SCRATCH"

  # Our own prefix already holds a bundle: whatever pair is running belongs to
  # that install, and re-running install refreshes it rather than migrating.
  if [ -e "$INSTALL_STAMP" ]; then
    rm -rf "$SCRATCH"
    return 0
  fi

  add_finding() {
    FOREIGN_COUNT=$((FOREIGN_COUNT + 1))
    FOREIGN_FINDINGS="$FOREIGN_FINDINGS$1
"
  }

  for probe_unit in "$DAEMON_UNIT" "$BROKER_UNIT"; do
    if [ -e "$SYSTEMD_USER_DIR/$probe_unit" ]; then
      add_finding "unit $probe_unit $SYSTEMD_USER_DIR/$probe_unit"
    fi
    case "$(run_systemctl_capture --user is-active "$probe_unit")" in
      active|activating) add_finding "unit $probe_unit systemctl --user is-active" ;;
    esac
  done

  if command -v "$(ps_cmd)" > /dev/null 2>&1; then
    "$(ps_cmd)" -eo pid=,args= > "$SCRATCH/ps" 2>/dev/null || : > "$SCRATCH/ps"
    grep -E 'daemon run|agent-comms[^ ]*[ /]broker|agent-comms-broker' "$SCRATCH/ps" \
      > "$SCRATCH/matches" 2>/dev/null || : > "$SCRATCH/matches"
    # Drop this probe's own grep and anything inside this install's prefix.
    grep -vF "$SCRATCH" "$SCRATCH/matches" 2>/dev/null | grep -vF "$PREFIX/" > "$SCRATCH/foreign" \
      2>/dev/null || : > "$SCRATCH/foreign"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      add_finding "process ${line%% *} ${line#* }"
    done < "$SCRATCH/foreign"
  fi

  rm -rf "$SCRATCH"
}

# Put a migrated pair back exactly as it was, after a failure.
restore_migrated_pair() {
  [ -n "${MIGRATED_UNITS:-}" ] || return 0
  # MIGRATED_UNITS is newline separated and read back through `read`: zsh does
  # not word-split an unquoted expansion, so a `for x in $LIST` loop would see
  # the whole list as one word there. Names are prefixed too: this runs from
  # inside install.sh's own unit loop, and a plain `unit` would overwrite that
  # loop variable and make the caller's error name the wrong service.
  printf '%s' "$MIGRATED_UNITS" | while IFS= read -r restored_unit; do
    [ -n "$restored_unit" ] || continue
    if [ -e "$PREFIX/$restored_unit.migrated" ]; then
      cp "$PREFIX/$restored_unit.migrated" "$SYSTEMD_USER_DIR/$restored_unit"
    fi
    run_systemctl --user enable --now "$restored_unit"
  done
  say "rolled back: the other install's services are running again"
}

# Take the pair over from another install: stop and disable what it owns, and
# preserve its unit files so a later failure can restore them verbatim.
# Newline separated, so restore_migrated_pair can read it back one unit at a
# time in every shell rather than relying on word splitting.
migrate_foreign_pair() {
  MIGRATED_UNITS=''
  mkdir -p "$SYSTEMD_USER_DIR" "$PREFIX"
  for migrating_unit in "$DAEMON_UNIT" "$BROKER_UNIT"; do
    enabled=$(run_systemctl_capture --user is-enabled "$migrating_unit")
    active=$(run_systemctl_capture --user is-active "$migrating_unit")
    if [ "$enabled" != disabled ] || [ "$active" != inactive ]; then
      run_systemctl --user stop "$migrating_unit"
      run_systemctl --user disable "$migrating_unit"
      MIGRATED_UNITS="$MIGRATED_UNITS$migrating_unit
"
    fi
    if [ -e "$SYSTEMD_USER_DIR/$migrating_unit" ]; then
      cp "$SYSTEMD_USER_DIR/$migrating_unit" "$PREFIX/$migrating_unit.migrated"
      rm -f "$SYSTEMD_USER_DIR/$migrating_unit"
      MIGRATED_UNITS="$MIGRATED_UNITS$migrating_unit
"
    fi
  done
  say "migrating from the other install: its broker and daemon are stopped"
}
