#!/usr/bin/env node
// Exporting a persona account's souls, workspaces and transcripts to the
// owner's account (#750 slice 2). The owner's decision (2026-10-10): a
// private drop and a guided copy.
//
//   In the persona account:  agent-bot sandbox export --for OWNER [--skip CATEGORY]... [--resume DIR] [--json] [--principal-stdin]
//   In the owner's account:  agent-bot sandbox export --verify ACCOUNT [--dir DIR] [--json]
//
// The export runs in the persona account, since the owner's account cannot
// read its home. Each category the owner confirms (one owner gate per
// category) is written to a drop folder only that account can read,
// `~/.agent-bot/exports/outgoing/<timestamp>/` (0700): souls as `soul env
// export` archives, workspaces (spaces no soul in the census owns) and the
// harnesses' loose session stores as tar archives. Every file is hashed
// back from disk; `manifest.json`, written last, lists each with its size
// and SHA-256. Its presence is what marks an export complete.
//
// agent-bot never runs sudo. It prints the commands the owner runs from
// their own account to copy the drop to
// `~/.agent-bot/exports/<account>/<timestamp>/` (0700) and take ownership.
// `--verify` then reads every file back against the manifest, and writes
// `verified.json` beside it only when all of them match. Verifying changes
// nothing else and needs no gate.
//
// A failure stops where it is and leaves every file in place; `--resume
// DIR` checks what is already written against its recorded hash and carries
// on. Nothing is removed by any of this: removal is a later slice that needs
// a verified export first.

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { appendAuditReceipt } from './agent-principals.mjs';
import { spacesHome } from './agent-space.mjs';
import { listSouls, populationFile } from './agent-population.mjs';
import { minimalChildEnv } from './child-env.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { readExportManifest } from './soul-env-export.mjs';

export const SANDBOX_EXPORT_SCHEMA = 1;
export const EXPORT_CATEGORIES = Object.freeze(['souls', 'workspaces', 'transcripts']);
const MANIFEST = 'manifest.json';
const PROGRESS = 'progress.json';
const VERIFIED = 'verified.json';
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,30}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const AGENT_FILE = /^agent_[0-9a-f-]{36}\.soul\.tgz$/;
export const EXPORT_USAGE = 'usage: agent-bot sandbox export --for OWNER [--skip souls|workspaces|transcripts]... [--resume DIR] [--json] [--principal-stdin] | sandbox export --verify ACCOUNT [--dir DIR] [--json]';

function fail(code, message, { action = null } = {}) {
  throw Object.assign(new Error(message), { code, ...(action ? { action } : {}) });
}

function lstat(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// The copied manifest is read through one descriptor: never through a link,
// never blocking on a FIFO, and only when it is the owner's own private
// regular file of a bounded size.
const MANIFEST_LIMIT = 4 * 1024 * 1024;
export function readPrivateJson(file, { uid }) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { fail('sandbox-export-invalid', `${file} is missing or is a link; the copy may be incomplete`); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MANIFEST_LIMIT) fail('sandbox-export-invalid', `${file} is not a manifest`);
    if (uid !== null && info.uid !== uid) fail('sandbox-export-not-owned', `${file} is not owned by this account`);
    if (info.mode & 0o077) fail('sandbox-export-not-private', `${file} can be read by other accounts`, { action: `chmod go-rwx ${quote(file)}` });
    const bytes = Buffer.alloc(info.size);
    let at = 0;
    while (at < bytes.length) { const read = readSync(fd, bytes, at, bytes.length - at, null); if (read === 0) break; at += read; }
    try { return JSON.parse(bytes.subarray(0, at).toString('utf8')); }
    catch { fail('sandbox-export-invalid', `${file} is not valid JSON`); }
  } finally { closeSync(fd); }
}

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes = 0;
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      bytes += read;
      hash.update(chunk.subarray(0, read));
    }
  } finally { closeSync(fd); }
  return { bytes, sha256: hash.digest('hex') };
}

function privateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

const stampOf = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

export function outgoingRoot({ home = homedir() } = {}) {
  return path.join(home, '.agent-bot', 'exports', 'outgoing');
}

export function incomingRoot(account, { home = homedir() } = {}) {
  return path.join(home, '.agent-bot', 'exports', account);
}

// --- what each category holds ------------------------------------------------

