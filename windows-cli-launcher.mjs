import { readFileSync, lstatSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';

const MARKER = '# agent-bot-windows-launcher-v1 ';
const MAX_BYTES = 8192;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function windowsLauncherText({ entrypoint, node = process.execPath }) {
  const entry = join(dirname(resolve(entrypoint)), 'agent-bot.mjs');
  for (const value of [entry, node]) {
    if (!win32.isAbsolute(value) || /[\r\n\0"%!]/.test(value)) throw new Error('unsafe Windows launcher path');
  }
  const metadata = JSON.stringify({ entry, node });
  return {
    entry, node,
    shell: `#!/bin/sh\n${MARKER}${metadata}\nexec ${quote(node.replaceAll('\\', '/'))} ${quote(entry.replaceAll('\\', '/'))} "$@"\n`,
    cmd: `@echo off\r\n@rem agent-bot-windows-launcher-v1\r\n"${node}" "${entry}" %*\r\n`,
  };
}

// Recognize only complete canonical pairs. A marker alone is never ownership.
export function readWindowsLauncher(executable, { stat = lstatSync, read = readFileSync } = {}) {
  try {
    for (const file of [executable, executable + '.cmd']) {
      const info = stat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
    }
    const shell = read(executable, 'utf8');
    const line = shell.split('\n')[1];
    if (!line?.startsWith(MARKER)) return null;
    const data = JSON.parse(line.slice(MARKER.length));
    if (Object.keys(data).sort().join(',') !== 'entry,node') return null;
    const expected = windowsLauncherText({ entrypoint: data.entry, node: data.node });
    if (shell !== expected.shell || read(executable + '.cmd', 'utf8') !== expected.cmd) return null;
    return { entry: expected.entry, node: expected.node };
  } catch { return null; }
}

export function installWindowsLauncher(executable, options = {}) {
  const expected = windowsLauncherText(options);
  const files = [executable, executable + '.cmd'];
  const present = files.map(file => {
    try { lstatSync(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  if (present.some(Boolean)) {
    const current = readWindowsLauncher(executable);
    if (!current || current.entry !== expected.entry || current.node !== expected.node) {
      throw new Error(`${executable} or its .cmd companion is not this runtime's managed Windows launcher`);
    }
    return executable;
  }
  mkdirSync(dirname(executable), { recursive: true });
  // Exclusive creation refuses concurrent/foreign files instead of replacing them.
  writeFileSync(executable, expected.shell, { flag: 'wx', mode: 0o755 });
  writeFileSync(executable + '.cmd', expected.cmd, { flag: 'wx' });
  return executable;
}
