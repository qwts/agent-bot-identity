#!/usr/bin/env node

// Transcript-bound execution identities (ENG-0081).
//
// The GitHub App remains the external actor. This module mints one private,
// structured identity per agent conversation so a commit can be resolved back
// to the provider transcript that produced it. Records contain no credential:
// they name the existing worktree-token provider, which continues to mint
// short-lived installation tokens privately and on demand.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveAgentSlug, AGENT_ID_KEYS } from './resolve-agent.mjs';
import { harnessForSlug, loadConfig } from './config.mjs';

const SCHEMA_VERSION = 1;
const ID_PATTERN = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APP_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function optionalText(name, value, { max = 512 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be printable text no longer than ${max} characters`);
  }
  return value;
}

function requiredText(name, value, options) {
  const text = optionalText(name, value, options);
  if (text === null) throw new Error(`${name} is required`);
  return text;
}

export function validateAgentId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`invalid Agent ID: ${JSON.stringify(id)}`);
  }
  return id;
}

export function stateDirectory({ env = process.env, home = homedir() } = {}) {
  // AGENT_BOT_STATE_HOME is the standalone name; QWTS_AGENT_STATE_HOME remains
  // accepted so playbook-engineering launchers keep working against this clone.
  const override = env.AGENT_BOT_STATE_HOME ?? env.QWTS_AGENT_STATE_HOME;
  if (override) return path.resolve(override);
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'agent-identities');
}

export function discoverTranscript(env = process.env) {
  const transcriptId = env.AGENT_BOT_TRANSCRIPT_ID ?? env.QWTS_AGENT_TRANSCRIPT_ID;
  if (transcriptId) {
    return {
      provider:
        optionalText(
          'AGENT_BOT_TRANSCRIPT_PROVIDER',
          env.AGENT_BOT_TRANSCRIPT_PROVIDER ?? env.QWTS_AGENT_TRANSCRIPT_PROVIDER,
        ) ?? 'custom',
      id: requiredText('AGENT_BOT_TRANSCRIPT_ID', transcriptId),
    };
  }
  if (env.CODEX_THREAD_ID) {
    return { provider: 'codex', id: requiredText('CODEX_THREAD_ID', env.CODEX_THREAD_ID) };
  }
  if (env.CLAUDE_SESSION_ID) {
    return { provider: 'claude', id: requiredText('CLAUDE_SESSION_ID', env.CLAUDE_SESSION_ID) };
  }
  if (env.CURSOR_CONVERSATION_ID) {
    return {
      provider: 'cursor',
      id: requiredText('CURSOR_CONVERSATION_ID', env.CURSOR_CONVERSATION_ID),
    };
  }
  return null;
}

export function identityFieldsFromEnv(env = process.env) {
  const team = env.AGENT_BOT_TEAM ?? env.QWTS_AGENT_TEAM;
  const squad = env.AGENT_BOT_SQUAD ?? env.QWTS_AGENT_SQUAD;
  const type = env.AGENT_BOT_TYPE ?? env.QWTS_AGENT_TYPE;
  const level = env.AGENT_BOT_LEVEL ?? env.QWTS_AGENT_LEVEL;
  const parentId = env.AGENT_BOT_PARENT_ID ?? env.QWTS_AGENT_PARENT_ID;
  return {
    team: optionalText('AGENT_BOT_TEAM', team),
    squad: optionalText('AGENT_BOT_SQUAD', squad),
    type: optionalText('AGENT_BOT_TYPE', type) ?? 'agent',
    level: optionalText('AGENT_BOT_LEVEL', level),
    parentId: parentId ? validateAgentId(parentId) : null,
  };
}

// Standalone: derive the harness from config / slug shape. Optional rosterPath
// keeps the playbook call signature for callers that still pass one.
export function harnessForApp(appSlug, _rosterPath) {
  return harnessForSlug(appSlug, loadConfig());
}

function normalizeTranscript(transcript) {
  if (!transcript) return null;
  return {
    provider: requiredText('transcript.provider', transcript.provider, { max: 80 }),
    id: requiredText('transcript.id', transcript.id),
    sha256: optionalText('transcript.sha256', transcript.sha256, { max: 64 }),
  };
}

function normalizeValues(name, values) {
  return [...new Set((values ?? []).map((value) => requiredText(name, value, { max: 1024 })))];
}

export function validateIdentity(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['identity must be an object'];
  if (record.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  try {
    validateAgentId(record.id);
  } catch (error) {
    errors.push(error.message);
  }
  if (!APP_PATTERN.test(record.github?.appSlug ?? '')) errors.push('github.appSlug must be a GitHub App slug');
  if (record.github?.credentialProvider !== 'worktree-token') {
    errors.push('github.credentialProvider must be worktree-token');
  }
  if ('token' in (record.github ?? {}) || 'privateKey' in (record.github ?? {}) || 'secret' in (record.github ?? {})) {
    errors.push('identity records must not contain credentials');
  }
  if (!['active', 'finalized', 'retired'].includes(record.status)) {
    errors.push('status must be active, finalized, or retired');
  }
  if (record.parentId !== null) {
    try {
      validateAgentId(record.parentId);
    } catch (error) {
      errors.push(`parentId: ${error.message}`);
    }
  }
  if (record.transcript !== null) {
    try {
      normalizeTranscript(record.transcript);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!Array.isArray(record.subjects) || !Array.isArray(record.artifacts)) {
    errors.push('subjects and artifacts must be arrays');
  }
  return errors;
}

function ensureStateDirectory(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    /* another platform may not expose POSIX modes */
  }
}

function identityPath(root, id) {
  return path.join(root, `${validateAgentId(id)}.json`);
}

function writeNewIdentity(root, record) {
  ensureStateDirectory(root);
  const target = identityPath(root, record.id);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    // A hard link publishes the fully-written record atomically while keeping
    // allocation exclusive: linkSync fails with EEXIST if another allocator
    // already claimed this Agent ID.
    linkSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function replaceIdentity(root, record) {
  const target = identityPath(root, record.id);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(temporary, target);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const STALE_LOCK_MS = 30_000;
// The takeover mutex only ever spans a stat, a rename and an rmdir, so an old
// one means a process died mid-swap rather than a slow neighbour.
const STALE_TAKEOVER_MS = 5_000;

// A directory rename is NOT a compare-and-swap: `renameSync(lock, …)` moves
// whatever occupies the path when it runs, not the directory the caller judged
// stale a moment earlier. Checking an inode afterwards does not fix that — by
// then a third waiter can already be inside its critical section, and the
// rollback can fail with ENOTEMPTY once that waiter stamps its own owner file.
// Verifying after acting is always too late.
//
// So the mutual exclusion rests on one invariant instead:
//
//   `lock` is removed or renamed ONLY while holding `<lock>.takeover`.
//
// Acquisition does not need the mutex, because `mkdirSync` only succeeds when
// the path is free, and the path can only become free through a release or a
// reclaim — both of which hold it. That makes a reclaimer's stat→rename window
// safe: while it holds the mutex nothing can release the lock, so nothing can
// replace it, so what it renames is what it inspected. See issue #15.
function ownerToken(lock) {
  try {
    return readFileSync(path.join(lock, 'owner'), 'utf8');
  } catch {
    return null;
  }
}

// Runs `mutate` while holding the takeover mutex, or returns false without
// running it. Callers must treat false as "try again later" — never as
// permission to proceed unguarded.
function withTakeover(lock, mutate) {
  const takeover = `${lock}.takeover`;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      mkdirSync(takeover, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        // A mutex this old belongs to a process that died holding it. Its
        // critical section touches only the lock path, so collecting it plainly
        // is bounded: the worst case is two reclaimers, which is the situation
        // that existed everywhere before this change.
        if (Date.now() - statSync(takeover).mtimeMs > STALE_TAKEOVER_MS) {
          rmSync(takeover, { recursive: true, force: true });
          continue;
        }
      } catch (staleError) {
        if (staleError.code !== 'ENOENT') throw staleError;
      }
      sleep(5);
      continue;
    }
    try {
      mutate();
      return true;
    } finally {
      rmSync(takeover, { recursive: true, force: true });
    }
  }
  return false;
}

export function reclaimStaleLock(lock, observed) {
  return withTakeover(lock, () => {
    // Re-read under the mutex. Nothing can remove or replace `lock` from here
    // until the mutex is dropped, so this reading stays true for the rename.
    let current;
    try {
      current = statSync(lock);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (current.ino !== observed.ino) return;
    if (Date.now() - current.mtimeMs <= STALE_LOCK_MS) return;

    const stale = `${lock}.stale.${process.pid}.${randomUUID()}`;
    renameSync(lock, stale);
    let moved;
    try {
      moved = statSync(stale);
    } catch {
      return;
    }
    if (moved.ino !== observed.ino) {
      // Unreachable while the invariant holds; kept because getting this wrong
      // costs a live holder its lock. Restoring is best-effort: if a waiter has
      // already taken the free path, leave both alone rather than throwing.
      try {
        renameSync(stale, lock);
      } catch (restoreError) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(restoreError.code)) throw restoreError;
      }
      return;
    }
    rmSync(stale, { recursive: true, force: true });
  });
}

export function withLock(lock, label, operation) {
  const token = `${process.pid}.${randomUUID()}`;
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const observed = statSync(lock);
        if (Date.now() - observed.mtimeMs > STALE_LOCK_MS) {
          reclaimStaleLock(lock, observed);
          continue;
        }
      } catch (lockError) {
        if (lockError.code !== 'ENOENT') throw lockError;
        /* another writer released or took over the observed lock */
      }
      sleep(10);
      continue;
    }
    try {
      // Stamped after the exclusive mkdir, so it can only ever describe the
      // holder. If stamping fails the directory must not be left behind: an
      // unstamped lock is owned by nobody and would block every writer until
      // the staleness window expired.
      writeFileSync(path.join(lock, 'owner'), token, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      rmSync(lock, { recursive: true, force: true });
      throw error;
    }
    acquired = true;
    break;
  }
  if (!acquired) throw new Error(`timed out waiting for ${label}`);
  try {
    return operation();
  } finally {
    // Under the mutex, so the directory whose token we read is the one we
    // remove. Reading the token and then removing the path as two separate
    // steps would delete a successor's lock whenever ours had been reclaimed
    // mid-operation — one stolen lock becoming a cascade.
    withTakeover(lock, () => {
      if (ownerToken(lock) === token) rmSync(lock, { recursive: true, force: true });
    });
  }
}

function withIdentityLock(root, id, operation) {
  return withLock(`${identityPath(root, id)}.lock`, `Agent ID ${id}`, operation);
}

function withRegistryLock(root, operation) {
  ensureStateDirectory(root);
  return withLock(path.join(root, '.allocation.lock'), 'identity allocation', operation);
}

export function readAgentIdentity(id, { stateDir = stateDirectory() } = {}) {
  let record;
  try {
    record = JSON.parse(readFileSync(identityPath(stateDir, id), 'utf8'));
  } catch (error) {
    throw new Error(`could not read Agent ID ${id}: ${error.message}`);
  }
  const errors = validateIdentity(record);
  if (errors.length > 0) throw new Error(`Agent ID ${id} is invalid: ${errors.join('; ')}`);
  return record;
}

export function mintAgentIdentity({
  appSlug,
  botUid = null,
  harness = null,
  transcript = null,
  team = null,
  squad = null,
  type = 'agent',
  level = null,
  parentId = null,
  subjects = [],
  artifacts = [],
  stateDir = stateDirectory(),
  now = () => new Date(),
  idFactory = () => `agent_${randomUUID()}`,
} = {}) {
  const slug = requiredText('appSlug', appSlug, { max: 100 });
  if (!APP_PATTERN.test(slug)) throw new Error(`invalid GitHub App slug: ${JSON.stringify(slug)}`);
  const normalizedParent = parentId ? validateAgentId(parentId) : null;
  const createdAt = now().toISOString();

  for (let attempt = 0; attempt < 8; attempt++) {
    const record = {
      schemaVersion: SCHEMA_VERSION,
      id: validateAgentId(idFactory()),
      team: optionalText('team', team) ?? slug,
      squad: optionalText('squad', squad),
      type: requiredText('type', type, { max: 80 }),
      level: optionalText('level', level, { max: 80 }),
      parentId: normalizedParent,
      harness: optionalText('harness', harness, { max: 80 }),
      github: {
        appSlug: slug,
        botUid: optionalText('botUid', botUid, { max: 40 }),
        actor: `${slug}[bot]`,
        credentialProvider: 'worktree-token',
      },
      transcript: normalizeTranscript(transcript),
      status: 'active',
      subjects: normalizeValues('subject', subjects),
      artifacts: normalizeValues('artifact', artifacts),
      createdAt,
      updatedAt: createdAt,
      finalizedAt: null,
    };
    const errors = validateIdentity(record);
    if (errors.length > 0) throw new Error(`invalid identity: ${errors.join('; ')}`);
    try {
      writeNewIdentity(stateDir, record);
      return record;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not allocate a unique Agent ID');
}

function sameTranscript(left, right) {
  return left?.provider === right?.provider && left?.id === right?.id;
}

function findTranscriptIdentity(appSlug, transcript, stateDir) {
  if (!transcript) return null;
  let names;
  try {
    names = readdirSync(stateDir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!ID_PATTERN.test(id)) continue;
    let record;
    try {
      record = readAgentIdentity(id, { stateDir });
    } catch (error) {
      // Records are audit data, not an availability gate. A crash artifact,
      // manual corruption, or older schema must not brick every future setup.
      console.warn(`agent-identity: ignoring invalid registry record ${id}: ${error.message}`);
      continue;
    }
    if (record.github.appSlug === appSlug && sameTranscript(record.transcript, transcript)) {
      return record;
    }
  }
  return null;
}

function mutateIdentity(id, stateDir, now, mutator, { afterWrite = null } = {}) {
  return withIdentityLock(stateDir, id, () => {
    const current = readAgentIdentity(id, { stateDir });
    const next = mutator(structuredClone(current));
    next.updatedAt = now().toISOString();
    const errors = validateIdentity(next);
    if (errors.length > 0) throw new Error(`invalid identity update: ${errors.join('; ')}`);
    replaceIdentity(stateDir, next);
    try {
      afterWrite?.(next);
    } catch (error) {
      try {
        replaceIdentity(stateDir, current);
      } catch {
        throw new Error('identity rollback failed after lifecycle synchronization failure');
      }
      throw error;
    }
    return next;
  });
}

export function bindAgentTranscript(id, transcript, {
  stateDir = stateDirectory(),
  now = () => new Date(),
} = {}) {
  const normalized = normalizeTranscript(transcript);
  return mutateIdentity(id, stateDir, now, (record) => {
    if (record.transcript && !sameTranscript(record.transcript, normalized)) {
      throw new Error(`Agent ID ${id} is already bound to another transcript`);
    }
    record.transcript = { ...normalized };
    return record;
  });
}

export function recordAgentEvidence(id, {
  subjects = [],
  artifacts = [],
  stateDir = stateDirectory(),
  now = () => new Date(),
} = {}) {
  const nextSubjects = normalizeValues('subject', subjects);
  const nextArtifacts = normalizeValues('artifact', artifacts);
  return mutateIdentity(id, stateDir, now, (record) => {
    record.subjects = [...new Set([...record.subjects, ...nextSubjects])];
    record.artifacts = [...new Set([...record.artifacts, ...nextArtifacts])];
    return record;
  });
}

export function finalizeAgentIdentity(id, {
  transcriptSha256 = null,
  stateDir = stateDirectory(),
  now = () => new Date(),
  onFinalized = null,
} = {}) {
  if (onFinalized !== null && typeof onFinalized !== 'function') {
    throw new Error('onFinalized must be a function or null');
  }
  return mutateIdentity(id, stateDir, now, (record) => {
    if (record.status === 'retired') throw new Error(`Agent ID ${id} is retired and cannot be finalized`);
    if (!record.transcript) throw new Error(`Agent ID ${id} has no transcript to finalize`);
    const digest = optionalText('transcriptSha256', transcriptSha256, { max: 64 });
    if (digest && !/^[0-9a-f]{64}$/i.test(digest)) throw new Error('transcriptSha256 must be 64 hexadecimal characters');
    if (digest) record.transcript.sha256 = digest.toLowerCase();
    record.status = 'finalized';
    record.finalizedAt = now().toISOString();
    return record;
  }, { afterWrite: onFinalized });
}

// Retirement is the explicit end of a soul's lifecycle (issue #46): it is
// recorded in the authoritative identity record so reuse paths can refuse it,
// not only in the census. Like finalize, an optional afterWrite hook lets the
// caller synchronize a second store with rollback on failure.
export function retireAgentIdentity(id, {
  stateDir = stateDirectory(),
  now = () => new Date(),
  onRetired = null,
} = {}) {
  if (onRetired !== null && typeof onRetired !== 'function') {
    throw new Error('onRetired must be a function or null');
  }
  return mutateIdentity(id, stateDir, now, (record) => {
    record.status = 'retired';
    record.retiredAt = now().toISOString();
    return record;
  }, { afterWrite: onRetired });
}

function retiredReuseError(id) {
  return new Error(
    `agent identity ${id} is retired; remove the worktree pin ` +
      '(git config --unset agentBot.id) or start a new session to mint a fresh identity',
  );
}

export function ensureAgentIdentity({
  currentId = null,
  appSlug,
  botUid = null,
  harness = null,
  transcript = discoverTranscript(),
  fields = identityFieldsFromEnv(),
  subjects = [],
  reusePending = false,
  stateDir = stateDirectory(),
  now = () => new Date(),
  idFactory,
} = {}) {
  return withRegistryLock(stateDir, () => {
    let identity = null;
    if (currentId) {
      let current = null;
      try {
        current = readAgentIdentity(currentId, { stateDir });
      } catch (error) {
        console.warn(`agent-identity: ignoring invalid current identity ${currentId}: ${error.message}`);
      }
      // A corrupt pin is repairable metadata. The registry scan below can
      // reuse a healthy transcript match or mint a replacement. A retired pin
      // is different: fail closed before any reuse path can touch the record.
      if (current?.github.appSlug === appSlug && current.status === 'retired') {
        throw retiredReuseError(current.id);
      }
      if (current?.github.appSlug === appSlug) {
        if (transcript && sameTranscript(current.transcript, transcript)) identity = current;
        else if (transcript && !current.transcript) {
          identity = findTranscriptIdentity(appSlug, transcript, stateDir)
            ?? bindAgentTranscript(current.id, transcript, { stateDir, now });
        } else if (!transcript && reusePending && !current.transcript) {
          identity = current;
        }
        // A different provider conversation reused the worktree: preserve the
        // old immutable record and resolve or mint its execution identity.
      }
    }
    identity ??= findTranscriptIdentity(appSlug, transcript, stateDir);
    if (identity?.status === 'retired') {
      // Deliberately fail closed instead of minting a replacement: a stale
      // worktree pin or transcript match reaching a retired soul means an
      // operator explicitly ended this lifecycle (issue #46). Silently
      // minting would hide that and re-register a look-alike soul; the
      // operator should remove the pin or start a fresh session on purpose.
      throw retiredReuseError(identity.id);
    }
    identity ??= mintAgentIdentity({
      appSlug,
      botUid,
      harness,
      transcript,
      ...fields,
      subjects,
      stateDir,
      now,
      idFactory,
    });
    const combinedSubjects = new Set([...identity.subjects, ...subjects]);
    if (combinedSubjects.size !== identity.subjects.length) {
      identity = recordAgentEvidence(identity.id, { subjects, stateDir, now });
    }
    return identity;
  });
}

function gitConfig(args, { cwd = process.cwd(), allowMissing = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowMissing && error.status === 1) return null;
    throw error;
  }
}

export function currentAgentId({ env = process.env, cwd = process.cwd() } = {}) {
  const fromEnv = env.AGENT_BOT_ID ?? env.QWTS_AGENT_ID;
  if (fromEnv) return validateAgentId(fromEnv);
  for (const key of AGENT_ID_KEYS) {
    const id = gitConfig(['config', '--get', key], { cwd, allowMissing: true });
    if (id) return validateAgentId(id);
  }
  return null;
}

function parseCli(argv) {
  const [command = 'current', ...tokens] = argv.slice(2);
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    if (token === '--json' || token === '--reuse-pending') {
      flags.set(token.slice(2), ['true']);
      continue;
    }
    const value = tokens[++index];
    if (!value) throw new Error(`${token} requires a value`);
    const key = token.slice(2);
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  const one = (name) => flags.get(name)?.at(-1) ?? null;
  return { command, positional, flags, one, json: flags.has('json') };
}

function botUidForSlug(slug, home = homedir()) {
  try {
    return readFileSync(path.join(home, '.config', slug, 'bot-uid'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function printRecord(record, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${record.id}\n`);
}

