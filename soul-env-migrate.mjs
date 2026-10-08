#!/usr/bin/env node
// `agent-bot soul env migrate`: the soul's tool homes on disk and the
// adoption of host sign-ins (#583 slice 2, ADR-0583 decision 5), and the
// move of a linked Agent Space into the soul folder (slice 5, decision 8,
// the mechanism in soul-memory.mjs), and the rename of an instance whose
// bundled template changed its name (GeniusBar#287, the mechanism in
// soul-templates.mjs).
//
// Reading is by existence only: whether a sign-in file is there, in the
// soul's tool home and in the host store, never what it holds. Adoption
// copies the files the registry names (soul-tool-homes.mjs), once, into
// the soul's tool home with private modes, records the step in
// `.soul-state/migration.json` and leaves an audit receipt naming files,
// never contents. The macOS keychain is never read: a keychain sign-in is
// per user, and the harness asks for it once inside the soul.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACP_SPAWN_REGISTRY } from './acp-registry.mjs';
import { readAgentIdentity, stateDirectory } from './agent-identity.mjs';
import { populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { ownerGate } from './cold-wake-settings.mjs';
import { SPACE_STEP_ID, migrateSpaceIntoSoul } from './soul-memory.mjs';
import { MIGRATION_SCHEMA_VERSION, readMigrationJournal, recordMigrationStep } from './soul-migration-journal.mjs';
import { planTemplateRename, renameFromTemplate } from './soul-templates.mjs';
import { TOOL_HOME_REGISTRY, adoptStepId, hostToolStore, toolHomeDecision, toolHomeEnv, toolHomeFiles, toolHomeFor, toolHomePath, toolHomeRelative, toolHomesRoot } from './soul-tool-homes.mjs';

// The journal lives in soul-migration-journal.mjs (shared with the space
// move); its API stays importable from here.
export { MIGRATION_JOURNAL, MIGRATION_SCHEMA_VERSION, STEP_STATUSES, readMigrationJournal } from './soul-migration-journal.mjs';
export const TEMPLATE_NAME_STEP_ID = 'template-name';
// `--complete` (#583 slice 6): every step the descriptor lists as not
// finished, run through the mechanism its own verb uses.
export const COMPLETE_OPERATION = 'complete';
export const MIGRATION_OPERATIONS = Object.freeze(['adopt-host-signin', 'space-into-soul', TEMPLATE_NAME_STEP_ID, COMPLETE_OPERATION]);
// Steps no release migrates yet: `--complete` lists them as they are and
// says so, never records them, so the descriptor keeps them pending.
const DEFERRED_STEPS = Object.freeze({ 'harnesses-into-runtimes': 'not migrated by this release; the harness install stays where it is and still launches' });
const STATE = '.soul-state';
const USAGE = 'usage: agent-bot soul env migrate <agentId|name> --adopt-host-signin [--harness NAME] | --space-into-soul | --template-name [--plan] | --complete [--plan] [--json] [--principal-stdin]';
// A sign-in file is small; `.claude.json` carries project state and can
// reach a few megabytes. Anything larger is not a file this adopts.
const FILE_MAX_BYTES = 16 * 1024 * 1024;
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
  recordMigrationStep(soulDir, step);
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
    for (const file of Array.isArray(step.files) ? step.files : []) lines.push(`  ${file.path}: ${file.status}`);
    for (const key of ['source', 'to', 'retired']) if (step.id === SPACE_STEP_ID && step[key]) lines.push(`  ${key}: ${step[key]}`);
    if (step.id === TEMPLATE_NAME_STEP_ID) {
      for (const key of ['from', 'to']) if (step[key]) lines.push(`  ${key}: ${step[key]}`);
      if (step.displayName?.from || step.displayName?.to) lines.push(`  displayName: ${step.displayName.from ?? '-'} -> ${step.displayName.to ?? '-'}`);
    }
    for (const link of step.copied?.links ?? []) lines.push(`  link kept as a link: ${link}`);
  }
  if (!result.steps.length) lines.push(result.operation === SPACE_STEP_ID ? 'nothing to move' : result.operation === COMPLETE_OPERATION ? 'nothing pending' : 'nothing to adopt');
  return `${lines.join('\n')}\n`;
}

