import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InboxDurable,
  applyDeliveryAttempt,
  backoffMs,
  buildDeliveryEnvelope,
  classifyRetryable,
  collectAndPush,
  deliverToSubscriber,
  handleHookRequest,
  normalizeRecord,
  parseSubscribers,
  pruneRecords,
  redactSecrets,
  selectSubscribers,
  signBody,
  takeRecord,
  verifyGithubSignature,
  BACKOFF_SCHEDULE_MS,
  DEAD_LETTER_TTL_MS,
  DELIVERED_TTL_MS,
  MAX_DELIVERY_ATTEMPTS,
  PULL_ONLY_TTL_MS,
  TEXT_LIMIT,
} from '../gh-app-hook.mjs';

const URL_A = 'https://grok-routine.invalid/hook';
const URL_B = 'https://other.invalid/hook';
const URL_C = 'https://third.invalid/hook';
const KEY_A = 'sender-key-a';

function subscriber(overrides = {}) {
  return { id: 'sub-a', app: 'qwts-grok-agent', url: URL_A, key: KEY_A, repos: null, auth: null, ...overrides };
}

function record(overrides = {}) {
  return {
    id: 'rec-1',
    app: 'qwts-grok-agent',
    repo: 'qwts/example1',
    kind: 'mention',
    url: 'https://github.com/qwts/example1/issues/1#issuecomment-1',
    text: '@qwts-grok-agent please look',
    number: 1,
    actor: 'qwts',
    headSha: 'abc123',
    createdAt: 1_000_000,
    ...overrides,
  };
}

// Records handed to the Durable Object use a real clock so TTL pruning in
// the DO behaves like production.
function freshRecord(overrides = {}) {
  return record({ createdAt: Date.now(), ...overrides });
}

// Fake Cloudflare Durable Object state: in-memory storage (per-key, with the
// StoredValue {value} wrapping), alarm scheduling, and a pass-through
// blockConcurrencyWhile. Exercises the real InboxDurable end to end.
function fakeHarness({ subscribers = null, fetchImpl = null, seed = {} } = {}) {
  const map = new Map(Object.entries(seed));
  const alarmLog = [];
  const storage = {
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    // the real runtime returns raw values in key order
    async list({ prefix } = {}) {
      const out = new Map();
      for (const [key, value] of map.entries()) {
        if (!prefix || key.startsWith(prefix)) out.set(key, value);
      }
      return out;
    },
    async setAlarm(time) { alarmLog.push(time); },
    async deleteAlarm() { alarmLog.push(null); },
  };
  const state = {
    storage,
    blockConcurrencyWhile: (callback) => callback(),
  };
  const env = { SUBSCRIBERS: subscribers, fetchImpl };
  return { state, env, map, alarmLog, durable: new InboxDurable(state, env) };
}

async function doFetch(durable, path, body) {
  return durable.fetch(new Request(`https://inbox${path}`, { method: 'POST', body: JSON.stringify(body) }));
}

test('signBody and verifyGithubSignature round-trip', async () => {
  const body = '{"x":1}';
  const signature = await signBody('secret', body);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(await verifyGithubSignature('secret', body, signature), true);
  assert.equal(await verifyGithubSignature('secret', `${body}x`, signature), false);
  assert.equal(await verifyGithubSignature('wrong', body, signature), false);
});

test('redactSecrets strips keys and URLs', () => {
  const out = redactSecrets(`failed to POST ${URL_A} with ${KEY_A}`, [KEY_A, URL_A]);
  assert.equal(out, 'failed to POST [redacted] with [redacted]');
});

test('normalizeRecord fills id, pulled, createdAt, and deliveries for legacy records', () => {
  const now = 5_000_000;
  const legacy = normalizeRecord({ app: 'qwts-grok-agent', repo: 'qwts/example1', kind: 'mention', url: 'u', text: 't' }, now);
  assert.match(legacy.id, /^[0-9a-f-]{36}$/); // random UUID assigned
  assert.equal(legacy.pulled, false);
  assert.equal(legacy.createdAt, now);
  assert.deepEqual(legacy.deliveries, []);

  const partial = normalizeRecord({ id: 'rec-9', deliveries: [{ status: 'delivered' }] }, now);
  assert.equal(partial.id, 'rec-9');
  assert.deepEqual(partial.deliveries, [{ status: 'delivered' }]);

  const complete = normalizeRecord(record(), now);
  assert.equal(complete.id, 'rec-1');
  assert.equal(complete.pulled, false);

  // the stored text is capped so one record can't exceed the storage
  // value limit; the pull path sees a marker, never a silent gap
  const long = 'x'.repeat(TEXT_LIMIT + 100);
  const truncated = normalizeRecord({ app: 'a', repo: 'o/n', kind: 'mention', text: long }, now);
  assert.equal(truncated.text.length, TEXT_LIMIT + '\n[truncated]'.length);
  assert.ok(truncated.text.endsWith('\n[truncated]'));
  const short = normalizeRecord({ app: 'a', repo: 'o/n', kind: 'mention', text: 'x'.repeat(TEXT_LIMIT) }, now);
  assert.equal(short.text, 'x'.repeat(TEXT_LIMIT)); // at the limit: untouched
});

