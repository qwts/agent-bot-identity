#!/usr/bin/env node
// `agent-bot soul env export` and `soul env import`: a soul's life as one
// archive (#583 slice 7, ADR-0583 decision 10). The export carries what the
// environment contract calls durable and the issue calls the life: the
// definition, the private home, tool state minus every sign-in file the
// tool-home registry names, memory, history, the settings and journals
// under `.soul-state/`, the revision journal, soul-owned workspaces whole
// and linked ones as a pointer with the patch and untracked files. Never
// credentials, secrets, sign-ins, runtimes, caches, temporary files or
// generated output: each is reconstructible, disposable or the host's.
// Every included path is classified by the contract and listed, with its
// SHA-256, in `manifest.json` inside the archive; what is left out is
// listed with its reason, so an archive is never an indiscriminate copy of
// the root and a reader knows what it holds before extracting a byte.
//
// Import keeps the Agent ID (a moved life), mints a new one with `--fork`,
// and refuses an ID that is active here unless `--replace`, which moves the
// existing root aside and never deletes it. The archive is untrusted: every
// entry must be a regular file or directory named in the manifest, under
// the archive's own prefixes, without traversal; a symlink entry, an absolute
// path or a hash that does not match refuses the whole import before
// anything reaches the soul root. A linked workspace is restored as its
// pointer, patch and untracked files under `.soul-state/imports/<name>/`;
// nothing is cloned.
//
// The archive format is POSIX ustar (GNU long names) inside gzip, written
// and read here with node's zlib and no dependency, so `tar -tzf` lists it.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip, createGzip } from 'node:zlib';
import { isAgentId, mintAgentIdentity, readAgentIdentity, stateDirectory } from './agent-identity.mjs';
import { populationFile, registerSoulDir, setSoulSpacePath, showSoul, showSoulByName, soulDirectory, upsertSoul } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { initSoulSpace } from './agent-space.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { CLASSIFICATIONS, classifyPath, retentionOf } from './soul-env-contract.mjs';
import { recordMigrationStep } from './soul-migration-journal.mjs';
import { PACKAGE_IGNORE_LIST, computePackageRevision } from './soul-package.mjs';
import { adoptSoulPackage, editSoulRevision, revisionHistory, revisionPackagePath } from './soul-revisions.mjs';
import { TOOL_HOME_REGISTRY, toolHomeEnv, toolHomeFiles } from './soul-tool-homes.mjs';
import { soulsHome } from './souls-root.mjs';

export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_MANIFEST = 'manifest.json';
export const LIFE_IMPORT_STEP_ID = 'life-import';
// Where a linked workspace's pointer, patch and untracked files land on
// import, until the owner links the checkout again.
export const IMPORTS_DIRECTORY = '.soul-state/imports';
export const COMPONENT_KINDS = Object.freeze(['file', 'dir', 'pointer', 'patch']);
// The archive's own prefixes: the soul root, linked workspaces' records,
// the revision journal. Nothing else is ever an entry.
const AREAS = Object.freeze({ life: 'root', workspaces: 'workspace', journal: 'journal' });
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = '.soul-state';
const USAGE = 'usage: agent-bot soul env export <agentId|name> --to FILE [--plan] [--json] [--principal-stdin] | soul env import FILE [--fork] [--replace] [--name NAME] [--plan] [--json] [--principal-stdin]';
const BLOCK = 512;
const TAR_SIZE_MAX = 0o77777777777; // the 11-octal-digit ustar size field
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const UNTRACKED_MAX_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const text = (value) => (typeof value === 'string' && value.trim() ? value : null);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanLine = (value) => String(value ?? '-').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

function fail(code, message, { action = null } = {}) {
  throw Object.assign(new Error(message), { code, action });
}

function lstat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return null; throw error; }
}

function realpath(file) {
  try { return realpathSync(file); } catch { return null; }
}

// Root-relative, POSIX, no traversal: the contract's own rule, reused so an
// archive path is only ever one the contract can classify.
function safeRelative(relative) {
  try { classifyPath(relative); return true; } catch { return false; }
}

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// ustar

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarHeader({ name, size, mode, mtime, type }) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(mtime, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

// A name longer than the ustar field travels as a GNU long-name entry
// before its own header, which every tar reads.
function* tarEntryHeader(entry) {
  const encoded = Buffer.from(entry.name, 'utf8');
  if (encoded.length > 100) {
    const body = Buffer.concat([encoded, Buffer.alloc(1)]);
    yield tarHeader({ name: '././@LongLink', size: body.length, mode: 0o644, mtime: entry.mtime, type: 'L' });
    yield body;
    yield padding(body.length);
  }
  yield tarHeader({ ...entry, name: encoded.length > 100 ? encoded.subarray(0, 100).toString('utf8') : entry.name });
}

function parseOctal(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  if (field[0] & 0x80) return null; // base-256: beyond what this reader accepts
  const digits = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (digits === '') return 0;
  if (!/^[0-7]+$/.test(digits)) return null;
  return parseInt(digits, 8);
}

function parseHeader(block) {
  if (block.every((byte) => byte === 0)) return null;
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i];
  const checksum = parseOctal(block, 148, 8);
  if (checksum !== sum) fail('import-archive-invalid', 'the archive is not a tar archive this reader accepts (header checksum)');
  const field = (offset, length) => block.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '');
  const size = parseOctal(block, 124, 12);
  const mode = parseOctal(block, 100, 8);
  if (size === null || mode === null) fail('import-archive-invalid', 'the archive uses a size or mode encoding this reader does not accept');
  const prefix = field(345, 155);
  const name = field(0, 100);
  return { name: prefix ? `${prefix}/${name}` : name, size, mode, type: field(156, 1) || '0' };
}

// A streaming tar reader: `open(entry)` returns a sink `{ write, end }` for
// a file entry, or handles a directory and returns null. Every entry's
// type is checked by the caller before a byte of its body is accepted.
class TarReader {
  constructor(open) {
    this.open = open;
    this.buffer = Buffer.alloc(0);
    this.longName = null;
    this.current = null;
    this.ended = false;
    this.entries = 0;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.ended) return;
      if (this.current) {
        const { sink, remaining, pad } = this.current;
        if (remaining > 0) {
          if (!this.buffer.length) return;
          const take = Math.min(remaining, this.buffer.length);
          if (sink) sink.write(this.buffer.subarray(0, take));
          this.buffer = this.buffer.subarray(take);
          this.current.remaining -= take;
          if (this.current.remaining > 0) return;
        }
        if (this.buffer.length < pad) return;
        this.buffer = this.buffer.subarray(pad);
        if (sink) sink.end();
        this.current = null;
        continue;
      }
      if (this.buffer.length < BLOCK) return;
      const header = parseHeader(this.buffer.subarray(0, BLOCK));
      this.buffer = this.buffer.subarray(BLOCK);
      if (header === null) { this.ended = true; return; }
      if (header.type === 'L') {
        if (header.size > 4096) fail('import-unsafe-archive', 'an entry name is longer than 4096 bytes');
        const chunks = [];
        this.current = { remaining: header.size, pad: padding(header.size).length,
          sink: { write: (bytes) => chunks.push(Buffer.from(bytes)), end: () => { this.longName = Buffer.concat(chunks).toString('utf8').replace(/\0+$/, ''); } } };
        continue;
      }
      const name = this.longName ?? header.name;
      this.longName = null;
      this.entries += 1;
      const sink = this.open({ ...header, name });
      this.current = { remaining: header.type === '5' ? 0 : header.size, pad: header.type === '5' ? 0 : padding(header.size).length, sink };
    }
  }
}

