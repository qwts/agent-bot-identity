// Launch trace continuity across agent-comms (#983, agent-comms#164).
//
// The fixture pins the raw account-watch lines the real agent-comms 0.5.0
// broker wrote after a principal SDK launch: one carrying a valid
// `traceparent` the broker forwarded unchanged, one whose invalid value the
// broker dropped. A fake broker on a temporary socket replays those exact
// bytes to this daemon's real comms supervisor and launch handler, so the
// test needs no agent-comms install and never touches a real broker or
// daemon. The `traceparent` is an untrusted correlation ID: it may only
// link diagnostics, never change the launch, its report or its journal.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commsPaths, createCommsSupervisor } from '../comms-client.mjs';
import { createLaunchHandler } from '../daemon-launch.mjs';
import { HARNESS_SESSION_EVENT } from '../executor-contract.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/agent-comms-0.5.0-launch-frames.json', import.meta.url), 'utf8'));
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function scratchWorld() {
  const root = mkdtempSync(path.join(tmpdir(), 'trace-'));
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
        socket.write(`${JSON.stringify({ v: 1, id: line.id, ok: true })}\n`);
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
    if (Date.now() > deadline) throw new Error('timed out waiting for the replayed launches');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

test('the fixture is pinned to the agent-comms 0.5.0 release it was recorded from', () => {
  assert.deepEqual(FIXTURE.source, {
    release: 'v0.5.0',
    commit: 'd3422393fea89c7af29a043e2b1faa4e97882b89',
    archive: 'https://github.com/qwts/agent-comms/releases/download/v0.5.0/agent-comms-0.5.0.tar.gz',
    archiveSha256: '32a778d5ef7825541f233b79986204957feefdf60b3d37e06be7259971f6513e',
    recordedAt: '2026-10-12',
  });
  assert.equal(JSON.parse(FIXTURE.valid.frame).traceparent, FIXTURE.valid.sent, 'the broker forwarded the valid value unchanged');
  assert.equal(Object.hasOwn(JSON.parse(FIXTURE.invalid.frame), 'traceparent'), false, 'the broker dropped the invalid value');
});

test('a principal traceparent forwarded by agent-comms 0.5.0 continues into the daemon launch; a dropped one starts a new trace', async () => {
  const world = scratchWorld();
  const valid = JSON.parse(FIXTURE.valid.frame);
  const invalid = JSON.parse(FIXTURE.invalid.frame);
  const received = [];
  const recorded = [];
  const reports = [];
  const handler = createLaunchHandler({
    file: path.join(world.root, 'launch-requests.json'),
    diagnostics: { record: (fields) => { recorded.push(fields); return true; } },
    identities: () => ({ id: valid.soul, github: null, harness: 'test' }),
    spawnPackage: () => { throw new Error('unexpected spawn'); },
    lookupBinding: () => ({ worktree: world.root, file: path.join(world.root, 'binding') }),
    provisionHome: () => null,
    executorFor: () => async (input) => { input.appendEvent(HARNESS_SESSION_EVENT, {}); },
  });
  const onLaunch = async (event, ports) => { received.push(event); return handler(event, ports); };
  onLaunch.recover = async () => {};
  const broker = await replayBroker(world.socket, [FIXTURE.ready, FIXTURE.valid.frame, FIXTURE.invalid.frame], reports);
  const credential = { account: valid.account, secret: 's3cret', brokerUid: process.getuid(), pairedAt: '2026-10-12T00:00:00.000Z' };
  const supervisor = createCommsSupervisor({ env: world.env, credential, paths: world.paths, onLaunch, sleepImpl: async () => {} });
  try {
    supervisor.start();
    await waitFor(() => reports.filter((r) => r.op === 'launch-result').length === 2);
  } finally {
    supervisor.stop();
    await broker.close();
  }

  // The daemon's event:launch reader got the broker's value unchanged, and nothing for the dropped one.
  assert.deepEqual(received.map((e) => e.requestId), [valid.requestId, invalid.requestId]);
  assert.equal(received[0].traceparent, FIXTURE.valid.sent);
  assert.equal(Object.hasOwn(received[1], 'traceparent'), false);

  // The valid launch is a child span of the principal's; the other is a fresh root.
  const launches = recorded.filter((e) => e.event === 'launch');
  assert.equal(launches.length, 2);
  const [, traceId, parentSpanId] = FIXTURE.valid.sent.split('-');
  assert.equal(launches[0].traceId, traceId);
  assert.equal(launches[0].parentSpanId, parentSpanId);
  assert.notEqual(launches[0].spanId, parentSpanId);
  assert.match(launches[1].traceId, /^[0-9a-f]{32}$/);
  assert.notEqual(launches[1].traceId, traceId);
  assert.notEqual(launches[1].traceId, FIXTURE.invalid.sent.split('-')[1].toLowerCase());
  assert.equal(launches[1].parentSpanId, undefined);
  assert.deepEqual(launches.map((e) => e.outcome), ['ok', 'ok'], 'the trace changes nothing about the launch');

  // Inbound only: no report back to the broker carries trace context, and the journal keeps none.
  const sentBack = JSON.stringify(reports);
  assert.equal(sentBack.includes('traceparent'), false);
  assert.equal(sentBack.includes(traceId), false);
  const journal = readFileSync(path.join(world.root, 'launch-requests.json'), 'utf8');
  assert.equal(journal.includes(traceId), false);
  assert.equal(journal.includes('traceparent'), false);
});
