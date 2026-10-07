// The disk/CLI layer is deliberately separate from the pure renderer.
import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildHarnessFiles, harnessReport, hasGeneratedJsonMarker, MCP_TARGETS, mergeableMcpServers, settingsTargets } from './soul-builder.mjs';
import { readSoulPackageEntries } from './soul-package.mjs';
import { GENERATED_HARNESS_PATHS, GENERATED_HARNESS_MARKER, isGeneratedPath } from './soul-harness-contract.mjs';
import { currentAgentId } from './agent-identity.mjs';
import { soulDirInfo } from './soul-dir.mjs';

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Byte order, as the renderer's own sort: output order never depends on locale.
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function hasMarker(bytes) {
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n'); }
  catch { return false; }
  // Generated JSON carries the marker as its first `_comment` string, the same
  // header position every other marked file uses.
  if (hasGeneratedJsonMarker(content)) return true;
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
  const { entries, manifest } = readSoulPackageEntries(root);
  const source = entries.filter((entry) => !isGeneratedPath(entry.path) &&
    !(entry.mode === '040000' && isGeneratedPath(`${entry.path}/`)));
  // A soul that ships its own MCP config keeps its servers: whatever is at each
  // rendered MCP path is handed to the pure renderer as an explicit input, so
  // a second build over its own output reproduces it byte for byte and an
  // authored file is merged rather than refused. `merged` names the files whose
  // unmarked content the renderer adopted. With comms off nothing is rendered,
  // so the soul's own file is left exactly as it is.
  const comms = manifest.comms !== false;
  const authored = new Map(), merged = [];
  const targets = new Map((comms ? MCP_TARGETS : []).map((target) => [target.path, target]));
  for (const target of settingsTargets(manifest)) {
    if (!targets.has(target.path)) targets.set(target.path, target);
  }
  for (const target of targets.values()) {
    const bytes = existing.get(target.path);
    if (!bytes) continue;
    authored.set(target.path, bytes);
    if (!hasMarker(bytes)) {
      merged.push({ path: target.path, harness: target.harness, kept: comms && MCP_TARGETS.some(({ path }) => path === target.path) ? mergeableMcpServers(target.path, bytes) : [] });
    }
  }
  const expected = buildHarnessFiles(source, { authored });
  const executable = new Set(source.filter((entry) => entry.mode === '100755').flatMap((entry) => [`.claude/${entry.path}`, `.gemini/${entry.path}`]));
  const writes = [], removals = [], conflicts = [];
  for (const [path, bytes] of expected) {
    regularPath(root, path);
    const current = existing.get(path);
    // An unmarked file at a rendered MCP path was merged into this output, so
    // it is now the renderer's own output; every other unmarked file at a
    // generated path stays a conflict.
    if (current && !hasMarker(current) && !authored.has(path)) conflicts.push(path);
    else if (!current?.equals(bytes)) writes.push(path);
  }
  for (const [path, bytes] of existing) {
    if (!expected.has(path) && hasMarker(bytes)) removals.push(path);
  }
  writes.sort(); removals.sort(); conflicts.sort(); merged.sort((a, b) => compare(a.path, b.path));
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
  return {
    drift, writes, removals, merged,
    harnesses: harnessReport(expected, { comms, manifest }),
  };
}

export function main(argv = process.argv.slice(2), options = {}) {
  const paths = argv.filter((arg) => arg !== '--check' && arg !== '--json');
  const flags = ['--check', '--json'];
  if (paths.length > 1 || paths.some((arg) => arg.startsWith('-'))
      || flags.some((flag) => argv.filter((arg) => arg === flag).length > 1)) {
    throw new Error('usage: agent-bot soul build [PATH] [--check] [--json]');
  }
  let directory = paths[0];
  if (!directory) {
    const id = currentAgentId(options);
    if (!id) throw new Error('no current soul; pass PATH or set an Agent ID');
    directory = soulDirInfo(id, options).soulDir;
  }
  const result = buildSoulDirectory(directory, { check: argv.includes('--check') });
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result)}\n` : format(result));
  return argv.includes('--check') && result.drift.length ? 1 : 0;
}

// The same report `--json` prints: every harness's rendered primitives, so a
// primitive that reached no harness is visible without parsing JSON.
function format({ drift, writes, removals, merged, harnesses }) {
  const lines = [`agent-bot soul build: ${writes.length} written, ${removals.length} removed, ${merged.length} merged${drift.length ? `, ${drift.length} pending` : ''}`];
  if (merged.length) lines.push(...merged.map((entry) => `merged ${entry.path}: kept ${entry.kept.join(', ') || 'no servers of its own'}`));
  for (const [harness, { rendered, unsupported }] of Object.entries(harnesses)) {
    lines.push(`${harness}: ${rendered.join(', ')}${unsupported.length ? ` (unsupported: ${unsupported.join(', ')})` : ''}`);
  }
  if (drift.length) lines.push(`pending: ${drift.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`agent-bot soul build: ${error.message}\n`); process.exitCode = 1; }
}
