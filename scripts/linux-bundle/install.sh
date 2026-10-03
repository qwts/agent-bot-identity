#!/bin/sh
# Install the agent-bot Linux bundle for one OS user (ADR-0332 decisions 1
# and 2). No root, ever: everything lands under $HOME.
#
#   1. unpack the archive into one user directory
#   2. write marked wrappers into ~/.local/bin
#   3. add ~/.local/bin to a login shell's PATH the way GeniusBar #41 does
#   4. write and start one systemd --user daemon and one broker, refusing to
#      start a second pair beside another install's unless --migrate is given
#
# Usage:
#   ./install.sh [--prefix DIR] [--bin-dir DIR] [--replace] [--migrate]
#                [--no-services] [--help]
#
# Environment overrides, for tests and for unusual layouts:
#   HOME                     the user home everything resolves from
#   AGENT_BUNDLE_PREFIX      install directory
#   AGENT_BUNDLE_BIN_DIR     wrapper directory
#   AGENT_BUNDLE_SOURCE      the unpacked ./bundle directory to copy from
#   AGENT_BOT_SYSTEMCTL      systemctl path (a fake, in tests)
#   AGENT_BOT_PS             ps path (a fake, in tests)
#
# Souls are never touched: nothing here reads, moves or deletes
# ~/.agent-bot/souls or $AGENT_BOT_SOULS_HOME.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'USAGE'
install.sh — install the agent-bot Linux bundle for one OS user (no root)

  ./install.sh [--prefix DIR] [--bin-dir DIR] [--replace] [--migrate]
               [--no-services] [--help]

  --prefix DIR     install directory (default: ${XDG_DATA_HOME:-$HOME/.local/share}/agent-bot)
  --bin-dir DIR    wrapper directory (default: $HOME/.local/bin)
  --replace        preserve a foreign file at a wrapper path as <name>.before-agent-bot
  --migrate        take the pair over from another install's broker and daemon
  --no-services    install the tree and the wrappers, write no systemd --user units

Never deletes souls: ~/.agent-bot/souls and $AGENT_BOT_SOULS_HOME are not read,
moved or removed. Remove this install with ./uninstall.sh.
USAGE
}

NO_SERVICES=0

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
    --replace)
      REPLACE_FOREIGN=1
      shift
      ;;
    --migrate)
      MIGRATE=1
      shift
      ;;
    --no-services)
      NO_SERVICES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

[ -n "${HOME:-}" ] || die "HOME is not set; this installer never runs as root"

resolve_prefix
bundle_paths
assert_safe_path --prefix "$PREFIX"
assert_safe_path --bin-dir "$BIN_DIR"

# ---------------------------------------------------------------- the archive
# The archive unpacks to ./bundle, so the installer copies that directory into
# place instead of assuming it was run from inside the unpacked archive.
if [ -n "${AGENT_BUNDLE_SOURCE:-}" ]; then
  SOURCE_ROOT=$AGENT_BUNDLE_SOURCE
elif [ -d "$PWD/bundle" ]; then
  SOURCE_ROOT=$PWD/bundle
else
  SOURCE_ROOT=$SCRIPT_DIR/bundle
fi
[ -d "$SOURCE_ROOT" ] || die "no bundle at $SOURCE_ROOT; unpack the archive and run ./install.sh from its top directory"

for required in "$SOURCE_ROOT/node/bin/node" "$SOURCE_ROOT/bin/agent-bot" "$SOURCE_ROOT/bin/agent-comms" "$SOURCE_ROOT/lib/agent-comms/bin/agent-comms.mjs"; do
  [ -f "$required" ] || die "the archive is incomplete: $required is missing"
done

# --------------------------------------------------- decision 2: one pair only
# Detection runs before anything is written, so a refusal leaves the other
# install's pair and every file on the machine exactly as they were.
detect_foreign_pair
if [ "$FOREIGN_COUNT" -gt 0 ]; then
  say "another install already runs a broker and a daemon for this user:"
  printf '%s' "$FOREIGN_FINDINGS" | while IFS= read -r finding; do
    [ -n "$finding" ] && say "  $finding"
  done
  if [ "$MIGRATE" != 1 ]; then
    die "cancelled: nothing was changed and no pair was started. Re-run with --migrate to take the pair over from that install, or remove that install first"
  fi
fi

# ------------------------------------------------------------------- install
mkdir -p "$PREFIX"
if [ "$FOREIGN_COUNT" -gt 0 ]; then
  migrate_foreign_pair
fi

