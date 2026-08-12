import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INVOCATION_TRANSITIONS,
  TERMINAL_STATUSES,
  addArtifact,
  appendEvent,
  compactEvents,
  createSession,
  getInvocation,
  getSession,
  interactionHome,
  listArtifacts,
  readEvents,
  recoverInteractionStore,
  submitInvocation,
  touchSession,
  transitionInvocation,
} from '../agent-jobs.mjs';

const WORKER = fileURLToPath(new URL('./helpers/submit-invocation-worker.mjs', import.meta.url));
const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const PRINCIPAL_ID = 'principal_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = () => new Date('2026-08-12T08:00:00.000Z');
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-jobs-'));
  roots.push(root);
  const options = {
    env: { AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction') },
    home: '/nonexistent',
    now: NOW,
  };
  return { root, options };
}

function seeded(options) {
  const session = createSession(
    { agentId: AGENT_ID, principalId: PRINCIPAL_ID, transport: 'telegram' },
    options,
  );
  const { invocation } = submitInvocation({
    sessionId: session.sessionId,
    agentId: AGENT_ID,
    principalId: PRINCIPAL_ID,
    transport: 'telegram',
    idempotencyKey: 'key-1',
  }, options);
  return { session, invocation };
}

test('interaction home follows explicit override, XDG state, then home default', () => {
  assert.equal(
    interactionHome({ env: { AGENT_BOT_INTERACTION_HOME: '/tmp/interaction' } }),
    '/tmp/interaction',
  );
  assert.equal(
    interactionHome({ env: { XDG_STATE_HOME: '/tmp/state' }, home: '/home/test' }),
    '/tmp/state/agent-bot/interaction',
  );
  assert.equal(
    interactionHome({ env: {}, home: '/home/test' }),
    '/home/test/.local/state/agent-bot/interaction',
  );
});

test('sessions are daemon-keyed records independent of transport identifiers', () => {
  const { options } = scratch();
  const session = createSession(
    { agentId: AGENT_ID, principalId: PRINCIPAL_ID, transport: 'telegram' },
    options,
  );
  assert.match(session.sessionId, /^session_[0-9a-f-]{36}$/);
  assert.deepEqual(
    Object.keys(session).sort(),
    ['agentId', 'createdAt', 'lastActivity', 'principalId', 'sessionId', 'transport'],
  );
  assert.equal(getSession(session.sessionId, options).agentId, AGENT_ID);
  const touched = touchSession(session.sessionId, {
    ...options,
    now: () => new Date('2026-08-12T09:00:00.000Z'),
  });
  assert.equal(touched.lastActivity, '2026-08-12T09:00:00.000Z');
  assert.equal(statSync(path.join(interactionHome(options), 'sessions.json')).mode & 0o777, 0o600);
});

test('the transition table is explicit and illegal transitions throw', () => {
  const { options } = scratch();
  assert.deepEqual(Object.keys(INVOCATION_TRANSITIONS).sort(), [
    'cancel-requested', 'cancelled', 'completed', 'failed', 'queued', 'running', 'waiting-approval',
  ]);
  for (const status of TERMINAL_STATUSES) {
    assert.deepEqual(INVOCATION_TRANSITIONS[status], []);
  }
  const { invocation } = seeded(options);
  const id = invocation.invocationId;
  assert.throws(() => transitionInvocation(id, 'completed', options), /illegal invocation transition from queued to completed/);
  transitionInvocation(id, 'running', options);
  // waiting-approval is reachable from running and back (#56 req 2).
  transitionInvocation(id, 'waiting-approval', options);
  transitionInvocation(id, 'running', options);
  transitionInvocation(id, 'completed', options);
  assert.throws(() => transitionInvocation(id, 'running', options), /illegal invocation transition/);
  assert.throws(() => transitionInvocation(id, 'not-a-state', options), /not a known state/);
  assert.throws(
    () => transitionInvocation(id, 'completed', { ...options, error: 'boom' }),
    /only failed invocations carry an error/,
  );
});

test('duplicate submission with one idempotency key returns the original invocation', () => {
  const { options } = scratch();
  const { session, invocation } = seeded(options);
  const retry = submitInvocation({
    sessionId: session.sessionId,
    agentId: AGENT_ID,
    principalId: PRINCIPAL_ID,
    transport: 'telegram',
    idempotencyKey: 'key-1',
  }, options);
  assert.equal(retry.created, false);
  assert.equal(retry.invocation.invocationId, invocation.invocationId);

  // A different principal with the same key is different work.
  const other = submitInvocation({
    sessionId: session.sessionId,
    agentId: AGENT_ID,
    principalId: 'principal_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    transport: 'telegram',
    idempotencyKey: 'key-1',
  }, options);
  assert.equal(other.created, true);
  assert.notEqual(other.invocation.invocationId, invocation.invocationId);
});

