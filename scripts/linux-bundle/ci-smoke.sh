#!/bin/sh
# Smoke test every archive in a build directory: unpack it, install it for a
# throwaway user with a fake systemctl, check what install.sh wrote, uninstall
# it, and check what it left behind.
#
# The real user manager is never involved and no real HOME is touched:
# AGENT_BOT_SYSTEMCTL and AGENT_BOT_PS are fakes and HOME is a temp directory.
# That is what makes this safe to run on a shared CI runner, and what makes it
# the same check locally.
#
# Usage: sh scripts/linux-bundle/ci-smoke.sh [DIST_DIR]
set -eu

DIST=${1:-dist}
[ -d "$DIST" ] || { echo "no build directory at $DIST" >&2; exit 1; }
# Absolute before the loop: run_for installs into a throwaway box and changes
# directory, so a relative path stops matching the remaining archives and the
# loop skips them instead of testing them.
DIST=$(CDPATH='' cd -- "$DIST" && pwd)

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
BUNDLE_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR" && pwd)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

write_fakes() {
  fake_root=$1
  home=$2
  log=$home/systemctl.log
  mkdir -p "$fake_root" "$home"
  cat > "$fake_root/systemctl" <<SYSTEMCTL
#!/bin/sh
# A systemctl that records what it was asked and reports a quiet machine.
printf '%s\n' "systemctl \$*" >> "$log"
case "\$*" in
  *is-active*) printf '%s\n' inactive ;;
  *is-enabled*) printf '%s\n' disabled ;;
esac
exit 0
SYSTEMCTL
  printf '#!/bin/sh\nexit 0\n' > "$fake_root/ps"
  chmod +x "$fake_root/systemctl" "$fake_root/ps"
}

fail() {
  echo "linux-bundle smoke: $*" >&2
  exit 1
}

# The Node naming scheme and uname's do not agree on the architecture.
host_platform() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    *) os=$(uname -s | tr '[:upper:]' '[:lower:]') ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) arch=$(uname -m) ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

