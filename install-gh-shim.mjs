#!/usr/bin/env node

import process from 'node:process';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGhShim } from './gh-shim.mjs';

function optionalStat(path, lstat) {
  try {
    return lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function installGhShim({
  home = homedir(),
  mkdir = mkdirSync,
  write = writeFileSync,
  read = readFileSync,
  append = appendFileSync,
  symlink = symlinkSync,
  remove = rmSync,
  lstat = lstatSync,
  readlink = readlinkSync,
} = {}) {
  const binDir = join(home, '.config', 'agent-bot', 'bin');
  mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, 'gh');
  write(shimPath, buildGhShim(), { mode: 0o755 });

  const localBin = join(home, '.local', 'bin');
  mkdir(localBin, { recursive: true });
  const localShim = join(localBin, 'gh');
  const stat = optionalStat(localShim, lstat);
  if (stat) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`${localShim} is a real file; move it before installing the gh shim`);
    }
    const target = resolve(dirname(localShim), readlink(localShim));
    if (target !== shimPath && !target.startsWith(`${binDir}/`)) {
      throw new Error(`${localShim} is a foreign symlink to ${target}`);
    }
    remove(localShim, { force: true });
  }
  symlink(shimPath, localShim);

  const zshenv = join(home, '.zshenv');
  const pathLine = 'export PATH="$HOME/.config/agent-bot/bin:$PATH"  # agent-bot gh shim';
  let body = '';
  try {
    body = read(zshenv, 'utf8');
  } catch {
    /* no file yet */
  }
  const zshenvUpdated = !body.includes('.config/agent-bot/bin');
  if (zshenvUpdated) {
    append(zshenv, `${body === '' || body.endsWith('\n') ? '' : '\n'}${pathLine}\n`);
  }
  return { shimPath, localShim, zshenv, zshenvUpdated };
}

export function main() {
  const result = installGhShim();
  process.stdout.write(`gh shim -> ${result.shimPath}\n`);
  process.stdout.write(`PATH shim -> ${result.localShim}\n`);
  process.stdout.write(
    result.zshenvUpdated
      ? `PATH line appended to ${result.zshenv}\n`
      : `PATH line already present in ${result.zshenv}\n`,
  );
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