const STOP = Symbol('stop reading');

async function readTarGz(file, open) {
  const reader = new TarReader(open);
  const source = createReadStream(file);
  const gunzip = createGunzip();
  try {
    for await (const chunk of source.pipe(gunzip)) reader.push(chunk);
  } catch (error) {
    if (error === STOP) return reader;
    if (error.code && error.code.startsWith('import-')) throw error;
    fail('import-archive-invalid', `the archive could not be read: ${error.code ?? error.message}`);
  } finally { source.destroy(); }
  if (!reader.ended) fail('import-archive-invalid', 'the archive ends before its end-of-archive marker');
  return reader;
}

// ---------------------------------------------------------------------------
// Export: the plan

function resolveSoul(id, options) {
  const file = options.file ?? populationFile(options);
  try { return typeof id === 'string' && id.startsWith('agent_') ? showSoul(id, { file }) : showSoulByName(id, { file }); }
  catch (error) {
    if (/no population record|id must be a valid Agent ID|no soul named|souls named/.test(error.message)) fail('soul-not-found', 'Soul not found.');
    throw error;
  }
}

function soulRoot(soul, options) {
  const registered = typeof soul.soulDir === 'string' && existsSync(soul.soulDir) ? soul.soulDir : null;
  return registered ?? soulDirectory(soul.id, { ...options, readOnly: true });
}

function engineVersion() {
  try { return text(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version); } catch { return null; }
}

// What never travels, beyond what the contract's retention already says:
// each reason names the rule so the manifest explains every omission.
function exclusionRules(soulDir, { env, home }) {
  const exact = new Map();
  const prefixes = [];
  exact.set(`${STATE}/agent-id`, 'the marker; the import writes it for the imported identity');
  prefixes.push([`${STATE}/credentials/`, 'credentials never travel']);
  prefixes.push([`${STATE}/home/node_modules/`, 'harness install (reconstructible; the next launch installs it again)']);
  prefixes.push([`${STATE}/harnesses/`, 'harness install (reconstructible; the next launch installs it again)']);
  for (const harness of Object.keys(TOOL_HOME_REGISTRY)) {
    for (const file of toolHomeFiles(soulDir, harness, { env, home })) {
      if (file.kind === 'sign-in') exact.set(path.relative(soulDir, file.soulPath).split(path.sep).join('/'), `${harness} sign-in file never travels`);
    }
    const routed = toolHomeEnv(soulDir, harness);
    for (const [variable, dir] of Object.entries(routed.env)) {
      if (variable === 'XDG_CACHE_HOME') prefixes.push([`${path.relative(soulDir, dir).split(path.sep).join('/')}/`, `${harness} cache (reconstructible)`]);
    }
  }
  return (relative, classification) => {
    const retention = retentionOf(classification);
    if (classification === 'generated') return 'generated output (reconstructible; the next build regenerates it)';
    if (retention === 'reconstructible') return `${classification} (reconstructible)`;
    if (retention === 'disposable') return `${classification} (disposable)`;
    if (exact.has(relative)) return exact.get(relative);
    for (const [prefix, reason] of prefixes) if (relative === prefix.slice(0, -1) || relative.startsWith(prefix)) return reason;
    const name = relative.startsWith(`${STATE}/`) && !relative.slice(STATE.length + 1).includes('/') ? relative.slice(STATE.length + 1) : null;
    if (name && (/\.lock$|\.tmp$/.test(name) || /^space\.(migrating|link)-/.test(name) || /^\.\w.*\.lock$/.test(name))) return 'transient (a lock or a staging of a run under way)';
    return null;
  };
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

// A linked workspace as a pointer: where it was, what it had checked out,
// its tracked changes as one patch and its untracked files whole. The
// repository itself stays where it is.
function linkedWorkspace(name, link, { now }) {
  let target = null;
  try { target = path.resolve(path.dirname(link), readlinkSync(link)); } catch { /* unreadable link */ }
  const record = { schemaVersion: 1, name, target, exists: Boolean(target && lstat(target)?.isDirectory()), repository: null, toplevel: null, head: null, branch: null, remote: null,
    patch: null, untracked: [], note: null, exportedAt: now().toISOString() };
  const components = [];
  const excluded = [];
  if (record.exists) {
    const toplevel = git(['rev-parse', '--show-toplevel'], target)?.toString('utf8').trim() ?? null;
    if (toplevel) {
      record.toplevel = toplevel;
      record.repository = git(['rev-parse', '--git-dir'], target)?.toString('utf8').trim() ?? null;
      if (record.repository && !path.isAbsolute(record.repository)) record.repository = path.resolve(target, record.repository);
      record.head = git(['rev-parse', 'HEAD'], target)?.toString('utf8').trim() ?? null;
      record.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], target)?.toString('utf8').trim() ?? null;
      record.remote = git(['remote', 'get-url', 'origin'], target)?.toString('utf8').trim() ?? null;
      const patch = record.head ? git(['diff', '--binary', 'HEAD', '--'], target) : null;
      if (patch?.length) {
        record.patch = 'changes.patch';
        components.push({ area: 'workspace', workspace: name, entry: `workspaces/${name}/changes.patch`, relative: `worktrees/${name}`, classification: 'workspace', retention: 'durable',
          kind: 'patch', bytes: patch.length, sha256: sha256Bytes(patch), mode: 0o600, source: { bytes: patch } });
      }
      const listed = git(['ls-files', '--others', '--exclude-standard', '-z'], target);
      for (const relative of (listed?.toString('utf8') ?? '').split('\0').filter(Boolean).sort()) {
        if (!safeRelative(relative)) { excluded.push({ relative: `worktrees/${name}/${relative}`, classification: 'workspace', reason: 'untracked path not representable' }); continue; }
        const file = path.join(target, ...relative.split('/'));
        const stat = lstat(file);
        if (!stat?.isFile()) { excluded.push({ relative: `worktrees/${name}/${relative}`, classification: 'workspace', reason: stat?.isSymbolicLink() ? 'untracked link' : 'not a regular file' }); continue; }
        if (stat.size > UNTRACKED_MAX_BYTES) { excluded.push({ relative: `worktrees/${name}/${relative}`, classification: 'workspace', reason: `untracked file larger than ${UNTRACKED_MAX_BYTES} bytes` }); continue; }
        record.untracked.push(relative);
        components.push({ area: 'workspace', workspace: name, entry: `workspaces/${name}/untracked/${relative}`, relative: `worktrees/${name}/${relative}`, classification: 'workspace', retention: 'durable',
          kind: 'file', bytes: stat.size, sha256: sha256File(file), mode: stat.mode & 0o7777, source: { file, mtime: stat.mtimeMs } });
      }
    } else record.note = 'not a git checkout (or git is not available); the pointer names the path only';
  } else record.note = 'the link target does not exist here';
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  components.unshift({ area: 'workspace', workspace: name, entry: `workspaces/${name}/pointer.json`, relative: `worktrees/${name}`, classification: 'workspace', retention: 'durable',
    kind: 'pointer', target, bytes: bytes.length, sha256: sha256Bytes(bytes), mode: 0o600, source: { bytes } });
  return { record, components, excluded };
}