test('events are monotonically ordered with stable IDs and resumable cursors', () => {
  const { options } = scratch();
  const { invocation } = seeded(options);
  const id = invocation.invocationId;
  for (let index = 0; index < 5; index++) appendEvent(id, 'progress', { step: index }, options);
  const events = readEvents(id, {}, options);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5]);
  for (const event of events) assert.match(event.id, /^event_[0-9a-f-]{36}$/);

  const resumed = readEvents(id, { afterSeq: 3 }, options);
  assert.deepEqual(resumed.map((event) => event.seq), [4, 5]);
  assert.deepEqual(resumed.map((event) => event.id), events.slice(3).map((event) => event.id));
  assert.deepEqual(readEvents(id, { afterSeq: 5 }, options), []);
  assert.throws(() => readEvents(id, { afterSeq: -1 }, options), /non-negative integer/);
});

test('event payloads are bounded and typed', () => {
  const { options } = scratch();
  const { invocation } = seeded(options);
  const id = invocation.invocationId;
  assert.throws(() => appendEvent(id, 'Not A Slug', {}, options), /short lowercase slug/);
  assert.throws(() => appendEvent(id, 'progress', { blob: 'x'.repeat(9 * 1024) }, options), /bounded event size/);
  assert.throws(() => appendEvent(id, 'progress', 'text', options), /plain object/);
  assert.throws(
    () => appendEvent('invocation_cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'progress', {}, options),
    /unknown invocation/,
  );
});

test('artifact references stay non-secret, relative, and traversal-free', () => {
  const { options } = scratch();
  const { invocation } = seeded(options);
  const id = invocation.invocationId;
  const artifact = {
    name: 'report.md',
    bytes: 2048,
    sha256: 'a'.repeat(64),
    spacePath: 'artifacts/report.md',
  };
  addArtifact(id, artifact, options);
  assert.deepEqual(listArtifacts(id, options), [artifact]);
  const events = readEvents(id, {}, options);
  assert.equal(events.at(-1).type, 'artifact');
  assert.deepEqual(events.at(-1).data, { name: 'report.md', bytes: 2048, sha256: 'a'.repeat(64) });

  assert.throws(() => addArtifact(id, { ...artifact, name: '../escape' }, options), /plain filename/);
  assert.throws(() => addArtifact(id, { ...artifact, name: 'a/b' }, options), /plain filename/);
  assert.throws(() => addArtifact(id, { ...artifact, spacePath: '/etc/passwd' }, options), /clean relative reference/);
  assert.throws(() => addArtifact(id, { ...artifact, spacePath: 'a/../b' }, options), /clean relative reference/);
  assert.throws(() => addArtifact(id, { ...artifact, sha256: 'nope' }, options), /hex digest/);
  assert.throws(() => addArtifact(id, { ...artifact, bytes: -1 }, options), /non-negative integer/);
  assert.throws(() => addArtifact(id, artifact, options), /already recorded/);
});

test('compaction prunes middle progress events but preserves finals and provenance', () => {
  const { options } = scratch();
  const { invocation } = seeded(options);
  const id = invocation.invocationId;
  appendEvent(id, 'status', { status: 'queued' }, options);
  for (let index = 0; index < 4; index++) appendEvent(id, 'progress', { step: index }, options);
  addArtifact(id, {
    name: 'out.txt', bytes: 1, sha256: 'b'.repeat(64), spacePath: 'artifacts/out.txt',
  }, options);
  appendEvent(id, 'status', { status: 'completed' }, options);

  const summary = compactEvents(id, options);
  assert.deepEqual(summary, { kept: 5, pruned: 2 });
  const events = readEvents(id, {}, options);
  assert.deepEqual(
    events.map((event) => [event.seq, event.type]),
    [[1, 'status'], [2, 'progress'], [5, 'progress'], [6, 'artifact'], [7, 'status']],
  );
  // Compaction never renumbers, so an existing cursor still works.
  assert.deepEqual(readEvents(id, { afterSeq: 5 }, options).map((event) => event.seq), [6, 7]);
  // Re-compacting an already-compact log is a no-op.
  assert.deepEqual(compactEvents(id, options), { kept: 5, pruned: 0 });
});

test('crash recovery reconciles orphaned jobs into documented states', () => {
  const { options } = scratch();
  const session = createSession(
    { agentId: AGENT_ID, principalId: PRINCIPAL_ID, transport: 'web' },
    options,
  );
  const base = {
    sessionId: session.sessionId,
    agentId: AGENT_ID,
    principalId: PRINCIPAL_ID,
    transport: 'web',
  };
  const running = submitInvocation({ ...base, idempotencyKey: 'running' }, options).invocation;
  transitionInvocation(running.invocationId, 'running', options);
  const waiting = submitInvocation({ ...base, idempotencyKey: 'waiting' }, options).invocation;
  transitionInvocation(waiting.invocationId, 'running', options);
  transitionInvocation(waiting.invocationId, 'waiting-approval', options);
  const cancelling = submitInvocation({ ...base, idempotencyKey: 'cancelling' }, options).invocation;
  transitionInvocation(cancelling.invocationId, 'running', options);
  transitionInvocation(cancelling.invocationId, 'cancel-requested', options);
  const queued = submitInvocation({ ...base, idempotencyKey: 'queued' }, options).invocation;

  const recovered = recoverInteractionStore(options);
  assert.deepEqual(new Map(recovered.failed.map((entry) => [entry.invocationId, entry.error])), new Map([
    [running.invocationId, 'interrupted by daemon restart'],
    [waiting.invocationId, 'interrupted by daemon restart'],
    [queued.invocationId, 'interrupted before dispatch'],
  ]));
  assert.deepEqual(recovered.cancelled, [cancelling.invocationId]);

  const failed = getInvocation(running.invocationId, options);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'interrupted by daemon restart');
  assert.equal(getInvocation(cancelling.invocationId, options).status, 'cancelled');
  // A queued job cannot be re-driven by a new daemon (its message only ever
  // travelled in memory), so recovery must not strand it in 'queued'.
  const stranded = getInvocation(queued.invocationId, options);
  assert.equal(stranded.status, 'failed');
  assert.equal(stranded.error, 'interrupted before dispatch');

  const recoveryEvents = readEvents(running.invocationId, {}, options);
  assert.equal(recoveryEvents.at(-1).type, 'recovery');
  assert.deepEqual(recoveryEvents.at(-1).data, {
    status: 'failed',
    error: 'interrupted by daemon restart',
  });
  const strandedEvents = readEvents(queued.invocationId, {}, options);
  assert.equal(strandedEvents.at(-1).type, 'recovery');
  assert.deepEqual(strandedEvents.at(-1).data, {
    status: 'failed',
    error: 'interrupted before dispatch',
  });
  // Recovery is idempotent: a second pass finds nothing to reconcile.
  assert.deepEqual(recoverInteractionStore(options), { failed: [], cancelled: [], expiredProposals: [] });
});

