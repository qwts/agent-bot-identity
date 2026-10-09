// Local skill acquisition and comparison (#603/#312). This library never
// executes imported files, installs a harness, or changes a soul revision.
import { createHash, randomUUID } from 'node:crypto';
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { withLock } from './agent-identity.mjs';
import { canonicalJson } from './canonical-json.mjs';
import { skillField, validateSkill } from './soul-package.mjs';
import { diffSkillManifest } from './skill-manifest.mjs';
import { skillLibraryRoot } from './skill-library-paths.mjs';
import { acquireRemoteSkill, skillSourceUrl, REMOTE_SKILL_LIMITS } from './skill-remote.mjs';
import { inlineMarkdownLinks } from './skill-references.mjs';

export const SKILL_LIBRARY_LIMITS = Object.freeze({ files: 1000, entries: 4000, bytes: 32 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, entryBytes: 64 * 1024, depth: 16, references: 1000 });
function boundedLimits(limits = {}) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) fail('skill-limit-invalid', 'skill limits must be an object');
  for (const [name, value] of Object.entries(limits)) {
    if (!Object.hasOwn(SKILL_LIBRARY_LIMITS, name) || !Number.isSafeInteger(value) || value < 0 || value > SKILL_LIBRARY_LIMITS[name]) {
      fail('skill-limit-invalid', 'skill limits may only lower the documented bounds');
    }
  }
  return { ...SKILL_LIBRARY_LIMITS, ...limits };
}
const EXCLUDED = new Set(['.git', '.hg', '.svn', 'node_modules', '.DS_Store']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const exists = file => { try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const inside = (root, file) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
const validName = name => typeof name === 'string' && name.length <= 64 && NAME.test(name);
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.split('/').some(part => !part || part === '.' || part === '..'
    || /[\\:*?"<>|\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    fail('skill-path-unsafe', 'skill path is not a safe portable relative path');
  }
  return value;
}
function readBounded(file, maximum) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail('skill-source-unsupported', 'skill source contains a non-regular file');
    if (stat.size > maximum) fail('skill-limit', `skill file exceeds ${maximum} bytes`);
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0, count;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    if (size > stat.size) fail('skill-source-changed', 'skill file grew while being read; retry the acquisition');
    return { bytes: Buffer.from(buffer.subarray(0, size)), mode: stat.mode & 0o111 ? '100755' : '100644' };
  } finally { closeSync(fd); }
}
function decode(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function manifest(entries) {
  const files = Object.create(null);
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'))) files[entry.path] = { mode: entry.mode, size: entry.bytes.length, sha256: hash(entry.bytes) };
  return { files, digest: hash(Buffer.from(canonicalJson(files))) };
}
function inventory(root, { limits = SKILL_LIBRARY_LIMITS, allowFileLinks = false } = {}) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail('skill-path-unsafe', 'skill root must be a real directory');
  limits = boundedLimits(limits);
  const realRoot = realpathSync(root), entries = [], excluded = [], materialized = [], names = new Set();
  let total = 0, visited = 0;
  function walk(directory, prefix, depth) {
    if (depth > limits.depth) fail('skill-limit', `skill directory depth exceeds ${limits.depth}`);
    const children = [], dir = opendirSync(directory);
    try {
      let child;
      while ((child = dir.readSync())) {
        if (++visited > limits.entries) fail('skill-limit', `skill entry count exceeds ${limits.entries}`);
        children.push(child);
      }
    } finally { dir.closeSync(); }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = safePath(prefix ? `${prefix}/${child.name}` : child.name);
      const normalized = relative.normalize('NFC').toLowerCase();
      if (names.has(normalized)) fail('skill-path-unsafe', 'skill paths collide after portable case normalization');
      names.add(normalized);
      if (EXCLUDED.has(child.name)) { excluded.push(relative); continue; }
      let file = path.join(directory, child.name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        if (!allowFileLinks) fail('skill-path-unsafe', 'stored skill files must not be symlinks');
        file = realpathSync(file);
        if (!inside(realRoot, file) || !lstatSync(file).isFile()) fail('skill-path-unsafe', 'skill symlink escapes its root or targets a directory');
        materialized.push({ path: relative, target: path.relative(realRoot, file).split(path.sep).join('/') });
      } else if (stat.isDirectory()) { walk(file, relative, depth + 1); continue; }
      else if (!stat.isFile()) fail('skill-source-unsupported', 'skill source contains a non-regular file');
      if (entries.length >= limits.files) fail('skill-limit', `skill file count exceeds ${limits.files}`);
      const value = readBounded(file, Math.min(limits.fileBytes, limits.bytes - total, relative === 'SKILL.md' ? limits.entryBytes : Infinity));
      total += value.bytes.length;
      entries.push({ path: relative, ...value });
    }
  }
  walk(root, '', 0);
  return { entries, excluded, materialized, ...manifest(entries) };
}
function dependencies(entries, id, limit, locations = []) {
  const paths = new Set(entries.map(entry => entry.path));
  const edges = [];
  const retainedReference = (raw, from) => {
    try {
      const base = locations.find(item => item.path === from)?.resolvedUrl;
      if (!base) return null;
      const url = skillSourceUrl(new URL(raw, base).href);
      const match = locations.find(item => [item.url, item.resolvedUrl].includes(url) && paths.has(item.path));
      return match ? { source: url, target: match.path, status: 'captured' } : null;
    } catch { return null; }
  };
  for (const entry of entries.filter(entry => entry.path.toLowerCase().endsWith('.md'))) {
    let text;
    try { text = decode(entry.bytes); } catch { edges.push({ owner: id, from: entry.path, status: 'unresolved', reason: 'non-utf8-markdown' }); continue; }
    for (const link of inlineMarkdownLinks(text)) {
      if (edges.length >= limit) { edges.push({ owner: id, from: entry.path, status: 'unresolved', reason: 'reference-limit' }); return edges; }
      const raw = link.url;
      const edge = { owner: id, from: entry.path, line: link.line };
      if (raw.startsWith('#')) { edges.push({ ...edge, status: 'external', reason: 'document-anchor' }); continue; }
      if (raw.includes('?') || /:\/\/[^/]*@/.test(raw)) { edges.push({ ...edge, status: 'unresolved', reason: 'sensitive-locator-withheld' }); continue; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        let url;
        try { url = new URL(raw); } catch { edges.push({ ...edge, status: 'unresolved', reason: 'invalid-reference' }); continue; }
        if (!['https:', 'http:'].includes(url.protocol)) { edges.push({ ...edge, status: 'external', reason: 'unsupported-reference-scheme' }); continue; }
        const instruction = /\.(?:md|markdown|txt)$/i.test(url.pathname);
        const captured = locations.find(item => [item.url, item.resolvedUrl].includes(`${url.origin}${url.pathname}`) && paths.has(item.path));
        if (captured) { edges.push({ ...edge, source: `${url.origin}${url.pathname}`, target: captured.path, status: 'captured' }); continue; }
        edges.push({ ...edge, source: `${url.origin}${url.pathname}`, status: instruction ? 'unresolved' : 'external', reason: instruction ? 'remote-capture-unsupported' : 'unclassified-remote-reference' });
        continue;
      }
      let target;
      try {
        const decoded = decodeURIComponent(raw.split('#')[0]);
        if (path.posix.isAbsolute(decoded) || decoded.includes('\\')) throw new Error('absolute reference');
        target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), decoded)); safePath(target); }
      catch { edges.push({ ...edge, ...(retainedReference(raw, entry.path) ?? { status: 'unresolved', reason: 'unsafe-reference' }) }); continue; }
      const retained = !paths.has(target) && retainedReference(raw, entry.path);
      edges.push({ ...edge, ...(retained || { target, status: paths.has(target) ? 'captured' : 'unresolved', ...(paths.has(target) ? {} : { reason: 'outside-or-missing-file' }) }) });
    }
  }
  // Mark cycles without following links or claiming arbitrary fetch coverage.
  const graph = new Map();
  for (const edge of edges.filter(edge => edge.status === 'captured')) graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.target]);
  function reaches(from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (graph.get(from) ?? []).some(next => reaches(next, target, seen));
  }
  for (const edge of edges.filter(edge => edge.status === 'captured')) if (reaches(edge.target, edge.from)) edge.cycle = true;
  return edges;
}
function acquire(input, id, options = {}) {
  if (typeof input !== 'string' || !input || /^[a-z][a-z0-9+.-]*:/i.test(input) && !path.isAbsolute(input)) fail('skill-source-unsupported', 'this slice imports local directories or SKILL.md files; remote acquisition is not implemented');
  const selected = path.resolve(input), stat = lstatSync(selected);
  if (stat.isSymbolicLink()) fail('skill-path-unsafe', 'select a real skill root or its real SKILL.md');
  const root = stat.isDirectory() ? selected : stat.isFile() && path.basename(selected) === 'SKILL.md' ? path.dirname(selected) : null;
  if (!root) fail('skill-source-unsupported', 'select a skill directory or its SKILL.md');
  const content = inventory(root, { ...options, allowFileLinks: true });
  const entry = content.entries.find(file => file.path === 'SKILL.md');
  if (!entry) fail('skill-entry-invalid', 'skill root has no SKILL.md');
  let name;
  try { const front = decode(entry.bytes).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]; name = skillField(front ?? '', 'name'); validateSkill(entry.bytes, name); }
  catch (error) { fail('skill-entry-invalid', error.message); }
  const refs = dependencies(content.entries, id, boundedLimits(options.limits).references);
  return { ...content, name, source: { kind: 'local', path: realpathSync(root) }, dependencies: refs,
    coverage: { boundary: 'markdown-inline-file-links-v1', unresolved: refs.filter(edge => edge.status === 'unresolved').length, external: refs.filter(edge => edge.status === 'external').length, universalRetrieval: false } };
}
function remote(input) { return typeof input === 'string' && /^https?:/i.test(input); }
async function acquireHttps(input, id, options) {
  const local = boundedLimits(options.limits), remoteLimits = { ...options.remoteLimits };
  // Validate remote overrides before applying any stricter local bounds.
  for (const [key, value] of Object.entries(remoteLimits)) if (!Object.hasOwn(REMOTE_SKILL_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > REMOTE_SKILL_LIMITS[key]) fail('skill-limit-invalid', 'remote limits may only lower the documented positive bounds');
  for (const key of ['files', 'bytes', 'fileBytes', 'depth', 'references']) remoteLimits[key] = Math.min(remoteLimits[key] ?? REMOTE_SKILL_LIMITS[key], local[key]);
  const content = await acquireRemoteSkill(input, id, { ...options, remoteLimits });
  const entry = content.entries.find(file => file.path === 'SKILL.md');
  if (!entry || entry.bytes.length > local.entryBytes) fail('skill-entry-invalid', 'remote SKILL.md exceeds the entrypoint bound');
  let name;
  try { const front = decode(entry.bytes).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]; name = skillField(front ?? '', 'name'); validateSkill(entry.bytes, name); }
  catch { fail('skill-entry-invalid', 'remote source must contain a valid SKILL.md entrypoint'); }
  return { ...content, name, ...manifest(content.entries) };
}
function validSource(source) {
  if (source?.kind === 'local') return path.isAbsolute(source.path ?? '');
  if (source?.kind === 'https') { try { return skillSourceUrl(source.url) === source.url; } catch { return false; } }
  return false;
}
function rootFor(options = {}, create = false) {
  const root = skillLibraryRoot(options), pending = [];
  // Check all library components below HOME, even when the final root exists.
  // Do not reject platform aliases above HOME, such as macOS /var -> /private/var.
  const home = path.resolve(options.home ?? options.env?.HOME ?? process.env.HOME ?? '/');
  if (inside(home, root)) {
    let component = home;
    for (const part of path.relative(home, root).split(path.sep).filter(Boolean)) {
      component = path.join(component, part);
      const stat = exists(component);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('skill-path-unsafe', 'skill library directories must not be symlinks or files');
    }
  }
  let cursor = root;
  while (!exists(cursor)) { pending.unshift(cursor); cursor = path.dirname(cursor); }
  // Validate the selected root and its nearest existing parent. The configured
  // path may have normal platform aliases above that parent (e.g. macOS /var).
  const stat = lstatSync(cursor);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('skill-path-unsafe', 'skill library directories must not be symlinks or files');
  if (create) for (const directory of pending) mkdirSync(directory, { mode: 0o700 });
  return root;
}
function freeze(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) freeze(file);
    else chmodSync(file, lstatSync(file).mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(root, 0o555);
}
// Only our unpublished staging is made writable for cleanup, never snapshots.
function removeStaging(root) {
  if (!exists(root)) return;
  function thaw(directory) {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) thaw(path.join(directory, entry.name));
  }
  thaw(root);
  rmSync(root, { recursive: true, force: true });
}
function recordRoot(id, options) {
  if (!UUID.test(id ?? '')) fail('skill-id-invalid', 'select a skill import UUID');
  const root = path.join(rootFor(options), id), stat = exists(root);
  if (!stat) fail('skill-not-found', 'skill import was not found');
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('skill-path-unsafe', 'skill record is not a real directory');
  return root;
}
function json(file) {
  try { return JSON.parse(decode(readBounded(file, 4 * 1024 * 1024).bytes)); }
  catch (error) { fail('skill-record-invalid', `skill record cannot be read (${error.code ?? 'invalid-json'})`); }
}
function validateManifest(value) {
  if (!value || !DIGEST.test(value.digest ?? '') || !value.files || Array.isArray(value.files) || typeof value.files !== 'object' || Object.keys(value.files).length > SKILL_LIBRARY_LIMITS.files) fail('skill-record-invalid', 'invalid skill file manifest');
  for (const [file, item] of Object.entries(value.files)) {
    safePath(file);
    if (!item || !['100644', '100755'].includes(item.mode) || !DIGEST.test(item.sha256 ?? '') || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > SKILL_LIBRARY_LIMITS.fileBytes) fail('skill-record-invalid', 'invalid skill file receipt');
  }
  if (hash(Buffer.from(canonicalJson(value.files))) !== value.digest) fail('skill-record-invalid', 'skill manifest digest does not match its files');
}
function load(id, options) {
  const root = recordRoot(id, options), record = json(path.join(root, 'manifest.json'));
  if (record.schemaVersion !== 1 || record.id !== id || !validName(record.name) || !DIGEST.test(record.accepted ?? '') || !validSource(record.source)) fail('skill-record-invalid', 'invalid skill library record');
  validateManifest(record.localBaseline);
  return { root, record };
}
function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > 4 * 1024 * 1024) fail('skill-limit', 'skill metadata exceeds 4 MiB');
  writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
}
function writePayload(root, entries) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const file = path.join(root, safePath(entry.path));
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, entry.bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
  }
}
function storedPath(root, ...parts) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = exists(current);
    if (stat?.isSymbolicLink()) fail('skill-path-unsafe', 'stored skill paths must not be symlinks');
  }
  return current;
}
function snapshotPath(root, digest) {
  if (!DIGEST.test(digest)) fail('skill-record-invalid', 'invalid snapshot digest');
  return storedPath(root, '.snapshots', digest.slice(7));
}
function readSnapshot(root, digest) {
  const target = snapshotPath(root, digest);
  const metadata = json(path.join(target, 'manifest.json'));
  validateManifest(metadata.manifest);
  const content = inventory(storedPath(target, 'payload'));
  if (metadata.manifest.digest !== digest || content.digest !== digest) fail('skill-record-invalid', 'snapshot bytes do not match their manifest');
  const refs = metadata.dependencies;
  if (metadata.schemaVersion !== 1 || !UUID.test(metadata.owner ?? '') || !validName(metadata.name)
    || !validSource(metadata.source)
    || !Array.isArray(refs) || refs.length > SKILL_LIBRARY_LIMITS.references + 1
    || refs.some(edge => !edge || edge.owner !== metadata.owner || !Object.hasOwn(content.files, edge.from ?? '')
      || !['captured', 'external', 'unresolved'].includes(edge.status)
      || (edge.status === 'captured' && !Object.hasOwn(content.files, edge.target ?? '')))
    || !['markdown-inline-file-links-v1', 'markdown-inline-https-instructions-v1'].includes(metadata.coverage?.boundary) || metadata.coverage.universalRetrieval !== false
    || metadata.coverage.unresolved !== refs.filter(edge => edge.status === 'unresolved').length
    || metadata.coverage.external !== refs.filter(edge => edge.status === 'external').length
    || !Array.isArray(metadata.excluded) || !Array.isArray(metadata.materialized)) fail('skill-record-invalid', 'invalid skill snapshot metadata');
  if (metadata.source.kind === 'https' && (!Array.isArray(metadata.locations) || metadata.locations.length > SKILL_LIBRARY_LIMITS.references + 1
    || metadata.locations.some(item => !Object.hasOwn(content.files, item.path ?? '') || !validSource({ kind: 'https', url: item.url }) || !validSource({ kind: 'https', url: item.resolvedUrl })))) fail('skill-record-invalid', 'invalid remote source provenance');
  if (metadata.source.kind === 'https' && (!Array.isArray(metadata.hosts) || !metadata.hosts.length || metadata.hosts.length > 6006
    || metadata.hosts.some(host => typeof host !== 'string' || !validSource({ kind: 'https', url: `https://${host}/` }) || new URL(`https://${host}/`).hostname !== host)
    || new Set(metadata.hosts).size !== metadata.hosts.length
    || metadata.locations.some(item => !metadata.hosts.includes(new URL(item.url).hostname) || !metadata.hosts.includes(new URL(item.resolvedUrl).hostname)))) fail('skill-record-invalid', 'invalid remote host provenance');
  try { validateSkill(content.entries.find(entry => entry.path === 'SKILL.md')?.bytes, metadata.name); }
  catch { fail('skill-record-invalid', 'invalid snapshot skill entrypoint'); }
  return metadata;
}
function snapshot(root, content, id, now) {
  const target = snapshotPath(root, content.digest);
  if (exists(target)) { readSnapshot(root, content.digest); return; }
  const temp = path.join(root, `.snapshot-${randomUUID()}`);
  try {
    writePayload(path.join(temp, 'payload'), content.entries);
    writeJson(path.join(temp, 'manifest.json'), { schemaVersion: 1, owner: id, name: content.name, manifest: { files: content.files, digest: content.digest }, source: content.source,
      capturedAt: now().toISOString(), dependencies: content.dependencies, coverage: content.coverage, excluded: content.excluded, materialized: content.materialized,
      ...(content.locations ? { locations: content.locations, hosts: content.hosts } : {}) });
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    freeze(temp);
    // macOS requires the moved directory itself to be writable at rename.
    chmodSync(temp, 0o700);
    renameSync(temp, target);
    chmodSync(target, 0o555);
  } finally { removeStaging(temp); }
}
export function importSkill(input, { now = () => new Date(), ...options } = {}) {
  const id = randomUUID();
  if (remote(input)) {
    input = skillSourceUrl(input); // reject secret-bearing input before async I/O
    return acquireHttps(input, id, options).then(content => publishImport(content, id, now, options));
  }
  return publishImport(acquire(input, id, options), id, now, options);
}
function publishImport(content, id, now, options) {
  const library = rootFor(options, true), staging = path.join(library, `.import-${id}`), target = path.join(library, id);
  try {
    mkdirSync(staging, { mode: 0o700 });
    snapshot(staging, content, id, now);
    writePayload(path.join(staging, content.name), content.entries);
    writeJson(path.join(staging, 'manifest.json'), { schemaVersion: 1, id, name: content.name, source: content.source, importedAt: now().toISOString(), accepted: content.digest, localBaseline: { files: content.files, digest: content.digest } });
    chmodSync(path.join(staging, 'manifest.json'), 0o444);
    renameSync(staging, target);
  } finally { removeStaging(staging); }
  return showSkill(id, options);
}
export function showSkill(id, options = {}) {
  const { root, record } = load(id, options), source = readSnapshot(root, record.accepted);
  validateManifest(source.manifest);
  if (source.owner !== id || source.name !== record.name || source.manifest.digest !== record.accepted) fail('skill-record-invalid', 'accepted snapshot does not match the record');
  return { ...record, path: path.join(root, record.name), snapshot: snapshotPath(root, record.accepted), dependencies: source.dependencies, coverage: source.coverage, excluded: source.excluded, materialized: source.materialized,
    ...(source.locations ? { locations: source.locations, hosts: source.hosts } : {}) };
}
export function listSkills(options = {}) {
  const root = rootFor(options);
  if (!exists(root)) return [];
  const names = [], directory = opendirSync(root);
  let scanned = 0;
  try {
    let entry;
    while ((entry = directory.readSync())) {
      if (++scanned > 4000) fail('skill-limit', 'skill library listing exceeds 4000 entries');
      if (UUID.test(entry.name)) {
        if (names.length >= 1000) fail('skill-limit', 'skill library listing exceeds 1000 records');
        names.push(entry.name);
      }
    }
  } finally { directory.closeSync(); }
  return names.sort().map(id => { const record = showSkill(id, options); return { id, name: record.name, accepted: record.accepted, path: record.path, coverage: record.coverage }; });
}
export function verifySkill(id, options = {}) {
  const { root, record } = load(id, options);
  const current = inventory(path.join(root, record.name), options);
  const changes = diffSkillManifest(record.localBaseline, current);
  return { id, verification: current.digest === record.localBaseline.digest ? 'verified' : 'drifted', expected: record.localBaseline.digest, actual: current.digest, changes, coverage: showSkill(id, options).coverage };
}