function harnessStores({ env, home }) {
  const claude = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  const codex = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  return [
    { name: 'claude-projects', source: path.join(claude, 'projects') },
    { name: 'codex-sessions', source: path.join(codex, 'sessions') },
  ].filter((store) => lstat(store.source)?.isDirectory());
}

function orphanSpaces({ env, home }, souls) {
  let root;
  try { root = spacesHome({ env, home }); } catch { return []; }
  if (!lstat(root)?.isDirectory()) return [];
  const owned = new Set(souls.map((soul) => soul.id));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^agent_/.test(entry.name) && !owned.has(entry.name))
    .map((entry) => ({ name: entry.name, source: path.join(root, entry.name) }));
}

export function planSandboxExport({ env = process.env, home = homedir() } = {}) {
  const souls = listSouls({ file: populationFile({ env, home }) });
  return {
    souls: souls.map((soul) => ({ id: soul.id, file: `souls/${soul.id}.soul.tgz` })),
    workspaces: orphanSpaces({ env, home }, souls).map((space) => ({ ...space, file: `workspaces/${space.name}.tgz` })),
    transcripts: harnessStores({ env, home }).map((store) => ({ ...store, file: `transcripts/${store.name}.tgz` })),
  };
}

// A directory as a gzip'd tar, through a rename so a file present is whole.
// tar runs with a minimal environment and argv only, never a shell.
function tarDirectory(source, target, { tar }) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    tar(['-czf', temporary, '-C', path.dirname(source), path.basename(source)]);
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}

const defaultTar = (args) => execFileSync('/usr/bin/tar', args, { stdio: ['ignore', 'ignore', 'pipe'], env: minimalChildEnv(process.env) });

// --- the persona account's side ----------------------------------------------

function readProgress(dir, { account, owner }) {
  if (lstat(path.join(dir, MANIFEST))) fail('sandbox-export-complete', `${dir} is already a complete export; copy it to ${owner}'s account and verify it there`);
  let progress;
  try { progress = JSON.parse(readFileSync(path.join(dir, PROGRESS), 'utf8')); }
  catch { fail('sandbox-export-resume-invalid', `${dir} has no readable ${PROGRESS}; start a new export instead`); }
  if (progress?.schemaVersion !== SANDBOX_EXPORT_SCHEMA || progress.account !== account || progress.for !== owner || !Array.isArray(progress.files)) {
    fail('sandbox-export-resume-invalid', `${dir} is not an unfinished export from ${account} for ${owner}`);
  }
  // What was written before is read back now; a file that changed since
  // stops the resume rather than being trusted or overwritten.
  for (const entry of progress.files) {
    const found = lstat(path.join(dir, entry.path));
    const now = found?.isFile() ? sha256File(path.join(dir, entry.path)) : null;
    if (!now || now.sha256 !== entry.sha256 || now.bytes !== entry.bytes) {
      fail('sandbox-export-changed', `${entry.path} in ${dir} no longer matches what was exported; start a new export instead`);
    }
  }
  return progress;
}

/**
 * Writes the export into a drop folder in this (persona) account. `gate`
 * is asked once per category that has something to export, before any of
 * it is written. `exportSoul(agentId, target)` writes one soul's archive.
 */
