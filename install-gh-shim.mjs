#!/usr/bin/env node

import process from 'node:process';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
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
import { buildGhShim } from './gh-shim.mjs';
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

const GH_INTERPOSER_BACKUP_SUFFIX = '.agent-bot-real';

function validateGhPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || basename(path) !== 'gh') {
    throw new Error('Codex desktop gh path must be an absolute path ending in /gh');
  }
  return path;
}

function symlinkTarget(path, readlink) {
  return resolve(dirname(path), readlink(path));
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

export function installGhInterposer({
  path,
  shimPath,
  lstat = lstatSync,
  stat = statSync,
  readlink = readlinkSync,
  rename = renameSync,
  symlink = symlinkSync,
} = {}) {
  const ghPath = validateGhPath(path);
  const backupPath = `${ghPath}${GH_INTERPOSER_BACKUP_SUFFIX}`;
  if (resolve(ghPath) === resolve(shimPath)) {
    throw new Error('Codex desktop gh path must be the external gh, not the managed shim');
  }
  const target = optionalStat(ghPath, lstat);
  const backup = optionalStat(backupPath, lstat);
  if (!target) throw new Error(`${ghPath} does not exist`);

  if (target.isSymbolicLink() && symlinkTarget(ghPath, readlink) === shimPath) {
    if (!backup) throw new Error(`${ghPath} is interposed but its original executable is missing`);
    if (backup.isDirectory()) throw new Error(`${backupPath} is not a saved gh executable`);
    if (!isExecutableFile(backupPath, stat)) {
      throw new Error(`${backupPath} no longer resolves to an executable gh`);
    }
    return { path: ghPath, backupPath, updated: false };
  }
  if (target.isDirectory()) throw new Error(`${ghPath} is a directory, not a gh executable`);
  if (!isExecutableFile(ghPath, stat)) {
    throw new Error(`${ghPath} does not resolve to an executable file`);
  }
  if (backup) {
    throw new Error(`${backupPath} already exists; refusing to replace ${ghPath}`);
  }

  rename(ghPath, backupPath);
  try {
    symlink(shimPath, ghPath);
  } catch (error) {
    rename(backupPath, ghPath);
    throw error;
  }
  return { path: ghPath, backupPath, updated: true };
}

export function restoreGhInterposer({
  path,
  shimPath,
  lstat = lstatSync,
  readlink = readlinkSync,
  rename = renameSync,
} = {}) {
  const ghPath = validateGhPath(path);
  const backupPath = `${ghPath}${GH_INTERPOSER_BACKUP_SUFFIX}`;
  const target = optionalStat(ghPath, lstat);
  if (!target?.isSymbolicLink() || symlinkTarget(ghPath, readlink) !== shimPath) {
    throw new Error(`${ghPath} is not an agent-bot managed interposer`);
  }
  const backup = optionalStat(backupPath, lstat);
  if (!backup) {
    throw new Error(`${backupPath} is missing; refusing an unrecoverable restore`);
  }
  if (backup.isDirectory()) throw new Error(`${backupPath} is not a saved gh executable`);
  // POSIX rename replaces the managed symlink atomically with the saved
  // executable or symlink, leaving no interval where gh is absent.
  rename(backupPath, ghPath);
  return { path: ghPath, backupPath, restored: true };
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
    readlink,
    rename,
    symlink,
  });
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
    shimPath, localShim, codexShim, codexInterposer, zshenv, zprofile,
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