/**
 * Walks a soul root and decides what travels: `{ manifest, sources }`. The
 * manifest is what the archive carries as `manifest.json`; `sources` map
 * each entry to the file or bytes it is written from. Read-only.
 */
export function planSoulExport(soulDir, { agentId, name = null, displayName = null, spacePath = null, identity = null, stateDir = null,
  env = process.env, home = env.HOME ?? homedir(), now = () => new Date() } = {}) {
  const excludedBy = exclusionRules(soulDir, { env, home });
  const components = [];
  const excluded = [];
  const workspaces = [];
  const memory = { location: null, target: null };
  const push = (component) => { components.push(component); return component; };
  const fileComponent = (relative, file, stat, classification) => {
    if (stat.size > TAR_SIZE_MAX) fail('export-file-too-large', `${relative} is larger than the archive format carries (${TAR_SIZE_MAX} bytes)`);
    return push({ area: 'root', entry: `life/${relative}`, relative, classification, retention: retentionOf(classification), kind: 'file', bytes: stat.size,
      sha256: sha256File(file), mode: stat.mode & 0o7777, source: { file, mtime: stat.mtimeMs } });
  };
  const walk = (directory, prefix) => {
    let names = [];
    try { names = readdirSync(directory).sort(); } catch { return; }
    for (const name of names) {
      const file = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!safeRelative(relative)) { excluded.push({ relative: cleanLine(relative), classification: null, reason: 'path not representable' }); continue; }
      const stat = lstat(file);
      if (!stat) continue;
      const classification = classifyPath(relative);
      const reason = excludedBy(relative, classification);
      if (reason) { excluded.push({ relative, classification, reason }); continue; }
      if (stat.isSymbolicLink()) {
        if (prefix === 'worktrees') {
          const linked = linkedWorkspace(name, file, { now });
          workspaces.push({ name, location: 'linked', target: linked.record.target, head: linked.record.head, branch: linked.record.branch, remote: linked.record.remote,
            patch: linked.record.patch !== null, untracked: linked.record.untracked.length, note: linked.record.note });
          components.push(...linked.components);
          excluded.push(...linked.excluded);
          continue;
        }
        // The soul's own memory, linked from before slice 5 (the census
        // says so), is read through the link so the life carries it and
        // lands inside on import. Any other link is a pointer: what it
        // points at is not the soul's to carry.
        let target = null;
        try { target = path.resolve(directory, readlinkSync(file)); } catch { /* unreadable */ }
        if (relative === `${STATE}/space` && target && spacePath && realpath(target) !== null && realpath(target) === realpath(spacePath)) {
          memory.location = 'linked';
          memory.target = target;
          walkInto(target, relative);
          continue;
        }
        push({ area: 'root', entry: null, relative, classification, retention: retentionOf(classification), kind: 'pointer', target, bytes: 0, sha256: null, mode: null });
        continue;
      }
      if (stat.isDirectory()) {
        if (relative === `${STATE}/space`) memory.location = 'inside';
        if (prefix === 'worktrees') workspaces.push({ name, location: 'inside', target: null, head: null, branch: null, remote: null, patch: false, untracked: 0, note: null });
        walkInto(file, relative, stat);
        continue;
      }
      if (stat.isFile()) { fileComponent(relative, file, stat, classification); continue; }
      excluded.push({ relative, classification, reason: 'not a regular file, directory or link' });
    }
  };
  const walkInto = (directory, relative, stat = lstat(directory)) => {
    const before = components.length;
    walk(directory, relative);
    // An empty directory travels as itself, so the structure comes back.
    if (components.length === before) {
      push({ area: 'root', entry: `life/${relative}`, relative, classification: classifyPath(relative), retention: retentionOf(classifyPath(relative)), kind: 'dir', bytes: 0, sha256: null,
        mode: (stat?.mode ?? 0o700) & 0o7777, source: { mtime: stat?.mtimeMs ?? now().getTime() } });
    }
  };
  walk(soulDir, '');
  // The revision journal (ADR-0583 decision 10): the daemon's events and
  // stored package objects for this soul, so the chain continues where it
  // left off. Locks and stagings stay.
  const journal = stateDir ? path.join(stateDir, 'soul-revisions', agentId) : null;
  let journalEntries = 0;
  if (journal && lstat(journal)?.isDirectory()) {
    const walkJournal = (directory, prefix) => {
      for (const name of readdirSync(directory).sort()) {
        if (name === '.lock' || name.startsWith('.package-') || /\.tmp$/.test(name)) continue;
        const file = path.join(directory, name);
        const relative = prefix ? `${prefix}/${name}` : name;
        if (!safeRelative(relative)) continue;
        const stat = lstat(file);
        if (stat?.isDirectory()) walkJournal(file, relative);
        else if (stat?.isFile()) {
          if (stat.size > TAR_SIZE_MAX) fail('export-file-too-large', `revision journal ${relative} is larger than the archive format carries`);
          push({ area: 'journal', entry: `journal/${relative}`, relative: null, classification: 'history', retention: 'durable', kind: 'file', bytes: stat.size,
            sha256: sha256File(file), mode: stat.mode & 0o7777, source: { file, mtime: stat.mtimeMs } });
          journalEntries += 1;
        }
      }
    };
    walkJournal(journal, '');
  }
  const sources = new Map();
  for (const component of components) {
    if (component.entry) sources.set(component.entry, component.source);
    delete component.source;
  }
  const manifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION, agentId, name, displayName, exportedAt: now().toISOString(), engineVersion: engineVersion(), root: soulDir,
    identity: identity ? { harness: text(identity.harness), parentId: identity.parentId ?? null, genesis: identity.genesis ?? null, createdAt: text(identity.createdAt) } : null,
    memory, workspaces, journal: { entries: journalEntries },
    components, excluded,
    totals: { files: components.filter((c) => c.entry && c.kind !== 'dir').length, bytes: components.reduce((sum, c) => sum + c.bytes, 0) },
  };
  return { manifest, sources };
}

// ---------------------------------------------------------------------------
// Export: the write

