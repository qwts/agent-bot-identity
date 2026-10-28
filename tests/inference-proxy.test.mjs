// The loopback inference proxy (#1190): a harness holds a short-lived proxy
// token, never the pilot provider key; the proxy swaps the key in on the way
// to the upstream and streams the answer back.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createInferenceProxy, proxyBaseUrl } from '../identity/inference-proxy.mjs';
import { brokeredProviderEnv, dropProviderKey, fetchProviderKey, startInferenceProxy, stopInferenceProxy } from '../identity/provider-key.mjs';
import { ServerSession } from '../identity/server-client.mjs';

const roots = [];
after(async () => { await stopInferenceProxy(); for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const KEY = 'sk-NOT-A-REAL-PILOT-KEY-123456';

async function withProxy(fn, { now } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body?.toString() });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: one\n\n')); c.enqueue(new TextEncoder().encode('data: two\n\n')); c.close(); } }),
      { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'r1' } });
  };
  const p = createInferenceProxy({ upstreams: { openai: 'https://opencode.ai/zen/go/v1' }, keyFor: (id) => (id === 'openai' ? KEY : null), fetchImpl, ...(now ? { now } : {}) });
  const port = await p.listen(0);
  try { await fn({ p, port, seen }); } finally { await p.close(); }
}

test('a valid proxy token is swapped for the held key, the path and body are forwarded, and the stream comes back', async () => {
  await withProxy(async ({ p, port, seen }) => {
    const token = p.issue({ agentId: 'agent_x', providerId: 'openai' });
    assert.match(token, /^abp_[0-9a-f]{48}$/);
    const res = await fetch(`${proxyBaseUrl(port, 'openai')}/chat/completions?x=1`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"model":"glm-5.3"}' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-request-id'), 'r1');
    assert.equal(await res.text(), 'data: one\n\ndata: two\n\n');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://opencode.ai/zen/go/v1/chat/completions?x=1');
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`, 'the upstream gets the real key');
    assert.equal(seen[0].body, '{"model":"glm-5.3"}');
    assert.ok(!Object.values(seen[0].headers).some((v) => String(v).includes(token)), 'the proxy token never goes upstream');
  });
});

test('no token, a forged or expired token, another provider, or an unconfigured provider is refused without reaching the upstream', async () => {
  let clock = 1_000;
  await withProxy(async ({ p, port, seen }) => {
    const base = proxyBaseUrl(port, 'openai');
    const call = (headers, url = `${base}/chat/completions`) => fetch(url, { method: 'POST', headers, body: '{}' });
    assert.equal((await call({})).status, 401);
    assert.equal((await call({ authorization: `Bearer abp_${'0'.repeat(48)}` })).status, 401);
    assert.equal((await call({ authorization: `Bearer ${KEY}` })).status, 401, 'the real key is not a proxy token');
    const token = p.issue({ agentId: 'agent_x', providerId: 'openai', ttlMs: 500 });
    assert.equal((await call({ authorization: `Bearer ${token}` }, `${proxyBaseUrl(port, 'anthropic')}/v1/messages`)).status, 404);
    clock += 1_000;
    assert.equal((await call({ authorization: `Bearer ${token}` })).status, 401, 'expired');
    const fresh = p.issue({ agentId: 'agent_x', providerId: 'openai' });
    p.revokeAll();
    assert.equal((await call({ authorization: `Bearer ${fresh}` })).status, 401, 'revoked');
    assert.equal(seen.length, 0);
    const body = await (await call({})).text();
    assert.doesNotMatch(body, /NOT-A-REAL/);
  }, { now: () => clock });
  assert.throws(() => createInferenceProxy({ upstreams: { openai: 'http://evil.example' }, keyFor: () => null }), /https URL/);
});

test('a soul whose baseUrl is on the proxy gets a proxy token, never the key, receipted as brokered-inference', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'inference-proxy-'));
  roots.push(root);
  const env = { AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'), AGENT_BOT_CONFIG: path.join(root, 'none.json'), AGENT_BOT_SERVER_STATE: path.join(root, 'server') };
  dropProviderKey();
  const session = Object.create(ServerSession.prototype);
  session.call = async (method, route) => {
    const q = new URL(route, 'https://x.test').searchParams;
    return { provider: 'openai', key: KEY, key_id: 'pk_1', expires_at: '2099-01-01T00:00:00Z', issuance_id: 'iss_pk1', operation_id: q.get('operation_id'), task_id: 'daemon-start' };
  };
  await fetchProviderKey({ provider: 'openai', env, home: root, session });
  const origin = await startInferenceProxy({ port: 0, upstreams: { openai: 'https://opencode.ai/zen/go/v1' } });
  assert.equal(brokeredProviderEnv({ providerId: 'openai', envKey: 'OPENAI_API_KEY', baseUrl: 'https://opencode.ai/zen/go/v1', env, home: root }), null, 'a baseUrl off the proxy is not brokered');
  const patch = brokeredProviderEnv({ providerId: 'openai', envKey: 'OPENAI_API_KEY', baseUrl: `${origin}/v0/inference/openai`, agentId: null, harness: 'opencode', env, home: root });
  assert.match(patch.env.OPENAI_API_KEY, /^abp_/);
  assert.notEqual(patch.env.OPENAI_API_KEY, KEY);
  const rows = readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const use = rows.at(-1);
  assert.deepEqual([use.event, use.decision, use.reason, use.issuanceId], ['provider-key-use', 'brokered', 'brokered-inference', 'iss_pk1']);
  assert.doesNotMatch(JSON.stringify(rows), /NOT-A-REAL|abp_/, 'neither the key nor the token is receipted');
  // Revocation invalidates every token at once.
  new ServerSession({ base: 'https://x.test', env }).revoked();
  const res = await fetch(`${origin}/v0/inference/openai/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${patch.env.OPENAI_API_KEY}` }, body: '{}' });
  assert.equal(res.status, 401);
  await stopInferenceProxy();
});