export async function runSandboxExport({ owner, skip = [], resume = null, principal = null, env = process.env, home = homedir(), cwd = process.cwd(),
  account = userInfo().username, gate = ownerGate, exportSoul, tar = defaultTar, now = () => new Date() } = {}) {
  if (!ACCOUNT_NAME.test(owner ?? '')) fail('usage', EXPORT_USAGE);
  if (owner === account) fail('sandbox-export-self', `this is ${owner}'s own account; run the export in the persona account, then verify it here with --verify`);
  const root = outgoingRoot({ home });
  let dir;
  let progress;
  if (resume) {
    dir = path.resolve(cwd, resume);
    if (path.dirname(dir) !== root || !STAMP.test(path.basename(dir))) fail('usage', `--resume takes a folder under ${root}`);
    progress = readProgress(dir, { account, owner });
  } else {
    const stamp = stampOf(now());
    dir = path.join(root, stamp);
    if (lstat(dir)) fail('sandbox-export-exists', `${dir} already exists; try again in a second`);
    progress = { schemaVersion: SANDBOX_EXPORT_SCHEMA, account, for: owner, createdAt: now().toISOString(), stamp, files: [], categories: {} };
  }
  const plan = planSandboxExport({ env, home });
  const done = new Set(progress.files.map((entry) => entry.path));
  const record = (entry) => { progress.files.push(entry); done.add(entry.path); writeJson(path.join(dir, PROGRESS), progress); };
  privateDirectory(path.join(home, '.agent-bot', 'exports'));
  privateDirectory(root);
  privateDirectory(dir);
  writeJson(path.join(dir, PROGRESS), progress);
  const receipt = (decision, detail) => appendAuditReceipt({ event: 'sandbox-export', operation: 'export', decision, detail }, { env, home, now });
  try {
    for (const category of EXPORT_CATEGORIES) {
      const items = plan[category];
      if (skip.includes(category)) {
        // A resumed export already holding this category cannot also leave
        // it out: the manifest would carry what --skip promised to omit.
        if (progress.files.some((entry) => entry.category === category)) {
          fail('sandbox-export-skip-recorded', `${dir} already holds ${category}; it cannot be skipped on resume`, { action: `agent-bot sandbox export --for ${owner}${skip.map((name) => ` --skip ${name}`).join('')} (a new export)` });
        }
        progress.categories[category] = { state: 'skipped', count: 0 };
        continue;
      }
      if (progress.categories[category]?.state === 'exported') continue;
      if (items.length === 0) { progress.categories[category] = { state: 'empty', count: 0 }; continue; }
      const todo = items.filter((item) => !done.has(item.file));
      if (todo.length) {
        await gate(`export ${todo.length} ${category === 'souls' ? 'soul(s)' : `${category} archive(s)`} from ${account} to the drop folder ${dir}, for ${owner}`, { principal, env, cwd });
      }
      privateDirectory(path.join(dir, category));
      for (const item of todo) {
        const target = path.join(dir, item.file);
        if (!lstat(target)) {
          if (category === 'souls') {
            try { await exportSoul(item.id, target); }
            catch (error) {
              // A census row whose soul never ran has no life to export:
              // listed, not a failure that would block every resume.
              if (error.code !== 'soul-state-missing') throw error;
              progress.unexported = [...(progress.unexported ?? []).filter((row) => row.agentId !== item.id), { agentId: item.id, reason: 'no .soul-state: the soul never ran' }];
              writeJson(path.join(dir, PROGRESS), progress);
              continue;
            }
          } else tarDirectory(item.source, target, { tar });
        }
        // A file written by rename is whole; it is hashed back from disk.
        if (!lstat(target)?.isFile()) fail('sandbox-export-missing', `${item.file} was not written`);
        chmodSync(target, 0o600);
        if (category === 'souls') {
          const inner = await readExportManifest(target);
          if (inner.agentId !== item.id) fail('sandbox-export-mismatch', `${item.file} holds ${inner.agentId}, not ${item.id}`);
        }
        record({ path: item.file, category, ...(item.id ? { agentId: item.id } : {}), ...sha256File(target) });
      }
      progress.categories[category] = { state: 'exported', count: items.length };
      writeJson(path.join(dir, PROGRESS), progress);
    }
  } catch (error) {
    receipt('failed', `${error.code ?? 'error'}: ${error.message}; resume with --resume ${dir}`);
    throw Object.assign(error, { action: error.action ?? `agent-bot sandbox export --for ${owner} --resume ${dir}`, dropFolder: dir });
  }
  const manifest = { schemaVersion: SANDBOX_EXPORT_SCHEMA, account, for: owner, createdAt: progress.createdAt, completedAt: now().toISOString(),
    stamp: path.basename(dir), categories: progress.categories, files: progress.files, unexported: progress.unexported ?? [] };
  writeJson(path.join(dir, MANIFEST), manifest);
  const bytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  receipt('exported', `${manifest.files.length} file(s), ${bytes} byte(s), to ${dir}`);
  return { applied: true, decision: 'exported', dropFolder: dir, manifest, copy: copyCommands({ dir, account, owner, stamp: manifest.stamp }) };
}

