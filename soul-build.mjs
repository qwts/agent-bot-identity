// The disk/CLI layer is deliberately separate from the pure renderer.
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildHarnessFiles } from './soul-builder.mjs';
import { readSoulPackageEntries } from './soul-package.mjs';
import { GENERATED_HARNESS_PATHS, GENERATED_HARNESS_MARKER, isGeneratedPath } from './soul-harness-contract.mjs';
import { currentAgentId } from './agent-identity.mjs';
import { soulDirInfo } from './soul-dir.mjs';

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function hasMarker(bytes) {
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n'); }
  catch { return false; }
  const front = content.match(/^---\n[\s\S]*?\n---\n/)?.[0];
  if (front) content = content.slice(front.length);
  else if (content.startsWith('#!')) content = content.slice(content.indexOf('\n') + 1);
  const first = content.split('\n')[0];
  return [GENERATED_HARNESS_MARKER, `# ${GENERATED_HARNESS_MARKER}`,
    `// ${GENERATED_HARNESS_MARKER}`, `/* ${GENERATED_HARNESS_MARKER} */`].includes(first);
}

// Inspect every component before reading/writing, including .github for its
// single eligible alias. Never follow a generated-directory symlink.
function regularPath(root, relative, directory = false) {
  const parts = relative.split('/');
  let location = root;
  for (let i = 0; i < parts.length; i++) {
    location = join(location, parts[i]);
    const info = stat(location);
    if (!info) continue;
    const wantsDirectory = i < parts.length - 1 || directory;
    if (info.isSymbolicLink() || !(wantsDirectory ? info.isDirectory() : info.isFile())) {
      throw new Error(`generated path conflict: ${relative} (requires regular ${wantsDirectory ? 'directory' : 'file'})`);
    }
  }
}

function generatedInventory(root) {
  const files = new Map();
  function walk(relative) {
    regularPath(root, relative, true);
    if (!stat(join(root, relative))) return;
    for (const name of readdirSync(join(root, relative)).sort()) {
      const child = `${relative}/${name}`;
      const info = stat(join(root, child));
      if (info.isDirectory()) walk(child);
      else { regularPath(root, child); files.set(child, readFileSync(join(root, child))); }
    }
  }
  for (const candidate of GENERATED_HARNESS_PATHS) {
    if (candidate.endsWith('/')) walk(candidate.slice(0, -1));
    else {
      regularPath(root, candidate);
      if (stat(join(root, candidate))) files.set(candidate, readFileSync(join(root, candidate)));
    }
  }
  return files;
}

export function buildSoulDirectory(directory, { check = false } = {}) {
  const root = resolve(directory);
  const info = stat(root);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('soul build requires a regular package directory');
  const existing = generatedInventory(root);
  const { entries } = readSoulPackageEntries(root);
  const source = entries.filter((entry) => !isGeneratedPath(entry.path) &&
    !(entry.mode === '040000' && isGeneratedPath(`${entry.path}/`)));
  const expected = buildHarnessFiles(source);
  const executable = new Set(source.filter((entry) => entry.mode === '100755').flatMap((entry) => [`.claude/${entry.path}`, `.gemini/${entry.path}`]));
  const writes = [], removals = [], conflicts = [];
  for (const [path, bytes] of expected) {
    regularPath(root, path);
    const current = existing.get(path);
    if (current && !hasMarker(current)) conflicts.push(path);
    else if (!current?.equals(bytes)) writes.push(path);
  }
  for (const [path, bytes] of existing) {
    if (!expected.has(path) && hasMarker(bytes)) removals.push(path);
  }
  writes.sort(); removals.sort(); conflicts.sort();
  if (conflicts.length) throw new Error(`unmarked generated path conflict: ${conflicts.join(', ')}`);
  const drift = [...writes, ...removals].sort();
  if (!check) {
    // Rewrite every output on each build; preflight all conflicts first.
    for (const [path, bytes] of expected) {
      regularPath(root, path);
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: 'wx', mode: executable.has(path) ? 0o755 : 0o644 });
        chmodSync(temporary, executable.has(path) ? 0o755 : 0o644);
        renameSync(temporary, destination);
      } finally { rmSync(temporary, { force: true }); }
    }
    for (const path of removals) {
      regularPath(root, path);
      rmSync(join(root, path));
      // Empty generated containers must not leave revision-bearing entries.
      let parent = dirname(path);
      while (parent !== '.' && isGeneratedPath(`${parent}/`)) {
        try { rmdirSync(join(root, parent)); }
        catch (error) { if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) break; throw error; }
        parent = dirname(parent);
      }
    }
  }
  return { drift, writes, removals };
}

export function main(argv = process.argv.slice(2), options = {}) {
  const paths = argv.filter((arg) => arg !== '--check');
  if (paths.length > 1 || paths.some((arg) => arg.startsWith('-')) || argv.filter((arg) => arg === '--check').length > 1) {
    throw new Error('usage: agent-bot soul build [PATH] [--check]');
  }
  let directory = paths[0];
  if (!directory) {
    const id = currentAgentId(options);
    if (!id) throw new Error('no current soul; pass PATH or set an Agent ID');
    directory = soulDirInfo(id, options).soulDir;
  }
  const result = buildSoulDirectory(directory, { check: argv.includes('--check') });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return argv.includes('--check') && result.drift.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`agent-bot soul build: ${error.message}\n`); process.exitCode = 1; }
}