test('parseSubscribers normalizes valid entries and fails closed on invalid ones', async () => {
  const raw = JSON.stringify({
    'qwts-grok-agent': [
      { url: URL_A, key: KEY_A },
      { url: URL_B, key: 'key-b', repos: ['QWTS/Example1', 'qwts/example2'] },
      { url: URL_C, key: KEY_A, auth: { header: 'X-Hub-Auth' } }, // scheme optional
      { url: 'http://plain.invalid/hook', key: KEY_A }, // not https, skipped
      { url: 'not-a-url', key: KEY_A }, // invalid URL, skipped
      { url: URL_A }, // missing key, skipped
      { key: KEY_A }, // missing URL, skipped
      { url: URL_A, key: KEY_A, auth: { header: 'X-Hub-Signature-256', scheme: 'Token' } }, // reserved, skipped
      { url: URL_A, key: KEY_A, auth: { header: 'Content-Type', scheme: 'Token' } }, // reserved, skipped
    ],
    '': [{ url: URL_A, key: KEY_A }], // empty app, skipped
    'qwts-opencode-agent': 'not-an-array', // non-array, skipped
  });
  const { subscribers, issues } = await parseSubscribers(raw);
  assert.equal(subscribers.length, 3);
  assert.equal(subscribers[0].app, 'qwts-grok-agent');
  assert.equal(subscribers[0].repos, null);
  assert.equal(subscribers[0].auth, null);
  assert.deepEqual(subscribers[1].repos, ['qwts/example1', 'qwts/example2']); // lowercased for case-insensitive match
  assert.deepEqual(subscribers[2].auth, { header: 'x-hub-auth', scheme: 'Bearer' }); // default scheme
  // ids are derived from the URL and are secret-free
  for (const entry of subscribers) assert.match(entry.id, /^[0-9a-f]{64}$/);
  // skipped entries produce redacted, loggable issues (no key or URL)
  const serialized = JSON.stringify(issues);
  assert.equal(serialized.includes(KEY_A), false);
  assert.equal(serialized.includes('grok-routine.invalid'), false);
  assert.ok(issues.length > 0);
});

test('parseSubscribers reports malformed input and dedupes identical destinations', async () => {
  const bad = await parseSubscribers('not json');
  assert.deepEqual(bad.subscribers, []);
  assert.deepEqual(bad.issues, ['SUBSCRIBERS is not valid JSON']);

  const empty = await parseSubscribers(null);
  assert.deepEqual(empty, { subscribers: [], issues: [] });

  const wrongShape = await parseSubscribers('[]');
  assert.deepEqual(wrongShape.issues, ['SUBSCRIBERS must be a JSON object keyed by App slug']);

  const dupes = await parseSubscribers(JSON.stringify({
    'qwts-grok-agent': [
      { url: URL_A, key: KEY_A },
      { url: URL_A, key: 'other-key' }, // identical URL, deduped with a warning
    ],
  }));
  assert.equal(dupes.subscribers.length, 1);
  assert.deepEqual(dupes.issues, ['skipped a subscriber for qwts-grok-agent: duplicate destination']);
});

test('selectSubscribers matches app and optional repo scope case-insensitively', () => {
  const subscribers = [
    { app: 'qwts-grok-agent', repos: null },
    { app: 'qwts-grok-agent', repos: ['qwts/example1'] },
    { app: 'qwts-grok-agent', repos: ['qwts/other'] },
    { app: 'qwts-opencode-agent', repos: null },
  ];
  const matches = selectSubscribers(subscribers, record());
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((s) => s.repos), [null, ['qwts/example1']]);

  const mixedCase = selectSubscribers(subscribers, record({ repo: 'QWTS/Example1' }));
  assert.equal(mixedCase.length, 2);
});

