#!/bin/sh
# Remove the agent-bot Linux bundle for one OS user (ADR-0332 decisions 1
# and 2). No root, ever.
#
#   1. stop and disable the systemd --user units this install wrote, and delete
#      those unit files
#   2. delete the wrappers that carry the agent-bot marker, and restore any file
#      --replace preserved as <name>.before-agent-bot
#   3. remove exactly the marked PATH block
#   4. remove the install directory
#
# Souls are never touched: ~/.agent-bot/souls and $AGENT_BOT_SOULS_HOME are not
# read, moved or deleted, here or anywhere else in this bundle. An Agent Space
# under ~/.agent-space is not touched either. Only the three install paths
# agent-bot wrote are removed, which is what "removes cleanly" means.
#
# Usage:
#   ./uninstall.sh [--prefix DIR] [--bin-dir DIR] [--keep-tree] [--help]
#
# Environment overrides, for tests and for unusual layouts:
#   HOME                     the user home everything resolves from
#   AGENT_BUNDLE_PREFIX      install directory
#   AGENT_BUNDLE_BIN_DIR     wrapper directory
#   AGENT_BOT_SYSTEMCTL      systemctl path (a fake, in tests)
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'USAGE'
uninstall.sh — remove the agent-bot Linux bundle for one OS user (no root)

  ./uninstall.sh [--prefix DIR] [--bin-dir DIR] [--keep-tree] [--help]

  --prefix DIR     install directory (default: ${XDG_DATA_HOME:-$HOME/.local/share}/agent-bot)
  --bin-dir DIR    wrapper directory (default: $HOME/.local/bin)
  --keep-tree      remove the wrappers, units and PATH block but keep the bundle
                   tree, for a reinstall that reuses the extracted files

Never deletes souls: ~/.agent-bot/souls and $AGENT_BOT_SOULS_HOME are left
exactly as they were, and no Agent Space is touched.
USAGE
}

KEEP_TREE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      [ $# -ge 2 ] || die "--prefix requires a directory"
      AGENT_BUNDLE_PREFIX=$2
      shift 2
      ;;
    --prefix=*)
      AGENT_BUNDLE_PREFIX=${1#--prefix=}
      shift
      ;;
    --bin-dir)
      [ $# -ge 2 ] || die "--bin-dir requires a directory"
      AGENT_BUNDLE_BIN_DIR=$2
      shift 2
      ;;
    --bin-dir=*)
      AGENT_BUNDLE_BIN_DIR=${1#--bin-dir=}
      shift
      ;;
    --keep-tree)
      KEEP_TREE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

[ -n "${HOME:-}" ] || die "HOME is not set; this uninstaller never runs as root"

resolve_prefix
bundle_paths
assert_safe_path --prefix "$PREFIX"
assert_safe_path --bin-dir "$BIN_DIR"

# A recursive delete of a resolved default must never be able to reach a home
# directory or a root, whatever the environment said.
case "$PREFIX" in
  ''|/|/usr|/usr/local|/home|"$HOME") die "refusing to remove the install tree at $PREFIX" ;;
esac
[ "${PREFIX%/}" != "${HOME%/}" ] || die "the install directory resolved to $HOME"

# The manifest is the whole contract. Uninstall is defined only against an
# install that recorded what it wrote; without one, a unit file or a wrapper at
# these paths belongs to some other install (Homebrew, GeniusBar, a checkout) and
# removing it here would be reaching outside this install's own bookkeeping. So a
# directory with no manifest is reported and left alone, and a --prefix that
# names the wrong directory is a no-op rather than a guess.
if [ ! -f "$BUNDLE_MANIFEST" ]; then
  say "no agent-bot Linux bundle install is recorded at $PREFIX"
  say "nothing was changed. Point --prefix at the directory install.sh wrote, or run this script from the unpacked archive."
  exit 0
fi
UNITS=''
while IFS='=' read -r key value; do
  case "$key" in
    bin_dir) [ -n "$value" ] && BIN_DIR=$value ;;
    startup_file) [ -n "$value" ] && STARTUP_FILE=$value ;;
    service) UNITS="$UNITS$value
" ;;
  esac
done < "$BUNDLE_MANIFEST"

# ------------------------------------------------------------------ services
# Only the units the manifest claims, one per line. A unit file this install
# never wrote is another install's, and the same "one pair, never a second" rule
# install.sh enforces says leave it running.
printf '%s' "$UNITS" | while IFS= read -r unit; do
  [ -n "$unit" ] || continue
  if [ -e "$SYSTEMD_USER_DIR/$unit" ] || [ -L "$SYSTEMD_USER_DIR/$unit" ]; then
    run_systemctl --user disable --now "$unit"
    rm -f "$SYSTEMD_USER_DIR/$unit"
    say "service removed -> $SYSTEMD_USER_DIR/$unit"
  else
    # The manifest claims it but the file is gone. Ask anyway: an enabled unit
    # can outlive its file, and a leftover enabled unit would start a daemon
    # from a tree this script is about to delete.
    case "$(run_systemctl_capture --user is-enabled "$unit")" in
      enabled|linked|static|alias) run_systemctl --user disable --now "$unit" ;;
    esac
  fi
done
run_systemctl --user daemon-reload

# ------------------------------------------------------------------ wrappers
# A wrapper is ours only when it is a regular file carrying the marker. Anything
# else at those paths is another install's or the user's, and stays.
# Never name a local `path`: zsh treats the lowercase `path` array as PATH, so
# assigning it here would repoint this script's own PATH mid-uninstall. Every
# local in these scripts is prefixed for the same reason.
while IFS= read -r name; do
  [ -n "$name" ] || continue
  wrapper_path="$BIN_DIR/$name"
  wrapper_backup=$(backup_path "$wrapper_path")
  if wrapper_is_ours "$wrapper_path"; then
    rm -f "$wrapper_path"
    say "wrapper removed -> $wrapper_path"
  fi
  if [ -e "$wrapper_backup" ] || [ -L "$wrapper_backup" ]; then
    if [ -e "$wrapper_path" ] || [ -L "$wrapper_path" ]; then
      warn "$wrapper_path exists again; leaving $wrapper_backup in place instead of overwriting it"
    else
      mv "$wrapper_backup" "$wrapper_path"
      say "restored $wrapper_path"
    fi
  fi
done <<WRAPPERS
$WRAPPER_NAMES
WRAPPERS

# ---------------------------------------------------------------------- PATH
remove_path_block "$STARTUP_FILE"
say "PATH block removed from $STARTUP_FILE"

# --------------------------------------------------------------- install tree
if [ "$KEEP_TREE" = 1 ]; then
  say "kept the bundle tree at $BUNDLE_ROOT (--keep-tree)"
else
  if [ -d "$PREFIX" ]; then
    rm -rf "$PREFIX"
    say "install directory removed -> $PREFIX"
  else
    say "nothing to remove at $PREFIX"
  fi
fi

say ""
say "agent-bot and agent-comms are gone from PATH."
say "Souls under ~/.agent-bot/souls and every Agent Space were not touched."
