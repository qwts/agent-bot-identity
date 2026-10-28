// The loopback inference proxy (#1190): a harness holds a short-lived proxy
// token, never the pilot provider key; the proxy swaps the key in on the way
// to the upstream and streams the answer back.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createInferenceProxy, isProxyBaseUrl, proxyBaseUrl, validProxyPort } from '../identity/inference-proxy.mjs';
import { brokeredProviderEnv, dropProviderKey, fetchProviderKey, launchProviderEnv, startInferenceProxy, stopInferenceProxy } from '../identity/provider-key.mjs';
import { acpExecutorFor } from '../wake-plane.mjs';
import { ServerSession } from '../identity/server-client.mjs';

const roots = [];
after(async () => { await stopInferenceProxy(); for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const KEY = 'sk-NOT-A-REAL-PILOT-KEY-123456';

async function withProxy(fn, { now, maxBodyBytes } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: init.body?.toString() });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: one\n\n')); c.enqueue(new TextEncoder().encode('data: two\n\n')); c.close(); } }),
      { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'r1', 'set-cookie': 'session=upstream' } });
  };
  const p = createInferenceProxy({ upstreams: { openai: 'https://opencode.ai/zen/go/v1' }, keyFor: (id) => (id === 'openai' ? KEY : null), fetchImpl, ...(now ? { now } : {}), ...(maxBodyBytes ? { maxBodyBytes } : {}) });
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
    assert.equal(res.headers.get('set-cookie'), null, 'upstream cookies are dropped');
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

// A raw request target, sent as written (fetch would normalise it first).
const raw = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject);
  req.end('{}');
});

test('a forwarded path cannot leave the upstream: //host, dot segments and encoded separators or traversal are refused before the upstream', async () => {
  await withProxy(async ({ p, port, seen }) => {
    const auth = { authorization: `Bearer ${p.issue({ agentId: 'agent_x', providerId: 'openai' })}` };
    assert.equal(await raw(port, '//evil.example/x', auth), 404);
    for (const path of ['/v0/inference/openai//evil.example/x', '/v0/inference/openai/../../v2/x', '/v0/inference/openai/%2e%2e/x',
      '/v0/inference/openai/a%2F..%2F..%2Fx', '/v0/inference/openai/a%5Cb', '/v0/inference/openai/%zz']) {
      assert.equal(await raw(port, path, auth), 400, path);
    }
    assert.equal(seen.length, 0, 'nothing reached the upstream');
    assert.equal(await raw(port, '/v0/inference/openai/chat/completions?stream=true', auth), 200);
    assert.equal(seen[0].url, 'https://opencode.ai/zen/go/v1/chat/completions?stream=true');
  });
});

test('a request body over the cap is refused with 413 and never forwarded', async () => {
  await withProxy(async ({ p, port, seen }) => {
    const auth = { authorization: `Bearer ${p.issue({ agentId: 'agent_x', providerId: 'openai' })}` };
    const big = await fetch(`${proxyBaseUrl(port, 'openai')}/chat/completions`, { method: 'POST', headers: auth, body: 'x'.repeat(64) });
    assert.equal(big.status, 413);
    const small = await fetch(`${proxyBaseUrl(port, 'openai')}/chat/completions`, { method: 'POST', headers: auth, body: 'x'.repeat(16) });
    assert.equal(small.status, 200);
    assert.equal(seen.length, 1);
  }, { maxBodyBytes: 32 });
});