// Whether the daemon has a turn in flight or a warm harness for the soul,
// as `soul remove` asks (soul-comms.mjs); loaded on demand because that
// module reaches the daemon client. No daemon means nothing is running.
async function soulIsRunning(agentId, { env, home }) {
  const { soulRunning } = await import('./soul-comms.mjs');
  return soulRunning(agentId, { env, home });
}

export async function soulEnvMigrateCommand(argv, { gate = ownerGate, readStdin = () => readFileSync(0, 'utf8'), write = (value) => process.stdout.write(value),
  env = process.env, home = env.HOME ?? homedir(), cwd = process.cwd(), now = () => new Date(), running = soulIsRunning, ...rest } = {}) {
  let id = null, operation = null, harness = null, json = false, presented = false, plan = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--adopt-host-signin' && operation === null) operation = 'adopt-host-signin';
    else if (arg === '--space-into-soul' && operation === null) operation = SPACE_STEP_ID;
    else if (arg === '--template-name' && operation === null) operation = TEMPLATE_NAME_STEP_ID;
    else if (arg === '--complete' && operation === null) operation = COMPLETE_OPERATION;
    else if (arg === '--plan' && !plan) plan = true;
    else if (arg === '--json' && !json) json = true;
    else if (arg === '--principal-stdin' && !presented) presented = true;
    else if (arg === '--harness' && harness === null && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('-')) { harness = argv[i + 1]; i += 1; }
    else if (!arg.startsWith('-') && id === null) id = arg;
    else throw new Error(USAGE);
  }
  if (!id || operation === null || (harness !== null && operation !== 'adopt-host-signin') || (plan && (![TEMPLATE_NAME_STEP_ID, COMPLETE_OPERATION].includes(operation) || presented))) throw new Error(USAGE);
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
  if (operation === SPACE_STEP_ID) return spaceIntoSoul({ soul, soulDir, principal, json, gate, running, write, env, home, cwd, now, file: options.file ?? populationFile(options) });
  if (operation === TEMPLATE_NAME_STEP_ID) return templateName({ soul, soulDir, principal, json, plan, gate, write, env, home, cwd, now, options: { ...options, file: options.file ?? populationFile(options) } });
  if (operation === COMPLETE_OPERATION) return complete({ soul, soulDir, principal, json, plan, gate, running, write, env, home, cwd, now, options: { ...options, file: options.file ?? populationFile(options) } });
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

// `--space-into-soul`: one soul, owner-gated, refused while the soul runs
// (a turn could write into the space mid-copy), checked again after the
// gate as `soul remove` does. The receipt names counts and paths, never a
// file's contents.
async function spaceIntoSoul({ soul, soulDir, principal, json, gate, running, write, env, home, cwd, now, file }) {
  const refuseRunning = () => fail('space-migrate-busy', `${soul.id} is running (a turn in flight or a warm harness); stop it before moving its Agent Space`, { action: `agent-bot soul stop ${soul.id}` });
  if (await running(soul.id, { env, home })) refuseRunning();
  await gate(`move ${soul.id}'s Agent Space into its soul folder`, { principal, env, cwd });
  if (await running(soul.id, { env, home })) refuseRunning();
  let step;
  try { step = migrateSpaceIntoSoul(soulDir, { agentId: soul.id, file, now }); }
  catch (error) {
    appendAuditReceipt({ event: 'soul-env-migrate', agentId: soul.id, operation: SPACE_STEP_ID, decision: 'failed', detail: `${error.code ?? 'error'}: ${error.message}` }, { env, home, now });
    throw error;
  }
  const decision = step.status === 'done' ? 'migrated' : step.status;
  const detail = step.status === 'done'
    ? `${step.copied?.files ?? 0} file(s), ${step.copied?.links.length ?? 0} link(s) from ${step.source} to ${step.to}; source retired to ${step.retired ?? 'nowhere'}`
    : `${step.status}: ${step.note ?? ''}`;
  appendAuditReceipt({ event: 'soul-env-migrate', agentId: soul.id, operation: SPACE_STEP_ID, decision, detail }, { env, home, now });
  const result = { schemaVersion: MIGRATION_SCHEMA_VERSION, agentId: soul.id, soulDir, operation: SPACE_STEP_ID, decision, steps: [step], root: step.to };
  write(json ? `${JSON.stringify(result)}\n` : formatMigration(result));
  return result;
}

