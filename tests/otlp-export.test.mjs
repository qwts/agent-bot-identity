import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnosticsOtlpEndpointSetting } from '../config.mjs';
import { createDiagnostics } from '../diagnostics.mjs';
import { createOtlpExporter, otlpHeaders, spanFor } from '../otlp-export.mjs';
import { diagnosticsExporter } from '../agent-daemon.mjs';
import { createLaunchHandler } from '../daemon-launch.mjs';
import { HARNESS_SESSION_EVENT } from '../executor-contract.mjs';

const AGENT = 'agent_11111111-1111-4111-8111-111111111111';
const CANARY = 'ghs_CANARYcanary0123456789abcdefABCDEF';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const noTimer = { setInterval: () => null, clearInterval: () => {} };

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bot-otlp-'));
  return { home: dir, env: { XDG_STATE_HOME: join(dir, '.local', 'state'), XDG_CONFIG_HOME: join(dir, '.config') } };
}

function recordingFetch(responses = []) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift() ?? { status: 200 };
    if (next.throw) throw new Error(`network down ${CANARY}`);
    return { ok: next.status >= 200 && next.status < 300, status: next.status };
  };
  return { fetch, calls };
}

test('the endpoint setting is opt-in and strict; ambient OTEL variables never enable export', () => {
  assert.equal(diagnosticsOtlpEndpointSetting({}), null);
  assert.equal(diagnosticsOtlpEndpointSetting({ settings: { diagnosticsOtlpEndpoint: 'https://collector.example:4318/' } }), 'https://collector.example:4318');
  for (const ok of ['http://localhost:4318', 'http://127.0.0.1:4318', 'http://[::1]:4318']) {
    assert.equal(diagnosticsOtlpEndpointSetting({ settings: { diagnosticsOtlpEndpoint: ok } }), ok);
  }
  for (const bad of ['http://collector.example:4318', 'https://user:pass@c.example', 'https://c.example?key=x', 'https://c.example#x', 'ftp://c.example', 'not a url', 42]) {
    assert.throws(() => diagnosticsOtlpEndpointSetting({ settings: { diagnosticsOtlpEndpoint: bad } }), /diagnosticsOtlpEndpoint/, String(bad));
  }
  const f = home();
  const created = [];
  const env = { ...f.env, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ambient.example', OTEL_TRACES_EXPORTER: 'otlp' };
  assert.equal(diagnosticsExporter({ env, home: f.home, config: {}, create: (o) => { created.push(o); return {}; } }), null);
  assert.equal(diagnosticsExporter({ env, home: f.home, create: (o) => { created.push(o); return {}; } }), null, 'no user config file');
  assert.deepEqual(created, []);
  diagnosticsExporter({ env: { ...env, AGENT_BOT_OTLP_HEADERS: 'x-api-key=k1' }, home: f.home,
    config: { settings: { diagnosticsOtlpEndpoint: 'https://c.example' } }, create: (o) => { created.push(o); return {}; } });
  assert.deepEqual(created.map((o) => [o.endpoint, o.headers]), [['https://c.example', { 'x-api-key': 'k1' }]]);
});

test('headers parse name=value pairs and refuse reserved or malformed ones', () => {
  assert.deepEqual(otlpHeaders({ AGENT_BOT_OTLP_HEADERS: 'x-api-key=a%3Db, Authorization=Bearer t ,content-type=text/plain,bad name=x,=y,novalue,x-nl=a%0Ab' }),
    { 'x-api-key': 'a=b', Authorization: 'Bearer t' });
  assert.deepEqual(otlpHeaders({}), {});
});

test('an operation and its stages become one span with only allowlisted attributes', async () => {
  const { fetch, calls } = recordingFetch();
  const exporter = createOtlpExporter({ endpoint: 'https://c.example/', headers: { 'x-api-key': 'k' }, version: '0.10.64', platform: 'darwin', fetch, ...noTimer });
  const base = { v: 1, component: 'daemon', traceId: TRACE, spanId: '00f067aa0ba902b7', parentSpanId: '1111111111111111', agent: 'abcdef0123456789' };
  exporter.enqueue({ ...base, at: '2026-10-11T00:00:01.000Z', event: 'launch-stage', stage: 'checking', outcome: 'ok', durationMs: 5, detail: CANARY });
  exporter.enqueue({ ...base, at: '2026-10-11T00:00:02.000Z', event: 'launch', stage: 'sign-in', outcome: 'refused', code: 'harness-signed-out', durationMs: 2000, detail: `${CANARY} /Users/someone/x` });
  exporter.enqueue({ v: 1, at: '2026-10-11T00:00:03.000Z', component: 'daemon', event: 'untraced', outcome: 'ok' });
  await exporter.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://c.example/v1/traces');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.headers['x-api-key'], 'k');
  assert.equal(calls[0].init.redirect, 'error');
  const [resource] = calls[0].body.resourceSpans;
  assert.deepEqual(resource.resource.attributes.map((a) => a.key), ['service.name', 'os.type', 'service.version']);
  const [span] = resource.scopeSpans[0].spans;
  assert.equal(span.traceId, TRACE);
  assert.equal(span.parentSpanId, '1111111111111111');
  assert.equal(span.name, 'launch');
  assert.equal(span.endTimeUnixNano, `${Date.parse('2026-10-11T00:00:02.000Z')}000000`);
  assert.equal(span.startTimeUnixNano, `${Date.parse('2026-10-11T00:00:00.000Z')}000000`);
  assert.deepEqual(span.attributes.map((a) => a.key), ['agent_bot.component', 'agent_bot.outcome', 'agent_bot.stage', 'agent_bot.code', 'agent_bot.agent_hash', 'agent_bot.duration_ms']);
  assert.deepEqual(span.events.map((e) => [e.name, e.attributes.map((a) => a.key)]), [['launch-stage', ['agent_bot.stage', 'agent_bot.duration_ms']]]);
  assert.deepEqual(span.status, { code: 0 });
  assert.equal(spanFor({ ...base, at: '2026-10-11T00:00:02.000Z', event: 'launch', outcome: 'failed' }).status.code, 2);
  const sentText = JSON.stringify(calls[0].body);
  for (const leak of [CANARY, '/Users/someone', 'detail']) assert.equal(sentText.includes(leak), false, leak);
  assert.deepEqual(exporter.stats(), { sent: 1, dropped: 0, queued: 0 });
});

test('the queue is bounded, failures retry once then drop, and nothing throws', async () => {
  const event = (i) => ({ v: 1, at: '2026-10-11T00:00:00.000Z', component: 'daemon', event: 'launch', outcome: 'ok', traceId: TRACE, spanId: i.toString(16).padStart(16, '1') });
  const { fetch, calls } = recordingFetch([{ throw: true }, { status: 503 }, { status: 400 }]);
  const exporter = createOtlpExporter({ endpoint: 'https://c.example', fetch, maxQueue: 4, batchSize: 10, ...noTimer });
  for (let i = 0; i < 6; i += 1) exporter.enqueue(event(i));
  assert.deepEqual(exporter.stats(), { sent: 0, dropped: 2, queued: 4 });
  await exporter.flush(); // network error: retried
  assert.deepEqual(exporter.stats(), { sent: 0, dropped: 2, queued: 4 });
  await exporter.flush(); // 503 on the retry: dropped
  assert.deepEqual(exporter.stats(), { sent: 0, dropped: 6, queued: 0 });
  exporter.enqueue(event(9));
  await exporter.flush(); // 400: dropped without retry
  assert.deepEqual(exporter.stats(), { sent: 0, dropped: 7, queued: 0 });
  assert.equal(calls.length, 3);
  exporter.enqueue(null);
  exporter.enqueue({ traceId: TRACE, spanId: 'x', event: 42 });
});

test('a broken or unreachable exporter never changes a launch or its local record', async (t) => {
  const f = home();
  const exporter = createOtlpExporter({ endpoint: 'http://127.0.0.1:9', fetch: async () => { throw new Error('refused'); }, timeoutMs: 50, ...noTimer });
  const throwingSink = () => { throw new Error('sink exploded'); };
  for (const sink of [exporter.enqueue, throwingSink]) {
    const diagnostics = createDiagnostics({ component: 'daemon', env: f.env, home: f.home, sink });
    const root = mkdtempSync(join(tmpdir(), 'otlp-launch-'));
    const reports = [];
    const handler = createLaunchHandler({
      file: join(root, 'launch-requests.json'), diagnostics,
      identities: () => ({ id: AGENT, github: { appSlug: 'test-app' }, harness: 'muse' }),
      spawnPackage: () => { throw new Error('unexpected spawn'); },
      lookupBinding: () => ({ worktree: '/work', file: '/private/binding' }), provisionHome: () => null,
      executorFor: () => async (input) => { input.appendEvent(HARNESS_SESSION_EVENT, {}); },
    });
    await handler({ event: 'launch', requestId: 'r1', principal: 'p1', account: 'worker', soul: AGENT, harness: 'claude' },
      { account: 'worker', report: async (r) => { reports.push(r); } });
    assert.deepEqual(reports, [{ requestId: 'r1', status: 'launched', agentId: AGENT }]);
  }
  await exporter.flush();
  await exporter.flush();
  assert.equal(exporter.stats().sent, 0);
  assert.ok(exporter.stats().dropped >= 1);
});

test('spans reach a real loopback OTLP/HTTP collector', async (t) => {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) }); res.writeHead(200).end('{}'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const f = home();
  mkdirSync(join(f.env.XDG_CONFIG_HOME, 'agent-bot'), { recursive: true });
  const exporter = createOtlpExporter({ endpoint: `http://127.0.0.1:${port}`, headers: { 'x-api-key': 'k' }, ...noTimer });
  const diagnostics = createDiagnostics({ component: 'daemon', env: f.env, home: f.home, sink: exporter.enqueue });
  diagnostics.record({ event: 'launch', outcome: 'ok', traceId: TRACE, spanId: '00f067aa0ba902b7', agentId: AGENT, durationMs: 12, detail: CANARY });
  await exporter.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/v1/traces');
  assert.equal(received[0].headers['x-api-key'], 'k');
  const text = JSON.stringify(received[0].body);
  for (const leak of [CANARY, AGENT, f.home]) assert.equal(text.includes(leak), false, leak);
  assert.equal(exporter.stats().sent, 1);
});

test('the daemon builds no exporter from a config file without an endpoint', () => {
  const f = home();
  mkdirSync(join(f.env.XDG_CONFIG_HOME, 'agent-bot'), { recursive: true });
  const configFile = join(f.home, 'config.json');
  writeFileSync(configFile, JSON.stringify({ settings: {} }));
  const created = [];
  assert.equal(diagnosticsExporter({ env: { ...f.env, AGENT_BOT_CONFIG: configFile }, home: f.home, create: (o) => { created.push(o); return {}; } }), null);
  writeFileSync(configFile, JSON.stringify({ settings: { diagnosticsOtlpEndpoint: 'http://localhost:4318' } }));
  diagnosticsExporter({ env: { ...f.env, AGENT_BOT_CONFIG: configFile }, home: f.home, create: (o) => { created.push(o); return {}; } });
  assert.deepEqual(created.map((o) => o.endpoint), ['http://localhost:4318']);
});
