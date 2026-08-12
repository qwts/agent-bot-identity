#!/usr/bin/env node

// Durable daemon-owned session, invocation, and event store (#56). Messaging
// is asynchronous relative to execution: a transport message can disconnect,
// retry, arrive twice, or outlive the process that accepted it. This store is
// the canonical operational record — sessions and invocations keyed
// independently of any transport chat/thread identifier, an append-only
// ordered event log per invocation, explicit state transitions, idempotent
// submission, and crash recovery. Telegram, a PWA, or an IDE adapter is only
// ever a projection of this store, never a system of record. Records are
// secret-free by construction: no credentials, tokens, or message bodies are
// persisted here (#31); artifact bytes live in the soul's Agent Space.

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateAgentId, withLock } from './agent-identity.mjs';

const SCHEMA_VERSION = 1;

const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID_PATTERN = new RegExp(`^session_${UUID_BODY}$`);
const INVOCATION_ID_PATTERN = new RegExp(`^invocation_${UUID_BODY}$`);
const PRINCIPAL_ID_PATTERN = new RegExp(`^principal_${UUID_BODY}$`);
const PROPOSAL_ID_PATTERN = new RegExp(`^proposal_${UUID_BODY}$`);
const TRANSPORT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// Idempotency keys are adapter-chosen retry handles: visible ASCII, no spaces.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_EVENT_DATA_BYTES = 8 * 1024;
const MAX_ERROR_LENGTH = 512;