// `--template-name`: one instance, owner-gated unless `--plan` (read-only,
// nothing recorded). A pending rename is one package revision through the
// host edit path and the census display name when it was the template's
// (soul-templates.mjs); a name the owner chose is skipped and recorded as
// such, so a rerun says why without asking again. The receipt names the
// names, never a file.
async function templateName({ soul, soulDir, principal, json, plan, gate, write, env, home, cwd, now, options }) {
  const { planned, base } = templateNameBase(soul, soulDir, { env, now });
  const emit = (step, decision) => {
    const result = { schemaVersion: MIGRATION_SCHEMA_VERSION, agentId: soul.id, soulDir, operation: TEMPLATE_NAME_STEP_ID, decision, steps: [step], root: soulDir };
    write(json ? `${JSON.stringify(result)}\n` : formatMigration(result));
    return result;
  };
  if (plan) return emit({ ...base, displayName: { ...base.displayName, to: base.displayName.from } }, 'planned');
  const authorization = await gate(`rename ${soul.id} from template name ${planned.templateName.from ?? planned.from ?? 'unknown'} to ${planned.templateName.to ?? 'its template'}`, { principal, env, cwd });
  const { step, decision } = await applyTemplateName({ soul, soulDir, planned, base, authorization, env, home, now, options }, { rethrow: true });
  return emit(step, decision);
}

// The template-name step the plan calls for, recorded and receipted as
// its own verb does: `skipped` for a name the owner chose, `done` after
// the rename, `failed` with the code in the note. `rethrow` is the verb's
// behaviour (the failure ends the command); `--complete` keeps going.
async function applyTemplateName({ soul, soulDir, planned, base, authorization, env, home, now, options }, { rethrow = false } = {}) {
  if (planned.status !== 'pending') {
    const step = recordMigrationStep(soulDir, { ...base, displayName: { ...base.displayName, to: base.displayName.from } });
    appendAuditReceipt({ event: 'soul-env-migrate', agentId: soul.id, operation: TEMPLATE_NAME_STEP_ID, decision: 'skipped', detail: `${planned.from ?? '-'}: ${planned.note}` }, { env, home, now });
    return { step, decision: 'skipped' };
  }
  let step;
  try {
    const done = await renameFromTemplate(soul.id, soulDir, planned, { ...options, stateDir: options.stateDir ?? stateDirectory(options), now, ...(authorization?.method ? { authorization } : {}) });
    step = recordMigrationStep(soulDir, { ...base, status: 'done', at: now().toISOString(), note: done.note, revision: done.revision, parentRevision: done.parentRevision, displayName: done.displayName });
  } catch (error) {
    step = recordMigrationStep(soulDir, { ...base, status: 'failed', at: now().toISOString(), note: `${error.code ?? 'error'}: ${error.message}` });
    appendAuditReceipt({ event: 'soul-env-migrate', agentId: soul.id, operation: TEMPLATE_NAME_STEP_ID, decision: 'failed', detail: `${error.code ?? 'error'}: ${error.message}` }, { env, home, now });
    if (rethrow) throw error;
    return { step, decision: 'failed' };
  }
  appendAuditReceipt({ event: 'soul-env-migrate', agentId: soul.id, operation: TEMPLATE_NAME_STEP_ID, decision: 'renamed',
    detail: `${step.from} -> ${step.to} (revision ${step.revision}); display name ${step.displayName.from ?? '-'} -> ${step.displayName.to ?? '-'}` }, { env, home, now });
  return { step, decision: 'renamed' };
}

// The template-name step as `templateName` builds it before deciding.
function templateNameBase(soul, soulDir, { env, now }) {
  const planned = planTemplateRename(soulDir, { env });
  const base = { id: TEMPLATE_NAME_STEP_ID, status: planned.status, from: planned.from, to: planned.to, at: now().toISOString(), note: planned.note,
    templateName: planned.templateName, template: planned.template, displayName: { from: typeof soul.displayName === 'string' ? soul.displayName : null, to: null } };
  return { planned, base };
}

