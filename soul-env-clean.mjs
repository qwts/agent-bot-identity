#!/usr/bin/env node
// `agent-bot soul env clean`: removes what the environment contract
// classifies as reconstructible or disposable (#583 slice 6, ADR-0583
// decisions 1 and 2, issue requirement 8 "classify retention explicitly"):
// the soul's cache, its temporary files, the runtime caches a routed launch
// keeps out of the host's HOME, and the staging an interrupted install
// left. Never anything durable: the definition, the home, tool state,
// credentials, secrets, sign-ins, memory, history or a workspace. Installed
// runtimes and generated output are reconstructible too but are rebuilt by
// their own commands, not dropped by a clean.
//
// `--plan` is read-only and lists what would go with sizes; the apply is
// owner-gated, refused while the soul runs, records the last run in
// `.soul-state/clean.json` and leaves an audit receipt naming paths and
// counts, never a file's contents.
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { RETENTION, classifyPath, retentionOf } from './soul-env-contract.mjs';
import { readMigrationStep } from './soul-migration-journal.mjs';
import { SPACE_STEP_ID } from './soul-memory.mjs';

export const CLEAN_SCHEMA_VERSION = 1;
export const CLEAN_JOURNAL = '.soul-state/clean.json';
// The components a clean may touch, by descriptor component id. Every
// path removed under them classifies as `cache`, `temp` or `runtime`, all
// reconstructible or disposable; the contract is checked per path again
// before anything is removed.
export const CLEAN_COMPONENTS = Object.freeze(['cache', 'temp', 'runtimes']);
// What a clean removes must never be durable: checked per path.
export const CLEAN_RETENTIONS = Object.freeze(RETENTION.filter((kind) => kind !== 'durable'));
// The caches the runtimes module routes a launch's tools to (soul-runtimes.mjs).
const RUNTIME_CACHES = Object.freeze(['node/npm-cache', 'uv/cache', 'go/cache']);
// A revision staging is a host's edit in progress for the TTL `soul
// revision prepare` promised (soul-revisions.mjs); older ones are leftovers.
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const STAGING_NAME = /^revision-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATE = '.soul-state';
const USAGE = 'usage: agent-bot soul env clean <agentId|name> [--plan] [--component cache|temp|runtimes] [--json] [--principal-stdin]';

function fail(code, message, { action = null } = {}) {
  throw Object.assign(new Error(message), { code, action });
}

function lstat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return null; throw error; }
}

// Files and bytes under one entry, never through a link; a link counts as
// one entry of no size, a special file likewise.
function measure(file, stat = lstat(file)) {
  if (!stat) return { files: 0, bytes: 0 };
  if (stat.isFile()) return { files: 1, bytes: stat.size };
  if (!stat.isDirectory()) return { files: 1, bytes: 0 };
  let files = 0, bytes = 0;
  let names = [];
  try { names = readdirSync(file); } catch { return { files, bytes }; }
  for (const name of names) {
    const child = measure(path.join(file, name));
    files += child.files;
    bytes += child.bytes;
  }
  return { files, bytes };
}

function resolveSoul(id, options) {
  const file = options.file ?? populationFile(options);
  try { return typeof id === 'string' && id.startsWith('agent_') ? showSoul(id, { file }) : showSoulByName(id, { file }); }
  catch (error) {
    if (/no population record|id must be a valid Agent ID/.test(error.message)) fail('soul-not-found', 'Soul not found.');
    throw error;
  }
}

function soulRoot(soul, options) {
  const registered = typeof soul.soulDir === 'string' && lstat(soul.soulDir)?.isDirectory() ? soul.soulDir : null;
  return registered ?? soulDirectory(soul.id, { ...options, readOnly: true });
}

/**
 * What a clean of `soulDir` would remove and what it leaves, read-only:
 * `{ removable[], kept[] }`. Each row is `{ component, path, relative,
 * classification, retention, kind, files, bytes }` (`kept` rows carry a
 * `reason` instead of a size). Entries directly under `.soul-state/cache`
 * and `.soul-state/tmp`, the runtime caches, and `.installing-*` stagings
 * under `.soul-state/runtimes`. A root that is a link is never descended;
 * a revision staging within its 24-hour window and a path whose contract
 * retention is durable are kept and say why.
 */