test('buildDeliveryEnvelope carries the small field set and no text', () => {
  const envelope = buildDeliveryEnvelope(record());
  assert.deepEqual(Object.keys(envelope).sort(), [
    'actor', 'app', 'deliveredAt', 'headSha', 'id', 'kind', 'prOrIssueNumber', 'repo', 'url',
  ]);
  assert.equal(envelope.text, undefined);
  assert.equal(envelope.id, 'rec-1');
  assert.equal(envelope.prOrIssueNumber, 1);
  assert.equal(envelope.kind, 'mention');
  assert.equal(envelope.deliveredAt, new Date(1_000_000).toISOString());
});

test('classifyRetryable retries 429 and 5xx only', () => {
  assert.equal(classifyRetryable(200), false);
  assert.equal(classifyRetryable(204), false);
  assert.equal(classifyRetryable(404), false);
  assert.equal(classifyRetryable(400), false);
  assert.equal(classifyRetryable(429), true);
  assert.equal(classifyRetryable(500), true);
  assert.equal(classifyRetryable(503), true);
  assert.equal(classifyRetryable('nope'), false);
});

test('backoffMs follows the 30s/2m/10m/1h schedule and caps at 1h', () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 2 * 60_000);
  assert.equal(backoffMs(3), 10 * 60_000);
  assert.equal(backoffMs(4), 60 * 60_000);
  assert.equal(backoffMs(100), 60 * 60_000); // capped
  assert.deepEqual(BACKOFF_SCHEDULE_MS, [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000]);
});

test('applyDeliveryAttempt transitions delivered/pending/dead and caps retries', () => {
  const base = { subscriberId: 'sub-a', status: 'pending', attempts: 0, lastError: null, nextRetryAt: null, deliveredAt: null };
  const delivered = applyDeliveryAttempt(base, { ok: true }, { now: 1_000_000 });
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.attempts, 1);
  assert.equal(delivered.deliveredAt, 1_000_000);

  const pending = applyDeliveryAttempt(base, { ok: false, retryable: true, error: 'HTTP 503' }, { now: 1_000_000 });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.attempts, 1);
  assert.equal(pending.nextRetryAt, 1_000_000 + backoffMs(1));

  const permanent = applyDeliveryAttempt(base, { ok: false, retryable: false, error: 'HTTP 404' }, { now: 1_000_000 });
  assert.equal(permanent.status, 'dead');
  assert.equal(permanent.attempts, 1);

  // cap: with maxAttempts 3, the third retryable attempt dead-letters.
  let current = base;
  for (let i = 0; i < 3; i += 1) {
    current = applyDeliveryAttempt(current, { ok: false, retryable: true, error: 'HTTP 503' }, { maxAttempts: 3, now: 1_000_000 });
  }
  assert.equal(current.status, 'dead');
  assert.equal(current.attempts, 3);
});