// Explicit invocation state machine (#56 req 2). Every mutation goes through
// this table; an unlisted transition throws instead of silently rewriting
// status. `cancel-requested` is a distinct state because cancellation is
// cooperative: the record becomes `cancelled` only once execution actually
// stopped, and an executor that finishes before noticing the request may
// still land on `completed` or `failed`. `queued -> failed` exists for jobs
// that can never dispatch: crash recovery after a daemon restart, or a
// dispatch that dies before reaching `running`.
export const INVOCATION_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['running', 'failed', 'cancel-requested']),
  running: Object.freeze(['completed', 'failed', 'waiting-approval', 'cancel-requested']),
  'waiting-approval': Object.freeze(['running', 'failed', 'cancel-requested']),
  'cancel-requested': Object.freeze(['cancelled', 'completed', 'failed']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

function printableText(name, value, { max = 512 } = {}) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${name} must be printable text no longer than ${max} characters`);
  }
  return value;
}

function matchOrThrow(pattern, value, message) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(message);
  return value;
}

export function validateSessionId(value) {
  return matchOrThrow(SESSION_ID_PATTERN, value, 'invalid session ID');
}

export function validateInvocationId(value) {
  return matchOrThrow(INVOCATION_ID_PATTERN, value, 'invalid invocation ID');
}

export function validateProposalId(value) {
  return matchOrThrow(PROPOSAL_ID_PATTERN, value, 'invalid proposal ID');
}

export function validateArtifactName(value) {
  return matchOrThrow(
    ARTIFACT_NAME_PATTERN,
    value,
    'artifact name must be a plain filename without path separators',
  );
}

function principalIdOrThrow(value) {
  return matchOrThrow(PRINCIPAL_ID_PATTERN, value, 'invalid principal ID');
}

function transportOrThrow(value) {
  return matchOrThrow(TRANSPORT_PATTERN, value, 'transport must be a short lowercase slug');
}

function agentIdOrThrow(value) {
  try {
    return validateAgentId(value);
  } catch {
    // validateAgentId messages can reflect their input; keep ours stable.
    throw new Error('invalid Agent ID');
  }
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

// Operational interaction state (sessions, jobs, events, audit) lives in one
// home so retention, backup, and inspection have a single root.
export function interactionHome({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_INTERACTION_HOME) return path.resolve(env.AGENT_BOT_INTERACTION_HOME);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'interaction');
}

function sessionsFile(options) {
  return path.join(interactionHome(options), 'sessions.json');
}

function jobsFile(options) {
  return path.join(interactionHome(options), 'jobs.json');
}

function eventsFile(invocationId, options) {
  return path.join(interactionHome(options), 'events', `${validateInvocationId(invocationId)}.jsonl`);
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

function readJsonDocument(file, label, collection) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${label} could not be read`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON parser errors may quote store contents; never reflect them.
    throw new Error(`${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  if (!Number.isSafeInteger(parsed.schemaVersion) || parsed.schemaVersion < SCHEMA_VERSION) {
    throw new Error(`${label} has an invalid schemaVersion`);
  }
  if (parsed.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`${label} uses a future schemaVersion; refusing to rewrite it`);
  }
  if (!parsed[collection] || typeof parsed[collection] !== 'object' || Array.isArray(parsed[collection])) {
    throw new Error(`${label} ${collection} must be an object`);
  }
  return parsed;
}

function writeJsonDocument(file, document) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
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

function normalizeSession(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('session record must be an object');
  }
  return {
    sessionId: validateSessionId(record.sessionId),
    agentId: agentIdOrThrow(record.agentId),
    principalId: principalIdOrThrow(record.principalId),
    transport: transportOrThrow(record.transport),
    createdAt: canonicalTimestamp('createdAt', record.createdAt),
    lastActivity: canonicalTimestamp('lastActivity', record.lastActivity),
  };
}

function normalizeArtifact(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('artifact reference must be an object');
  }
  // Non-secret metadata only. The name must not smuggle path traversal and
  // the reference is always relative to the soul's Agent Space root — the job
  // store never holds artifact bytes or absolute filesystem paths.
  const name = validateArtifactName(record.name);
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) {
    throw new Error('artifact bytes must be a non-negative integer');
  }
  const sha256 = matchOrThrow(SHA256_PATTERN, record.sha256, 'artifact sha256 must be a hex digest');
  const spacePath = printableText('artifact spacePath', record.spacePath, { max: 512 });
  if (
    path.isAbsolute(spacePath) || spacePath.includes('\\')
    || spacePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('artifact spacePath must be a clean relative reference');
  }
  return { name, bytes: record.bytes, sha256, spacePath };
}

function normalizeInvocation(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('invocation record must be an object');
  }
  if (!(record.status in INVOCATION_TRANSITIONS)) {
    throw new Error('invocation status is not a known state');
  }
  return {
    invocationId: validateInvocationId(record.invocationId),
    sessionId: validateSessionId(record.sessionId),
    agentId: agentIdOrThrow(record.agentId),
    principalId: principalIdOrThrow(record.principalId),
    transport: transportOrThrow(record.transport),
    status: record.status,
    idempotencyKey: matchOrThrow(IDEMPOTENCY_KEY_PATTERN, record.idempotencyKey, 'invalid idempotency key'),
    error: record.error === undefined || record.error === null
      ? null
      : printableText('error', record.error, { max: MAX_ERROR_LENGTH }),
    artifacts: (Array.isArray(record.artifacts) ? record.artifacts : []).map(normalizeArtifact),
    createdAt: canonicalTimestamp('createdAt', record.createdAt),
    updatedAt: canonicalTimestamp('updatedAt', record.updatedAt),
  };
}

function readSessions(options) {
  const document = readJsonDocument(sessionsFile(options), 'session store', 'sessions');
  const sessions = Object.create(null);
  for (const [key, value] of Object.entries(document?.sessions ?? {})) {
    const session = normalizeSession(value);
    if (key !== session.sessionId) throw new Error('session store key does not match its session ID');
    sessions[session.sessionId] = session;
  }
  return sessions;
}

function readJobs(options) {
  const document = readJsonDocument(jobsFile(options), 'job store', 'invocations');
  const invocations = Object.create(null);
  for (const [key, value] of Object.entries(document?.invocations ?? {})) {
    const invocation = normalizeInvocation(value);
    if (key !== invocation.invocationId) {
      throw new Error('job store key does not match its invocation ID');
    }
    invocations[invocation.invocationId] = invocation;
  }
  const idempotency = Object.create(null);
  for (const [key, value] of Object.entries(document?.idempotency ?? {})) {
    if (!invocations[value]) throw new Error('job store idempotency index references an unknown invocation');
    idempotency[key] = value;
  }
  return { invocations, idempotency };
}

function withSessionsLock(options, operation) {
  const file = sessionsFile(options);
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'session store', () => operation(file));
}

function withJobsLock(options, operation) {
  const file = jobsFile(options);
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'job store', () => operation(file));
}

export function createSession(
  { agentId, principalId, transport },
  {
    env = process.env,
    home = homedir(),
    now = () => new Date(),
    idFactory = () => `session_${randomUUID()}`,
  } = {},
) {
  const options = { env, home };
  const at = now().toISOString();
  const session = normalizeSession({
    sessionId: idFactory(),
    agentId,
    principalId,
    transport,
    createdAt: at,
    lastActivity: at,
  });
  return withSessionsLock(options, (file) => {
    const sessions = readSessions(options);
    if (sessions[session.sessionId]) throw new Error('session already exists');
    writeJsonDocument(file, {
      schemaVersion: SCHEMA_VERSION,
      sessions: { ...sessions, [session.sessionId]: session },
    });
    return session;
  });
}

export function getSession(sessionId, { env = process.env, home = homedir() } = {}) {
  return readSessions({ env, home })[validateSessionId(sessionId)] ?? null;
}

// Projection listings for control surfaces (#59). Filters are validated so a
// malformed selector fails loudly instead of silently matching nothing.
export function listSessions(
  { principalId = null, agentId = null } = {},
  { env = process.env, home = homedir() } = {},
) {
  const wantedPrincipal = principalId === null ? null : matchOrThrow(PRINCIPAL_ID_PATTERN, principalId, 'invalid principal ID');
  const wantedAgent = agentId === null ? null : agentIdOrThrow(agentId);
  const records = Object.values(readSessions({ env, home }))
    .filter((session) => wantedPrincipal === null || session.principalId === wantedPrincipal)
    .filter((session) => wantedAgent === null || session.agentId === wantedAgent);
  records.sort((left, right) => (
    left.createdAt === right.createdAt
      ? left.sessionId.localeCompare(right.sessionId)
      : left.createdAt.localeCompare(right.createdAt)
  ));
  return records;
}

export function listInvocations(
  { principalId = null, sessionId = null } = {},
  { env = process.env, home = homedir() } = {},
) {
  const wantedPrincipal = principalId === null ? null : matchOrThrow(PRINCIPAL_ID_PATTERN, principalId, 'invalid principal ID');
  const wantedSession = sessionId === null ? null : validateSessionId(sessionId);
  const records = Object.values(readJobs({ env, home }).invocations)
    .filter((invocation) => wantedPrincipal === null || invocation.principalId === wantedPrincipal)
    .filter((invocation) => wantedSession === null || invocation.sessionId === wantedSession);
  records.sort((left, right) => (
    left.createdAt === right.createdAt
      ? left.invocationId.localeCompare(right.invocationId)
      : left.createdAt.localeCompare(right.createdAt)
  ));
  return records;
}

export function touchSession(
  sessionId,
  { env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const options = { env, home };
  const target = validateSessionId(sessionId);
  return withSessionsLock(options, (file) => {
    const sessions = readSessions(options);
    const existing = sessions[target];
    if (!existing) throw new Error('unknown session');
    const session = { ...existing, lastActivity: now().toISOString() };
    writeJsonDocument(file, {
      schemaVersion: SCHEMA_VERSION,
      sessions: { ...sessions, [target]: session },
    });
    return session;
  });
}

// Transport retries must not start duplicate work (#56 req 4): the same
// (principalId, idempotencyKey) pair always returns the invocation created by
// the first delivery, flagged `created: false`.
export function submitInvocation(
  { sessionId, agentId, principalId, transport, idempotencyKey },
  {
    env = process.env,
    home = homedir(),
    now = () => new Date(),
    idFactory = () => `invocation_${randomUUID()}`,
  } = {},
) {
  const options = { env, home };
  const at = now().toISOString();
  const candidate = normalizeInvocation({
    invocationId: idFactory(),
    sessionId,
    agentId,
    principalId,
    transport,
    status: 'queued',
    idempotencyKey,
    error: null,
    artifacts: [],
    createdAt: at,
    updatedAt: at,
  });
  // principalId contains no space and idempotency keys exclude spaces, so a
  // single space joins the two into an unambiguous index key.
  const indexKey = `${candidate.principalId} ${candidate.idempotencyKey}`;
  return withJobsLock(options, (file) => {
    const { invocations, idempotency } = readJobs(options);
    const existingId = idempotency[indexKey];
    if (existingId) return { invocation: invocations[existingId], created: false };
    writeJsonDocument(file, {
      schemaVersion: SCHEMA_VERSION,
      invocations: { ...invocations, [candidate.invocationId]: candidate },
      idempotency: { ...idempotency, [indexKey]: candidate.invocationId },
    });
    return { invocation: candidate, created: true };
  });
}

export function getInvocation(invocationId, { env = process.env, home = homedir() } = {}) {
  return readJobs({ env, home }).invocations[validateInvocationId(invocationId)] ?? null;
}

export function transitionInvocation(
  invocationId,
  nextStatus,
  { error = null, env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const options = { env, home };
  const target = validateInvocationId(invocationId);
  if (!(nextStatus in INVOCATION_TRANSITIONS)) {
    throw new Error('invocation status is not a known state');
  }
  if (error !== null && nextStatus !== 'failed') {
    throw new Error('only failed invocations carry an error');
  }
  const nextError = error === null ? null : printableText('error', error, { max: MAX_ERROR_LENGTH });
  return withJobsLock(options, (file) => {
    const { invocations, idempotency } = readJobs(options);
    const existing = invocations[target];
    if (!existing) throw new Error('unknown invocation');
    if (!INVOCATION_TRANSITIONS[existing.status].includes(nextStatus)) {
      // Status names are internal constants, safe to surface verbatim.
      throw new Error(`illegal invocation transition from ${existing.status} to ${nextStatus}`);
    }
    const invocation = {
      ...existing,
      status: nextStatus,
      error: nextStatus === 'failed' ? nextError : existing.error,
      updatedAt: now().toISOString(),
    };
    writeJsonDocument(file, {
      schemaVersion: SCHEMA_VERSION,
      invocations: { ...invocations, [target]: invocation },
      idempotency,
    });
    return invocation;
  });
}

export function addArtifact(
  invocationId,
  artifact,
  { env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const options = { env, home };
  const target = validateInvocationId(invocationId);
  const candidate = normalizeArtifact(artifact);
  const invocation = withJobsLock(options, (file) => {
    const { invocations, idempotency } = readJobs(options);
    const existing = invocations[target];
    if (!existing) throw new Error('unknown invocation');
    if (existing.artifacts.some((known) => known.name === candidate.name)) {
      throw new Error('artifact name is already recorded for this invocation');
    }
    const updated = {
      ...existing,
      artifacts: [...existing.artifacts, candidate],
      updatedAt: now().toISOString(),
    };
    writeJsonDocument(file, {
      schemaVersion: SCHEMA_VERSION,
      invocations: { ...invocations, [target]: updated },
      idempotency,
    });
    return updated;
  });
  appendEvent(target, 'artifact', {
    name: candidate.name,
    bytes: candidate.bytes,
    sha256: candidate.sha256,
  }, { env, home, now });
  return invocation;
}

export function listArtifacts(invocationId, { env = process.env, home = homedir() } = {}) {
  const invocation = getInvocation(invocationId, { env, home });
  if (!invocation) throw new Error('unknown invocation');
  return invocation.artifacts;
}

function normalizeEventData(data) {
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('event data must be a plain object');
  }
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    throw new Error('event data must be JSON-serializable');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_DATA_BYTES) {
    throw new Error('event data exceeds the bounded event size');
  }
  return JSON.parse(serialized);
}

function parseEventLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new Error('event log is corrupt');
  }
  if (
    !event || typeof event !== 'object' || Array.isArray(event)
    || !Number.isSafeInteger(event.seq) || event.seq < 1
    || typeof event.id !== 'string' || typeof event.at !== 'string'
    || typeof event.type !== 'string'
  ) {
    throw new Error('event log is corrupt');
  }
  return event;
}

function readEventLog(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map(parseEventLine);
}

// Append-only, monotonically ordered event stream per invocation (#56 req 3).
// `seq` increases by one per event; `id` is a stable event identity so clients
// can deduplicate replays after a cursor reset.
export function appendEvent(
  invocationId,
  type,
  data = {},
  {
    env = process.env,
    home = homedir(),
    now = () => new Date(),
    idFactory = () => `event_${randomUUID()}`,
  } = {},
) {
  const options = { env, home };
  const target = validateInvocationId(invocationId);
  const eventType = matchOrThrow(EVENT_TYPE_PATTERN, type, 'event type must be a short lowercase slug');
  const eventData = normalizeEventData(data);
  if (!getInvocation(target, options)) throw new Error('unknown invocation');
  const file = eventsFile(target, options);
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'invocation event log', () => {
    const events = readEventLog(file);
    const seq = events.length === 0 ? 1 : events[events.length - 1].seq + 1;
    const event = { seq, id: idFactory(), at: now().toISOString(), type: eventType, data: eventData };
    appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return event;
  });
}

// Resumable cursor reads (#56 req 3): pass the last seen `seq` back as
// `afterSeq` to receive only newer events, in order.
export function readEvents(
  invocationId,
  { afterSeq = 0 } = {},
  { env = process.env, home = homedir() } = {},
) {
  const options = { env, home };
  const target = validateInvocationId(invocationId);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new Error('afterSeq must be a non-negative integer');
  }
  if (!getInvocation(target, options)) throw new Error('unknown invocation');
  return readEventLog(eventsFile(target, options)).filter((event) => event.seq > afterSeq);
}

// Retention rule (#56 req 7): compaction prunes only `progress` events, and
// even then preserves the first and last of them so the span of reported
// progress survives. Status transitions, recovery markers, artifact
// references, and every other event type are always retained, so final
// status and provenance can never be compacted away. Surviving events keep
// their original seq/id — cursors remain valid across compaction.
export function compactEvents(
  invocationId,
  { env = process.env, home = homedir() } = {},
) {
  const options = { env, home };
  const target = validateInvocationId(invocationId);
  if (!getInvocation(target, options)) throw new Error('unknown invocation');
  const file = eventsFile(target, options);
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'invocation event log', () => {
    const events = readEventLog(file);
    const progress = events.filter((event) => event.type === 'progress');
    const removable = new Set(progress.slice(1, -1).map((event) => event.seq));
    const kept = events.filter((event) => !removable.has(event.seq));
    if (removable.size > 0) {
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, kept.map((event) => `${JSON.stringify(event)}\n`).join(''), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        renameSync(temporary, file);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    return { kept: kept.length, pruned: removable.size };
  });
}

// ---------------------------------------------------------------------------
// Immutable operation proposals (#59 req 8). A privileged operation that needs
// human sign-off is frozen into a proposal bound to the sha256 digest of the
// operation's canonical JSON. Approval must echo that exact digest back — a
// conversational "yes", a replay of an old proposal, or a UI rendering a
// different operation than the one digested all fail closed. Proposals are
// single-decision: once approved, denied, or expired they never reopen.

const PROPOSAL_STATUSES = new Set(['open', 'approved', 'denied', 'expired']);
const MAX_PROPOSAL_SUMMARY_LENGTH = 512;
export const DEFAULT_PROPOSAL_TTL_MS = 15 * 60_000;

function proposalsFile(options) {
  return path.join(interactionHome(options), 'proposals.json');
}

// Canonical JSON: object keys sorted recursively, no whitespace, undefined
// members dropped — the same operation object always digests identically.
export function canonicalOperationJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('operation must be JSON-serializable');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalOperationJson(entry ?? null)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalOperationJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new Error('operation must be JSON-serializable');
}

export function operationDigest(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('operation must be a plain object');
  }
  return createHash('sha256').update(canonicalOperationJson(operation), 'utf8').digest('hex');
}

function normalizeProposal(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('proposal record must be an object');
  }
  if (!PROPOSAL_STATUSES.has(record.status)) throw new Error('proposal status is not a known state');
  return {
    proposalId: matchOrThrow(PROPOSAL_ID_PATTERN, record.proposalId, 'invalid proposal ID'),
    invocationId: validateInvocationId(record.invocationId),
    operationDigest: matchOrThrow(SHA256_PATTERN, record.operationDigest, 'operation digest must be a sha256 hex digest'),
    summary: printableText('summary', record.summary, { max: MAX_PROPOSAL_SUMMARY_LENGTH }),
    createdAt: canonicalTimestamp('createdAt', record.createdAt),
    expiresAt: canonicalTimestamp('expiresAt', record.expiresAt),
    status: record.status,
    decidedAt: record.decidedAt === undefined || record.decidedAt === null
      ? null
      : canonicalTimestamp('decidedAt', record.decidedAt),
    decidedBy: record.decidedBy === undefined || record.decidedBy === null
      ? null
      : matchOrThrow(PRINCIPAL_ID_PATTERN, record.decidedBy, 'invalid principal ID'),
  };
}

function readProposals(options) {
  const document = readJsonDocument(proposalsFile(options), 'proposal store', 'proposals');
  const proposals = Object.create(null);
  for (const [key, value] of Object.entries(document?.proposals ?? {})) {
    const proposal = normalizeProposal(value);
    if (key !== proposal.proposalId) throw new Error('proposal store key does not match its proposal ID');
    proposals[proposal.proposalId] = proposal;
  }
  return proposals;
}

function withProposalsLock(options, operation) {
  const file = proposalsFile(options);
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'proposal store', () => operation(file));
}

export function createProposal(
  { invocationId, operationDigest: digest, summary },
  {
    env = process.env,
    home = homedir(),
    now = () => new Date(),
    ttlMs = DEFAULT_PROPOSAL_TTL_MS,
    idFactory = () => `proposal_${randomUUID()}`,
  } = {},
) {
  const options = { env, home };
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('proposal ttlMs must be a positive integer');
  }
  const at = now();
  const proposal = normalizeProposal({
    proposalId: idFactory(),
    invocationId,
    operationDigest: digest,
    summary,
    createdAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
    status: 'open',
    decidedAt: null,
    decidedBy: null,
  });
  if (!getInvocation(proposal.invocationId, options)) throw new Error('unknown invocation');
  return withProposalsLock(options, (file) => {
    const proposals = readProposals(options);
    if (proposals[proposal.proposalId]) throw new Error('proposal already exists');
    writeJsonDocument(file, {
      schemaVersion: SCHEMA_VERSION,
      proposals: { ...proposals, [proposal.proposalId]: proposal },
    });
    return proposal;
  });
}

export function getProposal(proposalId, { env = process.env, home = homedir() } = {}) {
  return readProposals({ env, home })[validateProposalId(proposalId)] ?? null;
}

export function listProposals(
  { status = null, invocationId = null } = {},
  { env = process.env, home = homedir() } = {},
) {
  if (status !== null && !PROPOSAL_STATUSES.has(status)) {
    throw new Error('proposal status is not a known state');
  }
  const wantedInvocation = invocationId === null ? null : validateInvocationId(invocationId);
  const records = Object.values(readProposals({ env, home }))
    .filter((proposal) => status === null || proposal.status === status)
    .filter((proposal) => wantedInvocation === null || proposal.invocationId === wantedInvocation);
  records.sort((left, right) => (
    left.createdAt === right.createdAt
      ? left.proposalId.localeCompare(right.proposalId)
      : left.createdAt.localeCompare(right.createdAt)
  ));
  return records;
}

// The single, terminal decision. Approve/deny is refused once the proposal
// left `open` or its expiry passed; the only transition allowed after expiry
// is the bookkeeping move to `expired`.
export function decideProposal(
  proposalId,
  { decision, decidedBy = null },
  { env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const options = { env, home };
  const target = validateProposalId(proposalId);
  if (!['approved', 'denied', 'expired'].includes(decision)) {
    throw new Error('proposal decision must be approved, denied, or expired');
  }
  const decider = decidedBy === null
    ? null
    : matchOrThrow(PRINCIPAL_ID_PATTERN, decidedBy, 'invalid principal ID');
  return withProposalsLock(options, (file) => {
    const proposals = readProposals(options);
    const existing = proposals[target];
    if (!existing) throw new Error('unknown proposal');
    if (existing.status !== 'open') throw new Error('proposal is no longer open');
    const at = now();
    if (decision !== 'expired' && at.getTime() > new Date(existing.expiresAt).getTime()) {
      throw new Error('proposal has expired');
    }
    const decided = {
      ...existing,
      status: decision,
      decidedAt: at.toISOString(),
      decidedBy: decider,
    };
    writeJsonDocument(file, {
      schemaVersion: SCHEMA_VERSION,
      proposals: { ...proposals, [target]: decided },
    });
    return decided;
  });
}

// Crash recovery (#56 req 8), called on daemon startup before any dispatch.
// Nothing a previous daemon owned can be resumed: executing work lost its
// executor and in-memory context, and `queued` jobs lost the message that
// only ever travels in memory — leaving them queued would strand them
// forever. So `running` and `waiting-approval` jobs are reconciled to
// `failed` with 'interrupted by daemon restart', `queued` jobs to `failed`
// with 'interrupted before dispatch', and `cancel-requested` jobs become
// `cancelled` (the death of the process certainly stopped execution). The
// submitting adapter re-drives recovered work by retrying with a fresh
// idempotency key.
export function recoverInteractionStore(
  { env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const options = { env, home };
  const at = now().toISOString();
  const recovered = withJobsLock(options, (file) => {
    const { invocations, idempotency } = readJobs(options);
    const failed = [];
    const cancelled = [];
    const next = Object.create(null);
    for (const invocation of Object.values(invocations)) {
      if (invocation.status === 'running' || invocation.status === 'waiting-approval') {
        next[invocation.invocationId] = {
          ...invocation,
          status: 'failed',
          error: 'interrupted by daemon restart',
          updatedAt: at,
        };
        failed.push({ invocationId: invocation.invocationId, error: 'interrupted by daemon restart' });
      } else if (invocation.status === 'queued') {
        next[invocation.invocationId] = {
          ...invocation,
          status: 'failed',
          error: 'interrupted before dispatch',
          updatedAt: at,
        };
        failed.push({ invocationId: invocation.invocationId, error: 'interrupted before dispatch' });
      } else if (invocation.status === 'cancel-requested') {
        next[invocation.invocationId] = { ...invocation, status: 'cancelled', updatedAt: at };
        cancelled.push(invocation.invocationId);
      } else {
        next[invocation.invocationId] = invocation;
      }
    }
    if (failed.length > 0 || cancelled.length > 0) {
      writeJsonDocument(file, { schemaVersion: SCHEMA_VERSION, invocations: next, idempotency });
    }
    return { failed, cancelled };
  });
  for (const { invocationId, error } of recovered.failed) {
    appendEvent(invocationId, 'recovery', { status: 'failed', error }, { env, home, now });
  }
  for (const invocationId of recovered.cancelled) {
    appendEvent(invocationId, 'recovery', { status: 'cancelled' }, { env, home, now });
  }
  // A proposal whose approval nobody can deliver anymore (the waiting
  // execution died with the previous daemon) is expired, never resurrected.
  const orphaned = [];
  for (const proposal of listProposals({ status: 'open' }, options)) {
    const invocation = getInvocation(proposal.invocationId, options);
    if (!invocation || invocation.status !== 'waiting-approval') {
      decideProposal(proposal.proposalId, { decision: 'expired' }, { env, home, now });
      orphaned.push(proposal.proposalId);
    }
  }
  return { ...recovered, expiredProposals: orphaned };
}

async function main() {
  throw new Error('agent-jobs is a library consumed by the daemon interaction service; use agent-bot daemon');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-jobs: ${error.message}\n`);
    process.exit(1);
  });
}
