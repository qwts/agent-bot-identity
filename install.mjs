#!/usr/bin/env node

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensurePathLine, zshStartupDir } from './shell-path.mjs';
import { GIT_HOOK_NAMES } from './git-hooks.mjs';
import { ensureDaemonSupervisor } from './daemon-supervisor.mjs';
import { ensureSpacesCutover } from './spaces-cutover.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(ROOT, 'agent-bot');
const SOURCE_HOOKS = join(ROOT, 'hooks');

export function installationPaths(home = homedir()) {
  return {
    binDir: join(home, '.local', 'bin'),
    executable: join(home, '.local', 'bin', 'agent-bot'),
    agentHook: join(home, '.local', 'share', 'agent-bot', 'agent-hook'),
    hooksDir: join(home, '.local', 'share', 'agent-bot', 'hooks'),
  };
}

function optionalLstat(path, lstat = lstatSync) {
  try {
    return lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const HOMEBREW_AGENT_BOT = /(?:^|\/)(?:Cellar\/agent-bot\/[^/]+|opt\/agent-bot)\/(?:bin|libexec)\/agent-bot(?:\.mjs)?$/;

export function isHomebrewAgentBotPath(path) {
  return HOMEBREW_AGENT_BOT.test(String(path).replaceAll('\\', '/'));
}

// Brew kegs are versioned. The managed ~/.local/bin symlink must point at
// <prefix>/opt/agent-bot/bin/agent-bot so `brew upgrade` + cleanup cannot
// leave hooks pinned to a deleted Cellar path.
export function homebrewStableEntrypoint(entrypoint, exists = existsSync) {
  const normalized = resolve(entrypoint).replaceAll('\\', '/');
  const match = normalized.match(/^(.*)\/Cellar\/agent-bot\/[^/]+\/libexec\/agent-bot$/);
  if (!match) return null;
  const stable = join(match[1], 'opt', 'agent-bot', 'bin', 'agent-bot');
  return exists(stable) ? stable : null;
}

export function managedEntrypoint(entrypoint, exists = existsSync) {
  return homebrewStableEntrypoint(entrypoint, exists) ?? resolve(entrypoint);
}

export function isManagedExecutable(path, stat, entrypoint, readlink = readlinkSync) {
  if (!stat?.isSymbolicLink()) return false;
  const linked = readlink(path);
  const target = resolve(dirname(path), linked);
  const current = resolve(entrypoint);
  // `agent-bot.mjs` is the pre-launcher install target. Continue recognizing
  // it so `agent-bot update` can migrate an existing installation in place.
  if (target === current || target === join(dirname(current), 'agent-bot.mjs')) return true;
  // A previous Homebrew keg or the stable opt wrapper is ours to replace
  // when this install is also a Homebrew tree. A checkout must still refuse
  // a foreign same-basename symlink.
  if (
    isHomebrewAgentBotPath(linked)
    || isHomebrewAgentBotPath(target)
  ) {
    return isHomebrewAgentBotPath(current);
  }
  return false;
}

export function installExecutable({
  home = homedir(),
  entrypoint = ENTRYPOINT,
  mkdir = mkdirSync,
  lstat = lstatSync,
  readlink = readlinkSync,
  remove = rmSync,
  symlink = symlinkSync,
  chmod = chmodSync,
  exists = existsSync,
} = {}) {
  const paths = installationPaths(home);
  const desired = managedEntrypoint(entrypoint, exists);
  mkdir(paths.binDir, { recursive: true });
  chmod(entrypoint, 0o755);
  const stat = optionalLstat(paths.executable, lstat);
  if (stat) {
    if (!isManagedExecutable(paths.executable, stat, entrypoint, readlink)) {
      throw new Error(`${paths.executable} exists and is not an agent-bot symlink`);
    }
    const linked = readlink(paths.executable);
    const current = resolve(dirname(paths.executable), linked);
    if (linked === desired || current === resolve(desired)) return paths.executable;
    remove(paths.executable, { force: true });
  }
  symlink(desired, paths.executable);
  return paths.executable;
}

// Two registrations, because they answer different questions.
//
// .zshenv is read by EVERY zsh, including the non-login non-interactive shells
// a harness spawns for its startup scripts. Without it `command -v agent-bot`
// fails there and the runtime looks uninstalled while its symlink is present —
// hooks that fail closed abort, and hooks that fail open vanish silently.
//
// .zprofile is login-only, but it is appended after Homebrew's shellenv, so it
// is what puts our directory *first* for an interactive session. Dropping it
// would reintroduce the ordering bug; dropping .zshenv leaves every harness
// blind. Both, or neither works.
export function ensureExecutablePath({
  home = homedir(),
  env = process.env,
  read = readFileSync,
  append = appendFileSync,
} = {}) {
  const dir = zshStartupDir(home, env);
  // Distinct from install-gh-shim's `.config/agent-bot/bin` marker, which is a
  // loose substring the .zprofile line below also contains.
  const zshenv = ensurePathLine({
    dir,
    filename: '.zshenv',
    line: 'export PATH="$HOME/.local/bin:$PATH"  # agent-bot CLI',
    marker: '# agent-bot CLI',
    read,
    append,
  });
  const marker = '# agent-bot installed commands';
  const zprofile = ensurePathLine({
    dir,
    filename: '.zprofile',
    line: `export PATH="$HOME/.config/agent-bot/bin:$HOME/.local/bin:$PATH"  ${marker}`,
    marker,
    read,
    append,
  });
  // `updated` answers "did this run change anything", which is what the caller
  // prints. Reporting only .zprofile made an upgrade from the old .zprofile-only
  // install look like a no-op while .zshenv was quietly written.
  return {
    path: zprofile.path,
    updated: zshenv.updated || zprofile.updated,
    zshenv,
    zprofile,
  };
}

function hookWrapper(name) {
  return `#!/bin/sh\n# Managed by agent-bot install.\nexec "\${HOME}/.local/bin/agent-bot" hook ${name} "$@"\n`;
}

export function agentHookFastPath() {
  return `#!/bin/sh
# Managed by agent-bot install. Avoid Node when this repo has no hook for the
# requested event; generated harness adapters call this path unconditionally.
EVENT=""
DIALECT=""
PREV=""
for ARG in "$@"; do
  case "$PREV" in
    --dialect) DIALECT=$ARG ;;
    --event) EVENT=$ARG ;;
  esac
  PREV=$ARG
done
allow() {
  # Cursor rejects empty stdout when failClosed is enabled. An empty JSON
  # object is its neutral response and leaves the normal permission path intact.
  [ "$DIALECT" = "cursor" ] && printf '%s' '{}'
  exit 0
}
[ -n "$EVENT" ] || allow
RUNNER=\${AGENT_BOT_BIN:-"$HOME/.local/bin/agent-bot"}
[ -x "$RUNNER" ] || allow
DIR=\${AGENT_BOT_HOOKS_DIR:-}
if [ -z "$DIR" ]; then
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$ROOT" ] && [ -d "$ROOT/agent-hooks" ]; then
    DIR="$ROOT/agent-hooks"
  else
    TARGET=$(readlink "$RUNNER" 2>/dev/null || true)
    [ -n "$TARGET" ] || TARGET=$RUNNER
    case "$TARGET" in
      /*) ;;
      *) TARGET=$(dirname "$RUNNER")/$TARGET ;;
    esac
    DIR=$(dirname "$TARGET")/agent-hooks
  fi
fi
[ -d "$DIR/$EVENT" ] || allow
FOUND=""
for FILE in "$DIR/$EVENT"/*; do
  [ -f "$FILE" ] && [ -x "$FILE" ] && { FOUND=1; break; }
done
[ -n "$FOUND" ] || allow
exec "$RUNNER" agent-hook "$@"
`;
}

export function installAgentHook({
  home = homedir(),
  mkdir = mkdirSync,
  write = writeFileSync,
  chmod = chmodSync,
} = {}) {
  const path = installationPaths(home).agentHook;
  mkdir(dirname(path), { recursive: true });
  write(path, agentHookFastPath(), { mode: 0o755 });
  chmod(path, 0o755);
  return path;
}

export function installHookWrappers({
  home = homedir(),
  sourceHooks = SOURCE_HOOKS,
  mkdir = mkdirSync,
  list = readdirSync,
  read = readFileSync,
  write = writeFileSync,
  remove = rmSync,
  chmod = chmodSync,
} = {}) {
  const hooksDir = installationPaths(home).hooksDir;
  mkdir(hooksDir, { recursive: true });
  const available = new Set(list(sourceHooks));
  const missing = GIT_HOOK_NAMES.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`missing source Git hooks: ${missing.join(', ')}`);
  const hooks = [...GIT_HOOK_NAMES];
  for (const name of list(hooksDir)) {
    if (hooks.includes(name)) continue;
    const stale = join(hooksDir, name);
    let body = '';
    try {
      body = read(stale, 'utf8');
    } catch {
      continue;
    }
    if (body.includes('# Managed by agent-bot install.')) remove(stale, { force: true });
  }
  for (const name of hooks) {
    chmod(join(sourceHooks, name), 0o755);
    write(join(hooksDir, name), hookWrapper(name), { mode: 0o755 });
  }
  return hooksDir;
}

function getGlobal(run, key) {
  try {
    return run(['config', '--global', '--path', '--get', key]) || null;
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

export function isAgentBotHooksPath(path, home = homedir()) {
  if (!path) return false;
  const normalized = path.replaceAll('\\', '/');
  return (
    normalized === installationPaths(home).hooksDir.replaceAll('\\', '/') ||
    normalized.endsWith('/agent-bot-identity/hooks') ||
    normalized.endsWith('/tools/agent-bot/hooks')
  );
}

export async function installAgentBot({
  home = homedir(),
  env = process.env,
  run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
  installCli = installExecutable,
  installAgentHooks = installAgentHook,
  installHooks = installHookWrappers,
  installPath = ensureExecutablePath,
  ensureSupervisor = ensureDaemonSupervisor,
  ensureCutover = ensureSpacesCutover,
} = {}) {
  const executable = installCli({ home });
  const agentHook = installAgentHooks({ home });
  const pathRegistration = installPath({ home });
  const hooksPath = installHooks({ home });
  const previous = getGlobal(run, 'core.hooksPath');
  const canonicalChain = getGlobal(run, 'agentBot.chainedHooksPath');
  const legacyChain = getGlobal(run, 'qwts.chainedHooksPath');
  let chainedHooksPath = isAgentBotHooksPath(canonicalChain, home) ? null : canonicalChain;
  if (!chainedHooksPath && previous && !isAgentBotHooksPath(previous, home)) {
    chainedHooksPath = previous;
  }
  if (!chainedHooksPath && legacyChain && !isAgentBotHooksPath(legacyChain, home)) {
    chainedHooksPath = legacyChain;
  }
  if (chainedHooksPath) {
    run(['config', '--global', 'agentBot.chainedHooksPath', chainedHooksPath]);
  } else if (canonicalChain) {
    try {
      run(['config', '--global', '--unset-all', 'agentBot.chainedHooksPath']);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  run(['config', '--global', 'core.hooksPath', hooksPath]);
  const supervisor = await ensureSupervisor({ home, env, executable });
  const cutover = ensureCutover({ home, env });
  return { executable, agentHook, hooksPath, previous, chainedHooksPath, pathRegistration, supervisor, cutover };
}

export async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== '--with-gh-shim');
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  const result = await installAgentBot();
  process.stdout.write(`agent-bot -> ${result.executable}\n`);
  process.stdout.write(`core.hooksPath -> ${result.hooksPath}\n`);
  if (result.pathRegistration.updated) {
    process.stdout.write(`PATH line appended to ${result.pathRegistration.path}\n`);
  }
  if (result.chainedHooksPath) {
    process.stdout.write(`chained hooks -> ${result.chainedHooksPath}\n`);
  }
  if (result.supervisor?.applied) {
    process.stdout.write(`daemon supervisor -> ${result.supervisor.unitPath}\n`);
  } else if (result.supervisor?.reason === 'unsupported-platform') {
    process.stdout.write(`daemon supervisor skipped (${result.supervisor.platform})\n`);
  }
  if (result.cutover?.applied) {
    process.stdout.write(
      `spaces cutover -> ${result.cutover.from} -> ${result.cutover.to} (${result.cutover.moved} spaces)\n`,
    );
  }
  if (argv.includes('--with-gh-shim')) {
    execFileSync(result.executable, ['install-gh-shim'], { stdio: 'inherit' });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`install: ${error.message}\n`);
    process.exit(1);
  });
}
