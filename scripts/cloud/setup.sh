#!/bin/sh
# Set up agent-bot on a fresh, short-lived Linux host: a Claude Code cloud
# environment's setup script, a CI runner, a throwaway VM. Safe to run again.
#
#   sh scripts/cloud/setup.sh [--version vX.Y.Z | --from-checkout DIR]
#                             [--profile PATH|https-URL] [--no-hooks]
#
# 1. Install the Linux CLI bundle for this user, with no root: the given
#    release, the latest release by default (both checked against the
#    release's SHA256SUMS), or a bundle built from a source checkout
#    (--from-checkout) for a change that is not released yet.
# 2. Apply the organization profile when one is given (agent-bot bootstrap
#    --machine-only, github-identity on). Before the device is enrolled only
#    the per-App credential checks may fail, and the gh shim waits for them;
#    any other failed readiness check fails this script.
# 3. Register `agent-bot cloud up` and `cloud down` as the Claude Code
#    SessionStart and SessionEnd hooks. They start the daemon and enroll the
#    device when a session starts, and unenroll it when the session ends.
#
# Reads and writes no secret. AGENT_BOT_SERVER is not set here: set it as an
# environment variable of the environment, where the hooks read it.
#
# AGENT_BOT_SETUP_DIST names a directory holding an archive and its
# SHA256SUMS to install instead of downloading or building one (tests).
set -eu

REPO=${AGENT_BOT_REPO:-true-line/agent-bot-identity}
VERSION=''
CHECKOUT=''
PROFILE=''
HOOKS=1

say() { printf 'agent-bot cloud setup: %s\n' "$*"; }
die() { printf 'agent-bot cloud setup: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a release tag"; VERSION=$2; shift 2 ;;
    --from-checkout) [ $# -ge 2 ] || die "--from-checkout needs a directory"; CHECKOUT=$2; shift 2 ;;
    --profile) [ $# -ge 2 ] || die "--profile needs a path or an https URL"; PROFILE=$2; shift 2 ;;
    --no-hooks) HOOKS=0; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -z "$VERSION" ] || [ -z "$CHECKOUT" ] || die "--version and --from-checkout cannot be combined"
[ -n "${HOME:-}" ] || die "HOME is not set"

case "$(uname -m)" in
  x86_64|amd64) PLATFORM=linux-x64 ;;
  aarch64|arm64) PLATFORM=linux-arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# ------------------------------------------------------------ the archive
if [ -n "${AGENT_BOT_SETUP_DIST:-}" ]; then
  DIST=$AGENT_BOT_SETUP_DIST
elif [ -n "$CHECKOUT" ]; then
  CHECKOUT=$(CDPATH='' cd -- "$CHECKOUT" 2>/dev/null && pwd) || die "no directory at $CHECKOUT"
  [ -f "$CHECKOUT/scripts/linux-bundle/build.mjs" ] || die "$CHECKOUT is not an agent-bot-identity checkout"
  command -v node >/dev/null 2>&1 || die "building from a checkout needs node on PATH"
  say "building the $PLATFORM bundle from $CHECKOUT at $(git -C "$CHECKOUT" rev-parse --short HEAD 2>/dev/null || echo 'an unknown commit')"
  DIST=$WORK/dist
  node "$CHECKOUT/scripts/linux-bundle/build.mjs" --platform "$PLATFORM" --out "$DIST" > "$WORK/build.log" 2>&1 \
    || { cat "$WORK/build.log" >&2; die "the bundle build failed"; }
else
  if [ -z "$VERSION" ]; then
    VERSION=$(curl -fsSI "https://github.com/$REPO/releases/latest" | tr -d '\r' | sed -n 's|^[Ll]ocation: .*/releases/tag/||p' | tail -n 1)
    [ -n "$VERSION" ] || die "could not resolve the latest release of $REPO"
  fi
  case "$VERSION" in v*) ;; *) VERSION=v$VERSION ;; esac
  say "downloading $VERSION for $PLATFORM"
  DIST=$WORK/dist
  mkdir -p "$DIST"
  base=https://github.com/$REPO/releases/download/$VERSION
  curl -fsSL -o "$DIST/SHA256SUMS" "$base/SHA256SUMS" || die "no SHA256SUMS for $VERSION"
  curl -fsSL -o "$DIST/agent-bot-$PLATFORM-$VERSION.tar.gz" "$base/agent-bot-$PLATFORM-$VERSION.tar.gz" \
    || die "no $PLATFORM archive for $VERSION"
fi

