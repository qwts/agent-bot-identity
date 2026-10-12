// Wake trace continuity across agent-comms (#1027, agent-comms#208).
//
// The fixture pins the raw account-watch `event:wake` lines the real
// agent-comms 0.5.1 broker wrote for: one message with a valid sender
// `traceparent` (forwarded), a batch with two different valid values, a
// batch with one valid value and one without, an invalid value, and a
// catch-up wake for a message sent before the watch opened (all omitted). A
// fake broker on a temporary socket replays those exact bytes to this
// daemon's real comms supervisor and real wake plane. The `traceparent` is
// untrusted correlation only: it may continue the wake's trace and nothing
// else.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commsPaths, createCommsSupervisor } from '../comms-client.mjs';
import { createWakePlane } from '../wake-plane.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/agent-comms-0.5.1-wake-frames.json', import.meta.url), 'utf8'));
const CASES = ['valid', 'mixed', 'partial', 'invalid', 'catchUp'];
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function scratchWorld() {
  const root = mkdtempSync(path.join(tmpdir(), 'wtrace-'));
  roots.push(root);
  const shared = path.join(root, 'shared');
  mkdirSync(path.join(shared, 'pairing'), { recursive: true });
  chmodSync(path.join(shared, 'pairing'), 0o1777);
  const env = { AGENT_COMMS_SHARED_DIR: shared, XDG_STATE_HOME: path.join(root, 'state'), AGENT_BOT_COMMS_DAEMON_PATH: path.join(root, 'comms-daemon.json') };
  return { root, env, socket: path.join(shared, 'broker.sock'), paths: commsPaths({ env }) };
}

// Replays recorded broker lines byte for byte and acknowledges reports.
function replayBroker(socketPath, frames, reports) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (line.op === 'account-watch') { for (const frame of frames) socket.write(`${frame}\n`); continue; }
        reports.push(line);
        socket.write(`${JSON.stringify({ v: 1, id: line.id, ok: true, recorded: true })}\n`);
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve({ close: () => new Promise((done) => { for (const s of sockets) s.destroy(); server.close(done); }) }));
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the replayed wakes');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

test('the fixture is pinned to the agent-comms 0.5.1 release it was recorded from', () => {
  assert.deepEqual(FIXTURE.source, {
    release: 'v0.5.1',
    commit: 'f42c05bdaa5e6255e0a2d7793e51713e0893a5dc',
    archive: 'https://github.com/qwts/agent-comms/releases/download/v0.5.1/agent-comms-0.5.1.tar.gz',
    archiveBytes: 792618,
    archiveSha256: '931b386420856871e4931eacc5e52cdfd0ff18f427bae48d45e70b74ce44814e',
    recordedAt: '2026-10-12',
  });
  const frame = (name) => JSON.parse(FIXTURE.cases[name].frame);
  assert.equal(frame('valid').traceparent, FIXTURE.cases.valid.sent[0], 'one valid context is forwarded unchanged');
  for (const name of ['mixed', 'partial', 'invalid', 'catchUp']) assert.equal(Object.hasOwn(frame(name), 'traceparent'), false, name);
  assert.deepEqual(FIXTURE.cases.mixed.sent.length, 2);
  assert.equal(FIXTURE.cases.partial.sent[1], null);
});

test('real 0.5.1 wake frames: a forwarded traceparent continues the wake trace; omitted ones start new roots', async () => {
  const world = scratchWorld();
  const frames = CASES.map((name) => FIXTURE.cases[name].frame);
  const souls = CASES.map((name) => JSON.parse(FIXTURE.cases[name].frame).agentId);
  const warmFrames = [];
  const receipts = [];
  const events = [];
  const reports = [];
  const onWake = createWakePlane({
    pool: { has: (agentId) => souls.includes(agentId), send: (_agentId, frame) => { warmFrames.push(frame); return 1; } },
    settings: {},
    lookupSoul: () => null,
    identities: () => null,
    receipt: (record) => receipts.push(record),
    diagnostics: { record: (fields) => { events.push(fields); return true; } },
  });
  const broker = await replayBroker(world.socket, [FIXTURE.ready, ...frames], reports);
  const credential = { account: 'owner', secret: 's3cret', brokerUid: process.getuid(), pairedAt: '2026-10-12T00:00:00.000Z' };
  const supervisor = createCommsSupervisor({ env: world.env, credential, paths: world.paths, onWake, sleepImpl: async () => {} });
  try {
    supervisor.start();
    await waitFor(() => reports.filter((r) => r.op === 'wake-report').length === CASES.length && events.length === CASES.length);
  } finally {
    supervisor.stop();
    await broker.close();
  }

  const byAgent = new Map(events.map((e) => [e.agentId, e]));
  const [, traceId, parentSpanId] = FIXTURE.cases.valid.sent[0].split('-');
  const valid = byAgent.get(souls[0]);
  assert.deepEqual([valid.event, valid.stage, valid.outcome], ['wake', 'warm', 'ok']);
  assert.deepEqual([valid.traceId, valid.parentSpanId], [traceId, parentSpanId]);
  assert.notEqual(valid.spanId, parentSpanId);
  for (const [index, name] of CASES.entries()) {
    if (name === 'valid') continue;
    const root = byAgent.get(souls[index]);
    assert.ok(root, name);
    assert.equal(root.parentSpanId, undefined, name);
    assert.match(root.traceId, /^[0-9a-f]{32}$/, name);
    assert.notEqual(root.traceId, traceId, name);
  }

  // Every wake was reported as warm, and no frame, report or receipt carries trace context.
  const wakeReports = reports.filter((r) => r.op === 'wake-report');
  assert.deepEqual(wakeReports.map((r) => r.outcome), CASES.map(() => 'warm'));
  const text = JSON.stringify([warmFrames, wakeReports, receipts]);
  assert.equal(text.includes('traceparent'), false);
  assert.equal(text.includes(traceId), false);
});