async function* tarChunks(manifest, sources, now) {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const mtime = Math.floor(now().getTime() / 1000);
  yield* tarEntryHeader({ name: EXPORT_MANIFEST, size: manifestBytes.length, mode: 0o600, mtime, type: '0' });
  yield manifestBytes;
  yield padding(manifestBytes.length);
  for (const component of manifest.components) {
    if (!component.entry) continue;
    const source = sources.get(component.entry);
    const entryTime = Math.floor((source?.mtime ?? now().getTime()) / 1000);
    if (component.kind === 'dir') {
      yield* tarEntryHeader({ name: `${component.entry}/`, size: 0, mode: component.mode, mtime: entryTime, type: '5' });
      continue;
    }
    yield* tarEntryHeader({ name: component.entry, size: component.bytes, mode: component.mode, mtime: entryTime, type: '0' });
    if (source.bytes) { yield source.bytes; yield padding(source.bytes.length); continue; }
    // Read again while writing, hashed on the way: a file that changed
    // since the plan would leave the manifest lying about the archive.
    const hash = createHash('sha256');
    let written = 0;
    const fd = openSync(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      for (;;) {
        const read = readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) break;
        if (written + read > component.bytes) fail('export-changed', `${component.relative ?? component.entry} changed while it was being exported; stop the soul and run the export again`);
        const bytes = Buffer.from(chunk.subarray(0, read));
        hash.update(bytes);
        written += read;
        yield bytes;
      }
    } finally { closeSync(fd); }
    if (written !== component.bytes || hash.digest('hex') !== component.sha256) {
      fail('export-changed', `${component.relative ?? component.entry} changed while it was being exported; stop the soul and run the export again`);
    }
    yield padding(component.bytes);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Writes the planned archive to `file` (which must not exist), privately, through a rename. */
export async function writeSoulExport(plan, file, { now = () => new Date() } = {}) {
  const target = path.resolve(file);
  if (lstat(target)) fail('export-target-exists', `${target} already exists; choose another path`, { action: 'pick a file that does not exist yet' });
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await pipeline(Readable.from(tarChunks(plan.manifest, plan.sources, now)), createGzip({ level: 6 }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
  return target;
}

// ---------------------------------------------------------------------------
// Import: the manifest and the archive

function validateManifest(manifest) {
  const bad = (message) => fail('import-manifest-invalid', `manifest.json: ${message}`);
  if (!object(manifest)) bad('not an object');
  if (manifest.schemaVersion !== EXPORT_SCHEMA_VERSION) bad(`schemaVersion ${manifest.schemaVersion} is not ${EXPORT_SCHEMA_VERSION}`);
  if (!isAgentId(manifest.agentId)) bad('agentId is not an Agent ID');
  if (manifest.name !== null && (typeof manifest.name !== 'string' || !NAME_PATTERN.test(manifest.name))) bad('name is not a census handle');
  if (manifest.displayName !== null && (typeof manifest.displayName !== 'string' || manifest.displayName.length > 128 || /[\x00-\x1f\x7f]/.test(manifest.displayName))) bad('displayName is not printable text');
  if (!Array.isArray(manifest.components) || !Array.isArray(manifest.excluded)) bad('components and excluded must be arrays');
  const entries = new Set();
  for (const component of manifest.components) {
    if (!object(component)) bad('a component is not an object');
    if (!COMPONENT_KINDS.includes(component.kind)) bad(`component kind ${cleanLine(component.kind)} is unknown`);
    if (!CLASSIFICATIONS.includes(component.classification) || component.retention !== retentionOf(component.classification)) bad(`${cleanLine(component.entry ?? component.relative)}: classification or retention is not the contract's`);
    if (component.retention !== 'durable') bad(`${cleanLine(component.entry ?? component.relative)}: only durable state travels`);
    if (!Number.isSafeInteger(component.bytes) || component.bytes < 0) bad(`${cleanLine(component.entry)}: bytes`);
    if (component.relative !== null && !safeRelative(component.relative)) fail('import-unsafe-archive', `manifest.json names a path outside the root: ${cleanLine(component.relative)}`);
    if (component.entry === null) {
      if (component.kind !== 'pointer') bad(`${cleanLine(component.relative)}: only a pointer has no entry`);
      continue;
    }
    if (typeof component.entry !== 'string' || !safeRelative(component.entry)) fail('import-unsafe-archive', `manifest.json names an entry outside the archive: ${cleanLine(component.entry)}`);
    const [area] = component.entry.split('/');
    if (!Object.hasOwn(AREAS, area) || component.area !== AREAS[area] || !component.entry.includes('/')) fail('import-unsafe-archive', `manifest.json names an entry outside the archive's prefixes: ${cleanLine(component.entry)}`);
    if (area === 'life' && component.entry !== `life/${component.relative}`) fail('import-unsafe-archive', `${cleanLine(component.entry)} does not name its root path`);
    if (area === 'workspaces' && (!SEGMENT.test(component.workspace ?? '') || !component.entry.startsWith(`workspaces/${component.workspace}/`))) fail('import-unsafe-archive', `${cleanLine(component.entry)} names no workspace`);
    if (component.kind !== 'dir' && (typeof component.sha256 !== 'string' || !SHA256.test(component.sha256))) bad(`${cleanLine(component.entry)}: sha256`);
    if (!Number.isInteger(component.mode)) bad(`${cleanLine(component.entry)}: mode`);
    if (entries.has(component.entry)) bad(`${cleanLine(component.entry)} is listed twice`);
    entries.add(component.entry);
  }
  return manifest;
}

/** Reads and validates the archive's manifest (its first entry) without extracting anything. */
export async function readExportManifest(file) {
  let manifest = null;
  const chunks = [];
  await readTarGz(file, (entry) => {
    if (manifest) throw STOP;
    if (entry.name !== EXPORT_MANIFEST || (entry.type !== '0' && entry.type !== '\0')) fail('import-unsafe-archive', `the archive's first entry is ${cleanLine(entry.name)}, not ${EXPORT_MANIFEST}`);
    if (entry.size > MANIFEST_MAX_BYTES) fail('import-manifest-invalid', 'manifest.json is larger than this reader accepts');
    return { write: (bytes) => chunks.push(Buffer.from(bytes)), end: () => {
      try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail('import-manifest-invalid', 'manifest.json is not JSON'); }
    } };
  });
  if (!manifest) fail('import-manifest-invalid', `the archive has no ${EXPORT_MANIFEST}`);
  return validateManifest(manifest);
}

// Where an archive entry lands in the staging: the soul root for `life/`,
// `.soul-state/imports/<name>/` for a workspace's records, `.journal/` for
// the revision journal (moved to the state directory once verified).
function stagingPath(staging, entry) {
  const [area, ...rest] = entry.split('/');
  if (area === 'life') return path.join(staging, ...rest);
  if (area === 'workspaces') return path.join(staging, STATE, 'imports', ...rest);
  if (area === 'journal') return path.join(staging, '.journal', ...rest);
  fail('import-unsafe-archive', `entry ${cleanLine(entry)} is outside the archive's prefixes`);
}

/**
 * Extracts the archive into `staging` (fresh, private), verifying every
 * entry against the manifest: only regular files and directories the
 * manifest lists, under its prefixes, with the manifest's SHA-256; a
 * symlink or any other entry type, an entry the manifest does not name, a
 * hash that does not match or a listed entry that never arrives refuses
 * the import. Returns `{ manifest, files, bytes }`.
 */
export async function extractSoulExport(file, staging) {
  let manifest = null;
  const expected = new Map();
  const seen = new Set();
  let files = 0, bytes = 0;
  mkdirSync(staging, { mode: 0o700 });
  await readTarGz(file, (entry) => {
    const name = entry.name.replace(/\/$/, '');
    if (!manifest) {
      if (name !== EXPORT_MANIFEST || (entry.type !== '0' && entry.type !== '\0')) fail('import-unsafe-archive', `the archive's first entry is ${cleanLine(name)}, not ${EXPORT_MANIFEST}`);
      if (entry.size > MANIFEST_MAX_BYTES) fail('import-manifest-invalid', 'manifest.json is larger than this reader accepts');
      const chunks = [];
      return { write: (b) => chunks.push(Buffer.from(b)), end: () => {
        try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('import-manifest-invalid', 'manifest.json is not JSON'); }
        validateManifest(manifest);
        for (const component of manifest.components) if (component.entry) expected.set(component.entry, component);
      } };
    }
    if (entry.type !== '0' && entry.type !== '\0' && entry.type !== '5') fail('import-unsafe-archive', `${cleanLine(name)} is not a regular file or directory (type ${cleanLine(entry.type)})`);
    if (name === EXPORT_MANIFEST || path.isAbsolute(name) || !safeRelative(name)) fail('import-unsafe-archive', `entry ${cleanLine(name)} is not a safe relative path`);
    const component = expected.get(name);
    if (!component) fail('import-unsafe-archive', `entry ${cleanLine(name)} is not in the manifest`);
    if (seen.has(name)) fail('import-unsafe-archive', `entry ${cleanLine(name)} appears twice`);
    seen.add(name);
    const target = stagingPath(staging, name);
    if (entry.type === '5') {
      if (component.kind !== 'dir') fail('import-unsafe-archive', `${cleanLine(name)} is a directory but the manifest lists a ${component.kind}`);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      return null;
    }
    if (component.kind === 'dir') fail('import-unsafe-archive', `${cleanLine(name)} is a file but the manifest lists a directory`);
    if (entry.size !== component.bytes) fail('import-checksum-mismatch', `${cleanLine(name)} is ${entry.size} bytes, the manifest says ${component.bytes}`);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, (component.mode & 0o7777) | 0o600);
    const hash = createHash('sha256');
    return { write: (b) => { hash.update(b); writeSync(fd, b); }, end: () => {
      closeSync(fd);
      if (hash.digest('hex') !== component.sha256) fail('import-checksum-mismatch', `${cleanLine(name)} does not match its SHA-256 in the manifest`);
      files += 1;
      bytes += component.bytes;
    } };
  });
  if (!manifest) fail('import-manifest-invalid', `the archive has no ${EXPORT_MANIFEST}`);
  for (const entry of expected.keys()) if (!seen.has(entry)) fail('import-archive-incomplete', `${cleanLine(entry)} is in the manifest but not in the archive`);
  return { manifest, files, bytes };
}