// `--complete` (#583 slice 6): every migration step the descriptor lists
// as not finished (a pending inventory entry, a phase an interrupted run
// left, a failed step to retry), run through the mechanism its own verb
// uses and recorded as that verb records it, so the journal keeps its
// format. Owner-gated once for the lot, refused `soul-running` while the
// soul runs (checked before and after the gate), `--plan` read-only. A
// step this release does not migrate is listed as it is with a note and
// never recorded, so the descriptor keeps it pending. Idempotent: nothing
// pending is `skipped` with no steps, no gate and no receipt.
async function complete({ soul, soulDir, principal, json, plan, gate, running, write, env, home, cwd, now, options }) {
  // Loaded on demand: soul-env.mjs imports this module for the tool homes
  // and the journal, so a static import would be a cycle.
  const { readSoulEnvironment } = await import('./soul-env.mjs');
  const describe = () => readSoulEnvironment(soul.id, { env, home, now, ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.platform ? { platform: options.platform } : {}), ...(options.stateDir ? { stateDir: options.stateDir } : {}) });
  const emit = (steps, decision) => {
    const result = { schemaVersion: MIGRATION_SCHEMA_VERSION, agentId: soul.id, soulDir, operation: COMPLETE_OPERATION, decision, steps, root: soulDir };
    write(json ? `${JSON.stringify(result)}\n` : formatMigration(result));
    return result;
  };
  const inventory = () => describe().migration.steps.filter((step) => !['done', 'skipped'].includes(step.status));
  const planned = inventory().map((step) => ({ ...step, note: DEFERRED_STEPS[step.id] ?? step.note ?? (step.status === 'failed' ? 'failed last time; run again' : step.status === 'pending' ? 'not started' : `interrupted while ${step.status}; resumed`) }));
  if (plan) return emit(planned, 'planned');
  const runnable = planned.filter((step) => !Object.hasOwn(DEFERRED_STEPS, step.id));
  if (!runnable.length) return emit(planned, 'skipped');
  const refuseRunning = () => fail('soul-running', `${soul.id} is running (a turn in flight or a warm harness); stop it before completing its migration`, { action: `agent-bot soul stop ${soul.id}` });
  if (await running(soul.id, { env, home })) refuseRunning();
  const authorization = await gate(`complete ${soul.id}'s pending migration (${runnable.map((step) => step.id).join(', ')})`, { principal, env, cwd });
  if (await running(soul.id, { env, home })) refuseRunning();
  const steps = [];
  // The owner may have taken a while: what is pending is read again now.
  for (const entry of inventory()) {
    if (Object.hasOwn(DEFERRED_STEPS, entry.id)) { steps.push({ ...entry, note: DEFERRED_STEPS[entry.id] }); continue; }
    try {
      if (entry.id === SPACE_STEP_ID) steps.push(migrateSpaceIntoSoul(soulDir, { agentId: soul.id, file: options.file, now }));
      else if (entry.id.startsWith('adopt-host-signin:')) steps.push(adoptHostSignIn(soulDir, { harness: entry.id.slice('adopt-host-signin:'.length), env, home, now }));
      else if (entry.id === TEMPLATE_NAME_STEP_ID) {
        const { planned: rename, base } = templateNameBase(soul, soulDir, { env, now });
        steps.push((await applyTemplateName({ soul, soulDir, planned: rename, base, authorization, env, home, now, options })).step);
      } else steps.push({ ...entry, status: 'failed', note: 'no mechanism for this step in this release' });
    } catch (error) {
      // A coded refusal (the source is gone, a verify failed) is this
      // step's outcome; the other steps still run.
      steps.push({ id: entry.id, status: 'failed', from: entry.from, to: entry.to, at: now().toISOString(), note: `${error.code ?? 'error'}: ${error.message}`, action: error.action ?? null });
    }
  }
  const decision = steps.some((step) => step.status === 'failed') ? 'failed' : steps.some((step) => step.status === 'done') ? 'completed' : 'skipped';
  // Step ids and outcomes only: each step's own record holds its note and
  // paths, and a receipt's detail is bounded.
  appendAuditReceipt({ event: 'soul-env-migrate', agentId: soul.id, operation: COMPLETE_OPERATION, decision,
    detail: steps.map((step) => `${step.id}: ${step.status}`).join('; ') || 'nothing pending' }, { env, home, now });
  return emit(steps, decision);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulEnvMigrateCommand(process.argv.slice(2)).catch((error) => {
    const failure = { code: error.code ?? 'soul-env-migrate-failed', message: error.message, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul env migrate: ${failure.code}: ${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  });
}