test('deliverToSubscriber signs, authenticates, and classifies outcomes', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(null, { status: 200 });
  };
  const outcome = await deliverToSubscriber(subscriber(), buildDeliveryEnvelope(record()), { fetchImpl });
  assert.equal(outcome.ok, true);
  assert.equal(seen.url, URL_A);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, `Bearer ${KEY_A}`);
  assert.match(seen.init.headers['x-hub-signature-256'], /^sha256=/);

  const fiveHundred = await deliverToSubscriber(subscriber(), buildDeliveryEnvelope(record()), {
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  assert.equal(fiveHundred.ok, false);
  assert.equal(fiveHundred.retryable, true);
  assert.equal(fiveHundred.error, 'HTTP 503');

  const notFound = await deliverToSubscriber(subscriber(), buildDeliveryEnvelope(record()), {
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.equal(notFound.retryable, false);

  const authOverride = await deliverToSubscriber(
    subscriber({ auth: { header: 'x-hub-auth', scheme: 'Token' } }),
    buildDeliveryEnvelope(record()),
    { fetchImpl: async (_url, init) => { seen = init; return new Response(null, { status: 200 }); } },
  );
  assert.equal(authOverride.ok, true);
  assert.equal(seen.headers['x-hub-auth'], `Token ${KEY_A}`);
  assert.equal(seen.headers.authorization, undefined);
});

test('deliverToSubscriber redacts secrets from network errors', async () => {
  const outcome = await deliverToSubscriber(subscriber(), buildDeliveryEnvelope(record()), {
    fetchImpl: async () => { throw new Error(`connect ECONNREFUSED ${URL_A}?token=${KEY_A}`); },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.error, 'connect ECONNREFUSED [redacted]?token=[redacted]');
});

test('collectAndPush pushes due deliveries across all records and redacts stored errors', async () => {
  const now = 1_000_000;
  const later = record({ id: 'rec-2', createdAt: now });
  const subscribers = [subscriber()];
  const records = [
    record({ deliveries: [{ subscriberId: 'sub-a', status: 'pending', attempts: 0, lastError: null, nextRetryAt: now - 1, deliveredAt: null }] }),
    later, // no deliveries yet: nothing due
    record({
      id: 'rec-3',
      deliveries: [{ subscriberId: 'sub-a', status: 'pending', attempts: 0, lastError: null, nextRetryAt: now + 10_000, deliveredAt: null }],
    }), // not yet due
    record({ id: 'rec-4', deliveries: [{ subscriberId: 'sub-a', status: 'delivered', attempts: 1, lastError: null, nextRetryAt: null, deliveredAt: now }] }),
  ];
  const outcomes = await collectAndPush(records, subscribers, {
    now,
    fetchImpl: async () => { throw new Error(`timeout calling ${URL_A} with ${KEY_A}`); },
  });
  assert.equal(outcomes.length, 1); // only rec-1's delivery is due
  assert.equal(outcomes[0].recordId, 'rec-1');
  assert.equal(outcomes[0].subscriberId, 'sub-a');
  assert.equal(outcomes[0].delivery.status, 'pending');
  assert.equal(outcomes[0].delivery.attempts, 1);
  assert.equal(outcomes[0].delivery.lastError, 'timeout calling [redacted] with [redacted]');
  assert.equal(outcomes[0].delivery.nextRetryAt, now + backoffMs(1));
});

test('collectAndPush retries a missing subscriber instead of dead-lettering it', async () => {
  const now = 1_000_000;
  const base = { subscriberId: 'sub-gone', status: 'pending', attempts: 0, lastError: null, nextRetryAt: now - 1, deliveredAt: null };
  const records = [record({ deliveries: [base] })];
  // no subscribers at all (e.g. a transiently malformed SUBSCRIBERS secret)
  const outcomes = await collectAndPush(records, [], { now, fetchImpl: async () => new Response(null, { status: 200 }) });
  assert.equal(outcomes[0].delivery.status, 'pending'); // not dead-lettered
  assert.equal(outcomes[0].delivery.lastError, 'subscriber removed');
  assert.equal(outcomes[0].delivery.nextRetryAt, now + backoffMs(1));

  // the attempt cap still converges to dead if the subscriber never returns
  let delivery = { ...base, attempts: MAX_DELIVERY_ATTEMPTS - 1 };
  const capped = await collectAndPush([record({ deliveries: [delivery] })], [], { now, fetchImpl: async () => new Response(null, { status: 200 }) });
  assert.equal(capped[0].delivery.status, 'dead');
  assert.equal(capped[0].delivery.lastError, 'subscriber removed');
});

test('takeRecord is non-destructive and returns each record once', () => {
  const stored = record({ deliveries: [{ subscriberId: 'sub-a', status: 'pending', attempts: 1, nextRetryAt: 2_000_000 }] });
  const first = takeRecord([stored], { app: 'qwts-grok-agent', repo: 'qwts/example1' });
  assert.equal(first.record.id, 'rec-1');
  assert.equal(first.record.pulled, true);
  assert.equal(first.records.length, 1); // still present, pending push not lost

  const second = takeRecord(first.records, { app: 'qwts-grok-agent', repo: 'qwts/example1' });
  assert.equal(second.record, null);
});

test('pruneRecords keeps pending, expires pushed 24h after the last ack regardless of pulled', () => {
  const now = 1_000_000;
  const pending = record({ deliveries: [{ status: 'pending', nextRetryAt: now + 1 }] });
  const deliveredPulled = record({ id: 'rec-d1', pulled: true, deliveries: [{ status: 'delivered', deliveredAt: now }] });
  // push-only: fully delivered, never pulled — must still expire
  const deliveredUnpulled = record({ id: 'rec-d2', pulled: false, deliveries: [{ status: 'delivered', deliveredAt: now }] });
  const dead = record({ id: 'rec-dead', pulled: true, deliveries: [{ status: 'dead' }] });

  const fresh = pruneRecords([pending, deliveredPulled, deliveredUnpulled, dead], now);
  assert.equal(fresh.kept.length, 4);

  // pushed records expire 24h after the last ack, pulled or not, so a
  // push-only subscriber's records never accumulate forever
  const after24h = pruneRecords([deliveredPulled, deliveredUnpulled], now + DELIVERED_TTL_MS);
  assert.equal(after24h.kept.length, 0);

  // the window is the LAST ack, not creation: an old record re-acked recently
  // survives, and its expiry counts toward the wake
  const oldAckedLate = record({
    id: 'rec-late',
    createdAt: now - DELIVERED_TTL_MS * 3,
    deliveries: [{ status: 'delivered', deliveredAt: now - 1_000 }],
  });
  const late = pruneRecords([oldAckedLate], now);
  assert.equal(late.kept.length, 1);
  assert.equal(late.nextWake, now - 1_000 + DELIVERED_TTL_MS);

  // dead letters outlive the delivered TTL and expire at 7 days
  const beforeDeadTtl = pruneRecords([dead], now + DELIVERED_TTL_MS);
  assert.equal(beforeDeadTtl.kept.length, 1);
  const afterDeadTtl = pruneRecords([dead], now + DEAD_LETTER_TTL_MS);
  assert.equal(afterDeadTtl.kept.length, 0);

  // pending is never pruned even far in the future
  const pendingLater = pruneRecords([pending], now + DEAD_LETTER_TTL_MS * 10);
  assert.equal(pendingLater.kept.length, 1);
});

test('pruneRecords caps subscriber-less records: 24h after pull, 7d unpulled', () => {
  const now = 1_000_000;
  const pulled = record({ id: 'rec-p1', pulled: true, deliveries: [] });
  const unpulled = record({ id: 'rec-p2', pulled: false, deliveries: [] }); // pull-only app

  // pulled: kept for the 24h catch-up window
  const after24h = pruneRecords([pulled], now + DELIVERED_TTL_MS);
  assert.equal(after24h.kept.length, 0);

  // unpulled: kept for a pull consumer, but only up to the 7-day hard cap
  const beforeCap = pruneRecords([unpulled], now + DELIVERED_TTL_MS);
  assert.equal(beforeCap.kept.length, 1);
  assert.equal(beforeCap.nextWake, now + PULL_ONLY_TTL_MS); // the cap counts toward the wake
  const afterCap = pruneRecords([unpulled], now + PULL_ONLY_TTL_MS);
  assert.equal(afterCap.kept.length, 0);
});

test('pruneRecords computes the next wake across ALL records, not just one', () => {
  const now = 1_000_000;
  const pendingA = record({ id: 'rec-a', deliveries: [{ status: 'pending', nextRetryAt: now + 60_000 }] });
  const pendingB = record({ id: 'rec-b', deliveries: [{ status: 'pending', nextRetryAt: now + 30_000 }] });
  // the wake comes from rec-b (the second record): the scan covers all records
  const { nextWake } = pruneRecords([pendingA, pendingB], now);
  assert.equal(nextWake, now + 30_000);

  // a soon-expiring delivered record competes with pending retries
  const expiring = record({
    id: 'rec-c',
    pulled: true,
    createdAt: now + 5_000 - DELIVERED_TTL_MS, // expires at now + 5s
    deliveries: [{ status: 'delivered' }],
  });
  const mixed = pruneRecords([pendingA, pendingB, expiring], now);
  assert.equal(mixed.nextWake, now + 5_000);

  const pullOnly = pruneRecords([record({ id: 'rec-x', pulled: false, deliveries: [] })], now);
  assert.equal(pullOnly.nextWake, now + PULL_ONLY_TTL_MS); // the hard cap wakes the prune
});

test('the deadletter route is bearer-protected and returns redacted dead records', async () => {
  const token = 'inbox-token';
  const dead = record({ deliveries: [{ subscriberId: 'sub-a', status: 'dead', attempts: 5, lastError: 'HTTP 500', nextRetryAt: null, deliveredAt: null }] });
  const mailbox = {
    async deadletter({ app }) {
      return app === 'qwts-grok-agent' ? [dead] : [];
    },
  };
  const request = (headers = {}) => new Request(
    'https://gh-app-hook.qwts.org/deadletter?app=qwts-grok-agent',
    { method: 'GET', headers },
  );

  const denied = await handleHookRequest(request(), mailbox, { inboxToken: token, webhookSecrets: {} });
  assert.equal(denied.status, 401);

  const ok = await handleHookRequest(request({ authorization: `Bearer ${token}` }), mailbox, { inboxToken: token, webhookSecrets: {} });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].id, 'rec-1');
  assert.equal(body[0].deliveries[0].status, 'dead');
  // subscriber identity is a hash id, never a key or URL
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(KEY_A), false);
  assert.equal(serialized.includes('grok-routine.invalid'), false);
});

