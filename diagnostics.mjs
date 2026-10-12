// The local diagnostics store (ADR-0983 decisions 1 and 4, #983).
//
// Events are JSON lines in `~/.local/state/agent-bot/diagnostics/`: the
// directory is 0700 and the files 0600. `events.jsonl` rotates into
// `events.1.jsonl` before it would pass 5 MB, so at most two files exist.
// A previous generation whose newest event is older than 7 days is deleted,
// and older events are skipped on read.
//
// Only allowlisted fields are kept, each checked for shape; anything else is
// dropped. `detail` is redacted through diagnostic-redact.mjs and is local
// only: the exporter never sends it. An Agent ID is stored only as its hash.
//
// Recording never throws and never waits on anything but a local append. A
// write that fails is counted, and the next write that succeeds records the
// count as a `diagnostics-dropped` event first. Rotation by two processes at
// once can lose a generation; the store is diagnostic, not an audit log, and
// audit receipts and the launch journal are kept elsewhere as before.

import process from 'node:process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactDiagnostic } from './diagnostic-redact.mjs';
import { stateDirectory } from './state-paths.mjs';

export const DIAGNOSTICS_SCHEMA = 1;
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTCOMES = Object.freeze(['ok', 'refused', 'failed']);
const LIVE = 'events.jsonl';
const PREVIOUS = 'events.1.jsonl';
const NAME = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const AGENT_ID = /^agent_[0-9a-f-]{36}$/;
const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`);
const TRACE_ID = HEX(32);
const SPAN_ID = HEX(16);
const DETAIL_MAX = 500;

/** This install's agent-bot version, from its package.json, or null. */
export function runtimeVersion() {
  try {
    const { version } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
    return typeof version === 'string' && VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

export function diagnosticsDirectory({ env = process.env, home = homedir() } = {}) {
  return join(dirname(stateDirectory({ env, home })), 'diagnostics');
}

/** The exported form of an Agent ID: 16 hex of SHA-256, or null for a malformed ID. */
export function hashAgentId(agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return null;
  return createHash('sha256').update(`agent-bot-diagnostics:v1:${agentId}`).digest('hex').slice(0, 16);
}

const name = (value) => (typeof value === 'string' && value.length <= 64 && NAME.test(value) ? value : undefined);

/**
 * The stored form of an event: allowlisted, shape-checked fields only.
 * Returns null when the required `event` name is unusable.
 */
export function diagnosticEvent(fields, { component, version, now = () => new Date(), env = process.env, home = homedir() } = {}) {
  const event = name(fields?.event);
  const source = name(fields?.component ?? component);
  if (!event || !source) return null;
  const record = {
    v: DIAGNOSTICS_SCHEMA,
    at: now().toISOString(),
    id: randomBytes(8).toString('hex'),
    component: source,
  };
  const build = fields.version ?? version;
  if (typeof build === 'string' && VERSION.test(build)) record.version = build;
  record.event = event;
  if (name(fields.stage)) record.stage = fields.stage;
  if (OUTCOMES.includes(fields.outcome)) record.outcome = fields.outcome;
  if (name(fields.code)) record.code = fields.code;
  if (Number.isFinite(fields.durationMs) && fields.durationMs >= 0) record.durationMs = Math.round(fields.durationMs);
  if (TRACE_ID.test(fields.traceId ?? '')) record.traceId = fields.traceId;
  if (SPAN_ID.test(fields.spanId ?? '')) record.spanId = fields.spanId;
  if (SPAN_ID.test(fields.parentSpanId ?? '')) record.parentSpanId = fields.parentSpanId;
  const agent = hashAgentId(fields.agentId);
  if (agent) record.agent = agent;
  if (fields.detail !== undefined && fields.detail !== null) {
    const detail = redactDiagnostic(fields.detail, { env, home, maxLength: DETAIL_MAX });
    if (detail) record.detail = detail;
  }
  return record;
}

const EVENT_ID = HEX(16);
const AGENT_HASH = HEX(16);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * A stored event re-checked field by field for reading out: the store can be
 * edited by anything running as the user, so nothing is passed through
 * unchecked and `detail` is redacted again. Null when it is not a v1 event.
 */
export function cleanStoredEvent(stored, { env = process.env, home = homedir() } = {}) {
  if (!stored || typeof stored !== 'object' || stored.v !== DIAGNOSTICS_SCHEMA) return null;
  if (typeof stored.at !== 'string' || !ISO.test(stored.at) || !name(stored.component) || !name(stored.event)) return null;
  const event = { v: DIAGNOSTICS_SCHEMA, at: stored.at };
  if (EVENT_ID.test(stored.id ?? '')) event.id = stored.id;
  event.component = stored.component;
  if (typeof stored.version === 'string' && VERSION.test(stored.version)) event.version = stored.version;
  event.event = stored.event;
  if (name(stored.stage)) event.stage = stored.stage;
  if (OUTCOMES.includes(stored.outcome)) event.outcome = stored.outcome;
  if (name(stored.code)) event.code = stored.code;
  if (Number.isSafeInteger(stored.durationMs) && stored.durationMs >= 0) event.durationMs = stored.durationMs;
  if (TRACE_ID.test(stored.traceId ?? '')) event.traceId = stored.traceId;
  if (SPAN_ID.test(stored.spanId ?? '')) event.spanId = stored.spanId;
  if (SPAN_ID.test(stored.parentSpanId ?? '')) event.parentSpanId = stored.parentSpanId;
  if (AGENT_HASH.test(stored.agent ?? '')) event.agent = stored.agent;
  if (typeof stored.detail === 'string') {
    const detail = redactDiagnostic(stored.detail, { env, home, maxLength: DETAIL_MAX });
    if (detail) event.detail = detail;
  }
  return event;
}

function openAppend(path) {
  // O_NOFOLLOW: a symlink planted at the log path is refused, not followed.
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error('diagnostics log is not a regular file'), { code: 'EINVAL' });
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function expirePrevious(dir, nowMs, retentionMs) {
  try {
    if (nowMs - statSync(join(dir, PREVIOUS)).mtimeMs > retentionMs) unlinkSync(join(dir, PREVIOUS));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * A recorder for one component. `record(fields)` returns true when the event
 * was appended. `dropped()` is the count not yet recorded. `sink(event)`, if
 * given, is called with each stored event after it is appended.
 */
export function createDiagnostics({
  component, version = null, env = process.env, home = homedir(), now = () => new Date(),
  maxFileBytes = DEFAULT_MAX_FILE_BYTES, retentionMs = DEFAULT_RETENTION_MS, sink = null,
} = {}) {
  let dropped = 0;
  const dir = diagnosticsDirectory({ env, home });
  const append = (lines) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const live = join(dir, LIVE);
    let size = 0;
    try { size = statSync(live).size; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const bytes = Buffer.byteLength(lines);
    if (size > 0 && size + bytes > maxFileBytes) {
      renameSync(live, join(dir, PREVIOUS));
    }
    expirePrevious(dir, now().getTime(), retentionMs);
    const fd = openAppend(live);
    try { writeSync(fd, lines); } finally { closeSync(fd); }
  };
  const record = (fields) => {
    try {
      const event = diagnosticEvent(fields, { component, version, now, env, home });
      if (!event) { dropped += 1; return false; }
      const lines = [];
      if (dropped > 0) {
        lines.push(JSON.stringify(diagnosticEvent({ event: 'diagnostics-dropped', outcome: 'failed', code: 'diagnostics-dropped', detail: `${dropped} event(s) were not recorded` }, { component, version, now, env, home })));
      }
      lines.push(JSON.stringify(event));
      append(`${lines.join('\n')}\n`);
      dropped = 0;
      // An optional sink (the OTLP exporter) sees what was stored, after it
      // was stored; it can neither block nor fail the record.
      if (sink) { try { sink(event); } catch { /* best effort */ } }
      return true;
    } catch {
      dropped += 1;
      return false;
    }
  };
  return { record, dropped: () => dropped, directory: dir };
}

/**
 * Stored events at or after `since` (ms) and within retention, oldest file
 * first. Malformed lines and records of another schema are skipped.
 */
export function readDiagnostics({ env = process.env, home = homedir(), since = null, now = () => new Date(), retentionMs = DEFAULT_RETENTION_MS } = {}) {
  const dir = diagnosticsDirectory({ env, home });
  const floor = Math.max(since ?? -Infinity, now().getTime() - retentionMs);
  const events = [];
  for (const file of [PREVIOUS, LIVE]) {
    let text;
    try { text = readFileSync(join(dir, file), 'utf8'); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.v !== DIAGNOSTICS_SCHEMA || typeof event.at !== 'string' || !(Date.parse(event.at) >= floor)) continue;
      events.push(event);
    }
  }
  return events;
}
