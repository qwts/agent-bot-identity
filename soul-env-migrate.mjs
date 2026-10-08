#!/usr/bin/env node
// `agent-bot soul env migrate`: the soul's tool homes on disk and the
// adoption of host sign-ins (#583 slice 2, ADR-0583 decision 5).
//
// Reading is by existence only: whether a sign-in file is there, in the
// soul's tool home and in the host store, never what it holds. Adoption
// copies the files the registry names (soul-tool-homes.mjs), once, into
// the soul's tool home with private modes, records the step in
// `.soul-state/migration.json` and leaves an audit receipt naming files,
// never contents. The macOS keychain is never read: a keychain sign-in is
// per user, and the harness asks for it once inside the soul.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ACP_SPAWN_REGISTRY } from './acp-registry.mjs';
import { readAgentIdentity, stateDirectory } from './agent-identity.mjs';
import { populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { TOOL_HOME_REGISTRY, adoptStepId, hostToolStore, toolHomeDecision, toolHomeEnv, toolHomeFiles, toolHomeFor, toolHomePath, toolHomeRelative, toolHomesRoot } from './soul-tool-homes.mjs';

export const MIGRATION_SCHEMA_VERSION = 1;
export const MIGRATION_JOURNAL = '.soul-state/migration.json';
export const STEP_STATUSES = Object.freeze(['pending', 'done', 'skipped', 'failed']);
const STATE = '.soul-state';
const USAGE = 'usage: agent-bot soul env migrate <agentId|name> --adopt-host-signin [--harness NAME] [--json] [--principal-stdin]';
// A sign-in file is small; `.claude.json` carries project state and can
// reach a few megabytes. Anything larger is not a file this adopts.
const FILE_MAX_BYTES = 16 * 1024 * 1024;
const JOURNAL_MAX_BYTES = 256 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() ? value : null);

function fail(code, message, { action = null } = {}) {
  throw Object.assign(new Error(message), { code, action });
}

function lstat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return null; throw error; }
}

// Presence of a regular file, never through a link: a linked sign-in would
// be adopted from wherever it points.
const fileState = (file) => (lstat(file)?.isFile() ? 'present' : 'missing');

/**
 * The tool homes of a soul for the given harnesses, by existence only:
 * `{ harness, path, home, routing, containment, reason, hostPath, signIn,
 * hostSignIn, adopted, note, files[] }`. `containment` is
 * `toolHomeDecision` over what is found, and `routing` the variables the
 * next launch sets (none unless contained). Never reads a file's contents.
 * On macOS a host Claude sign-in lives in the keychain, which no file
 * shows and nothing here reads, so its absent file is `unknown`, not
 * `missing`: a signed-in host is never mistaken for one with nothing to
 * lose.
 */
export function inspectToolHomes(soulDir, harnesses, { env = process.env, home = env.HOME ?? homedir(), platform = process.platform } = {}) {
  const journal = readMigrationJournal(soulDir);
  return harnesses.map((harness) => {
    const routed = toolHomeEnv(soulDir, harness);
    const row = toolHomeFor(harness);
    const files = toolHomeFiles(soulDir, harness, { env, home }).map((file) => ({ kind: file.kind, path: file.path, soul: fileState(file.soulPath), host: fileState(file.hostPath) }));
    const signIns = files.filter((file) => file.kind === 'sign-in');
    const state = (side) => (!row.routable || !signIns.length ? 'unknown' : signIns.every((file) => file[side] === 'present') ? 'present' : 'missing');
    const signIn = state('soul');
    let hostSignIn = state('host');
    if (hostSignIn === 'missing' && row.note && platform === 'darwin') hostSignIn = 'unknown';
    const adopted = journal.some((step) => step.id === adoptStepId(harness) && (step.status === 'done' || step.status === 'skipped'));
    const decision = toolHomeDecision(harness, { signIn, hostSignIn, adopted });
    return { harness, path: toolHomeRelative(harness), home: routed.home, routing: decision.containment === 'soul' ? routed.routing : [], containment: decision.containment,
      reason: decision.reason, hostPath: hostToolStore(harness, { env, home }), signIn, hostSignIn, adopted, note: row.note, files };
  });
}