async function main() {
  const args = parseCli(process.argv);
  const stateDir = stateDirectory();
  const targetId = () => args.positional[0] ?? currentAgentId();

  switch (args.command) {
    case 'ensure': {
      const explicitApp = args.one('app');
      // Territory-aware unless --app is explicit — the shared policy set by
      // appConfig in mint-token.mjs (#20).
      const appSlug = resolveAgentSlug({ explicit: explicitApp, worktree: !explicitApp });
      if (!appSlug) throw new Error('no GitHub App identity resolves in this context');
      const identity = ensureAgentIdentity({
        currentId: currentAgentId(),
        appSlug,
        botUid: botUidForSlug(appSlug),
        harness: harnessForApp(appSlug),
        transcript: args.one('transcript')
          ? { provider: args.one('provider') ?? 'custom', id: args.one('transcript') }
          : discoverTranscript(),
        fields: {
          ...identityFieldsFromEnv(),
          team: args.one('team') ?? identityFieldsFromEnv().team,
          squad: args.one('squad') ?? identityFieldsFromEnv().squad,
          type: args.one('type') ?? identityFieldsFromEnv().type,
          level: args.one('level') ?? identityFieldsFromEnv().level,
          parentId: args.one('parent') ?? identityFieldsFromEnv().parentId,
        },
        subjects: args.flags.get('subject') ?? [],
        reusePending: args.flags.has('reuse-pending'),
        stateDir,
      });
      gitConfig(['config', 'extensions.worktreeConfig', 'true']);
      gitConfig(['config', '--worktree', 'agentBot.agentId', identity.id]);
      printRecord(identity, args.json);
      break;
    }
    case 'spawn': {
      const parentId = args.one('parent') ?? currentAgentId();
      const parent = parentId ? readAgentIdentity(parentId, { stateDir }) : null;
      // --app and the parent's App are explicit statements; only the inferred
      // fallback is territory-aware (shared policy — appConfig, mint-token.mjs, #20).
      const appSlug = args.one('app') ?? parent?.github.appSlug ?? resolveAgentSlug({ worktree: true });
      if (!appSlug) throw new Error('spawn requires an App identity or a resolvable parent');
      const identity = mintAgentIdentity({
        appSlug,
        botUid: parent?.github.botUid ?? botUidForSlug(appSlug),
        harness: parent?.harness ?? harnessForApp(appSlug),
        transcript: args.one('transcript')
          ? { provider: args.one('provider') ?? 'custom', id: args.one('transcript') }
          : discoverTranscript(),
        team: args.one('team') ?? parent?.team,
        squad: args.one('squad') ?? parent?.squad,
        type: args.one('type') ?? 'agent',
        level: args.one('level'),
        parentId,
        subjects: args.flags.get('subject') ?? [],
        stateDir,
      });
      printRecord(identity, args.json);
      break;
    }
    case 'bind': {
      const id = targetId();
      if (!id) throw new Error('bind requires an Agent ID');
      const transcriptId = args.one('transcript');
      if (!transcriptId) throw new Error('bind requires --transcript');
      printRecord(bindAgentTranscript(id, {
        provider: args.one('provider') ?? 'custom',
        id: transcriptId,
        sha256: args.one('sha256'),
      }, { stateDir }), args.json);
      break;
    }
    case 'record': {
      const id = targetId();
      if (!id) throw new Error('record requires an Agent ID');
      printRecord(recordAgentEvidence(id, {
        subjects: args.flags.get('subject') ?? [],
        artifacts: args.flags.get('artifact') ?? [],
        stateDir,
      }), args.json);
      break;
    }
    case 'finalize': {
      const id = targetId();
      if (!id) throw new Error('finalize requires an Agent ID');
      // Loaded only for this command because population validation imports the
      // identity primitives above. The coordinator owns the cross-store lock.
      const { finalizeIdentityWithPopulation } = await import('./agent-population.mjs');
      const identity = finalizeIdentityWithPopulation(id, {
        transcriptSha256: args.one('sha256'),
        stateDir,
      });
      printRecord(identity, args.json);
      break;
    }
    case 'show': {
      const id = targetId();
      if (!id) throw new Error('show requires an Agent ID');
      printRecord(readAgentIdentity(id, { stateDir }), true);
      break;
    }
    case 'current': {
      const id = currentAgentId();
      if (!id) return;
      if (args.json) printRecord(readAgentIdentity(id, { stateDir }), true);
      else process.stdout.write(`${id}\n`);
      break;
    }
    default:
      throw new Error('usage: agent-identity.mjs <ensure|spawn|bind|record|finalize|show|current>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`agent-identity: ${error.message}`);
    process.exit(1);
  });
}