export function planSoulClean(soulDir, { components = CLEAN_COMPONENTS, now = () => new Date() } = {}) {
  const removable = [], kept = [];
  const consider = (component, relative, kind, { reason = null } = {}) => {
    const classification = classifyPath(relative);
    const retention = retentionOf(classification);
    const file = path.join(soulDir, relative);
    const row = { component, path: file, relative, classification, retention, kind };
    if (retention === null || !CLEAN_RETENTIONS.includes(retention)) { kept.push({ ...row, reason: `${classification} is ${retention ?? 'not the soul\'s'}; never cleaned` }); return; }
    if (reason) { kept.push({ ...row, reason }); return; }
    removable.push({ ...row, ...measure(file) });
  };
  const children = (relative) => {
    const stat = lstat(path.join(soulDir, relative));
    if (!stat) return null;
    if (stat.isSymbolicLink()) return 'link';
    if (!stat.isDirectory()) return 'file';
    try { return readdirSync(path.join(soulDir, relative)).sort(); } catch { return []; }
  };
  const rootOf = (component, relative) => {
    const names = children(relative);
    if (names === 'link') { kept.push({ component, path: path.join(soulDir, relative), relative, classification: classifyPath(relative), retention: retentionOf(classifyPath(relative)), kind: 'link', reason: 'a link is never followed; move it aside to clean what it points at' }); return null; }
    return Array.isArray(names) ? names : null;
  };
  if (components.includes('cache')) {
    for (const name of rootOf('cache', `${STATE}/cache`) ?? []) consider('cache', `${STATE}/cache/${name}`, 'cache-entry');
  }
  if (components.includes('temp')) {
    for (const name of rootOf('temp', `${STATE}/tmp`) ?? []) {
      const relative = `${STATE}/tmp/${name}`;
      const stat = lstat(path.join(soulDir, relative));
      if (STAGING_NAME.test(name) && stat?.isDirectory() && now().getTime() - stat.mtimeMs < STAGING_TTL_MS) {
        consider('temp', relative, 'revision-staging', { reason: 'a revision staging within its 24-hour window may be a host\'s edit in progress; agent-bot soul revision prepare --discard removes it' });
      } else consider('temp', relative, STAGING_NAME.test(name) ? 'revision-staging' : 'temp-entry');
    }
  }
  if (components.includes('runtimes')) {
    const runtimes = rootOf('runtimes', `${STATE}/runtimes`);
    if (runtimes) {
      for (const cache of RUNTIME_CACHES) {
        const relative = `${STATE}/runtimes/${cache}`;
        if (lstat(path.join(soulDir, relative))?.isDirectory()) consider('runtimes', relative, 'runtime-cache');
      }
      // Stagings of an interrupted install: `.installing-<uuid>` beside a
      // runtime's versions or a harness's (soul-runtimes.mjs).
      const dirs = runtimes.map((name) => `${STATE}/runtimes/${name}`);
      for (const name of Array.isArray(children(`${STATE}/runtimes/harnesses`)) ? children(`${STATE}/runtimes/harnesses`) : []) dirs.push(`${STATE}/runtimes/harnesses/${name}`);
      for (const dir of dirs) {
        const names = children(dir);
        if (!Array.isArray(names)) continue;
        for (const name of names) if (name.startsWith('.installing-')) consider('runtimes', `${dir}/${name}`, 'install-staging');
      }
    }
  }
  // A space move under way keeps its staging until `soul env migrate`
  // finishes it; nothing here touches `.soul-state/space*` anyway, since
  // the contract classifies it durable. Said so a host sees why it stays.
  const step = readMigrationStep(soulDir, SPACE_STEP_ID);
  if (step && !['done', 'skipped', 'failed'].includes(step.status) && typeof step.staging === 'string') {
    kept.push({ component: 'memory', path: step.staging, relative: path.relative(soulDir, step.staging), classification: 'memory', retention: 'durable', kind: 'space-staging',
      reason: `the Agent Space move is ${step.status}; agent-bot soul env migrate --complete finishes it` });
  }
  return { removable, kept };
}