test('concurrent cross-process submissions neither corrupt nor duplicate', async () => {
  const { options } = scratch();
  const { session } = seeded(options);
  const env = { ...process.env, AGENT_BOT_INTERACTION_HOME: options.env.AGENT_BOT_INTERACTION_HOME };
  const runWorker = (key) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      WORKER, session.sessionId, AGENT_ID, PRINCIPAL_ID, 'telegram', key,
    ], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
  });

  const results = await Promise.all([
    runWorker('race'), runWorker('race'), runWorker('race'),
    runWorker('solo-1'), runWorker('solo-2'),
  ]);
  const race = results.slice(0, 3);
  assert.equal(race.filter((result) => result.created).length, 1);
  assert.equal(new Set(race.map((result) => result.invocationId)).size, 1);
  assert.equal(results[3].created, true);
  assert.equal(results[4].created, true);

  // The store survived the race intact and holds exactly the expected jobs:
  // key-1 from seeding, the single race winner, and the two solo submits.
  const raw = JSON.parse(readFileSync(path.join(interactionHome(options), 'jobs.json'), 'utf8'));
  assert.equal(Object.keys(raw.invocations).length, 4);
  assert.equal(Object.keys(raw.idempotency).length, 4);
});

test('persisted job records carry no message bodies or free-form payloads', () => {
  const { options } = scratch();
  const { invocation } = seeded(options);
  assert.deepEqual(Object.keys(invocation).sort(), [
    'agentId', 'artifacts', 'createdAt', 'error', 'idempotencyKey',
    'invocationId', 'principalId', 'sessionId', 'status', 'transport', 'updatedAt',
  ]);
  const raw = JSON.parse(readFileSync(path.join(interactionHome(options), 'jobs.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(raw.invocations[invocation.invocationId]).sort(),
    Object.keys(invocation).sort(),
  );
});