// Durable Object tests: exercise the real InboxDurable against a fake state.

test('InboxDurable add persists first, schedules the alarm, and never pushes inline', async () => {
  const calls = [];
  const { durable, map, alarmLog } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async (url) => { calls.push(url); return new Response(null, { status: 200 }); },
  });
  const response = await doFetch(durable, '/add', freshRecord());
  assert.equal(response.status, 204);
  // no outbound fetch during add — the push belongs to the alarm
  assert.equal(calls.length, 0);
  // the record is persisted under its own per-record key before any push
  assert.equal(map.size, 1);
  const key = [...map.keys()][0];
  assert.match(key, /^record:/);
  const stored = map.get(key);
  assert.equal(stored.id, 'rec-1');
  assert.equal(stored.pulled, false);
  assert.deepEqual(stored.deliveries.map((d) => d.status), ['pending']);
  // the alarm is scheduled for now
  assert.equal(alarmLog.length, 1);
});

test('InboxDurable alarm delivers pending pushes and schedules the delivered expiry', async () => {
  const seen = [];
  const { durable, map, alarmLog } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });
  await doFetch(durable, '/add', freshRecord());
  await durable.alarm();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, URL_A);
  assert.equal(seen[0].init.headers.authorization, `Bearer ${KEY_A}`);
  const stored = [...map.values()][0];
  assert.equal(stored.deliveries[0].status, 'delivered');
  assert.ok(Number.isFinite(stored.deliveries[0].deliveredAt));
  // a push-only record (never pulled) still expires: the alarm re-arms for
  // 24h after the last ack rather than being cleared
  const last = alarmLog[alarmLog.length - 1];
  assert.equal(last, stored.deliveries[0].deliveredAt + DELIVERED_TTL_MS);
});