/** Reads the last clean's record, `.soul-state/clean.json`, or null. */
export function readCleanJournal(soulDir) {
  try {
    const file = path.join(soulDir, CLEAN_JOURNAL);
    if (!lstat(file)?.isFile()) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.schemaVersion === CLEAN_SCHEMA_VERSION ? parsed : null;
  } catch { return null; }
}

function writeCleanJournal(soulDir, record) {
  const file = path.join(soulDir, CLEAN_JOURNAL);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
  return record;
}

/**
 * Removes every `removable` row of a plan, each checked against the
 * contract once more (a durable retention is refused, never removed), and
 * records the run. Returns `{ removed[], failed[], files, bytes }`; a path
 * that cannot be removed is listed with its error code and the rest still
 * goes.
 */
export function applySoulClean(soulDir, plan, { agentId = null, now = () => new Date() } = {}) {
  const removed = [], failed = [];
  for (const row of plan.removable) {
    if (!CLEAN_RETENTIONS.includes(retentionOf(classifyPath(row.relative)))) fail('clean-component-durable', `${row.relative} is ${row.classification} (${row.retention}); a clean never removes it`);
    if (!path.resolve(row.path).startsWith(path.resolve(soulDir) + path.sep)) fail('clean-component-durable', `${row.path} is outside the soul; a clean never removes it`);
    try { rmSync(row.path, { recursive: true, force: true }); removed.push(row); }
    catch (error) { failed.push({ ...row, error: error.code ?? error.message }); }
  }
  const files = removed.reduce((sum, row) => sum + row.files, 0);
  const bytes = removed.reduce((sum, row) => sum + row.bytes, 0);
  writeCleanJournal(soulDir, { schemaVersion: CLEAN_SCHEMA_VERSION, agentId, at: now().toISOString(), files, bytes,
    removed: removed.map((row) => ({ relative: row.relative, classification: row.classification, kind: row.kind, files: row.files, bytes: row.bytes })),
    failed: failed.map((row) => ({ relative: row.relative, error: row.error })) });
  return { removed, failed, files, bytes };
}

export function formatClean(result) {
  const lines = [`agentId: ${result.agentId}`, `soulDir: ${result.soulDir}`, `applied: ${result.applied}`, `decision: ${result.decision}`, ''];
  const section = (title, rows) => {
    lines.push(`${title} (${rows.length})`);
    for (const row of rows) lines.push(`  ${row.relative} (${row.classification}, ${row.retention})${'bytes' in row ? ` ${row.files} file(s), ${row.bytes} byte(s)` : ''}${row.reason ? ` - ${row.reason}` : ''}${row.error ? ` - ${row.error}` : ''}`);
  };
  section(result.applied ? 'removed' : 'would remove', result.applied ? result.removed : result.removable);
  if (result.applied && result.failed.length) section('not removed', result.failed);
  section('kept', result.kept);
  lines.push(`total: ${result.files} file(s), ${result.bytes} byte(s)`);
  return `${lines.join('\n')}\n`;
}

async function soulIsRunning(agentId, { env, home }) {
  const { soulRunning } = await import('./soul-comms.mjs');
  return soulRunning(agentId, { env, home });
}

/**
 * `agent-bot soul env clean <soul> [--plan] [--component ID] [--json]
 * [--principal-stdin]`. Prints `{ schemaVersion, agentId, soulDir,
 * applied, decision, components, removable[], removed[], failed[], kept[],
 * files, bytes, journal }`: with `--plan` `applied: false`, `decision:
 * planned`, nothing gated and nothing written; otherwise owner-gated,
 * refused `soul-running` while the soul has a turn in flight or a warm
 * harness (checked before and after the gate), `decision` `cleaned |
 * nothing | failed`. `--component` names a durable component is
 * `clean-component-durable`.
 */
