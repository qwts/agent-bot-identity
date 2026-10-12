// Limits of local diagnostics and OTLP export under load (#983 acceptance:
// bounded overhead, broken exporters change nothing, documented limits).
// Timing bounds are deliberately loose: they catch an unbounded wait or a
// pathological slowdown, not a regression of a few percent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDiagnostics, diagnosticsDirectory, readDiagnostics } from '../diagnostics.mjs';
import { createOtlpExporter } from '../otlp-export.mjs';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const noTimer = { setInterval: () => null, clearInterval: () => {} };

function store() {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-diag-limits-'));
  const env = { XDG_STATE_HOME: join(home, '.local', 'state') };
  return { home, env, dir: diagnosticsDirectory({ env, home }) };
}

// A loopback port with nothing listening: connections are refused at once.
async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('the store stays within two generations under sustained writes, and every write returns', () => {
  const f = store();
  const maxFileBytes = 64 * 1024;
  const diagnostics = createDiagnostics({ component: 'daemon', env: f.env, home: f.home, maxFileBytes });
  const started = performance.now();
  for (let i = 0; i < 5000; i += 1) {
    assert.equal(diagnostics.record({ event: 'launch', stage: 'harness', outcome: 'ok', code: `c${i % 50}`, durationMs: i, traceId: TRACE, spanId: (i + 1).toString(16).padStart(16, '0'), detail: 'x'.repeat(200) }), true);
  }
  const elapsed = performance.now() - started;
  const files = readdirSync(f.dir).sort();
  assert.deepEqual(files, ['events.1.jsonl', 'events.jsonl']);
  const total = files.reduce((sum, file) => sum + statSync(join(f.dir, file)).size, 0);
  assert.ok(total <= 2 * maxFileBytes, `store is ${total} bytes`);
  assert.equal(readDiagnostics({ env: f.env, home: f.home }).at(-1).durationMs, 4999);
  assert.ok(elapsed < 20_000, `5000 synchronous records took ${Math.round(elapsed)} ms`);
});

test('an offline collector under load keeps the queue bounded, counts drops and never fails a record', async () => {
  const f = store();
  const port = await closedPort();
  const exporter = createOtlpExporter({ endpoint: `http://127.0.0.1:${port}`, timeoutMs: 500, maxQueue: 64, batchSize: 16, ...noTimer });
  const diagnostics = createDiagnostics({ component: 'daemon', env: f.env, home: f.home, sink: exporter.enqueue });
  const started = performance.now();
  for (let i = 0; i < 1000; i += 1) {
    assert.equal(diagnostics.record({ event: 'launch', outcome: i % 3 ? 'ok' : 'failed', traceId: TRACE, spanId: (i + 1).toString(16).padStart(16, '0') }), true);
    assert.ok(exporter.stats().queued <= 64);
  }
  const recordMs = performance.now() - started;
  for (let i = 0; i < 4; i += 1) await exporter.flush();
  const stats = exporter.stats();
  assert.equal(stats.sent, 0);
  assert.ok(stats.queued <= 64);
  assert.ok(stats.dropped >= 1000 - 64, `dropped ${stats.dropped}`);
  assert.equal(readDiagnostics({ env: f.env, home: f.home }).length, 1000, 'the local store kept every event');
  assert.ok(recordMs < 20_000, `recording took ${Math.round(recordMs)} ms with an offline collector`);
});

test('a collector that never answers is cut off by the request timeout', async (t) => {
  // Accepts the connection and never responds.
  const sockets = [];
  const server = createServer((socket) => { sockets.push(socket); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const exporter = createOtlpExporter({ endpoint: `http://127.0.0.1:${server.address().port}`, timeoutMs: 200, ...noTimer });
  exporter.enqueue({ v: 1, at: new Date().toISOString(), component: 'daemon', event: 'launch', outcome: 'ok', traceId: TRACE, spanId: '00f067aa0ba902b7' });
  const started = performance.now();
  await exporter.flush();
  await exporter.flush();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `two timed-out flushes took ${Math.round(elapsed)} ms`);
  assert.deepEqual([exporter.stats().sent, exporter.stats().dropped], [0, 1], 'retried once, then dropped and counted');
});
