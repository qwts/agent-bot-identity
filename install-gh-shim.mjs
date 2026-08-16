#!/usr/bin/env node

import process from 'node:process';
import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename, dirname, isAbsolute, join, resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGhShim, GH_SHIM_MARKER } from './gh-shim.mjs';
import { ensurePathLine, zshStartupDir } from './shell-path.mjs';

function optionalStat(path, lstat) {
  try {
    return lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function installManagedShimLink({ path, shimPath, binDir, lstat, readlink, remove, symlink }) {
  const stat = optionalStat(path, lstat);
  if (stat) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`${path} is a real file; move it before installing the gh shim`);
    }
    const target = resolve(dirname(path), readlink(path));
    if (target !== shimPath && !target.startsWith(`${binDir}/`)) {
      throw new Error(`${path} is a foreign symlink to ${target}`);
    }
    remove(path, { force: true });
  }
  symlink(shimPath, path);
  return path;
}

export const GH_INTERPOSER_BACKUP_SUFFIX = '.agent-bot-real';
export const GH_INTERPOSER_LEGACY_BACKUP_SUFFIX = '.bak';
const CODEX_DESKTOP_GH_STATE_FILE = 'codex-desktop-gh.json';

function validateGhPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path) !== 'gh') {
    throw new Error('Codex desktop gh path must be an absolute path ending in /gh');
  }
  return path;
}

