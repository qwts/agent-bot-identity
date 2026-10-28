// The pilot provider key (D2, #1184): fetched from the identity service with
// a fresh operation, held in memory only, receipted as provider-key-exception
// on fetch and on every use, and dropped at once on device revocation.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dropProviderKey, ensureProviderKey, fetchProviderKey, heldProviderEnv, providerKeyStale, providerKeyStatus } from '../identity/provider-key.mjs';
import { ServerSession } from '../identity/server-client.mjs';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'provider-key-'));
  roots.push(root);
  return { root, env: { AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'), AGENT_BOT_CONFIG: path.join(root, 'none.json'), AGENT_BOT_SERVER_STATE: path.join(root, 'server') } };
}
const SECRET = 'pk-NOT-A-REAL-KEY-0123456789';

function fakeSession({ fail = null } = {}) {
  const calls = [];
  const session = Object.create(ServerSession.prototype);
  session.call = async (method, route) => {
    calls.push(route);
    if (fail) throw fail;
    const q = new URL(route, 'https://x.test').searchParams;
    return { provider: q.get('provider'), key: SECRET, key_id: 'pk_1', expires_at: '2099-01-01T00:00:00Z', issuance_id: 'iss_pk1', operation_id: q.get('operation_id'), task_id: 'daemon-start' };
  };
  return { session, calls };
}

const receipts = (env) => readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the key is fetched with a fresh operation, held in memory only, and receipted without the secret', async () => {
  const { root, env } = scratch();
  dropProviderKey();
  const { session, calls } = fakeSession();
  const status = await fetchProviderKey({ provider: 'anthropic', env, home: root, session });
  assert.deepEqual(status, { provider: 'anthropic', keyId: 'pk_1', issuanceId: 'iss_pk1', expiresAt: '2099-01-01T00:00:00Z' });
  assert.match(calls[0], /^\/api\/daemon\/provider-key\?provider=anthropic&operation_id=op_[0-9a-f-]{36}&profile=managed%20cooperative$/);
  assert.equal(providerKeyStale(), false);
  // Use: only for the matching provider, receipted with the exception named.
  assert.equal(heldProviderEnv({ providerId: 'openai', envKey: 'OPENAI_API_KEY', env, home: root }), null);
  const patch = heldProviderEnv({ providerId: 'anthropic', envKey: 'ANTHROPIC_API_KEY', harness: 'claude', env, home: root });
  assert.deepEqual(patch.env, { ANTHROPIC_API_KEY: SECRET });
  const rows = receipts(env);
  assert.deepEqual(rows.map((r) => [r.event, r.decision, r.reason, r.issuanceId, r.taskId]), [
    ['provider-key-fetch', 'granted', 'provider-key-exception', 'iss_pk1', 'daemon-start'],
    ['provider-key-use', 'injected', 'provider-key-exception', 'iss_pk1', 'daemon-start'],
  ]);
  assert.match(rows[1].detail, /reaches the harness process environment; to be replaced by the loopback inference proxy \(#1190\)/);
  // Never on disk: not in receipts, not anywhere under the state roots.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(root)) assert.doesNotMatch(readFileSync(file, 'utf8'), /pk-NOT-A-REAL-KEY/, file);
  dropProviderKey();
  assert.equal(providerKeyStatus(), null);
});

test('the key is never used past its lease, is refetched near its end and after a failure with backoff, and drops when unconfigured', async () => {
  const { root, env } = scratch();
  dropProviderKey();
  let clock = Date.parse('2026-10-28T00:00:00Z');
  const now = () => new Date(clock);
  const answers = [];
  const calls = [];
  const session = Object.create(ServerSession.prototype);
  session.call = async (method, route) => {
    calls.push(route);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    const q = new URL(route, 'https://x.test').searchParams;
    return { provider: 'anthropic', key: SECRET, issuance_id: `iss_${calls.length}`, operation_id: q.get('operation_id'), task_id: 'daemon-start', ...next };
  };
  const ensure = () => ensureProviderKey({ provider: 'anthropic', env, home: root, session, now });
  // A failed start fetch (a locked vault) holds nothing and backs off.
  answers.push(Object.assign(new Error('vault_locked'), { status: 423 }));
  assert.equal(await ensure(), null);
  assert.equal(calls.length, 1);
  assert.equal(await ensure(), null, 'inside the backoff window nothing is sent');
  assert.equal(calls.length, 1);
  clock += 31_000;
  answers.push({ key_id: 'pk_1', expires_at: new Date(clock + 3_600_000).toISOString() });
  assert.equal((await ensure()).keyId, 'pk_1', 'refetched once the backoff passed');
  assert.equal(await ensure() !== null && calls.length, 2, 'a fresh key is not refetched');
  // Past the lease the key is never injected.
  clock += 3_600_001;
  assert.equal(heldProviderEnv({ providerId: 'anthropic', envKey: 'ANTHROPIC_API_KEY', env, home: root, now }), null);
  assert.equal(providerKeyStatus(), null, 'an expired key is dropped');
  // Near the lease end it is refetched; a rotated key_id replaces the old key.
  answers.push({ key_id: 'pk_1', expires_at: new Date(clock + 5 * 60_000).toISOString() });
  await ensure();
  answers.push({ key_id: 'pk_2', expires_at: new Date(clock + 3_600_000).toISOString() });
  assert.equal((await ensure()).keyId, 'pk_2', 'stale (inside the 10-minute margin) is refetched, and the new key_id replaces the old');
  // The service saying the key is not configured drops it.
  clock += 3_100_000;
  answers.push(Object.assign(new Error('agent-bot server /api/daemon/provider-key: 404 provider_key_not_configured'), { status: 404 }));
  assert.equal(await ensure(), null);
  assert.equal(providerKeyStatus(), null);
  dropProviderKey();
});

test('a failed fetch is receipted and leaves nothing held; device revocation drops the key at once', async () => {
  const { root, env } = scratch();
  dropProviderKey();
  const failing = fakeSession({ fail: Object.assign(new Error('down'), { code: 'credential-unavailable' }) });
  await assert.rejects(fetchProviderKey({ provider: 'anthropic', env, home: root, session: failing.session }), (e) => e.code === 'credential-unavailable');
  assert.equal(providerKeyStatus(), null);
  assert.equal(receipts(env).at(-1).reason, 'credential-unavailable');
  await fetchProviderKey({ provider: 'anthropic', env, home: root, session: fakeSession().session });
  assert.ok(providerKeyStatus());
  // ServerSession.revoked() fires the listeners provider-key registered.
  const s = new ServerSession({ base: 'https://x.test', env });
  s.revoked();
  assert.equal(providerKeyStatus(), null, 'dropped at once on device revocation');
});