# Copy beside the live tree and swap, so a failed copy leaves the running pair
# on the previous bundle rather than a half-written one.
STAGE="$PREFIX/.bundle.new"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -cf - -C "$SOURCE_ROOT" . | tar -xf - -C "$STAGE"
chmod 0755 "$STAGE/node/bin/node" "$STAGE/bin/agent-bot" "$STAGE/bin/agent-comms"
rm -rf "$BUNDLE_ROOT"
mv "$STAGE" "$BUNDLE_ROOT"
touch "$INSTALL_STAMP"
say "bundle installed in $BUNDLE_ROOT"

# ------------------------------------------------------------------ wrappers
# A refused foreign file aborts here, before any service is started, so the
# previous install's pair keeps running untouched.
#
# WRAPPER_NAMES is read through a here-doc, not `for name in $WRAPPER_NAMES`:
# zsh does not word-split an unquoted expansion, so that loop would see all three
# names as one word and write a single wrapper named after the list.
while IFS= read -r name; do
  [ -n "$name" ] || continue
  case "$name" in
    agent-bot) entry_target=$BUNDLE_AGENT_BOT ;;
    agent-comms) entry_target=$BUNDLE_COMMS ;;
    node) entry_target=$BUNDLE_NODE ;;
    *) die "no bundled binary for wrapper $name" ;;
  esac
  write_wrapper "$name" "$entry_target" > /dev/null
  say "wrapper -> $BIN_DIR/$name"
done <<WRAPPERS
$WRAPPER_NAMES
WRAPPERS

# ---------------------------------------------------------------------- PATH
ensure_path_block
case "$PATH_BLOCK_RESULT" in
  added) say "PATH block added to $STARTUP_FILE" ;;
  already-present) say "$STARTUP_FILE already carries the agent-bot PATH block" ;;
  already-on-path) say "$STARTUP_FILE already puts $BIN_DIR on PATH; left it alone" ;;
esac

# ------------------------------------------------------------------ services
if [ "$NO_SERVICES" = 1 ]; then
  say "skipped the systemd --user units (--no-services)"
else
  mkdir -p "$SYSTEMD_USER_DIR"
  for template_unit in "$DAEMON_UNIT" "$BROKER_UNIT"; do
    template="$SCRIPT_DIR/systemd/$template_unit.in"
    [ -f "$template" ] || die "the archive is incomplete: $template is missing"
    sed \
      -e "s|@AGENT_BOT_NODE@|$BUNDLE_NODE|g" \
      -e "s|@AGENT_BOT_ENTRY@|$BUNDLE_ROOT/lib/agent-bot/agent-bot.mjs|g" \
      -e "s|@AGENT_BOT_COMMS_ENTRY@|$BUNDLE_COMMS_ENTRY|g" \
      -e "s|@AGENT_BOT_BIN@|$BUNDLE_BIN|g" \
      -e "s|@AGENT_BOT_BUNDLE_ROOT@|$BUNDLE_ROOT|g" \
      -e "s|@AGENT_BOT_TOOL_PATH@|$BUNDLE_BIN|g" \
      "$template" > "$SYSTEMD_USER_DIR/$template_unit"
  done
  run_systemctl --user daemon-reload
  for started_unit in "$DAEMON_UNIT" "$BROKER_UNIT"; do
    if ! try_systemctl --user enable --now "$started_unit"; then
      # The previous pair is this install's to restore, and this install's own
      # unit must not be left enabled behind a run that failed.
      restore_migrated_pair
      run_systemctl --user disable --now "$started_unit"
      die "could not start $started_unit; the bundle is installed but its services are not"
    fi
    say "service -> $SYSTEMD_USER_DIR/$started_unit"
  done
fi

# ------------------------------------------------------------------ manifest
# uninstall.sh reads this to find what this install wrote, so the wrappers, the
# units and the install directory cannot drift apart. One record per line: a list
# on a single line would have to be word-split to read back, and zsh does not
# word-split an unquoted expansion.
{
  printf '%s\n' '# Written by the agent-bot Linux bundle install. uninstall.sh reads it.'
  printf 'prefix=%s\n' "$PREFIX"
  printf 'bin_dir=%s\n' "$BIN_DIR"
  printf 'startup_file=%s\n' "$STARTUP_FILE"
  if [ "$NO_SERVICES" = 1 ]; then
    printf 'services=none\n'
  else
    printf 'service=%s\n' "$DAEMON_UNIT"
    printf 'service=%s\n' "$BROKER_UNIT"
  fi
} > "$BUNDLE_MANIFEST"

say ""
say "agent-bot is installed. Open a new login shell, or run:"
say "  . $STARTUP_FILE"
say ""
say "Next: agent-bot bootstrap --profile <organization-profile.json> --with-gh-shim --machine-only"
say "Souls under ~/.agent-bot/souls were not touched, and uninstall.sh never deletes them."