export async function soulEnvCleanCommand(argv, { gate = ownerGate, readStdin = () => readFileSync(0, 'utf8'), write = (value) => process.stdout.write(value),
  env = process.env, home = env.HOME ?? homedir(), cwd = process.cwd(), now = () => new Date(), running = soulIsRunning, ...rest } = {}) {
  let id = null, json = false, plan = false, presented = false;
  const components = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan' && !plan) plan = true;
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented) presented = true;
    else if (arg === '--component' && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('-')) { components.push(argv[i + 1]); i += 1; }
    else if (!arg.startsWith('-') && id === null) id = arg;
    else throw new Error(USAGE);
  }
  if (!id || (plan && presented)) throw new Error(USAGE);
  for (const component of components) {
    if (CLEAN_COMPONENTS.includes(component)) continue;
    fail('clean-component-durable', `${component} is not a component a clean may remove; only ${CLEAN_COMPONENTS.join(', ')} hold reconstructible or disposable state`,
      { action: `agent-bot soul env ${id} --json shows each component's retention` });
  }
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  const options = { env, home, now, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  if (!lstat(path.join(soulDir, STATE))?.isDirectory()) fail('soul-state-missing', `${soulDir} has no .soul-state yet; spawn or launch the soul first`);
  const selected = components.length ? [...new Set(components)] : [...CLEAN_COMPONENTS];
  const planned = planSoulClean(soulDir, { components: selected, now });
  const base = { schemaVersion: CLEAN_SCHEMA_VERSION, agentId: soul.id, soulDir, applied: false, decision: 'planned', components: selected,
    removable: planned.removable, removed: [], failed: [], kept: planned.kept,
    files: planned.removable.reduce((sum, row) => sum + row.files, 0), bytes: planned.removable.reduce((sum, row) => sum + row.bytes, 0), journal: CLEAN_JOURNAL };
  const emit = (result) => { write(json ? `${JSON.stringify(result)}\n` : formatClean(result)); return result; };
  if (plan) return emit(base);
  const refuseRunning = () => fail('soul-running', `${soul.id} is running (a turn in flight or a warm harness); stop it before cleaning its environment`, { action: `agent-bot soul stop ${soul.id}` });
  if (await running(soul.id, { env, home })) refuseRunning();
  await gate(`clean ${soul.id}'s reconstructible environment (${selected.join(', ')})`, { principal, env, cwd });
  if (await running(soul.id, { env, home })) refuseRunning();
  // Planned again after the gate: the owner may have taken a while.
  const fresh = planSoulClean(soulDir, { components: selected, now });
  let applied;
  try { applied = applySoulClean(soulDir, fresh, { agentId: soul.id, now }); }
  catch (error) {
    appendAuditReceipt({ event: 'soul-env-clean', agentId: soul.id, operation: 'clean', decision: 'failed', detail: `${error.code ?? 'error'}: ${error.message}` }, { env, home, now });
    throw error;
  }
  const decision = applied.failed.length ? 'failed' : applied.removed.length ? 'cleaned' : 'nothing';
  // Counts and the first few names: a cache entry's name is the most a
  // receipt says, and the journal holds the whole list.
  const named = (rows) => `${rows.slice(0, 5).map((row) => row.relative).join(', ')}${rows.length > 5 ? `, and ${rows.length - 5} more` : ''}`;
  appendAuditReceipt({ event: 'soul-env-clean', agentId: soul.id, operation: 'clean', decision,
    detail: `${applied.removed.length} path(s), ${applied.files} file(s), ${applied.bytes} byte(s) removed${applied.removed.length ? `: ${named(applied.removed)}` : ''}${applied.failed.length ? `; not removed: ${named(applied.failed)}` : ''}` }, { env, home, now });
  return emit({ ...base, applied: true, decision, removable: fresh.removable, removed: applied.removed, failed: applied.failed, kept: fresh.kept, files: applied.files, bytes: applied.bytes });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulEnvCleanCommand(process.argv.slice(2)).catch((error) => {
    const failure = { code: error.code ?? 'soul-env-clean-failed', message: error.message, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul env clean: ${failure.code}: ${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  });
}
