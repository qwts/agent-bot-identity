#!/usr/bin/env node

// Account-local census of Agent souls, one per OS user (ADR-0332). Identity
// JSON remains provenance; this index answers population questions without
// teaching every consumer to scan identity records and Agent Spaces
// independently.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  finalizeAgentIdentity,
  isAgentId,
  readAgentIdentity,
  retireAgentIdentity,
  stateDirectory,
  validateAgentId,
  withLock,
} from './agent-identity.mjs';

import { soulsHome } from './souls-root.mjs';

const SCHEMA_VERSION = 1;
const APP_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Display names (#92). Two words and a two-hex-digit tail, derived
// deterministically from the Agent ID so every existing census row gains a
// stable name with no migration. The census is authoritative: consumers read
// the recorded name and never re-derive meaning from the display string —
// the derivation below is only the default generator, and the row remains
// keyed by Agent ID (names may collide; IDs cannot).
const NAME_ADJECTIVES = [
  'amber', 'ashen', 'bold', 'brisk', 'calm', 'candid', 'civic', 'clever',
  'coral', 'crisp', 'deft', 'dusky', 'eager', 'early', 'even', 'fabled',
  'fair', 'fleet', 'frank', 'gentle', 'gilded', 'glad', 'grand', 'hardy',
  'hazel', 'humble', 'indigo', 'iron', 'jade', 'keen', 'kind', 'lively',
  'loyal', 'lucid', 'mellow', 'mild', 'noble', 'north', 'olive', 'onyx',
  'opal', 'pale', 'patient', 'plain', 'proud', 'quiet', 'rapid', 'rustic',
  'sable', 'sage', 'sharp', 'silent', 'sleek', 'sober', 'solid', 'spry',
  'stark', 'steady', 'still', 'sunny', 'swift', 'tidy', 'vivid', 'wry',
];
const NAME_NOUNS = [
  'anvil', 'arch', 'aspen', 'atlas', 'badger', 'beacon', 'birch', 'bison',
  'brook', 'cairn', 'cedar', 'comet', 'crane', 'delta', 'dune', 'ember',
  'falcon', 'fern', 'fjord', 'flint', 'gable', 'glade', 'grove', 'harbor',
  'heron', 'hollow', 'inlet', 'ivy', 'juniper', 'kestrel', 'knoll', 'lantern',
  'larch', 'ledge', 'linden', 'lynx', 'maple', 'marten', 'mesa', 'moss',
  'otter', 'owl', 'oxbow', 'pine', 'plume', 'quarry', 'quill', 'raven',
  'reed', 'ridge', 'rowan', 'sparrow', 'spruce', 'summit', 'tarn', 'thicket',
  'trellis', 'vale', 'walnut', 'warren', 'weir', 'willow', 'wren', 'yarrow',
];

export function displayName(id) {
  // agentId(), not validateAgentId(): the identity module's message reflects
  // its input, and a name derivation fed untrusted text must answer with a
  // stable error instead of echoing it.
  const hex = agentId(id).slice('agent_'.length).replaceAll('-', '');
  const adjective = NAME_ADJECTIVES[Number.parseInt(hex.slice(0, 2), 16) % NAME_ADJECTIVES.length];
  const noun = NAME_NOUNS[Number.parseInt(hex.slice(2, 4), 16) % NAME_NOUNS.length];
  return `${adjective}-${noun}-${hex.slice(-2)}`;
}

function printableText(name, value, { max = 512, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be printable text no longer than ${max} characters`);
  }
  return value;
}

function agentId(value, name = 'id') {
  try {
    return validateAgentId(value);
  } catch {
    throw new Error(`${name} must be a valid Agent ID`);
  }
}

function appSlug(value) {
  // Null is a soul with no GitHub App (#280). A present value is still a slug.
  if (value === undefined || value === null) return null;
  const slug = printableText('appSlug', value, { max: 100 });
  if (!APP_PATTERN.test(slug)) throw new Error('appSlug must be a GitHub App slug');
  return slug;
}

function canonicalTimestamp(name, value) {
  const text = printableText(name, value, { max: 40 });
  let normalized;
  try {
    normalized = new Date(text).toISOString();
  } catch {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  if (normalized !== text) throw new Error(`${name} must be a canonical ISO timestamp`);
  return text;
}

function transcriptLocator(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('transcriptLocator must be an object or null');
  }
  return {
    provider: printableText('transcriptLocator.provider', value.provider, { max: 80 }),
    id: printableText('transcriptLocator.id', value.id),
  };
}

function normalizeSoul(record, { defaultLastSeen = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('population record must be an object');
  }
  const root = printableText('spacePath', record.spacePath, { max: 4096 });
  if (!path.isAbsolute(root)) throw new Error('spacePath must be absolute');
  const id = agentId(record.id);
  // The checkout setup-worktree last pinned this soul to, so an active soul
  // that no checkout references is discoverable instead of needing a manual
  // diff of the census against every pin (#192). Rows written before the
  // field existed read as null until a setup records one.
  let worktree = null;
  if (record.worktree !== undefined && record.worktree !== null) {
    worktree = printableText('worktree', record.worktree, { max: 4096 });
    if (!path.isAbsolute(worktree)) throw new Error('worktree must be absolute');
  }
  if (record.worktrees !== undefined && !Array.isArray(record.worktrees)) {
    throw new Error('worktrees must be an array');
  }
  const worktrees = [...new Set([
    ...Array.from(record.worktrees ?? [], (value) => {
      const checkout = printableText('worktrees entry', value, { max: 4096 });
      if (!path.isAbsolute(checkout)) throw new Error('worktrees entries must be absolute');
      return path.normalize(checkout);
    }),
    ...(worktree === null ? [] : [path.normalize(worktree)]),
  ])];
  // Rows written before names existed gain one on the next read, derived from
  // the ID, so no migration touches the store; the next write persists it.
  const name = printableText('name', record.name, { max: 80, required: false }) ?? displayName(id);
  if (!NAME_PATTERN.test(name)) {
    throw new Error('name must be hyphen-separated segments of lowercase letters and digits');
  }
  let soulDir;
  if (record.soulDir !== undefined) {
    soulDir = printableText('soulDir', record.soulDir, { max: 4096 });
    if (!path.isAbsolute(soulDir)) throw new Error('soulDir must be absolute');
    soulDir = path.normalize(soulDir);
  }
  return {
    id,
    name,
    ...(soulDir === undefined ? {} : { soulDir }),
    appSlug: appSlug(record.appSlug),
    parentId: record.parentId === undefined || record.parentId === null
      ? null
      : agentId(record.parentId, 'parentId'),
    status: printableText('status', record.status, { max: 80 }),
    spacePath: root,
    worktree,
    worktrees,
    transcriptLocator: transcriptLocator(record.transcriptLocator),
    lastSeen: canonicalTimestamp('lastSeen', record.lastSeen ?? defaultLastSeen),
    // Managed: the daemon started this soul from a launch (GeniusBar or a
    // package), rather than an already-running agent joining. Comms: the
    // agent-comms teammate tools its turns get, fixed at that launch from its
    // soul.json (`comms`, default on). Rows written before either existed
    // read as unmanaged with comms on.
    managed: booleanField('managed', record.managed, false),
    comms: booleanField('comms', record.comms, true),
    // The name the owner chose at launch or join, as agent-comms' census
    // shows it (#429). `name` stays the generated handle agents address.
    ...displayNameField(record.displayName),
    // The harness sign-in a daemon turn found missing or expired (#84), so
    // GeniusBar can ask the owner to sign the soul in again. Absent when the
    // last turn ran, or nothing has failed.
    ...harnessAuthField(record.harnessAuth),
  };
}

export const HARNESS_AUTH_STATUSES = Object.freeze(['signed-out', 'expired']);

function harnessAuthField(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('harnessAuth must be an object');
  if (!HARNESS_AUTH_STATUSES.includes(value.status)) throw new Error(`harnessAuth.status must be one of ${HARNESS_AUTH_STATUSES.join(', ')}`);
  return {
    harnessAuth: {
      status: value.status,
      harness: printableText('harnessAuth.harness', value.harness, { max: 40 }),
      since: canonicalTimestamp('harnessAuth.since', value.since),
    },
  };
}

function displayNameField(value) {
  const shown = printableText('displayName', value, { max: 128, required: false });
  return shown === null ? {} : { displayName: shown };
}

function booleanField(name, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

export function populationFile({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_POPULATION_PATH) return path.resolve(env.AGENT_BOT_POPULATION_PATH);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'population.json');
}

function emptyDocument() {
  return { schemaVersion: SCHEMA_VERSION, souls: Object.create(null) };
}

function readDocument(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyDocument();
    throw new Error('population store could not be read');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON parser errors may quote store contents. The census must never turn
    // corruption into a secret-bearing diagnostic.
    throw new Error('population store is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('population store must be an object');
  }
  if (!Number.isSafeInteger(parsed.schemaVersion) || parsed.schemaVersion < SCHEMA_VERSION) {
    throw new Error('population store has an invalid schemaVersion');
  }
  if (!parsed.souls || typeof parsed.souls !== 'object' || Array.isArray(parsed.souls)) {
    throw new Error('population store souls must be an object');
  }

  const souls = Object.create(null);
  for (const [key, value] of Object.entries(parsed.souls)) {
    const soul = normalizeSoul(value);
    if (key !== soul.id) throw new Error('population store key does not match its Agent ID');
    souls[soul.id] = soul;
  }
  return { schemaVersion: parsed.schemaVersion, souls };
}

function ensurePrivateDirectory(directory) {
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created === undefined) return;
  try {
    chmodSync(directory, 0o700);
  } catch {
    /* POSIX modes are best-effort on other platforms. */
  }
}

function writeDocument(file, souls) {
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const document = { schemaVersion: SCHEMA_VERSION, souls };
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function upsertSoul(
  record,
  { file = populationFile(), now = () => new Date() } = {},
) {
  let candidate = normalizeSoul(record, { defaultLastSeen: now().toISOString() });
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) {
      throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    }
    const existing = current.souls[candidate.id];
    if (existing) {
      if (record.soulDir === undefined && existing.soulDir) candidate.soulDir = existing.soulDir;
      // Launch facts are written only by recordSoulLaunch; a lifecycle upsert
      // that does not mention them carries them forward.
      if (record.managed === undefined) candidate.managed = existing.managed;
      if (record.comms === undefined) candidate.comms = existing.comms;
      candidate.worktrees = [...new Set([...existing.worktrees, ...candidate.worktrees])];
      if (record.worktree === undefined) candidate.worktree = existing.worktree;
    }
    candidate = normalizeSoul(candidate);
    if (existing && JSON.stringify(existing) === JSON.stringify(candidate)) return existing;
    const souls = { ...current.souls, [candidate.id]: candidate };
    writeDocument(file, souls);
    return candidate;
  });
}

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// One locked rewrite so a cutover cannot leave the census split across roots.
export function relocateSoulSpaces(
  fromRoot,
  toRoot,
  { file = populationFile() } = {},
) {
  if (typeof fromRoot !== 'string' || !path.isAbsolute(fromRoot)) {
    throw new Error('fromRoot must be an absolute path');
  }
  if (typeof toRoot !== 'string' || !path.isAbsolute(toRoot)) {
    throw new Error('toRoot must be an absolute path');
  }
  if (!existsSync(file)) return { moved: 0 };
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) {
      throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    }
    const souls = { ...current.souls };
    let moved = 0;
    for (const [id, record] of Object.entries(souls)) {
      if (!pathIsInside(fromRoot, record.spacePath)) continue;
      souls[id] = normalizeSoul({
        ...record,
        spacePath: path.join(toRoot, id),
      });
      moved += 1;
    }
    if (moved > 0) writeDocument(file, souls);
    return { moved };
  });
}

export function updateSoulStatus(
  id,
  status,
  { file = populationFile(), now = () => new Date() } = {},
) {
  const target = agentId(id);
  const nextStatus = printableText('status', status, { max: 80 });
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) {
      throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    }
    const existing = current.souls[target];
    if (!existing) return null;
    const candidate = normalizeSoul({
      ...existing,
      status: nextStatus,
      lastSeen: now().toISOString(),
    });
    const souls = { ...current.souls, [target]: candidate };
    writeDocument(file, souls);
    return candidate;
  });
}

function withSoulLifecycleLock(id, stateDir, operation) {
  const target = agentId(id);
  return withLock(
    path.join(stateDir, `.${target}.lifecycle.lock`),
    `Agent lifecycle ${target}`,
    operation,
  );
}

export function upsertIdentitySoul(
  id,
  spacePath,
  {
    file = populationFile(),
    stateDir = stateDirectory(),
    now = () => new Date(),
    // The checkout being bound. Undefined carries the recorded checkout
    // forward (a lifecycle upsert knows nothing about place); null clears it.
    worktree = undefined,
  } = {},
) {
  const target = agentId(id);
  return withSoulLifecycleLock(target, stateDir, () => {
    // Identity resolution may have completed before a concurrent finalizer.
    // Re-read under the shared lifecycle lock so setup cannot revive a soul.
    const identity = readAgentIdentity(target, { stateDir });
    if (identity.status === 'retired') {
      throw new Error(
        `agent identity ${target} is retired; refusing to register it in the population census`,
      );
    }
    // A retired census record is a tombstone even when the identity record is
    // gone or stale (issue #46): there is no un-retire flow, so nothing may
    // overwrite it back to life.
    let existing = null;
    try {
      existing = showSoul(target, { file });
    } catch {
      /* no census record yet — a fresh soul is fine */
    }
    if (existing?.status === 'retired') {
      throw new Error(
        `soul ${target} is retired in the population census; refusing to revive it`,
      );
    }
    return upsertSoul({
      id: identity.id,
      // The census is authoritative for names: a lifecycle upsert must carry
      // the recorded handle forward, not regenerate the derived default over
      // an operator-chosen one. A missing row derives fresh in normalizeSoul.
      name: existing?.name ?? null,
      appSlug: identity.github?.appSlug ?? null,
      parentId: identity.parentId,
      status: identity.status,
      spacePath,
      worktree: worktree === undefined ? existing?.worktree ?? null : worktree,
      transcriptLocator: identity.transcript
        ? { provider: identity.transcript.provider, id: identity.transcript.id }
        : null,
      lastSeen: now().toISOString(),
    }, { file, now });
  });
}

export function finalizeIdentityWithPopulation(
  id,
  {
    transcriptSha256 = null,
    file = populationFile(),
    stateDir = stateDirectory(),
    now = () => new Date(),
  } = {},
) {
  const target = agentId(id);
  return withSoulLifecycleLock(target, stateDir, () => finalizeAgentIdentity(target, {
    transcriptSha256,
    stateDir,
    now,
    // mutateIdentity restores the provenance record if this synchronized
    // census write fails, so the CLI cannot report failure after partial state.
    onFinalized: (identity) => updateSoulStatus(identity.id, identity.status, { file, now }),
  }));
}

// Retire a soul in BOTH stores under the shared lifecycle lock, mirroring
// finalizeIdentityWithPopulation: the authoritative identity record is marked
// retired (with rollback if the census write fails), so a stale worktree pin
// or transcript match can never resurrect the soul through setup (issue #46).
// A soul may outlive its identity record (pruned state dir); retirement then
// falls back to the census tombstone alone.
export function retireIdentityWithPopulation(
  id,
  {
    file = populationFile(),
    stateDir = stateDirectory(),
    now = () => new Date(),
  } = {},
) {
  const target = agentId(id);
  // The lifecycle lock lives in the state dir; a census-only retirement may
  // run on a machine that never minted an identity record locally.
  ensurePrivateDirectory(stateDir);
  return withSoulLifecycleLock(target, stateDir, () => {
    if (!existsSync(path.join(stateDir, `${target}.json`))) {
      const soul = updateSoulStatus(target, 'retired', { file, now });
      return { identity: null, soul };
    }
    let soul = null;
    const identity = retireAgentIdentity(target, {
      stateDir,
      now,
      // mutateIdentity restores the provenance record if this synchronized
      // census write fails, exactly like the finalize path.
      onRetired: (record) => {
        soul = updateSoulStatus(record.id, record.status, { file, now });
      },
    });
    return { identity, soul };
  });
}

function filterValue(name, value, { app = false } = {}) {
  if (value === undefined || value === null) return null;
  return app ? appSlug(value) : printableText(name, value, { max: 80 });
}

export function listSouls({
  status = null,
  app = null,
  file = populationFile(),
} = {}) {
  const wantedStatus = filterValue('status', status);
  const wantedApp = filterValue('app', app, { app: true });
  const records = Object.values(readDocument(file).souls)
    .filter((record) => wantedStatus === null || record.status === wantedStatus)
    .filter((record) => wantedApp === null || record.appSlug === wantedApp);
  records.sort((left, right) => left.id.localeCompare(right.id));
  return records;
}

export function showSoul(id, { file = populationFile() } = {}) {
  const target = agentId(id);
  const soul = readDocument(file).souls[target];
  if (!soul) throw new Error(`no population record for ${target}`);
  return soul;
}

// Explicit registration also supports souls moved outside the configured root.
export function registerSoulDir(id, directory, { file = populationFile() } = {}) {
  const target = agentId(id);
  const dir = printableText('soulDir', directory, { max: 4096 });
  if (!path.isAbsolute(dir)) throw new Error('soulDir must be absolute');
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    const existing = current.souls[target];
    if (!existing) throw new Error(`no population record for ${target}`);
    const soul = normalizeSoul({ ...existing, soulDir: dir });
    if (existing.soulDir !== soul.soulDir) writeDocument(file, { ...current.souls, [target]: soul });
    return soul;
  });
}

// A managed launch records what it started with: the soul is managed, and
// its comms setting is the one its soul.json had at this launch. Turns read
// it from here, so editing soul.json while the soul runs changes nothing
// until the next launch. Without a census row there is nothing to record,
// which is the default (comms on) — so only an opt-out needs a row.
export function recordSoulLaunch(id, { comms = true } = {}, { file = populationFile() } = {}) {
  const target = agentId(id);
  if (typeof comms !== 'boolean') throw new Error('comms must be a boolean');
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    const existing = current.souls[target];
    if (!existing) {
      if (comms === false) throw new Error(`no population record for ${target}; cannot record comms off`);
      return null;
    }
    const soul = normalizeSoul({ ...existing, managed: true, comms });
    if (existing.managed !== soul.managed || existing.comms !== soul.comms) {
      writeDocument(file, { ...current.souls, [target]: soul });
    }
    return soul;
  });
}

// Souls the daemon launched before launches were recorded (#389) have no
// managed flag and read as unmanaged (#409). The daemon's launch journal is
// the evidence: every ID it reports launched is marked managed, once, with
// its comms setting left as it is. IDs with no census row are skipped, and a
// soul that only joined never appears in the journal.
export function backfillManagedSouls(ids, { file = populationFile() } = {}) {
  const targets = [...new Set(ids)].flatMap((id) => { try { return [agentId(id)]; } catch { return []; } });
  if (!targets.length || !existsSync(file)) return [];
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    const souls = { ...current.souls };
    const marked = [];
    for (const target of targets) {
      const existing = souls[target];
      if (!existing || existing.managed) continue;
      souls[target] = normalizeSoul({ ...existing, managed: true });
      marked.push(target);
    }
    if (marked.length) writeDocument(file, souls);
    return marked;
  });
}

// The owner changed a soul's comms setting while it was not running
// (`agent-bot soul comms`). Its next turn reads this row, so the change
// applies from then; the managed flag is left as it is. Without a row the
// default (on) already holds, so only an opt-out needs one.
export function setSoulComms(id, comms, { file = populationFile() } = {}) {
  const target = agentId(id);
  if (typeof comms !== 'boolean') throw new Error('comms must be a boolean');
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    const existing = current.souls[target];
    if (!existing) {
      if (comms === false) throw new Error(`no population record for ${target}; cannot record comms off`);
      return null;
    }
    const soul = normalizeSoul({ ...existing, comms });
    if (existing.comms !== soul.comms) writeDocument(file, { ...current.souls, [target]: soul });
    return soul;
  });
}

// Records the name a launch or join gave the soul (#429), so every command
// shows the name the census does. Returns the row, or null with no row.
export function recordSoulDisplayName(id, name, { file = populationFile() } = {}) {
  const target = agentId(id);
  const value = printableText('displayName', name, { max: 128 });
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    const existing = current.souls[target];
    if (!existing) return null;
    const soul = normalizeSoul({ ...existing, displayName: value });
    if (existing.displayName !== soul.displayName) writeDocument(file, { ...current.souls, [target]: soul });
    return soul;
  });
}

// Records or clears (`null`) a soul's harness sign-in failure (#84). The
// first failure's time is kept while the status stays the same. `only`
// clears just a failure recorded for that harness. Returns the row, or null
// with no row.
export function recordHarnessAuth(id, value, { file = populationFile(), now = () => new Date(), only = null } = {}) {
  const target = agentId(id);
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    const existing = current.souls[target];
    if (!existing) return null;
    const before = existing.harnessAuth ?? null;
    if (value === null && (before === null || (only !== null && before.harness !== only))) return normalizeSoul(existing);
    const next = value === null ? null : {
      status: value.status,
      harness: value.harness,
      since: before?.status === value.status && before?.harness === value.harness ? before.since : now().toISOString(),
    };
    const { harnessAuth: _dropped, ...rest } = existing;
    const soul = normalizeSoul(next === null ? rest : { ...rest, harnessAuth: next });
    if (JSON.stringify(before) !== JSON.stringify(soul.harnessAuth ?? null)) writeDocument(file, { ...current.souls, [target]: soul });
    return soul;
  });
}

// The one name commands show for a soul (#429): the launch or join name,
// else its soul.json name, else the generated handle.
export function soulShownName(soul, directory = null) {
  if (soul.displayName) return soul.displayName;
  if (directory) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'soul.json'), 'utf8'));
      if (typeof manifest?.name === 'string' && manifest.name.trim()) return manifest.name;
    } catch { /* no readable soul.json */ }
  }
  return soul.name;
}

// What a package's soul.json offers a launch form: only well-formed,
// printable, bounded values; anything else is left out rather than quoted.
const MANIFEST_TEXT = /^[^\u0000-\u001f\u007f]+$/;
function manifestText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && MANIFEST_TEXT.test(text) ? text : null;
}
export function packageManifest(directory) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(directory, 'soul.json'), 'utf8'));
  } catch { return {}; }
  if (!manifest || typeof manifest !== 'object') return {};
  const out = {};
  const name = manifestText(manifest.name, 128);
  if (name) out.name = name;
  const description = manifestText(manifest.description, 512);
  if (description) out.description = description;
  if (Array.isArray(manifest.preferredHarnesses)) {
    const harnesses = manifest.preferredHarnesses.slice(0, 8).map((h) => manifestText(h, 64)).filter(Boolean);
    if (harnesses.length) out.preferredHarnesses = harnesses;
  }
  return out;
}

function claimedByOther(directory, id) {
  // An empty marker is one being written (older tools wrote it in place),
  // not another soul's claim.
  try {
    const owner = readFileSync(path.join(directory, '.soul-state', 'agent-id'), 'utf8').trim();
    return owner !== '' && owner !== id;
  }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function directoryMatches(directory, id) {
  try { return readFileSync(path.join(directory, '.soul-state', 'agent-id'), 'utf8').trim() === id; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// The `.soul` folders directly under the souls root, read once per call.
function soulRootDirs(root) {
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return entries.filter((entry) => entry.name.endsWith('.soul') && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => path.join(root, entry.name));
}

// Where a soul's folder is, without changing the store: `moved` says the
// recorded folder is gone and the soul's marker was found in another one.
// `scan` lists the souls root's folders (memoized by callers that resolve
// many souls).
function resolveSoulDir(soul, root, scan) {
  const target = soul.id;
  if (soul.soulDir && existsSync(soul.soulDir) && directoryMatches(soul.soulDir, target)) return { directory: soul.soulDir, moved: false };
  if (soul.soulDir && !existsSync(soul.soulDir)) {
    const matches = scan().filter((dir) => directoryMatches(dir, target));
    if (matches.length > 1) throw new Error(`multiple soul directories for ${target}`);
    if (matches.length === 1) return { directory: matches[0], moved: true };
  }
  // Names may collide (#92), so a default directory another soul already
  // marked falls back to one carrying this soul's ID suffix.
  const named = path.join(root, `${soul.name}.soul`);
  return { directory: claimedByOther(named, target) ? path.join(root, `${soul.name}-${target.slice(-8)}.soul`) : named, moved: false };
}

export function soulDirectory(id, options = {}) {
  const target = agentId(id);
  const file = options.file ?? populationFile(options);
  const soul = showSoul(target, { file });
  const { root } = soulsHome(options);
  const { directory, moved } = resolveSoulDir(soul, root, () => soulRootDirs(root));
  if (moved) registerSoulDir(target, directory, { file });
  return directory;
}

// The marker's soul, or null when the folder has none (a package, not an
// installed soul). An empty marker is one being written: no claim yet.
// The folder may be an untrusted package, so the marker is read without
// following a link, only as a small regular file, and only an Agent ID is
// believed; anything else is INVALID_MARKER and its contents are never
// echoed (a linked marker could otherwise leak any file the daemon can read).
const INVALID_MARKER = Symbol('invalid soul marker');
const MARKER_MAX_BYTES = 256;
function markerOf(directory) {
  let fd;
  try { fd = openSync(path.join(directory, '.soul-state', 'agent-id'), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    if (error.code === 'ELOOP' || error.code === 'EMLINK') return INVALID_MARKER;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MARKER_MAX_BYTES) return INVALID_MARKER;
    const text = readFileSync(fd, 'utf8').trim();
    if (!text) return null;
    return isAgentId(text) ? text : INVALID_MARKER;
  } finally { closeSync(fd); }
}

function samePath(left, right) {
  try { return realpathSync(left) === realpathSync(right); }
  catch { return path.resolve(left) === path.resolve(right); }
}

// Every folder under the souls root whose marker claims a soul, by soul.
// Copying a soul folder (a Finder Duplicate, #80) copies its marker, so one
// soul can be claimed by several folders.
function soulDirClaims(options = {}) {
  const { root } = soulsHome(options);
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const claims = new Map();
  for (const entry of entries) {
    if (!entry.name.endsWith('.soul') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const directory = path.join(root, entry.name);
    const id = markerOf(directory);
    if (typeof id === 'string') claims.set(id, [...(claims.get(id) ?? []), directory]);
  }
  return claims;
}

// Souls claimed by more than one folder: [{ agentId, soulDir, copies }].
// `soulDir` is the census-registered folder when it still carries the
// marker, else null (no folder is provably the soul's). `copies` are the
// other folders; agent-bot never runs a soul from one of them.
export function duplicateSoulDirs(options = {}) {
  const file = options.file ?? populationFile(options);
  const souls = readDocument(file).souls;
  const duplicates = [];
  for (const [id, dirs] of soulDirClaims(options)) {
    if (dirs.length < 2) continue;
    const registered = souls[id]?.soulDir;
    const owner = registered && dirs.some((dir) => samePath(dir, registered)) ? registered : null;
    duplicates.push({ agentId: id, soulDir: owner, copies: dirs.filter((dir) => !owner || !samePath(dir, owner)).sort() });
  }
  return duplicates.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

// Every folder that carries this soul's marker: its registered folder (which
// may sit outside the souls root) and any under the root, copies included.
export function soulDirsOf(id, options = {}) {
  const target = agentId(id);
  const file = options.file ?? populationFile(options);
  const dirs = [...(soulDirClaims(options).get(target) ?? [])];
  const registered = readDocument(file).souls[target]?.soulDir;
  if (registered && existsSync(registered) && markerOf(registered) === target
    && !dirs.some((dir) => samePath(dir, registered))) dirs.push(registered);
  return dirs.sort();
}

// Moves every folder of this soul (soulDirsOf) into `<souls root>/.archive/`
// as `<UTC stamp>-<folder name>`, never deleting one (#419): a failed launch
// rolls back this way, and `soul remove` archives a soul this way. A move
// across file systems copies, then removes the original. Returns
// [{ from, to }].
export function archiveSoulDirs(id, { now = () => new Date(), rename = renameSync, ...options } = {}) {
  const target = agentId(id);
  const archive = path.join(soulsHome(options).root, '.archive');
  const moved = [];
  for (const from of soulDirsOf(target, options)) {
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    let to = path.join(archive, `${stamp}-${path.basename(from)}`);
    for (let n = 2; existsSync(to); n += 1) to = path.join(archive, `${stamp}-${n}-${path.basename(from)}`);
    try { rename(from, to); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      rmSync(from, { recursive: true, force: true });
    }
    moved.push({ from, to });
  }
  return moved;
}

// Folders under the souls root whose marker names a soul that is not active
// here (#419): a launch that failed before rollback existed, or a soul
// retired while its folder stayed. [{ agentId, path, status }], where status
// is `retired`, or `unknown` when the census has no row. A finalized soul
// keeps its folder on purpose and is not listed.
export function orphanSoulDirs(options = {}) {
  const file = options.file ?? populationFile(options);
  const souls = readDocument(file).souls;
  const orphans = [];
  for (const [id, dirs] of soulDirClaims(options)) {
    const status = souls[id]?.status ?? 'unknown';
    if (status === 'active' || status === 'finalized') continue;
    for (const dir of dirs) orphans.push({ agentId: id, path: dir, status });
  }
  return orphans.sort((left, right) => left.path.localeCompare(right.path));
}

// What a folder opened as a soul package is (#80):
// - `package`: no soul marker; launching it starts a new soul.
// - `installed`: the registered folder of an active soul; opening it means
//   that soul, so a launch relaunches it instead of starting another.
// - `copy`: carries the marker of a soul whose own folder is elsewhere.
// - `duplicate`: several folders claim the soul and none is registered.
// - `unregistered`: the marker names no active soul in this census.
// - `invalid`: the marker is a link, not a small regular file, or not an
//   Agent ID; the message never quotes it.
// Only `package` and `installed` may be launched; the rest carry a message.
// A package also carries what its soul.json says about itself (name,
// description, preferredHarnesses), so a launch form can prefill (#120).
export function locateSoulDir(directory, options = {}) {
  const dir = path.resolve(printableText('path', directory, { max: 4096 }));
  const id = markerOf(dir);
  if (id === INVALID_MARKER) {
    return { path: dir, status: 'invalid',
      message: `${dir} has an invalid soul marker: .soul-state/agent-id must be a regular file holding one Agent ID` };
  }
  if (!id) return { path: dir, status: 'package', ...packageManifest(dir) };
  const file = options.file ?? populationFile(options);
  const soul = readDocument(file).souls[id];
  if (!soul || soul.status !== 'active') {
    return { path: dir, status: 'unregistered', agentId: id,
      message: `${dir} belongs to soul ${id}, which is not an active soul here` };
  }
  const claims = soulDirClaims(options).get(id) ?? [];
  if (!claims.some((claim) => samePath(claim, dir))) claims.push(dir);
  const owner = soul.soulDir && existsSync(soul.soulDir) && markerOf(soul.soulDir) === id ? soul.soulDir
    : claims.length === 1 ? dir : null;
  const copies = claims.filter((claim) => !owner || !samePath(claim, owner)).sort();
  const found = { path: dir, agentId: id, name: soulShownName(soul, owner ?? dir), handle: soul.name, soulDir: owner, copies };
  if (owner && samePath(owner, dir)) return { ...found, status: 'installed' };
  if (owner) {
    return { ...found, status: 'copy',
      message: `${dir} is a copy of soul ${id}, whose folder is ${owner}; open that soul instead and remove the copy` };
  }
  return { ...found, status: 'duplicate',
    message: `${claims.length} folders claim soul ${id} (${claims.sort().join(', ')}); keep its own folder, remove the copies, then retry` };
}

// Agents refer to each other by name, so `show` accepts one — but the census
// stays keyed by Agent ID, and a name is only a handle: zero or several
// matches fail with a stable message instead of guessing.
export function showSoulByName(name, { file = populationFile() } = {}) {
  const wanted = printableText('name', name, { max: 128 });
  const souls = Object.values(readDocument(file).souls);
  // A handle first; else the name the owner chose, as shown (#429).
  let matches = souls.filter((record) => record.name === wanted);
  if (matches.length === 0) matches = souls.filter((record) => record.displayName === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error('no population record with that name');
  throw new Error(
    `that name is shared by ${matches.length} souls; use an Agent ID (${matches.map((record) => record.id).join(', ')})`,
  );
}

function parseCli(argv) {
  const [command = 'list', ...tokens] = argv.slice(2);
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    if (token === '--json') {
      flags.set('json', true);
      continue;
    }
    if (token === '--dry-run') {
      flags.set('dry-run', true);
      continue;
    }
    if (!['--status', '--app'].includes(token)) throw new Error(`unknown option: ${token}`);
    const value = tokens[++index];
    if (!value) throw new Error(`${token} requires a value`);
    flags.set(token.slice(2), value);
  }
  return { command, positional, flags };
}

// "No parent" and "parent unknown" are different answers (#91). A bound row
// (transcript recorded) with a null parentId was in a position to name its
// spawner and had none: genuinely parentless, shown as '-'. An unbound row
// never reached the moment where lineage is observable, so its null means
// "we could not look", shown as '?'.
function formatParent(record) {
  if (record.parentId) return record.parentId;
  return record.transcriptLocator ? '-' : '?';
}

function formatRow(record) {
  const transcript = record.transcriptLocator
    ? `${record.transcriptLocator.provider}:${record.transcriptLocator.id}`
    : '-';
  return [
    record.name,
    record.id,
    record.appSlug ?? '-',
    record.status,
    formatParent(record),
    record.lastSeen,
    record.spacePath,
    transcript,
  ].join('\t');
}

// The role line GeniusBar shows under a soul's name (Lovable X2): the soul's
// own `role` from soul.json, else "Lead" for a soul with a team, then how
// many live souls it started ("Lead · 7 subagents"). Null when there is
// neither, and the host falls back to the harness. `description` is the
// soul.json description, for a Details row. Derived on read, never stored.
const ROLE_MAX = 60;

// Reads only: a moved folder is found but not re-registered, and the record
// given is used as is, so enriching N rows never rereads the store.
function soulManifest(record, root, scan) {
  let directory;
  try { ({ directory } = resolveSoulDir(record, root, scan)); } catch { return null; }
  try { return JSON.parse(readFileSync(path.join(directory, 'soul.json'), 'utf8')); } catch { return null; }
}

function shortText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function withRoles(records, { file = populationFile(), env = process.env, home = homedir() } = {}) {
  const children = new Map();
  for (const soul of listSouls({ file })) {
    if (soul.parentId === null || soul.status === 'retired') continue;
    children.set(soul.parentId, (children.get(soul.parentId) ?? 0) + 1);
  }
  const { root } = soulsHome({ env, home });
  let dirs = null;
  const scan = () => (dirs ??= soulRootDirs(root));
  return records.map((record) => {
    const manifest = soulManifest(record, root, scan);
    const role = shortText(manifest?.role, ROLE_MAX);
    const count = children.get(record.id) ?? 0;
    const parts = [role ?? (count > 0 ? 'Lead' : null), count > 0 ? `${count} ${count === 1 ? 'subagent' : 'subagents'}` : null].filter(Boolean);
    return {
      ...record,
      role,
      description: shortText(manifest?.description, 280),
      children: count,
      roleLine: parts.length ? parts.join(' · ') : null,
    };
  });
}

function formatPopulation(records) {
  // Retired souls are tombstones, not census peers: list them in their own
  // section so an operator scanning the living population never mistakes a
  // retired soul for an active one (issue #46).
  const active = records.filter((record) => record.status !== 'retired');
  const retired = records.filter((record) => record.status === 'retired');
  const lines = ['NAME\tID\tAPP\tSTATUS\tPARENT\tLAST SEEN\tSPACE\tTRANSCRIPT'];
  for (const record of active) lines.push(formatRow(record));
  if (retired.length > 0) {
    lines.push('', 'RETIRED');
    for (const record of retired) lines.push(formatRow(record));
  }
  // "transcript pending" may not persist silently (#91): every listing counts
  // the souls that never bound and names the repair, so the gap stays loud
  // until an operator either backfills it or accepts it knowingly.
  const pending = active.filter((record) => record.transcriptLocator === null);
  if (pending.length > 0) {
    lines.push(
      '',
      `${pending.length} of ${active.length} souls have never bound a transcript (PARENT '?'); `
      + `'agent-bot population backfill' repairs what local transcripts still prove.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseCli(process.argv);
  switch (args.command) {
    case 'list': {
      if (args.positional.length > 0) throw new Error('population list does not accept Agent IDs');
      const records = listSouls({ status: args.flags.get('status'), app: args.flags.get('app') });
      if (args.flags.has('json')) process.stdout.write(`${JSON.stringify(withRoles(records), null, 2)}\n`);
      else process.stdout.write(formatPopulation(records));
      break;
    }
    case 'show': {
      if (args.flags.has('status') || args.flags.has('app')) {
        throw new Error('population show does not accept filters');
      }
      if (args.positional.length !== 1) throw new Error('population show requires one Agent ID or name');
      const target = args.positional[0];
      const soul = target.startsWith('agent_')
        ? showSoul(target)
        : showSoulByName(target);
      process.stdout.write(`${JSON.stringify(withRoles([soul])[0], null, 2)}\n`);
      break;
    }
    case 'backfill': {
      if (args.positional.length > 0 || args.flags.has('status') || args.flags.has('app')) {
        throw new Error('population backfill accepts only --dry-run and --json');
      }
      const { backfillTranscriptLocators, formatBackfillReport } = await import('./agent-backfill.mjs');
      const report = backfillTranscriptLocators({ apply: !args.flags.has('dry-run') });
      if (args.flags.has('json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(formatBackfillReport(report));
      break;
    }
    default:
      throw new Error(
        'usage: agent-bot population list [--status <status>] [--app <slug>] [--json]\n' +
          '       agent-bot population show <agent-id|name> [--json]\n' +
          '       agent-bot population backfill [--dry-run] [--json]',
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-population: ${error.message}\n`);
    process.exit(1);
  });
}