// ---------------------------------------------------------------------------
// Import: identity and destination

function census(id, file) {
  try { return showSoul(id, { file }); } catch { return null; }
}

/**
 * The identity decision and the destination for an archive, read-only:
 * `{ decision: keep | replace | fork, agentId, importedFrom, existing,
 * name, displayName, soulDir, replaced }`. `keep` is a moved life whose ID
 * is unknown here; an active ID is `import-id-active` unless `--replace`
 * (`replace`) or `--fork` (`fork`, a new ID minted on apply); a retired ID
 * is a tombstone, `import-id-retired`, and can only come back as a fork.
 */
export function planSoulImport(manifest, { fork = false, replace = false, name = null, env = process.env, home = env.HOME ?? homedir(), file = populationFile({ env, home }), stateDir = stateDirectory({ env, home }), ...rest } = {}) {
  const options = { env, home, file, ...rest };
  const id = manifest.agentId;
  const existing = census(id, file);
  let identity = null;
  try { identity = readAgentIdentity(id, { stateDir }); } catch { /* unknown here */ }
  const { root } = soulsHome(options);
  const handle = text(manifest.name);
  const displayName = text(name) ?? text(manifest.displayName) ?? handle;
  const summary = existing ? { status: existing.status ?? null, soulDir: existing.soulDir ?? null } : null;
  if (fork) {
    // The folder's name is the handle's; a fork whose default is taken gets
    // the minted ID's tail, which only the apply knows.
    const base = handle ?? 'soul';
    const named = path.join(root, `${base}.soul`);
    return { decision: 'fork', agentId: null, importedFrom: id, existing: summary, name: null, displayName, base, soulDir: lstat(named) ? path.join(root, `${base}-<agent id tail>.soul`) : named, replaced: null };
  }
  if (existing?.status === 'retired' || identity?.status === 'retired') {
    fail('import-id-retired', `${id} is retired here; a retired soul never comes back under its ID`, { action: 'add --fork to import it as a new soul' });
  }
  if (existing) {
    if (!replace) fail('import-id-active', `${id} is an active soul here (${existing.soulDir ?? 'no folder registered'})`, { action: 'add --replace to overwrite its life, or --fork to import as a new soul' });
    const soulDir = typeof existing.soulDir === 'string' && lstat(existing.soulDir) ? existing.soulDir : soulDirectory(id, { ...options, readOnly: true });
    return { decision: 'replace', agentId: id, importedFrom: id, existing: summary, name: existing.name ?? handle, displayName: text(name) ?? existing.displayName ?? displayName, base: null, soulDir, replaced: lstat(soulDir) ? soulDir : null };
  }
  return { decision: 'keep', agentId: id, importedFrom: id, existing: null, name: handle, displayName, base: handle ?? 'soul', soulDir: freshDestination(root, handle ?? 'soul', id), replaced: null };
}

// The census default, `<root>/<name>.soul`, or one carrying the ID's tail
// when that path is taken (as `soulDirectory` falls back, #92).
function freshDestination(root, name, id) {
  const named = path.join(root, `${name}.soul`);
  return lstat(named) ? path.join(root, `${name}-${id.slice(-8)}.soul`) : named;
}