test('InboxDurable alarm retries with backoff and re-arms the alarm', async () => {
  let attempts = 0;
  const { durable, map, alarmLog } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async () => {
      attempts += 1;
      return new Response(null, { status: 503 }); // retryable
    },
  });
  await doFetch(durable, '/add', freshRecord());
  await durable.alarm();
  const stored = [...map.values()][0];
  assert.equal(stored.deliveries[0].status, 'pending');
  assert.equal(stored.deliveries[0].attempts, 1);
  // the alarm re-arms exactly at the pending retry deadline
  const last = alarmLog[alarmLog.length - 1];
  assert.equal(last, stored.deliveries[0].nextRetryAt);
  assert.ok(Number.isFinite(last) && last > Date.now());
});

test('InboxDurable alarm dead-letters after MAX_DELIVERY_ATTEMPTS', async () => {
  const { durable, map } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async () => new Response(null, { status: 404 }), // permanent 4xx
  });
  await doFetch(durable, '/add', freshRecord());
  await durable.alarm();
  const stored = [...map.values()][0];
  assert.equal(stored.deliveries[0].status, 'dead');
  assert.equal(stored.deliveries[0].lastError, 'HTTP 404');
  const response = await doFetch(durable, '/deadletter', { app: 'qwts-grok-agent' });
  const dead = await response.json();
  assert.equal(dead.length, 1);
  assert.equal(dead[0].id, 'rec-1');
});

test('InboxDurable add dedupes a GitHub redelivery by X-GitHub-Delivery id', async () => {
  const calls = [];
  const { durable, map } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async (url) => { calls.push(url); return new Response(null, { status: 200 }); },
  });
  await doFetch(durable, '/add', freshRecord({ id: 'guid-1234' }));
  await doFetch(durable, '/add', freshRecord({ id: 'guid-1234', text: '@qwts-grok-agent again' }));
  await durable.alarm();
  assert.equal(map.size, 1); // one record, not two
  assert.equal(calls.length, 1); // pushed once, not re-pushed
});

test('InboxDurable migrates legacy single-array records without losing or duplicating them', async () => {
  const legacy = [
    { app: 'qwts-grok-agent', repo: 'qwts/example1', kind: 'mention', url: 'https://github.com/qwts/example1/issues/2', text: 'hi', number: 2 },
    { app: 'qwts-grok-agent', repo: 'qwts/example1', kind: 'review_requested', url: null, text: null, number: 3 },
  ];
  const { durable, map } = fakeHarness({
    subscribers: null,
    fetchImpl: async () => new Response(null, { status: 200 }),
    seed: { records: legacy },
  });
  // /add against the legacy layout must not crash (regression: deliveries/createdAt)
  const response = await doFetch(durable, '/add', freshRecord());
  assert.equal(response.status, 204);
  assert.equal(map.has('records'), false); // legacy key removed
  const keys = [...map.keys()].filter((key) => key.startsWith('record:'));
  assert.equal(keys.length, 3); // two migrated + one new
  for (const key of keys) {
    const stored = map.get(key);
    assert.ok(Array.isArray(stored.deliveries));
    assert.ok(Number.isFinite(stored.createdAt));
    assert.equal(stored.pulled, false);
    assert.ok(typeof stored.id === 'string' && stored.id !== '');
  }
  // a take still sees the migrated legacy record
  const taken = await doFetch(durable, '/take', { app: 'qwts-grok-agent', repo: 'qwts/example1' });
  assert.equal(taken.status, 200);
  const event = await taken.json();
  assert.ok(event.id);
});

