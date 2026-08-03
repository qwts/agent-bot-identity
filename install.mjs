#!/usr/bin/env node

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensurePathLine } from './shell-path.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(ROOT, 'agent-bot.mjs');
const SOURCE_HOOKS = join(ROOT, 'hooks');

export function installationPaths(home = homedir()) {
  return {
    binDir: join(home, '.local', 'bin'),
    executable: join(home, '.local', 'bin', 'agent-bot'),
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

function isManagedExecutable(path, stat, readlink = readlinkSync) {
  if (!stat?.isSymbolicLink()) return false;
  const target = readlink(path);
  return basename(target) === 'agent-bot.mjs';
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
} = {}) {
  const paths = installationPaths(home);
  mkdir(paths.binDir, { recursive: true });
  chmod(entrypoint, 0o755);
  const stat = optionalLstat(paths.executable, lstat);
  if (stat) {
    if (!isManagedExecutable(paths.executable, stat, readlink)) {
      throw new Error(`${paths.executable} exists and is not an agent-bot symlink`);
    }
    const current = resolve(dirname(paths.executable), readlink(paths.executable));
    if (current === resolve(entrypoint)) return paths.executable;
    remove(paths.executable, { force: true });
  }
  symlink(entrypoint, paths.executable);
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
  read = readFileSync,
  append = appendFileSync,
} = {}) {
  // Distinct from install-gh-shim's `.config/agent-bot/bin` marker, which is a
  // loose substring the .zprofile line below also contains.
  const zshenv = ensurePathLine({
    home,
    filename: '.zshenv',
    line: 'export PATH="$HOME/.local/bin:$PATH"  # agent-bot CLI',
    marker: '# agent-bot CLI',
    read,
    append,
  });
  const marker = '# agent-bot installed commands';
  const zprofile = ensurePathLine({
    home,
    filename: '.zprofile',
    line: `export PATH="$HOME/.config/agent-bot/bin:$HOME/.local/bin:$PATH"  ${marker}`,
    marker,
    read,
    append,
  });
  // `path`/`updated` stay on the .zprofile registration so existing callers and
  // output keep their meaning; the new one is reported alongside.
  return { ...zprofile, zshenv };
}

function hookWrapper(name) {
  return `#!/bin/sh\n# Managed by agent-bot install.\nexec "\${HOME}/.local/bin/agent-bot" hook ${name} "$@"\n`;
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
  const hooks = list(sourceHooks).filter((name) => name !== 'chain-hook');
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

export function installAgentBot({
  home = homedir(),
  run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
  installCli = installExecutable,
  installHooks = installHookWrappers,
  installPath = ensureExecutablePath,
} = {}) {
  const executable = installCli({ home });
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
  return { executable, hooksPath, previous, chainedHooksPath, pathRegistration };
}

export function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== '--with-gh-shim');
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
  const result = installAgentBot();
  process.stdout.write(`agent-bot -> ${result.executable}\n`);
  process.stdout.write(`core.hooksPath -> ${result.hooksPath}\n`);
  if (result.pathRegistration.updated) {
    process.stdout.write(`PATH line appended to ${result.pathRegistration.path}\n`);
  }
  if (result.chainedHooksPath) {
    process.stdout.write(`chained hooks -> ${result.chainedHooksPath}\n`);
  }
  if (argv.includes('--with-gh-shim')) {
    execFileSync(result.executable, ['install-gh-shim'], { stdio: 'inherit' });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`install: ${error.message}\n`);
    process.exit(1);
  }
}