// Materialization boundary for learning: return bounded, reverified bytes to
// the revision workflow, never a mutable library link or an implicit selection.
export function readSkillMaterial(id, { selection = 'accepted', expectedDigest, ...options } = {}) {
  if (!['accepted', 'local'].includes(selection)) fail('skill-selection-invalid', 'select accepted or local skill material');
  const record = showSkill(id, options);
  const content = inventory(selection === 'accepted' ? path.join(record.snapshot, 'payload') : record.path, options);
  if (selection === 'accepted' && content.digest !== record.accepted) fail('skill-record-invalid', 'accepted skill changed while being read');
  if (expectedDigest !== undefined && expectedDigest !== content.digest) fail('skill-source-changed', 'selected skill digest changed; review it again');
  try { validateSkill(content.entries.find(entry => entry.path === 'SKILL.md')?.bytes, record.name); }
  catch { fail('skill-entry-invalid', 'selected material must keep a valid skill entrypoint and name'); }
  return { record, selection, ...content, dependencies: selection === 'accepted' ? record.dependencies
    : dependencies(content.entries, id, boundedLimits(options.limits).references, record.locations) };
}
function checkReceipt(root, result) {
  const checks = storedPath(root, '.checks');
  mkdirSync(checks, { recursive: true, mode: 0o700 });
  writeJson(path.join(checks, `${randomUUID()}.json`), result);
  return result;
}
function textDiffs(root, accepted, candidate, changes) {
  let budget = 64 * 1024;
  const diffs = [];
  for (const file of [...changes.added, ...changes.modified, ...changes.removed].sort()) {
    const beforeFile = path.join(snapshotPath(root, accepted), 'payload', file);
    const afterFile = path.join(snapshotPath(root, candidate), 'payload', file);
    const before = exists(beforeFile) ? readBounded(beforeFile, SKILL_LIBRARY_LIMITS.fileBytes).bytes : Buffer.alloc(0);
    const after = exists(afterFile) ? readBounded(afterFile, SKILL_LIBRARY_LIMITS.fileBytes).bytes : Buffer.alloc(0);
    if (before.length + after.length > budget || before.includes(0) || after.includes(0)) { diffs.push({ path: file, text: null, reason: 'binary-or-diff-limit' }); continue; }
    let left, right;
    try { left = decode(before); right = decode(after); } catch { diffs.push({ path: file, text: null, reason: 'non-utf8' }); continue; }
    const lines = text => text ? text.replace(/\n$/, '').split('\n') : [];
    const a = lines(left), b = lines(right);
    const section = (text, parts, prefix) => [...parts.map(line => `${prefix}${line}`), ...(text && !text.endsWith('\n') ? ['\\ No newline at end of file'] : [])];
    const text = [`--- a/${file}`, `+++ b/${file}`, `@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@`, ...section(left, a, '-'), ...section(right, b, '+')].join('\n');
    if (Buffer.byteLength(text) > budget) { diffs.push({ path: file, text: null, reason: 'diff-limit' }); continue; }
    budget -= Buffer.byteLength(text);
    diffs.push({ path: file, text });
  }
  return diffs;
}
export function checkSkill(id, { now = () => new Date(), ...options } = {}) {
  const { root, record } = load(id, options);
  if (record.source.kind === 'https') return acquireHttps(record.source.url, id, options).then(
    source => publishCheck(source), error => publishCheck(null, error));
  return publishCheck();
  function publishCheck(fetched, fetchError) {
  return withLock(path.join(root, '.check.lock'), 'skill source check', () => {
    const fresh = load(id, options).record;
    if (canonicalJson(fresh) !== canonicalJson(record)) fail('skill-source-changed', 'skill record changed during source acquisition; retry');
    const accepted = readSnapshot(root, record.accepted);
    const local = inventory(path.join(root, record.name), options);
    let source;
    try { if (fetchError) throw fetchError; source = fetched ?? acquire(record.source.path, id, options); }
    catch (error) {
      return checkReceipt(root, { id, status: 'unavailable', accepted: record.accepted, reason: error.code ?? 'skill-source-unavailable', checkedAt: now().toISOString(), message: 'source could not be checked; accepted snapshot and local files are unchanged' });
    }
    snapshot(root, source, id, now);
    const result = { id, status: source.digest === record.accepted ? 'unchanged' : 'changed', accepted: record.accepted, candidate: source.digest,
      candidatePath: snapshotPath(root, source.digest), candidateName: source.name, changes: diffSkillManifest(accepted.manifest, source), localAdaptations: diffSkillManifest(accepted.manifest, local), localDrift: diffSkillManifest(record.localBaseline, local), coverage: source.coverage, checkedAt: now().toISOString() };
    result.textDiffs = textDiffs(root, record.accepted, source.digest, result.changes);
    if (source.locations) { result.locations = source.locations; result.hosts = source.hosts; result.dependencies = source.dependencies; }
    if (source.coverage.acquisition === 'partial') Object.assign(result, {
      status: 'unavailable', reason: 'skill-capture-incomplete',
      message: 'instruction capture is incomplete; partial candidate retained, accepted snapshot and local files are unchanged',
    });
    return checkReceipt(root, result);
  }, { keepLiveOwners: true });
  }
}