test('InboxDurable take is non-destructive and /inbox fallback still works while pushes are pending', async () => {
  const { durable } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async () => new Response(null, { status: 503 }), // push keeps failing
  });
  await doFetch(durable, '/add', freshRecord());
  await durable.alarm(); // delivery still pending after a failed push
  const taken = await doFetch(durable, '/take', { app: 'qwts-grok-agent', repo: 'qwts/example1' });
  assert.equal(taken.status, 200);
  const event = await taken.json();
  assert.equal(event.id, 'rec-1');
  assert.equal(event.pulled, true);
  // the pull response carries per-subscriber delivery status
  assert.equal(event.deliveries[0].status, 'pending');
  const again = await doFetch(durable, '/take', { app: 'qwts-grok-agent', repo: 'qwts/example1' });
  assert.equal(again.status, 204);
});

test('InboxDurable skips subscribers scoped to other repos', async () => {
  const calls = [];
  const { durable, map } = fakeHarness({
    subscribers: JSON.stringify({
      'qwts-grok-agent': [{ url: URL_A, key: KEY_A, repos: ['qwts/other'] }],
    }),
    fetchImpl: async (url) => { calls.push(url); return new Response(null, { status: 200 }); },
  });
  await doFetch(durable, '/add', freshRecord()); // repo qwts/example1, not in scope
  await durable.alarm();
  assert.equal(calls.length, 0); // no push
  const stored = [...map.values()][0];
  assert.deepEqual(stored.deliveries, []); // pull-only path
});

test('InboxDurable take returns the OLDEST record, not key order (FIFO)', async () => {
  const { durable } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async () => new Response(null, { status: 200 }),
  });
  const base = Date.now();
  // added in reverse chronological order, with ids whose key order
  // (record:c..., record:n..., record:z...) also differs from arrival order
  await doFetch(durable, '/add', freshRecord({ id: 'z-guid', createdAt: base + 3_000, number: 3 }));
  await doFetch(durable, '/add', freshRecord({ id: 'n-guid', createdAt: base + 2_000, number: 2 }));
  await doFetch(durable, '/add', freshRecord({ id: 'c-guid', createdAt: base + 1_000, number: 1 }));
  const first = await doFetch(durable, '/take', { app: 'qwts-grok-agent', repo: 'qwts/example1' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).id, 'c-guid'); // oldest by createdAt, not key order
  const second = await doFetch(durable, '/take', { app: 'qwts-grok-agent', repo: 'qwts/example1' });
  assert.equal((await second.json()).id, 'n-guid');
});

test('InboxDurable migration keeps identical legacy events as distinct records', async () => {
  const same = { app: 'qwts-grok-agent', repo: 'qwts/example1', kind: 'mention', url: 'https://github.com/qwts/example1/issues/9', text: 'dup', number: 9 };
  const { durable, map } = fakeHarness({
    subscribers: null,
    fetchImpl: async () => new Response(null, { status: 200 }),
    seed: { records: [same, { ...same }] }, // two identical legacy events
  });
  await doFetch(durable, '/take', { app: 'qwts-grok-agent', repo: 'qwts/example1' });
  assert.equal(map.has('records'), false);
  // both survive migration as separate records (the array index keeps
  // otherwise-identical content hashes distinct)
  assert.equal([...map.keys()].filter((key) => key.startsWith('record:')).length, 2);
});

test('InboxDurable alarm catches a failure and re-arms instead of dying', async () => {
  const { durable, map, alarmLog, state } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  await doFetch(durable, '/add', freshRecord());
  // a transiently throwing storage call fails the alarm run...
  const originalList = state.storage.list;
  state.storage.list = async () => { throw new Error('transient storage failure'); };
  await durable.alarm(); // ...but the alarm itself must not throw
  state.storage.list = originalList;
  // ...and it re-arms shortly so the retry loop survives (Cloudflare only
  // retries a failed alarm six times)
  const last = alarmLog[alarmLog.length - 1];
  assert.ok(Number.isFinite(last) && last > Date.now() && last <= Date.now() + 30_000);
  // the re-armed run completes the delivery
  await durable.alarm();
  const stored = [...map.values()][0];
  assert.equal(stored.deliveries[0].status, 'delivered');
});