# $1: the target platform the archive claims, used only to decide whether the
# bundled Node can actually be executed on this machine.
run_for() {
  platform=$1
  archive=$2
  box="$WORK/$platform"
  mkdir -p "$box"
  tar -xzf "$archive" -C "$box"
  home="$box/home"
  write_fakes "$box/fakes" "$home"
  printf 'export EXISTING=1\n' > "$home/.profile"
  # A soul the install and the uninstall both must leave alone.
  mkdir -p "$home/.agent-bot/souls/Test.soul"
  printf '{"schema_version":1}\n' > "$home/.agent-bot/souls/Test.soul/soul.json"

  # A foreign file at one wrapper path, which --replace must preserve and
  # uninstall must put back.
  mkdir -p "$home/.local/bin"
  printf '#!/bin/sh\necho "a foreign agent-comms"\n' > "$home/.local/bin/agent-comms"

  cd "$box"
  run_install() {
    HOME="$home" SHELL=/bin/bash \
      AGENT_BOT_SYSTEMCTL="$box/fakes/systemctl" AGENT_BOT_PS="$box/fakes/ps" \
      sh ./install.sh "$@" > "$box/install.log" 2>&1
  }
  run_uninstall() {
    HOME="$home" SHELL=/bin/bash \
      AGENT_BOT_SYSTEMCTL="$box/fakes/systemctl" AGENT_BOT_PS="$box/fakes/ps" \
      sh ./uninstall.sh > "$box/uninstall.log" 2>&1
  }

  # A foreign file at a wrapper path must stop the first run, and it must stop
  # it before anything is started. --replace then carries the install through.
  if run_install; then
    cat "$box/install.log" >&2
    fail "$platform: install.sh replaced a foreign wrapper without --replace"
  fi
  grep -q 'not an agent-bot bundle wrapper' "$box/install.log" \
    || { cat "$box/install.log" >&2; fail "$platform: install.sh failed for the wrong reason"; }
  # A refused run starts nothing and touches nothing.
  if grep -q 'enable --now' "$home/systemctl.log" 2> /dev/null; then
    fail "$platform: the refused run started a pair anyway"
  fi
  foreign_body=$(cat "$home/.local/bin/agent-comms")
  [ "$foreign_body" = '#!/bin/sh
echo "a foreign agent-comms"' ] || fail "$platform: the refused run touched the foreign file"

  run_install --replace || { cat "$box/install.log" >&2; fail "$platform: install.sh --replace failed"; }

  # The wrappers carry the GeniusBar marker and reach the bundled runtime.
  for name in agent-bot agent-comms node; do
    wrapper="$home/.local/bin/$name"
    [ -x "$wrapper" ] || fail "$platform: no $name wrapper"
    grep -qxF '# agent-bot-linux-cli-tool' "$wrapper" || fail "$platform: $name wrapper has no marker"
  done
  # One PATH block, and the user's own line is still there.
  [ "$(grep -cF '# >>> agent-bot PATH >>>' "$home/.profile")" = 1 ] || fail "$platform: PATH block is not there exactly once"
  grep -qxF 'export EXISTING=1' "$home/.profile" || fail "$platform: the startup file lost the user's line"
  # Both halves of the pair, started once each.
  unit="$home/.config/systemd/user/agent-bot-daemon.service"
  [ -f "$unit" ] || fail "$platform: no daemon unit"
  grep -q '/bundle/node/bin/node .*daemon run' "$unit" || fail "$platform: the daemon unit does not exec the bundled runtime"
  broker="$home/.config/systemd/user/agent-comms-broker.service"
  [ -f "$broker" ] || fail "$platform: no broker unit"
  # The command agent-comms' own service installer builds (service-startup.mjs,
  # single-account mode), run on the bundled Node from the pinned entry.
  grep -q '/bundle/lib/agent-comms/bin/agent-comms\.mjs broker run --single-account' "$broker" \
    || fail "$platform: the broker unit does not start agent-comms the way its own installer does"
  grep -qxF 'systemctl --user enable --now agent-comms-broker.service' "$home/systemctl.log" \
    || fail "$platform: the broker was never started"
  # The foreign file was preserved, not overwritten.
  preserved=$(cat "$home/.local/bin/agent-comms.before-agent-bot")
  [ "$preserved" = '#!/bin/sh
echo "a foreign agent-comms"' ] || fail "$platform: --replace did not preserve the foreign file"

  # On a machine that can run this platform's binaries, prove the wrapper really
  # reaches the bundled agent-bot rather than something already on PATH.
  if [ "$platform" = "$(host_platform)" ]; then
    "$home/.local/bin/agent-bot" --version > "$box/version.log" 2>&1 \
      || fail "$platform: the installed wrapper could not run agent-bot"
  fi

  run_uninstall || { cat "$box/uninstall.log" >&2; fail "$platform: uninstall.sh failed"; }

  [ ! -e "$home/.local/share/agent-bot" ] || fail "$platform: the install directory survived"
  [ ! -e "$home/.local/bin/agent-bot" ] || fail "$platform: a wrapper survived"
  [ ! -e "$home/.config/systemd/user/agent-bot-daemon.service" ] || fail "$platform: a unit file survived"
  restored=$(cat "$home/.local/bin/agent-comms")
  [ "$restored" = '#!/bin/sh
echo "a foreign agent-comms"' ] || fail "$platform: the foreign file was not restored"
  grep -qxF 'export EXISTING=1' "$home/.profile" || fail "$platform: the PATH block was not removed cleanly"
  [ -f "$home/.agent-bot/souls/Test.soul/soul.json" ] || fail "$platform: uninstall deleted a soul"

  echo "linux-bundle smoke: $platform ok"
  cd "$BUNDLE_ROOT"
}

found=0
for archive in "$DIST"/agent-bot-linux-*.tar.gz; do
  [ -f "$archive" ] || continue
  found=1
  name=$(basename "$archive")
  platform=${name#agent-bot-}
  platform=${platform%-v*.tar.gz}
  run_for "$platform" "$archive"
done

[ "$found" = 1 ] || { echo "no agent-bot-linux-*.tar.gz in $DIST" >&2; exit 1; }
