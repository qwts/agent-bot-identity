import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PATH_MARKER = '# agent-bot installed commands';
const PATH_LINE = `export PATH="$HOME/.local/bin:$PATH"  ${PATH_MARKER}`;
const MANAGED_PATH_LINES = [
  /^export PATH="\$HOME\/\.config\/agent-bot\/bin:\$PATH"\s+# agent-bot gh shim(?: \(ENG-\d+\))?$/,
  /^export PATH="\$HOME\/\.local\/bin:\$PATH"\s+# agent-bot CLI$/,
  /^export PATH="\$HOME\/\.config\/agent-bot\/bin:\$HOME\/\.local\/bin:\$PATH"\s+# agent-bot installed commands$/,
  /^export PATH="\$HOME\/\.local\/bin:\$PATH"\s+# agent-bot installed commands$/,
];

function readOptional(path, read) {
  try {
    return read(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function removeManagedPathLines(body) {
  return body.split('\n').filter(
    (line) => !MANAGED_PATH_LINES.some((pattern) => pattern.test(line)),
  ).join('\n');
}

function cleanLegacyFile(path, read, write) {
  const body = readOptional(path, read);
  if (body === null) return false;
  const cleaned = removeManagedPathLines(body);
  if (cleaned === body) return false;
  write(path, cleaned);
  return true;
}

function appendManagedPath(body) {
  const cleaned = removeManagedPathLines(body);
  const separator = cleaned === '' || cleaned.endsWith('\n') ? '' : '\n';
  return `${cleaned}${separator}${PATH_LINE}\n`;
}

export function ensureExecutablePath({
  home = homedir(),
  read = readFileSync,
  write = writeFileSync,
} = {}) {
  const zshenv = join(home, '.zshenv');
  const migrated = cleanLegacyFile(zshenv, read, write) ? [zshenv] : [];
  const path = join(home, '.zprofile');
  const body = readOptional(path, read) ?? '';
  const updatedBody = appendManagedPath(body);
  const updated = updatedBody !== body;
  if (updated) write(path, updatedBody);
  return { path, updated, migrated };
}
