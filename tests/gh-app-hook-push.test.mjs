import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDeliveryAttempt,
  backoffMs,
  buildDeliveryEnvelope,
  classifyRetryable,
  deliverToSubscriber,
  handleHookRequest,
  parseSubscribers,
  pruneRecords,
  redactSecrets,
  runDeliveries,
  selectSubscribers,
  signBody,
  takeRecord,
  verifyGithubSignature,
  DEAD_LETTER_TTL_MS,
  DELIVERED_TTL_MS,
  MAX_DELIVERY_ATTEMPTS,
} from '../gh-app-hook.mjs';

const URL_A = 'https://grok-routine.invalid/hook';
const URL_B = 'https://other.invalid/hook';
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
  assert.equal(out.includes(KEY_A), false);
  assert.equal(out.includes(URL_A), false);
  assert.match(out, /\[redacted\]/);
});

test('parseSubscribers normalizes valid entries and fails closed on invalid ones', async () => {
  const raw = JSON.stringify({
    'qwts-grok-agent': [
      { url: URL_A, key: KEY_A },
      { url: URL_B, key: 'key-b', repos: ['qwts/example1', 'qwts/example2'] },
      { url: URL_A, key: KEY_A, auth: { header: 'X-Hub-Auth', scheme: 'Token' } },
      { url: 'not-a-url', key: KEY_A }, // invalid URL, skipped
      { url: URL_A }, // missing key, skipped
      { key: KEY_A }, // missing URL, skipped
    ],
    '': [{ url: URL_A, key: KEY_A }], // empty app, skipped
    'qwts-opencode-agent': 'not-an-array', // non-array, skipped
  });
  const subscribers = await parseSubscribers(raw);
  assert.equal(subscribers.length, 3);
  assert.equal(subscribers[0].app, 'qwts-grok-agent');
  assert.equal(subscribers[0].repos, null);
  assert.equal(subscribers[0].auth, null);
  assert.deepEqual(subscribers[1].repos, ['qwts/example1', 'qwts/example2']);
  assert.deepEqual(subscribers[2].auth, { header: 'x-hub-auth', scheme: 'Token' });
  // ids are derived from the URL and are secret-free
  for (const entry of subscribers) assert.match(entry.id, /^[0-9a-f]{64}$/);
});

test('parseSubscribers rejects malformed and empty input', async () => {
  assert.deepEqual(await parseSubscribers(null), []);
  assert.deepEqual(await parseSubscribers(''), []);
  assert.deepEqual(await parseSubscribers('not json'), []);
  assert.deepEqual(await parseSubscribers('[]'), []);
});

test('selectSubscribers matches app and optional repo scope', () => {
  const subscribers = [
    { app: 'qwts-grok-agent', repos: null },
    { app: 'qwts-grok-agent', repos: ['qwts/example1'] },
    { app: 'qwts-grok-agent', repos: ['qwts/other'] },
    { app: 'qwts-opencode-agent', repos: null },
  ];
  const matches = selectSubscribers(subscribers, record());
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((s) => s.repos), [null, ['qwts/example1']]);
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
  assert.equal(outcome.error.includes(KEY_A), false);
  assert.equal(outcome.error.includes(URL_A), false);
  assert.match(outcome.error, /\[redacted\]/);
});

test('runDeliveries folds outcomes into delivery state', async () => {
  const delivered = await runDeliveries(record(), [subscriber()], {
    fetchImpl: async () => new Response(null, { status: 204 }),
    now: 1_000_000,
  });
  assert.equal(delivered.nextAlarm, null);
  assert.equal(delivered.deliveries[0].status, 'delivered');

  const retrying = await runDeliveries(record(), [subscriber()], {
    fetchImpl: async () => new Response(null, { status: 503 }),
    now: 1_000_000,
  });
  assert.equal(retrying.deliveries[0].status, 'pending');
  assert.equal(retrying.nextAlarm, 1_000_000 + backoffMs(1));

  const dead = await runDeliveries(record(), [subscriber()], {
    fetchImpl: async () => new Response(null, { status: 404 }),
    now: 1_000_000,
  });
  assert.equal(dead.deliveries[0].status, 'dead');
  assert.equal(dead.nextAlarm, null);
});

test('runDeliveries stores redacted errors, never the key or URL', async () => {
  const { deliveries } = await runDeliveries(record(), [subscriber()], {
    fetchImpl: async () => { throw new Error(`timeout calling ${URL_A} with ${KEY_A}`); },
    now: 1_000_000,
  });
  const serialized = JSON.stringify(deliveries);
  assert.equal(serialized.includes(KEY_A), false);
  assert.equal(serialized.includes(URL_A), false);
  assert.equal(deliveries[0].status, 'pending');
  assert.equal(deliveries[0].attempts, 1);
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

test('pruneRecords keeps pending, expires delivered at 24h and dead at 7d', () => {
  const now = 1_000_000;
  const pending = record({ deliveries: [{ status: 'pending', nextRetryAt: now + 1 }] });
  const delivered = record({ id: 'rec-delivered', deliveries: [{ status: 'delivered' }] });
  const dead = record({ id: 'rec-dead', deliveries: [{ status: 'dead' }] });

  const fresh = pruneRecords([pending, delivered, dead], now);
  assert.equal(fresh.kept.length, 3);

  const after24h = pruneRecords([delivered], now + DELIVERED_TTL_MS);
  assert.equal(after24h.kept.length, 0);

  const beforeDeadTtl = pruneRecords([dead], now + DELIVERED_TTL_MS);
  assert.equal(beforeDeadTtl.kept.length, 1); // dead lives longer than delivered

  const afterDeadTtl = pruneRecords([dead], now + DEAD_LETTER_TTL_MS);
  assert.equal(afterDeadTtl.kept.length, 0);

  // pending is never pruned even far in the future
  const pendingLater = pruneRecords([pending], now + DEAD_LETTER_TTL_MS * 10);
  assert.equal(pendingLater.kept.length, 1);
});

test('the deadletter route is bearer-protected and returns dead records', async () => {
  const token = 'inbox-token';
  const dead = record({ deliveries: [{ status: 'dead', lastError: 'HTTP 500' }] });
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
  assert.equal(JSON.stringify(body).includes('sub-a'), false); // no subscriber id leak concern beyond status
});

test('MAX_DELIVERY_ATTEMPTS is the agreed small cap', () => {
  assert.equal(MAX_DELIVERY_ATTEMPTS, 5);
});