// Whether the next launch of a harness is routed into the soul: the
// decision over what the folder and the host hold right now.
const contained = (soulDir, harness, options) => inspectToolHomes(soulDir, [harness], options)[0].containment === 'soul';

// `.soul-state/tools/<harness>` and every directory the patch points at,
// private, created once. A directory that cannot be made is a coded
// failure: a launch that silently fell back to the host store would be
// the fake containment decision 5 forbids.
export function ensureToolHome(soulDir, harness) {
  const routed = toolHomeEnv(soulDir, harness);
  for (const dir of routed.dirs) {
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    catch (error) { fail('tool-home-unwritable', `${harness}'s tool home ${dir} cannot be created (${error.code ?? error.message}); fix the soul folder's permissions`); }
    if (!lstat(dir)?.isDirectory()) fail('tool-home-unwritable', `${harness}'s tool home ${dir} is not a directory; move what is there aside`);
  }
  return routed;
}

function readJournal(soulDir) {
  const file = path.join(soulDir, STATE, 'migration.json');
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return { schemaVersion: MIGRATION_SCHEMA_VERSION, steps: [] }; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES) return { schemaVersion: MIGRATION_SCHEMA_VERSION, steps: [] };
    const parsed = JSON.parse(readFileSync(fd, 'utf8'));
    return object(parsed) && Array.isArray(parsed.steps) ? parsed : { schemaVersion: MIGRATION_SCHEMA_VERSION, steps: [] };
  } catch { return { schemaVersion: MIGRATION_SCHEMA_VERSION, steps: [] }; }
  finally { closeSync(fd); }
}

/**
 * The recorded steps of `.soul-state/migration.json`, each reduced to the
 * keys the descriptor publishes: `{ id, status, from, to, at, note }`. A
 * missing or malformed journal is an empty list.
 */
export function readMigrationJournal(soulDir) {
  return readJournal(soulDir).steps
    .filter((step) => object(step) && typeof step.id === 'string' && STEP_STATUSES.includes(step.status))
    .map((step) => ({ id: step.id, status: step.status, from: text(step.from), to: text(step.to), at: text(step.at), note: text(step.note) }));
}