// A restored space carries the exported soul's marker; a fork rewrites it
// to the new ID, a kept ID checks it. No space at all gets a fresh one.
function bindSpace(staging, agentId, { now }) {
  const space = path.join(staging, STATE, 'space');
  const marker = path.join(space, 'space.json');
  if (lstat(space)?.isDirectory() && lstat(marker)?.isFile()) {
    let record = null;
    try { record = JSON.parse(readFileSync(marker, 'utf8')); } catch { /* rewritten below */ }
    const next = { ...(object(record) ? record : { schemaVersion: 1, createdAt: now().toISOString() }), agentId };
    writeFileSync(marker, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { path: space, created: false };
  }
  rmSync(space, { recursive: true, force: true });
  const created = initSoulSpace(agentId, staging, { now });
  return { path: created.path, created: true };
}

function moveTree(from, to) {
  try { renameSync(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}

const stamp = (date) => date.toISOString().replace(/[:.]/g, '-');

/**
 * Restores an extracted staging as a soul: identity (kept, or minted for a
 * fork), the marker, the space binding, the revision journal (restored
 * when the archive carries one and none exists here, else adopted), then
 * the folder into place, the census and the migration journal. Returns the
 * import record.
 */
async function restoreSoul({ archive, staging, manifest, plan, env, home, file, stateDir, now, config, authorization }) {
  const options = { env, home, file, ...(config === undefined ? {} : { config }) };
  let agentId = plan.agentId;
  let journal = null;
  const journalStaging = path.join(staging, '.journal');
  const carriedJournal = lstat(journalStaging)?.isDirectory() && readdirSync(journalStaging).some((name) => /^\d{10}\.json$/.test(name));
  const manifestPath = path.join(staging, 'soul.json');
  if (plan.decision === 'fork') {
    // As `soul fork` does: the original's credentials declaration names
    // its GitHub App, so the fork drops it; the seed changes after genesis.
    let packageManifest = {};
    try { packageManifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { fail('import-manifest-invalid', 'the exported soul.json cannot be read'); }
    const { credentials: _original, ...kept } = packageManifest;
    const next = { ...kept, formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, template: false, parentRevision: null, templateRevision: packageManifest.templateRevision ?? packageManifest.revision };
    const save = () => writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
    save();
    next.revision = computePackageRevision(staging);
    save();
    const identity = mintAgentIdentity({ env, home, stateDir, now, appSlug: null, packagePath: staging, harness: manifest.identity?.harness ?? null, parentId: null, useGithub: false });
    agentId = identity.id;
    const revisionOptions = { stateDir, now, soulDir: staging, ...(authorization?.method ? { authorization } : {}) };
    adoptSoulPackage(agentId, staging, { ...revisionOptions, reason: `Import as a fork of ${manifest.agentId}` });
    next.displaySeed = agentId;
    save();
    const initialized = await editSoulRevision(agentId, staging, { ...revisionOptions, reason: 'Initialize display seed from imported identity' });
    writeFileSync(manifestPath, readFileSync(path.join(revisionPackagePath(agentId, initialized.revision, revisionOptions), 'soul.json')));
    journal = 'adopted';
    rmSync(journalStaging, { recursive: true, force: true });
  } else {
    let identity = null;
    try { identity = readAgentIdentity(agentId, { stateDir }); } catch { /* unknown here: a moved life */ }
    if (identity?.status === 'retired') fail('import-id-retired', `${agentId} is retired here`, { action: 'add --fork to import it as a new soul' });
    if (!identity) mintAgentIdentity({ env, home, stateDir, now, appSlug: null, idFactory: () => agentId, harness: manifest.identity?.harness ?? null, parentId: manifest.identity?.parentId ?? null, useGithub: false });
    const local = path.join(stateDir, 'soul-revisions', agentId);
    const localHead = revisionHistory(agentId, { stateDir }).length > 0;
    if (localHead) { journal = 'kept-local'; rmSync(journalStaging, { recursive: true, force: true }); }
    else if (carriedJournal) {
      mkdirSync(path.dirname(local), { recursive: true, mode: 0o700 });
      rmSync(local, { recursive: true, force: true });
      moveTree(journalStaging, local);
      journal = 'restored';
    } else {
      adoptSoulPackage(agentId, staging, { stateDir, now, soulDir: staging, reason: `Import of a moved life from ${manifest.root ?? 'another host'}`, ...(authorization?.method ? { authorization } : {}) });
      journal = 'adopted';
      rmSync(journalStaging, { recursive: true, force: true });
    }
  }
  writeFileSync(path.join(staging, STATE, 'agent-id'), `${agentId}\n`, { mode: 0o600 });
  const space = bindSpace(staging, agentId, { now });
  // The folder into place: a replaced root is moved aside first, never deleted.
  let replaced = null;
  if (plan.decision === 'replace' && plan.replaced && lstat(plan.replaced)) {
    replaced = `${plan.replaced}.replaced-${stamp(now())}`;
    renameSync(plan.replaced, replaced);
  }
  const destination = plan.decision === 'replace' ? plan.soulDir : freshDestination(path.dirname(plan.soulDir), plan.base, agentId);
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (lstat(destination)) fail('import-destination-exists', `${destination} exists; move it aside`, { action: `move ${destination} aside and run the import again` });
  moveTree(staging, destination);
  const spacePath = path.join(destination, STATE, 'space');
  const record = upsertSoul({ id: agentId, ...(plan.name ? { name: plan.name } : {}), displayName: plan.displayName, soulDir: destination, spacePath, status: 'active',
    parentId: plan.decision === 'fork' ? null : manifest.identity?.parentId ?? null, appSlug: null }, { file, now });
  registerSoulDir(agentId, destination, { file });
  setSoulSpacePath(agentId, spacePath, { file });
  const workspaces = (manifest.workspaces ?? []).filter((row) => row.location === 'linked').map((row) => ({ ...row, imported: `${IMPORTS_DIRECTORY}/${row.name}` }));
  const step = recordMigrationStep(destination, { id: LIFE_IMPORT_STEP_ID, status: 'done', from: archive, to: destination, at: now().toISOString(),
    note: `${plan.decision}: ${manifest.components.filter((c) => c.entry && c.kind !== 'dir').length} file(s) from ${manifest.agentId}${agentId !== manifest.agentId ? ` as ${agentId}` : ''}; journal ${journal}; ${workspaces.length} workspace(s) to link again`,
    identity: { decision: plan.decision, agentId, importedFrom: manifest.agentId }, journal, replaced, workspaces: workspaces.map((row) => row.name), space: space.created ? 'created' : 'restored' });
  return { agentId, name: record.name, displayName: record.displayName ?? null, soulDir: destination, replaced, journal, space: step.space, workspaces, step };
}

// ---------------------------------------------------------------------------
// Commands

const counts = (components) => {
  const by = {};
  for (const component of components) {
    if (!component.entry || component.kind === 'dir') continue;
    by[component.classification] = by[component.classification] ?? { files: 0, bytes: 0 };
    by[component.classification].files += 1;
    by[component.classification].bytes += component.bytes;
  }
  return by;
};

export function formatExport(result) {
  const m = result.manifest;
  const lines = [`agentId: ${m.agentId}`, `name: ${cleanLine(m.displayName ?? m.name)}`, `soulDir: ${cleanLine(m.root)}`, `decision: ${result.decision}`,
    `file: ${cleanLine(result.file ?? '-')}`, ''];
  const by = counts(m.components);
  lines.push(`carried (${Object.values(by).reduce((s, c) => s + c.files, 0)} file(s), ${Object.values(by).reduce((s, c) => s + c.bytes, 0)} byte(s))`);
  for (const [classification, row] of Object.entries(by)) lines.push(`  ${classification}: ${row.files} file(s), ${row.bytes} byte(s)`);
  for (const pointer of m.components.filter((c) => c.kind === 'pointer' && c.area === 'root')) lines.push(`  pointer ${cleanLine(pointer.relative)} -> ${cleanLine(pointer.target)}`);
  lines.push(`memory: ${m.memory.location ?? 'absent'}${m.memory.target ? ` (${cleanLine(m.memory.target)})` : ''}`, `revision journal: ${m.journal.entries} entr${m.journal.entries === 1 ? 'y' : 'ies'}`);
  if (m.workspaces.length) {
    lines.push('workspaces');
    for (const w of m.workspaces) lines.push(`  ${cleanLine(w.name)}: ${w.location}${w.location === 'linked' ? ` -> ${cleanLine(w.target)}${w.branch ? ` (${cleanLine(w.branch)}${w.head ? ` ${w.head.slice(0, 12)}` : ''})` : ''}, patch ${w.patch ? 'yes' : 'no'}, ${w.untracked} untracked` : ''}${w.note ? ` - ${cleanLine(w.note)}` : ''}`);
  }
  if (m.excluded.length) {
    lines.push(`excluded (${m.excluded.length})`);
    for (const row of m.excluded) lines.push(`  ${cleanLine(row.relative)}: ${cleanLine(row.reason)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatImport(result) {
  const lines = [`archive: ${cleanLine(result.archive)}`, `decision: ${result.decision}`, `identity: ${result.identity.decision} (${result.identity.agentId ?? 'minted on apply'} from ${result.identity.importedFrom})`,
    `soulDir: ${cleanLine(result.soulDir)}`, `name: ${cleanLine(result.displayName ?? result.name)}`];
  if (result.replaced) lines.push(`replaced: ${cleanLine(result.replaced)}`);
  lines.push(`journal: ${result.journal ?? '-'}`, '');
  const by = result.restored.byClassification;
  lines.push(`${result.applied ? 'restored' : 'would restore'} (${result.restored.files} file(s), ${result.restored.bytes} byte(s))`);
  for (const [classification, row] of Object.entries(by)) lines.push(`  ${classification}: ${row.files} file(s), ${row.bytes} byte(s)`);
  for (const pointer of result.pointers) lines.push(`  pointer ${cleanLine(pointer.relative)} -> ${cleanLine(pointer.target)} (not restored)`);
  if (result.workspaces.length) {
    lines.push('workspaces to link again');
    for (const w of result.workspaces) lines.push(`  ${cleanLine(w.name)}: ${cleanLine(w.target)}${w.branch ? ` (${cleanLine(w.branch)})` : ''}, patch ${w.patch ? 'yes' : 'no'}, ${w.untracked} untracked -> ${w.imported}`);
  }
  return `${lines.join('\n')}\n`;
}

async function soulIsRunning(agentId, { env, home }) {
  const { soulRunning } = await import('./soul-comms.mjs');
  return soulRunning(agentId, { env, home });
}

function readPrincipal(presented, readStdin) {
  if (!presented) return null;
  try { return JSON.parse(readStdin()); }
  catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
}

/**
 * `agent-bot soul env export <soul> --to FILE [--plan] [--json]
 * [--principal-stdin]`. Prints `{ schemaVersion, agentId, soulDir, applied,
 * decision: planned | exported, file, manifest }`. `--plan` is read-only
 * and prints the manifest; the write is owner-gated (the archive holds the
 * soul's private home) and refused `soul-running` while the soul has a turn
 * in flight or a warm harness, checked before and after the gate.
 */
export async function soulEnvExportCommand(argv, { gate = ownerGate, readStdin = () => readFileSync(0, 'utf8'), write = (value) => process.stdout.write(value),
  env = process.env, home = env.HOME ?? homedir(), cwd = process.cwd(), now = () => new Date(), running = soulIsRunning, ...rest } = {}) {
  let id = null, to = null, json = false, plan = false, presented = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan' && !plan) plan = true;
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented) presented = true;
    else if (arg === '--to' && to === null && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') { to = argv[i + 1]; i += 1; }
    else if (!arg.startsWith('-') && id === null) id = arg;
    else throw new Error(USAGE);
  }
  if (!id || (!to && !plan) || (plan && presented)) throw new Error(USAGE);
  const principal = readPrincipal(presented, readStdin);
  const options = { env, home, now, ...rest };
  const file = options.file ?? populationFile(options);
  const stateDir = options.stateDir ?? stateDirectory(options);
  const soul = resolveSoul(id, { ...options, file });
  const soulDir = soulRoot(soul, { ...options, file });
  if (!lstat(path.join(soulDir, STATE))?.isDirectory()) fail('soul-state-missing', `${soulDir} has no .soul-state yet; spawn or launch the soul first`);
  const target = to ? path.resolve(cwd, to) : null;
  if (target) {
    const inside = path.relative(soulDir, target);
    if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) fail('export-target-inside-root', `${target} is inside the soul root; write the archive elsewhere`);
    if (lstat(target)) fail('export-target-exists', `${target} already exists; choose another path`, { action: 'pick a file that does not exist yet' });
  }
  let identity = null;
  try { identity = readAgentIdentity(soul.id, { stateDir }); } catch { /* no record: the manifest says so */ }
  const planOptions = { agentId: soul.id, name: soul.name ?? null, displayName: soul.displayName ?? null, spacePath: soul.spacePath ?? null, identity, stateDir, env, home, now };
  const planned = planSoulExport(soulDir, planOptions);
  const emit = (result) => { write(json ? `${JSON.stringify(result)}\n` : formatExport(result)); return result; };
  const base = { schemaVersion: EXPORT_SCHEMA_VERSION, agentId: soul.id, soulDir, applied: false, decision: 'planned', file: target, manifest: planned.manifest };
  if (plan) return emit(base);
  const refuseRunning = () => fail('soul-running', `${soul.id} is running (a turn in flight or a warm harness); stop it before exporting its life`, { action: `agent-bot soul stop ${soul.id}` });
  if (await running(soul.id, { env, home })) refuseRunning();
  await gate(`export ${soul.id}'s life to ${target}`, { principal, env, cwd });
  if (await running(soul.id, { env, home })) refuseRunning();
  // Planned again after the gate: the owner may have taken a while.
  const fresh = planSoulExport(soulDir, planOptions);
  let written;
  try { written = await writeSoulExport(fresh, target, { now }); }
  catch (error) {
    appendAuditReceipt({ event: 'soul-env-export', agentId: soul.id, operation: 'export', decision: 'failed', detail: `${error.code ?? 'error'}: ${error.message}` }, { env, home, now });
    throw error;
  }
  // Counts and the archive's path, short enough for a receipt line; never
  // a file's contents. The manifest inside the archive holds the detail.
  appendAuditReceipt({ event: 'soul-env-export', agentId: soul.id, operation: 'export', decision: 'exported',
    detail: `${fresh.manifest.totals.files} file(s), ${fresh.manifest.totals.bytes} byte(s), ${fresh.manifest.excluded.length} excluded, ${fresh.manifest.workspaces.filter((w) => w.location === 'linked').length} linked workspace(s) as pointers, to ${written}` }, { env, home, now });
  return emit({ ...base, applied: true, decision: 'exported', file: written, manifest: fresh.manifest });
}

/**
 * `agent-bot soul env import FILE [--fork] [--replace] [--name NAME]
 * [--plan] [--json] [--principal-stdin]`. Prints `{ schemaVersion, archive,
 * applied, decision: planned | imported | replaced | forked, identity
 * { decision, agentId, importedFrom, existing }, soulDir, replaced, name,
 * displayName, journal, restored { files, bytes, byClassification },
 * pointers[], workspaces[], migration }`. `--plan` reads the manifest and
 * decides identity and destination without extracting a byte. The apply is
 * owner-gated; `--replace` is refused `soul-running` while the existing
 * soul runs, checked before and after the gate.
 */
export async function soulEnvImportCommand(argv, { gate = ownerGate, readStdin = () => readFileSync(0, 'utf8'), write = (value) => process.stdout.write(value),
  env = process.env, home = env.HOME ?? homedir(), cwd = process.cwd(), now = () => new Date(), running = soulIsRunning, ...rest } = {}) {
  let archive = null, fork = false, replace = false, name = null, json = false, plan = false, presented = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fork' && !fork) fork = true;
    else if (arg === '--replace' && !replace) replace = true;
    else if (arg === '--plan' && !plan) plan = true;
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented) presented = true;
    else if (arg === '--name' && name === null && typeof argv[i + 1] === 'string' && argv[i + 1] !== '' && !argv[i + 1].startsWith('-')) { name = argv[i + 1]; i += 1; }
    else if (!arg.startsWith('-') && archive === null) archive = arg;
    else throw new Error(USAGE);
  }
  if (!archive || (fork && replace) || (plan && presented)) throw new Error(USAGE);
  if (name !== null && (name.length > 128 || /[\x00-\x1f\x7f]/.test(name))) throw new Error('--name must be printable text of at most 128 characters');
  const principal = readPrincipal(presented, readStdin);
  const options = { env, home, now, ...rest };
  const file = options.file ?? populationFile(options);
  const stateDir = options.stateDir ?? stateDirectory(options);
  const source = path.resolve(cwd, archive);
  if (!lstat(source)?.isFile()) fail('import-archive-missing', `${source} is not a file`);
  const manifest = await readExportManifest(source);
  const decide = () => planSoulImport(manifest, { fork, replace, name, env, home, file, stateDir, ...(options.config === undefined ? {} : { config: options.config }) });
  const planned = decide();
  const pointers = manifest.components.filter((c) => c.kind === 'pointer' && c.area === 'root').map((c) => ({ relative: c.relative, target: c.target ?? null }));
  const base = { schemaVersion: EXPORT_SCHEMA_VERSION, archive: source, applied: false, decision: 'planned',
    identity: { decision: planned.decision, agentId: planned.agentId, importedFrom: planned.importedFrom, existing: planned.existing },
    soulDir: planned.soulDir, replaced: planned.replaced, name: planned.name, displayName: planned.displayName, journal: null,
    restored: { files: manifest.components.filter((c) => c.entry && c.kind !== 'dir').length, bytes: manifest.components.reduce((sum, c) => sum + c.bytes, 0), byClassification: counts(manifest.components) },
    pointers, workspaces: (manifest.workspaces ?? []).filter((w) => w.location === 'linked').map((w) => ({ ...w, imported: `${IMPORTS_DIRECTORY}/${w.name}` })), migration: LIFE_IMPORT_STEP_ID };
  const emit = (result) => { write(json ? `${JSON.stringify(result)}\n` : formatImport(result)); return result; };
  if (plan) return emit(base);
  const refuseRunning = () => fail('soul-running', `${manifest.agentId} is running (a turn in flight or a warm harness); stop it before replacing its life`, { action: `agent-bot soul stop ${manifest.agentId}` });
  if (planned.decision === 'replace' && await running(manifest.agentId, { env, home })) refuseRunning();
  const what = planned.decision === 'fork' ? `import a fork of ${manifest.agentId}'s life from ${source}` : planned.decision === 'replace'
    ? `import ${manifest.agentId}'s life from ${source}, replacing the soul here` : `import ${manifest.agentId}'s life from ${source}`;
  const authorization = await gate(what, { principal, env, cwd });
  // Decided again after the gate: the census may have changed meanwhile.
  const fresh = decide();
  if (fresh.decision === 'replace' && await running(manifest.agentId, { env, home })) refuseRunning();
  const { root } = soulsHome({ env, home, ...(options.config === undefined ? {} : { config: options.config }) });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = path.join(root, `.import-${randomUUID()}`);
  let restored;
  try {
    const extracted = await extractSoulExport(source, staging);
    restored = await restoreSoul({ archive: source, staging, manifest: extracted.manifest, plan: fresh, env, home, file, stateDir, now, config: options.config, authorization });
  } catch (error) {
    // The archive is still there: the staging is ours and goes; nothing
    // the soul root held is touched.
    rmSync(staging, { recursive: true, force: true });
    appendAuditReceipt({ event: 'soul-env-import', agentId: isAgentId(manifest.agentId) ? manifest.agentId : null, operation: 'import', decision: 'failed', detail: `${error.code ?? 'error'}: ${error.message}` }, { env, home, now });
    throw error;
  }
  const decision = fresh.decision === 'fork' ? 'forked' : fresh.decision === 'replace' ? 'replaced' : 'imported';
  // The migration journal in the soul holds the paths; the receipt names
  // the counts, the identities and where the life went.
  appendAuditReceipt({ event: 'soul-env-import', agentId: restored.agentId, operation: 'import', decision,
    detail: `${base.restored.files} file(s), ${base.restored.bytes} byte(s)${restored.agentId !== manifest.agentId ? ` as a fork of ${manifest.agentId}` : ''}, journal ${restored.journal}, ${restored.workspaces.length} workspace(s) to link again${restored.replaced ? ', previous root moved aside' : ''}, into ${restored.soulDir}` }, { env, home, now });
  return emit({ ...base, applied: true, decision, identity: { ...base.identity, decision: fresh.decision, agentId: restored.agentId, existing: fresh.existing },
    soulDir: restored.soulDir, replaced: restored.replaced, name: restored.name, displayName: restored.displayName, journal: restored.journal, workspaces: restored.workspaces });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [verb, ...args] = process.argv.slice(2);
  const command = verb === 'export' ? soulEnvExportCommand : verb === 'import' ? soulEnvImportCommand : null;
  (command ? command(args) : Promise.reject(new Error(USAGE))).catch((error) => {
    const failure = { code: error.code ?? `soul-env-${verb === 'import' ? 'import' : 'export'}-failed`, message: error.message, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul env ${verb ?? 'export'}: ${failure.code}: ${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  });
}