test('a proxy token never outlives notAfter (the held key\'s lease)', async () => {
  let clock = 1_000;
  await withProxy(async ({ p, port }) => {
    const token = p.issue({ agentId: 'agent_x', providerId: 'openai', notAfter: 1_500 });
    const call = () => fetch(`${proxyBaseUrl(port, 'openai')}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
    assert.equal((await call()).status, 200);
    clock = 1_500;
    assert.equal((await call()).status, 401, 'expired with the lease, not six hours later');
    assert.equal(p.issue({ agentId: 'agent_x', providerId: 'openai', notAfter: 1_000 }), null, 'no token past an expired lease');
  }, { now: () => clock });
});

test('the proxy port is fixed, and a loopback baseUrl on the port or the proxy path counts as the proxy', () => {
  assert.equal(validProxyPort(0), false, 'a soul baseUrl cannot name a random port');
  assert.equal(validProxyPort(8787), true);
  assert.equal(validProxyPort(65536), false);
  assert.equal(validProxyPort('8787'), false);
  assert.equal(isProxyBaseUrl('http://127.0.0.1:8787/v0/inference/openai', 8787), true);
  assert.equal(isProxyBaseUrl('http://localhost:8787/v1', 8787), true);
  assert.equal(isProxyBaseUrl('http://127.0.0.1:9999/v0/inference/openai', undefined), true, 'the proxy path on loopback, even with no setting');
  assert.equal(isProxyBaseUrl('http://127.0.0.1:11434/v1', 8787), false, 'a local model server is not the proxy');
  assert.equal(isProxyBaseUrl('https://opencode.ai/zen/go/v1', 8787), false);
  assert.equal(isProxyBaseUrl(null, 8787), false);
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

test('brokering fails closed: with the proxy down and the key held, a soul whose baseUrl is on the proxy is refused and its env never gets the key', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'inference-proxy-'));
  roots.push(root);
  const env = { AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'), AGENT_BOT_CONFIG: path.join(root, 'none.json'), AGENT_BOT_SERVER_STATE: path.join(root, 'server') };
  dropProviderKey();
  await stopInferenceProxy();
  const session = Object.create(ServerSession.prototype);
  session.call = async (method, route) => ({ provider: 'openai', key: KEY, key_id: 'pk_1', expires_at: '2099-01-01T00:00:00Z', issuance_id: 'iss_pk1', operation_id: new URL(route, 'https://x.test').searchParams.get('operation_id'), task_id: 'daemon-start' });
  await fetchProviderKey({ provider: 'openai', env, home: root, session });
  const onProxy = { providerId: 'openai', envKey: 'OPENAI_API_KEY', baseUrl: 'http://127.0.0.1:8787/v0/inference/openai', proxyPort: 8787, harness: 'opencode', env, home: root };
  assert.throws(() => launchProviderEnv(onProxy), (e) => e.code === 'inference-proxy-unavailable' && !e.message.includes(KEY));
  // The launch itself: the executor is never created, so no harness env exists.
  let created = null;
  const createExecutor = (opts) => { created = opts; return async () => ({ stopReason: 'end_turn' }); };
  assert.throws(() => acpExecutorFor({ identities: () => ({}), policy: {}, baseEnv: { PATH: '/usr/bin' }, createExecutor, providerEnvFor: () => launchProviderEnv(onProxy) })(
    { agentId: 'agent_11111111-1111-4111-8111-111111111111', harness: 'opencode', cwd: '/repo', env: {} }), (e) => e.code === 'inference-proxy-unavailable');
  assert.equal(created, null);
  // A proxy on another port does not serve this baseUrl either.
  await startInferenceProxy({ port: 0, upstreams: { openai: 'https://opencode.ai/zen/go/v1' } });
  assert.throws(() => launchProviderEnv(onProxy), (e) => e.code === 'inference-proxy-unavailable');
  await stopInferenceProxy();
  const rows = readFileSync(path.join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.some((r) => r.event === 'provider-key-use'), false, 'no use was receipted: the key was not handed out');
  // A soul off the proxy keeps the pilot exception (the held key, receipted).
  const off = launchProviderEnv({ ...onProxy, baseUrl: 'https://opencode.ai/zen/go/v1' });
  assert.equal(off.env.OPENAI_API_KEY, KEY);
  assert.equal(off.provider.source, 'identity-service');
  dropProviderKey();
});