// One entry per step id: a rerun replaces its record rather than growing
// the journal. Written whole, privately, through a rename.
function recordStep(soulDir, step) {
  const journal = readJournal(soulDir);
  journal.schemaVersion = MIGRATION_SCHEMA_VERSION;
  journal.steps = [...journal.steps.filter((entry) => !object(entry) || entry.id !== step.id), step];
  const file = path.join(soulDir, STATE, 'migration.json');
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

// A private copy of one regular file: opened without following links,
// bounded, written exclusively with mode 0600. The bytes stay in this
// function; the caller learns only that it was copied.
function copyPrivately(from, to) {
  const fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' });
    if (stat.size > FILE_MAX_BYTES) throw Object.assign(new Error(`larger than ${FILE_MAX_BYTES} bytes`), { code: 'EFBIG' });
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  writeFileSync(to, bytes, { flag: 'wx', mode: 0o600 });
}

/**
 * Adopts the host's sign-in for one harness into the soul's tool home and
 * records the step. Idempotent: a file the soul already has is left alone,
 * so a second run is `skipped` (already adopted). Returns the step record
 * `{ id, status, from, to, at, note, files[] }`; `files[]` names each file
 * and what happened to it (`copied | present | absent | failed`).
 */
export function adoptHostSignIn(soulDir, { harness, env = process.env, home = env.HOME ?? homedir(), now = () => new Date() } = {}) {
  const row = toolHomeFor(harness);
  const step = { id: adoptStepId(harness), status: 'skipped', from: hostToolStore(harness, { env, home }), to: toolHomePath(soulDir, harness), at: now().toISOString(), note: null, files: [] };
  if (!row.routable) { step.note = row.reason; return step; }
  ensureToolHome(soulDir, harness);
  for (const file of toolHomeFiles(soulDir, harness, { env, home })) {
    const entry = { path: file.path, kind: file.kind, status: null };
    step.files.push(entry);
    if (lstat(file.soulPath)?.isFile()) { entry.status = 'present'; continue; }
    if (!lstat(file.hostPath)?.isFile()) { entry.status = 'absent'; continue; }
    try { copyPrivately(file.hostPath, file.soulPath); entry.status = 'copied'; }
    catch (error) {
      entry.status = 'failed';
      step.status = 'failed';
      step.note = `${file.path}: could not be copied (${error.code ?? error.message})`;
      break;
    }
  }
  const signIns = step.files.filter((file) => file.kind === 'sign-in');
  if (step.status !== 'failed') {
    const copied = step.files.filter((file) => file.status === 'copied').map((file) => file.path);
    if (copied.length) { step.status = 'done'; step.note = `copied ${copied.join(', ')}`; }
    else if (signIns.every((file) => file.status === 'present')) step.note = 'already adopted';
    else step.note = 'the host has no sign-in file for this harness; sign in once inside the soul';
    // What a file copy cannot carry (claude's keychain token) is said
    // whenever the sign-in file itself did not come along.
    if (row.note && !signIns.every((file) => file.status === 'present' || file.status === 'copied')) step.note += `; ${row.note}`;
  }
  recordStep(soulDir, step);
  return step;
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
  const registered = typeof soul.soulDir === 'string' && existsSync(soul.soulDir) ? soul.soulDir : null;
  return registered ?? soulDirectory(soul.id, { ...options, readOnly: true });
}

/**
 * The env patch a turn of this harness gets (CLAUDE_CONFIG_DIR, CODEX_HOME,
 * OpenCode's XDG bases), with the tool home created; `{}` when the soul has
 * no folder yet or the harness is unroutable. A tool home that cannot be
 * made fails `tool-home-unwritable`.
 */
export function soulToolHomeEnv(id, { env = process.env, home = env.HOME ?? homedir(), harness = null, platform = process.platform, ...rest } = {}) {
  const options = { env, home, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  if (!harness || !existsSync(path.join(soulDir, STATE)) || !contained(soulDir, harness, { env, home, platform })) return {};
  return ensureToolHome(soulDir, harness).env;
}

/** The `tool-home:<harness>` label a launch has to prepare, or [] (never throws). */
export function pendingSoulToolHome(id, { harness = null, env = process.env, home = env.HOME ?? homedir(), platform = process.platform, ...rest } = {}) {
  try {
    const options = { env, home, ...rest };
    const soul = resolveSoul(id, options);
    const soulDir = soulRoot(soul, options);
    return harness && existsSync(path.join(soulDir, STATE)) && contained(soulDir, harness, { env, home, platform }) ? [`tool-home:${harness}`] : [];
  } catch { return []; }
}

/** Creates the soul's tool home for a launched harness that is routed; fails `tool-home-unwritable` when it cannot. */
export function prepareSoulToolHome(id, { harness = null, env = process.env, home = env.HOME ?? homedir(), platform = process.platform, ...rest } = {}) {
  const options = { env, home, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  if (!harness || !existsSync(path.join(soulDir, STATE)) || !contained(soulDir, harness, { env, home, platform })) return null;
  return ensureToolHome(soulDir, harness).home;
}

// The harnesses a soul names: its execution identity's and its manifest's
// preferred ones, in that order, registry harnesses only.
function soulHarnesses(soulDir, { identityHarness = null } = {}) {
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(path.join(soulDir, 'soul.json'), 'utf8')); } catch { /* no manifest */ }
  const preferred = Array.isArray(manifest?.preferredHarnesses) ? manifest.preferredHarnesses : [];
  return [...new Set([identityHarness, ...preferred].filter((name) => typeof name === 'string' && (Object.hasOwn(ACP_SPAWN_REGISTRY, name) || Object.hasOwn(TOOL_HOME_REGISTRY, name))))];
}

export function formatMigration(result) {
  const lines = [`agentId: ${result.agentId}`, `soulDir: ${result.soulDir}`, `operation: ${result.operation}`, `decision: ${result.decision}`, ''];
  for (const step of result.steps) {
    lines.push(`${step.id}: ${step.status}${step.note ? ` - ${step.note}` : ''}`);
    for (const file of step.files) lines.push(`  ${file.path}: ${file.status}`);
  }
  if (!result.steps.length) lines.push('nothing to adopt');
  return `${lines.join('\n')}\n`;
}

export async function soulEnvMigrateCommand(argv, { gate = ownerGate, readStdin = () => readFileSync(0, 'utf8'), write = (value) => process.stdout.write(value),
  env = process.env, home = env.HOME ?? homedir(), cwd = process.cwd(), now = () => new Date(), ...rest } = {}) {
  let id = null, adopt = false, harness = null, json = false, presented = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--adopt-host-signin' && !adopt) adopt = true;
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented) presented = true;
    else if (arg === '--harness' && harness === null && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('-')) { harness = argv[i + 1]; i += 1; }
    else if (!arg.startsWith('-') && id === null) id = arg;
    else throw new Error(USAGE);
  }
  if (!id || !adopt) throw new Error(USAGE);
  if (harness !== null && !Object.hasOwn(ACP_SPAWN_REGISTRY, harness) && !Object.hasOwn(TOOL_HOME_REGISTRY, harness)) {
    throw new Error(`--harness must be one of ${[...new Set([...Object.keys(ACP_SPAWN_REGISTRY), ...Object.keys(TOOL_HOME_REGISTRY)])].join(', ')}`);
  }
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  const options = { env, home, now, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  if (!existsSync(path.join(soulDir, STATE))) fail('soul-state-missing', `${soulDir} has no .soul-state yet; spawn or launch the soul first`);
  if (harness !== null && !toolHomeFor(harness).routable) fail('tool-home-unsupported', `${harness}: ${toolHomeFor(harness).reason}`);
  // Without --harness: the soul's own harnesses (its execution identity's,
  // then its manifest's preferred ones), the routable ones only.
  let identityHarness = null;
  try { identityHarness = text(readAgentIdentity(soul.id, { stateDir: options.stateDir ?? stateDirectory(options) }).harness); } catch { /* no identity record */ }
  const harnesses = harness !== null ? [harness] : soulHarnesses(soulDir, { identityHarness }).filter((name) => toolHomeFor(name).routable);
  await gate(`adopt the host's ${harnesses.join(', ') || 'harness'} sign-in into ${soul.id}'s soul folder`, { principal, env, cwd });
  const steps = harnesses.map((name) => adoptHostSignIn(soulDir, { harness: name, env, home, now }));
  const decision = steps.some((step) => step.status === 'failed') ? 'failed' : steps.some((step) => step.status === 'done') ? 'adopted' : 'skipped';
  // Names only: which files were copied, present or absent; never a byte of them.
  appendAuditReceipt({ event: 'soul-env-migrate', agentId: soul.id, operation: 'adopt-host-signin', decision,
    detail: steps.map((step) => `${step.id.split(':')[1]}: ${step.status} (${step.files.map((file) => `${file.path} ${file.status}`).join(', ') || step.note})`).join('; ') || 'no routable harness' }, { env, home, now });
  const result = { schemaVersion: MIGRATION_SCHEMA_VERSION, agentId: soul.id, soulDir, operation: 'adopt-host-signin', decision, steps, root: toolHomesRoot(soulDir) };
  write(json ? `${JSON.stringify(result)}\n` : formatMigration(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulEnvMigrateCommand(process.argv.slice(2)).catch((error) => {
    const failure = { code: error.code ?? 'soul-env-migrate-failed', message: error.message, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul env migrate: ${failure.code}: ${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  });
}