function isExecutableFile(path, stat) {
  try {
    const target = stat(path);
    return target.isFile() && (target.mode & 0o111) !== 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function codexDesktopGhStatePath(home = homedir()) {
  return join(home, '.config', 'agent-bot', CODEX_DESKTOP_GH_STATE_FILE);
}

export function isAgentBotGhShim(path, {
  open = openSync,
  read = readSync,
  close = closeSync,
} = {}) {
  let descriptor;
  try {
    descriptor = open(path, 'r');
    const buffer = Buffer.alloc(Buffer.byteLength(GH_SHIM_MARKER) + 96);
    const length = read(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString('utf8').includes(GH_SHIM_MARKER);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally {
    if (descriptor !== undefined) close(descriptor);
  }
}

function resolvesTo(path, expected, realpath) {
  try {
    return realpath(path) === realpath(expected);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function savedGhStatus(path, { lstat, stat, isShim }) {
  const entry = optionalStat(path, lstat);
  if (!entry) return { status: 'missing', path };
  if (entry.isDirectory()) return { status: 'invalid', path, reason: 'directory' };
  try {
    if (isShim(path)) return { status: 'recursive', path };
  } catch {
    return { status: 'invalid', path, reason: 'unreadable' };
  }
  if (isExecutableFile(path, stat)) return { status: 'ready', path };
  if (entry.isSymbolicLink()) return { status: 'dangling', path };
  return { status: 'invalid', path, reason: 'not-executable' };
}

export function inspectGhInterposer({
  path,
  shimPath,
  lstat = lstatSync,
  stat = statSync,
  realpath = realpathSync,
  isShim = isAgentBotGhShim,
} = {}) {
  const ghPath = validateGhPath(path);
  const backupPath = `${ghPath}${GH_INTERPOSER_BACKUP_SUFFIX}`;
  const legacyBackupPath = `${ghPath}${GH_INTERPOSER_LEGACY_BACKUP_SUFFIX}`;
  const target = optionalStat(ghPath, lstat);
  const backup = savedGhStatus(backupPath, { lstat, stat, isShim });
  const legacy = savedGhStatus(legacyBackupPath, { lstat, stat, isShim });
  const evidence = { path: ghPath, backup_path: backupPath };

  if (!target) {
    return { status: 'missing', code: 'codex-gh-interposer-missing', evidence };
  }
  if (target.isDirectory() || !isExecutableFile(ghPath, stat)) {
    return { status: 'unrecoverable', code: 'codex-gh-interposer-unrecoverable', evidence };
  }
  let targetIsShim;
  try {
    targetIsShim = resolvesTo(ghPath, shimPath, realpath) || isShim(ghPath);
  } catch {
    return { status: 'unrecoverable', code: 'codex-gh-interposer-unrecoverable', evidence };
  }
  if (backup.status === 'recursive' || legacy.status === 'recursive') {
    return { status: 'recursive', code: 'codex-gh-interposer-recursive', evidence };
  }

  if (targetIsShim) {
    if (backup.status === 'ready') {
      if (legacy.status === 'missing') return { status: 'ready', code: null, evidence };
      return {
        status: 'legacy-ambiguous',
        code: 'codex-gh-interposer-legacy-ambiguous',
        evidence: { ...evidence, legacy_backup_path: legacyBackupPath },
      };
    }
    if (backup.status === 'missing' && legacy.status === 'ready') {
      return {
        status: 'legacy-backup',
        code: 'codex-gh-interposer-legacy-backup',
        evidence: { ...evidence, legacy_backup_path: legacyBackupPath },
      };
    }
    return { status: 'unrecoverable', code: 'codex-gh-interposer-unrecoverable', evidence };
  }

  if (backup.status === 'invalid' || legacy.status === 'invalid') {
    return { status: 'unrecoverable', code: 'codex-gh-interposer-unrecoverable', evidence };
  }
  if (legacy.status !== 'missing') {
    return {
      status: 'legacy-ambiguous',
      code: 'codex-gh-interposer-legacy-ambiguous',
      evidence: { ...evidence, legacy_backup_path: legacyBackupPath },
    };
  }
  if (backup.status !== 'missing') {
    return { status: 'replaced', code: 'codex-gh-interposer-replaced', evidence };
  }
  return { status: 'unconfigured', code: 'codex-gh-interposer-unconfigured', evidence };
}

export function inspectShellGhShim({ home = homedir() } = {}) {
  const shimPath = join(home, '.config', 'agent-bot', 'bin', 'gh');
  const localPath = join(home, '.local', 'bin', 'gh');
  const evidence = { path: shimPath, local_path: localPath };
  const shim = optionalStat(shimPath, lstatSync);
  const local = optionalStat(localPath, lstatSync);
  if (!shim || !local) return { status: 'missing', code: 'gh-shim-missing', evidence };
  let shimIsManaged;
  try {
    shimIsManaged = isExecutableFile(shimPath, statSync) && isAgentBotGhShim(shimPath);
  } catch {
    return { status: 'unrecoverable', code: 'gh-shell-shim-unrecoverable', evidence };
  }
  if (!shimIsManaged) {
    return { status: 'replaced', code: 'gh-shell-shim-replaced', evidence };
  }
  if (!resolvesTo(localPath, shimPath, realpathSync)) {
    let localIsShim;
    try {
      localIsShim = isAgentBotGhShim(localPath);
    } catch {
      return { status: 'unrecoverable', code: 'gh-shell-shim-unrecoverable', evidence };
    }
    return {
      status: localIsShim ? 'recursive' : 'replaced',
      code: localIsShim ? 'gh-shell-shim-recursive' : 'gh-shell-shim-replaced',
      evidence,
    };
  }
  return { status: 'ready', code: null, evidence };
}

export function inspectConfiguredCodexDesktopGh({ home = homedir() } = {}) {
  const statePath = codexDesktopGhStatePath(home);
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'unconfigured', code: 'codex-gh-interposer-unconfigured', evidence: {} };
    }
    return {
      status: 'unrecoverable',
      code: 'codex-gh-interposer-state-invalid',
      evidence: { state_path: statePath },
    };
  }
  if (state?.schema_version !== 1 || typeof state.path !== 'string') {
    return {
      status: 'unrecoverable',
      code: 'codex-gh-interposer-state-invalid',
      evidence: { state_path: statePath },
    };
  }
  const shimPath = join(home, '.config', 'agent-bot', 'bin', 'gh');
  try {
    return inspectGhInterposer({ path: state.path, shimPath });
  } catch {
    return {
      status: 'unrecoverable',
      code: 'codex-gh-interposer-state-invalid',
      evidence: { state_path: statePath },
    };
  }
}

export function installGhInterposer({
  path,
  shimPath,
  lstat = lstatSync,
  stat = statSync,
  realpath = realpathSync,
  rename = renameSync,
  remove = rmSync,
  symlink = symlinkSync,
  isShim = isAgentBotGhShim,
} = {}) {
  const ghPath = validateGhPath(path);
  const backupPath = `${ghPath}${GH_INTERPOSER_BACKUP_SUFFIX}`;
  const legacyBackupPath = `${ghPath}${GH_INTERPOSER_LEGACY_BACKUP_SUFFIX}`;
  if (resolve(ghPath) === resolve(shimPath)) {
    throw new Error('Codex desktop gh path must be the external gh, not the managed shim');
  }
  if (!isExecutableFile(shimPath, stat) || !isShim(shimPath)) {
    throw new Error('Codex desktop interposition requires the managed agent-bot gh shim');
  }
  const inspection = inspectGhInterposer({
    path: ghPath, shimPath, lstat, stat, realpath, isShim,
  });
  if (inspection.status === 'ready') {
    return { path: ghPath, backupPath, updated: false };
  }
  if (inspection.status === 'legacy-backup') {
    rename(legacyBackupPath, backupPath);
    return { path: ghPath, backupPath, updated: true, migratedLegacyBackup: true };
  }
  if (!['unconfigured', 'replaced'].includes(inspection.status)) {
    throw new Error(`${ghPath} cannot be interposed: ${inspection.code}`);
  }

  rename(ghPath, backupPath);
  try {
    symlink(shimPath, ghPath);
  } catch (error) {
    rename(backupPath, ghPath);
    throw error;
  }
  if (optionalStat(legacyBackupPath, lstat)) remove(legacyBackupPath, { force: true });
  return { path: ghPath, backupPath, updated: true };
}

export function restoreGhInterposer({
  path,
  shimPath,
  lstat = lstatSync,
  stat = statSync,
  realpath = realpathSync,
  rename = renameSync,
  isShim = isAgentBotGhShim,
} = {}) {
  const ghPath = validateGhPath(path);
  const backupPath = `${ghPath}${GH_INTERPOSER_BACKUP_SUFFIX}`;
  const legacyBackupPath = `${ghPath}${GH_INTERPOSER_LEGACY_BACKUP_SUFFIX}`;
  const inspection = inspectGhInterposer({
    path: ghPath, shimPath, lstat, stat, realpath, isShim,
  });
  if (!['ready', 'legacy-backup', 'legacy-ambiguous'].includes(inspection.status)) {
    throw new Error(`${ghPath} cannot be restored: ${inspection.code}`);
  }
  const savedPath = inspection.status === 'legacy-backup' ? legacyBackupPath : backupPath;
  // POSIX rename replaces the managed symlink atomically with the saved
  // executable or symlink, leaving no interval where gh is absent.
  rename(savedPath, ghPath);
  return { path: ghPath, backupPath: savedPath, restored: true };
}

export function installGhShim({
  home = homedir(),
  env = process.env,
  codexGhPath = null,
  codexOverrideDir = join(
    home, '.cache', 'codex-runtimes', 'codex-primary-runtime',
    'dependencies', 'bin', 'override',
  ),
  mkdir = mkdirSync,
  write = writeFileSync,
  read = readFileSync,
  append = appendFileSync,
  symlink = symlinkSync,
  remove = rmSync,
  lstat = lstatSync,
  readlink = readlinkSync,
  rename = renameSync,
} = {}) {
  const binDir = join(home, '.config', 'agent-bot', 'bin');
  mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, 'gh');
  write(shimPath, buildGhShim(), { mode: 0o755 });

  const localBin = join(home, '.local', 'bin');
  mkdir(localBin, { recursive: true });
  const localShim = join(localBin, 'gh');
  installManagedShimLink({
    path: localShim, shimPath, binDir, lstat, readlink, remove, symlink,
  });

  let codexShim = null;
  if (optionalStat(codexOverrideDir, lstat)?.isDirectory()) {
    codexShim = installManagedShimLink({
      path: join(codexOverrideDir, 'gh'),
      shimPath,
      binDir,
      lstat,
      readlink,
      remove,
      symlink,
    });
  }
  const codexInterposer = codexGhPath == null ? null : installGhInterposer({
    path: codexGhPath,
    shimPath,
    lstat,
    rename,
    remove,
    symlink,
  });
  const codexStatePath = codexInterposer ? codexDesktopGhStatePath(home) : null;
  if (codexStatePath) {
    write(codexStatePath, `${JSON.stringify({ schema_version: 1, path: codexGhPath })}\n`, {
      mode: 0o600,
    });
  }
  const dir = zshStartupDir(home, env);
  const zshenv = ensurePathLine({
    dir,
    filename: '.zshenv',
    line: 'export PATH="$HOME/.config/agent-bot/bin:$PATH"  # agent-bot gh shim',
    marker: '.config/agent-bot/bin',
    read,
    append,
  });
  const zprofile = ensurePathLine({
    dir,
    filename: '.zprofile',
    line: 'path=("$HOME/.local/bin" "${(@)path:#$HOME/.local/bin}")  # agent-bot gh shim login priority',
    marker: '# agent-bot gh shim login priority',
    read,
    append,
  });
  return {
    shimPath, localShim, codexShim, codexInterposer, codexStatePath, zshenv, zprofile,
  };
}

function parseArgs(argv) {
  if (argv.length === 0) return { action: 'install', codexGhPath: null };
  if (argv.length === 2 && argv[0] === '--codex-desktop-gh') {
    return { action: 'install', codexGhPath: validateGhPath(argv[1]) };
  }
  if (argv.length === 2 && argv[0] === '--restore-codex-desktop-gh') {
    return { action: 'restore', codexGhPath: validateGhPath(argv[1]) };
  }
  throw new Error(
    'usage: install-gh-shim [--codex-desktop-gh <absolute-gh-path> | '
    + '--restore-codex-desktop-gh <absolute-gh-path>]',
  );
}

export function main(argv = process.argv.slice(2), { home = homedir() } = {}) {
  const options = parseArgs(argv);
  if (options.action === 'restore') {
    const shimPath = join(home, '.config', 'agent-bot', 'bin', 'gh');
    const restored = restoreGhInterposer({ path: options.codexGhPath, shimPath });
    rmSync(codexDesktopGhStatePath(home), { force: true });
    process.stdout.write(`Codex desktop gh restored -> ${restored.path}\n`);
    return restored;
  }

  const result = installGhShim({ home, codexGhPath: options.codexGhPath });
  process.stdout.write(`gh shim -> ${result.shimPath}\n`);
  process.stdout.write(`PATH shim -> ${result.localShim}\n`);
  if (result.codexShim) {
    process.stdout.write(`Codex runtime shim -> ${result.codexShim}\n`);
  }
  if (result.codexInterposer) {
    process.stdout.write(`Codex desktop gh shim -> ${result.codexInterposer.path}\n`);
    process.stdout.write(`Original gh preserved -> ${result.codexInterposer.backupPath}\n`);
  }
  process.stdout.write(result.zshenv.updated
    ? `PATH line appended to ${result.zshenv.path}\n`
    : `PATH line already present in ${result.zshenv.path}\n`);
  process.stdout.write(result.zprofile.updated
    ? `Login PATH line appended to ${result.zprofile.path}\n`
    : `Login PATH line already present in ${result.zprofile.path}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`install-gh-shim: ${error.message}\n`);
    process.exit(1);
  }
}