// Run by the owner from their own account: only the copy and the change of
// ownership need sudo, since the drop folder is the persona account's.
export function copyCommands({ dir, account, owner, stamp }) {
  const into = `~/.agent-bot/exports/${account}`;
  return [
    `mkdir -p -m 700 ~/.agent-bot/exports ${into}`,
    `chmod 700 ~/.agent-bot/exports ${into}`,
    `sudo /usr/bin/ditto ${quote(dir)} ${into}/${stamp}`,
    `sudo /usr/sbin/chown -R ${owner} ${into}/${stamp}`,
    `chmod -R go-rwx ${into}/${stamp}`,
    `agent-bot sandbox export --verify ${account} --dir ${into}/${stamp}`,
  ];
}

// --- the owner's side ----------------------------------------------------------

function newestExport(root) {
  if (!lstat(root)?.isDirectory()) return null;
  const stamps = readdirSync(root).filter((name) => STAMP.test(name) && lstat(path.join(root, name, MANIFEST))?.isFile()).sort();
  return stamps.length ? path.join(root, stamps.at(-1)) : null;
}

function safeEntry(relative) {
  const [category, name, ...more] = String(relative).split('/');
  if (more.length || !EXPORT_CATEGORIES.includes(category) || !name || name === '.' || name === '..') return false;
  return category === 'souls' ? AGENT_FILE.test(name) : /^[A-Za-z0-9_.-]+\.tgz$/.test(name);
}

/**
 * Reads every file of an export in this (owner's) account back against its
 * manifest. Writes `verified.json` only when all match; changes nothing else.
 */
export async function verifySandboxExport(account, options = {}) {
  const { env = process.env, home = homedir(), now = () => new Date() } = options;
  try { return await verifyExport(account, options); }
  catch (error) {
    // Every refusal leaves a receipt; a mismatch has already left its own.
    if (error.code !== 'usage' && error.code !== 'sandbox-export-unverified') {
      appendAuditReceipt({ event: 'sandbox-export', operation: 'verify', decision: 'refused', detail: `${error.code}: ${error.message}` }, { env, home, now });
    }
    throw error;
  }
}

async function verifyExport(account, { dir = null, env = process.env, home = homedir(), cwd = process.cwd(), owner = userInfo().username,
  uid = process.getuid?.() ?? null, now = () => new Date() } = {}) {
  if (!ACCOUNT_NAME.test(account ?? '')) fail('usage', EXPORT_USAGE);
  const root = incomingRoot(account, { home });
  const target = dir ? path.resolve(cwd, dir.replace(/^~(?=\/)/, home)) : newestExport(root);
  if (!target) fail('sandbox-export-not-found', `no copied export from ${account} under ${root}`, { action: `run agent-bot sandbox export --for ${owner} in ${account}, then the copy commands it prints` });
  if (path.dirname(target) !== root || !STAMP.test(path.basename(target))) fail('usage', `--dir takes a folder under ${root}`);
  const problems = [];
  const fail2 = (code, message, action = null) => fail(code, message, { action });
  for (const folder of [root, target]) {
    const info = lstat(folder);
    if (!info?.isDirectory()) fail2('sandbox-export-not-found', `${folder} is not a folder`);
    if (uid !== null && info.uid !== uid) fail2('sandbox-export-not-owned', `${folder} is not owned by ${owner}`, `sudo /usr/sbin/chown -R ${owner} ${quote(target)}`);
    if (info.mode & 0o077) fail2('sandbox-export-not-private', `${folder} can be read by other accounts`, `chmod go-rwx ${quote(folder)}`);
  }
  const manifest = readPrivateJson(path.join(target, MANIFEST), { uid });
  if (manifest?.schemaVersion !== SANDBOX_EXPORT_SCHEMA || manifest.account !== account || !Array.isArray(manifest.files)) {
    fail2('sandbox-export-invalid', `${target}/${MANIFEST} is not an export from ${account}`);
  }
  if (manifest.for !== owner) fail2('sandbox-export-wrong-owner', `this export was made for ${manifest.for}, not ${owner}`);
  const seen = new Set();
  let bytes = 0;
  for (const entry of manifest.files) {
    if (!safeEntry(entry?.path) || seen.has(entry.path)) { problems.push({ path: String(entry?.path), problem: 'invalid' }); continue; }
    seen.add(entry.path);
    const file = path.join(target, entry.path);
    const info = lstat(file);
    if (!info?.isFile()) { problems.push({ path: entry.path, problem: 'missing' }); continue; }
    if (uid !== null && info.uid !== uid) { problems.push({ path: entry.path, problem: 'not-owned' }); continue; }
    if (info.mode & 0o077) { problems.push({ path: entry.path, problem: 'not-private' }); continue; }
    const read = sha256File(file);
    if (read.bytes !== entry.bytes || read.sha256 !== entry.sha256) { problems.push({ path: entry.path, problem: 'changed' }); continue; }
    if (entry.category === 'souls') {
      try {
        const inner = await readExportManifest(file);
        if (inner.agentId !== entry.agentId) { problems.push({ path: entry.path, problem: 'wrong-soul' }); continue; }
      } catch { problems.push({ path: entry.path, problem: 'unreadable-archive' }); continue; }
    }
    bytes += read.bytes;
  }
  const souls = manifest.files.filter((entry) => entry?.category === 'souls' && typeof entry.agentId === 'string').map((entry) => entry.agentId);
  const unexported = Array.isArray(manifest.unexported) ? manifest.unexported.map((row) => row?.agentId).filter((id) => typeof id === 'string') : [];
  const result = { account, dir: target, files: manifest.files.length, bytes, categories: manifest.categories ?? {}, completedAt: typeof manifest.completedAt === 'string' ? manifest.completedAt : null,
    // When the copy changed hands on this side: the folder's ctime, which
    // the persona account cannot set (the owner's chown and chmod move it).
    copiedAt: new Date(lstat(target).ctimeMs).toISOString(), souls, unexported, problems, verified: problems.length === 0 };
  appendAuditReceipt({ event: 'sandbox-export', operation: 'verify', decision: result.verified ? 'verified' : 'refused',
    detail: result.verified ? `${result.files} file(s), ${bytes} byte(s) in ${target}` : `${problems.length} problem(s) in ${target}` }, { env, home, now });
  if (!result.verified) {
    fail('sandbox-export-unverified', `${problems.length} of ${manifest.files.length} file(s) do not match the manifest: ${problems.map((p) => `${p.path} (${p.problem})`).join(', ')}`,
      { action: 'copy the drop folder again with the printed commands, then verify again; the persona account still has it' });
  }
  writeJson(path.join(target, VERIFIED), { schemaVersion: SANDBOX_EXPORT_SCHEMA, account, verifiedAt: now().toISOString(), files: result.files, bytes });
  return result;
}