test('MAX_DELIVERY_ATTEMPTS is the agreed small cap', () => {
  assert.equal(MAX_DELIVERY_ATTEMPTS, 5);
});

for (const status of [204, 503]) {
  test(`InboxDurable bounds pushes when outcome saves fail after HTTP ${status}, even across restarts`, async (t) => {
    let now = 1_000_000;
    let pushes = 0;
    let failSave = false;
    const warnings = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(console, 'warn', (message) => warnings.push(message));
    const { durable, state, env, map, alarmLog } = fakeHarness({
      subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
      fetchImpl: async () => {
        pushes += 1;
        failSave = true;
        return new Response(null, { status });
      },
    });
    await doFetch(durable, '/add', freshRecord());
    const originalPut = state.storage.put;
    state.storage.put = async (key, value) => {
      if (failSave) {
        failSave = false;
        throw new Error(`save failed for ${URL_A} with ${KEY_A}`);
      }
      await originalPut(key, structuredClone(value));
    };
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await new InboxDurable(state, env).alarm();
      assert.equal(pushes, attempt);
      const delivery = map.get('record:rec-1').deliveries[0];
      assert.equal(delivery.attempts, attempt);
      if (attempt < MAX_DELIVERY_ATTEMPTS) {
        assert.equal(delivery.nextRetryAt, now + backoffMs(attempt));
        assert.equal(alarmLog.at(-1), delivery.nextRetryAt);
        now = delivery.nextRetryAt - 1;
        await new InboxDurable(state, env).alarm();
        assert.equal(pushes, attempt); // an early alarm cannot bypass the reservation
        now += 1;
      }
    }
    const delivery = map.get('record:rec-1').deliveries[0];
    assert.equal(delivery.status, 'dead');
    assert.equal(delivery.lastError, 'delivery outcome not saved');
    assert.equal(delivery.nextRetryAt, null);
    for (let retry = 0; retry < 10; retry += 1) {
      now += 60 * 60_000;
      await new InboxDurable(state, env).alarm();
    }
    assert.equal(pushes, MAX_DELIVERY_ATTEMPTS);
    const response = await doFetch(new InboxDurable(state, env), '/deadletter', { app: 'qwts-grok-agent' });
    assert.equal((await response.json()).length, 1);
    assert.equal(warnings.length, MAX_DELIVERY_ATTEMPTS);
    assert.ok(warnings.every((message) => !message.includes(KEY_A) && !message.includes(URL_A)));
  });
}

test('InboxDurable never pushes without a saved attempt and backs off storage failures to a ceiling', async (t) => {
  const now = 1_000_000;
  let pushes = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  const { durable, state, map, alarmLog } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async () => { pushes += 1; return new Response(null, { status: 204 }); },
  });
  await doFetch(durable, '/add', freshRecord());
  const originalPut = state.storage.put;
  state.storage.put = async () => { throw new Error('storage unavailable'); };
  for (let failure = 1; failure <= 8; failure += 1) {
    await durable.alarm();
    assert.equal(alarmLog.at(-1), now + backoffMs(failure));
  }
  assert.equal(pushes, 0);
  assert.equal(map.get('record:rec-1').deliveries[0].attempts, 0);
  state.storage.put = originalPut;
  await durable.alarm();
  assert.equal(pushes, 1);
  assert.equal(map.get('record:rec-1').deliveries[0].status, 'delivered');
  // A successful run resets the consecutive storage-failure backoff.
  state.storage.list = async () => { throw new Error('storage unavailable'); };
  await durable.alarm();
  assert.equal(alarmLog.at(-1), now + backoffMs(1));
});

test('InboxDurable recovers from a failed outcome save without losing the reserved attempt', async (t) => {
  let now = 1_000_000;
  let pushes = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  const { durable, state, env, map } = fakeHarness({
    subscribers: JSON.stringify({ 'qwts-grok-agent': [{ url: URL_A, key: KEY_A }] }),
    fetchImpl: async () => { pushes += 1; return new Response(null, { status: 204 }); },
  });
  await doFetch(durable, '/add', freshRecord());
  const originalPut = state.storage.put;
  state.storage.put = async (key, value) => {
    if (value.deliveries[0].status === 'delivered') throw new Error('outcome save failed');
    await originalPut(key, value);
  };
  await durable.alarm();
  now = map.get('record:rec-1').deliveries[0].nextRetryAt;
  state.storage.put = originalPut;
  await new InboxDurable(state, env).alarm();
  assert.equal(pushes, 2);
  assert.equal(map.get('record:rec-1').deliveries[0].attempts, 2);
  assert.equal(map.get('record:rec-1').deliveries[0].status, 'delivered');
});