ARCHIVE=''
for candidate in "$DIST"/agent-bot-"$PLATFORM"-v*.tar.gz; do
  [ -f "$candidate" ] && ARCHIVE=$candidate
done
[ -n "$ARCHIVE" ] || die "no agent-bot-$PLATFORM archive in $DIST"
NAME=$(basename "$ARCHIVE")
[ -f "$DIST/SHA256SUMS" ] || die "no SHA256SUMS beside $NAME"
( cd "$DIST" && grep " $NAME\$" SHA256SUMS | sha256sum --check --strict > /dev/null 2>&1 ) \
  || die "$NAME does not match its SHA256SUMS entry"

# ---------------------------------------------------------------- install
mkdir "$WORK/unpacked"
tar -xzf "$ARCHIVE" -C "$WORK/unpacked"
( cd "$WORK/unpacked" && sh ./install.sh --no-services > "$WORK/install.log" 2>&1 ) \
  || { cat "$WORK/install.log" >&2; die "install.sh failed"; }
BIN=$HOME/.local/bin/agent-bot
[ -x "$BIN" ] || die "install.sh left no $BIN"
say "installed $NAME ($("$BIN" --version 2>/dev/null || echo 'version unknown'))"

# ---------------------------------------------------------------- profile
# Readiness, check by check. Before the device is enrolled (at session start)
# two things are expected to fail and nothing else may: each App's credential
# check, with a "not enrolled yet" code, and the gh shim, which bootstrap
# installs only once credentials are ready so gh is never fail-closed with
# nothing behind it (`agent-bot cloud up` installs it after enrolling).
READINESS='
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const checks = r.machine?.checks ?? [];
const status = (id) => checks.find((c) => c.id === id)?.status;
const problems = [];
for (const id of ["config.profile", "config.feature_gates"]) {
  if (status(id) !== "ready") problems.push(`${id} is ${status(id) ?? "missing"}`);
}
for (const c of checks) {
  if (c.status === "failed" && !(c.id === "shim.gh" && c.code === "gh-shim-missing")) problems.push(`${c.id}: ${c.code ?? ""} ${c.message ?? ""}`);
}
const pending = new Set(["provider-unavailable", "server-device-not-enrolled", "server-harness-not-enrolled"]);
for (const app of r.machine?.apps ?? []) {
  for (const c of [app.credential, app.live_mint]) {
    if (c?.status === "failed" && !pending.has(c.code)) problems.push(`${app.slug} ${c.id}: ${c.code ?? ""} ${c.message ?? ""}`);
  }
}
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(r.ready ? "ready" : "pending");
'
if [ -n "$PROFILE" ]; then
  case "$PROFILE" in
    https://*) curl -fsSL -o "$WORK/profile.json" "$PROFILE" || die "could not fetch the profile at $PROFILE"; PROFILE_FILE=$WORK/profile.json ;;
    http://*) die "the profile URL must be https" ;;
    *) [ -f "$PROFILE" ] || die "no profile at $PROFILE"; PROFILE_FILE=$PROFILE ;;
  esac
  # No systemd user session here: the unit is written but not loaded, and
  # `agent-bot cloud up` starts the daemon when a session starts.
  AGENT_BOT_SUPERVISOR_SKIP_LOAD=1 "$BIN" bootstrap --profile "$PROFILE_FILE" --features github-identity --with-gh-shim \
    --machine-only --json > "$WORK/bootstrap.json" 2> "$WORK/bootstrap.err" || true
  verdict=$("$HOME/.local/bin/node" -e "$READINESS" "$WORK/bootstrap.json" 2> "$WORK/readiness.err") || verdict=failed
  if [ "$verdict" = ready ] || [ "$verdict" = pending ]; then
    if [ "$verdict" = ready ]; then
      say "applied the organization profile; machine readiness passes"
    else
      say "applied the organization profile with github-identity on; credentials and the gh shim follow enrollment at session start"
    fi
  else
    cat "$WORK/readiness.err" "$WORK/bootstrap.err" >&2
    die "bootstrap failed beyond the credential checks that wait for enrollment"
  fi
fi

# ------------------------------------------------------------------ hooks
if [ "$HOOKS" = 1 ]; then
  "$BIN" cloud --help > /dev/null 2>&1 \
    || die "this agent-bot has no \`cloud\` command; install a newer --version, or build one with --from-checkout"
  "$BIN" cloud install-hooks
fi

say "done. Set AGENT_BOT_SERVER on the environment: each session then runs \`agent-bot cloud up\` when it starts."