// --- CLI -----------------------------------------------------------------------

export function formatExportResult(result) {
  if (result.verified !== undefined) {
    return `verified: ${result.files} file(s), ${result.bytes} byte(s) from ${result.account} in ${result.dir}\n`;
  }
  const lines = [`exported to ${result.dropFolder} (only this account can read it)`];
  for (const [category, state] of Object.entries(result.manifest.categories)) lines.push(`  ${category}: ${state.state}${state.count ? ` (${state.count})` : ''}`);
  lines.push('', `From ${result.manifest.for}'s account, copy it over and verify it (agent-bot never runs sudo):`, ...result.copy.map((command) => `  ${command}`));
  return `${lines.join('\n')}\n`;
}

export async function sandboxExportCommand(argv, { readStdin = () => readFileSync(0, 'utf8'), write = (text) => process.stdout.write(text), ...options } = {}) {
  let owner = null, verify = null, dir = null, resume = null, json = false, presented = false;
  const skip = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    const takes = typeof value === 'string' && value !== '' && !value.startsWith('--');
    if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented) presented = true;
    else if (arg === '--for' && owner === null && takes) { owner = value; i += 1; }
    else if (arg === '--verify' && verify === null && takes) { verify = value; i += 1; }
    else if (arg === '--dir' && dir === null && takes) { dir = value; i += 1; }
    else if (arg === '--resume' && resume === null && takes) { resume = value; i += 1; }
    else if (arg === '--skip' && takes && EXPORT_CATEGORIES.includes(value) && !skip.includes(value)) { skip.push(value); i += 1; }
    else fail('usage', EXPORT_USAGE);
  }
  const out = (result) => { write(json ? `${JSON.stringify(result)}\n` : formatExportResult(result)); return result; };
  if (verify !== null) {
    if (owner !== null || resume !== null || skip.length || presented) fail('usage', EXPORT_USAGE);
    return out(await verifySandboxExport(verify, { dir, ...options }));
  }
  if (owner === null || dir !== null) fail('usage', EXPORT_USAGE);
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  return out(await runSandboxExport({ owner, skip, resume, principal, ...options }));
}
