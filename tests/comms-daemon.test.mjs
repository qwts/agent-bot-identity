import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDaemonServer, daemonStatus, runDaemon } from '../agent-daemon.mjs';
import { commsPaths, saveCommsCredential } from '../comms-client.mjs';

const DAEMON_CLI = fileURLToPath(new URL('../agent-daemon.mjs', import.meta.url));
const ME = userInfo().username;
const MY_UID = process.getuid();
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchWorld() {
  const root = mkdtempSync(path.join(tmpdir(), 'comms-daemon-'));
  roots.push(root);
  const shared = path.join(root, 'shared');
  mkdirSync(path.join(shared, 'pairing'), { recursive: true });
  chmodSync(path.join(shared, 'pairing'), 0o1777);
  const env = {
    XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(root, 'daemon.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_COMMS_SHARED_DIR: shared,
    AGENT_BOT_COMMS_DAEMON_PATH: path.join(root, 'comms-daemon.json'),
  };
  return { root, shared, env, socket: path.join(shared, 'broker.sock') };
}

async function waitFor(predicate, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the fake broker');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

function startFakeBroker(socketPath, onLine) {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!raw) continue;
        const line = JSON.parse(raw);
        requests.push(line);
        onLine(line, {
          send: (value) => socket.write(`${JSON.stringify(value)}\n`),
          socket,
          requests,
        });
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve({
      server,
      requests,
      async close() {
        for (const socket of sockets) socket.destroy();
        await new Promise((done) => { server.close(done); });
      },
    }));
  });
}

function childEnv(world) {
  return { ...process.env, ...world.env };
}

// Async spawn: the fake broker and the daemon under test live in this
// process, so the event loop must stay alive while the CLI child runs.
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DAEMON_CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('pair-comms pairs against a fake broker and prints the owner code', async () => {
  const world = scratchWorld();
  const broker = await startFakeBroker(world.socket, (line, { send }) => {
    assert.equal(line.op, 'daemon-pair-request');
    send({ v: 1, id: line.id, ok: true, account: line.account, code: 'OWNER1', state: 'pending' });
  });
  try {
    const run = await runCli(['pair-comms', '--broker', ME], childEnv(world));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /owner approval code: OWNER1/);
    assert.match(run.stdout, new RegExp(`daemon pairing requested for account '${ME}'`));
    assert.equal(statSync(world.env.AGENT_BOT_COMMS_DAEMON_PATH).mode & 0o777, 0o600);
    const credential = JSON.parse(readFileSync(world.env.AGENT_BOT_COMMS_DAEMON_PATH, 'utf8'));
    assert.equal(credential.account, ME);
    assert.equal(credential.brokerUid, MY_UID);
  } finally {
    await broker.close();
  }
});

test('pair-comms without --broker prints usage and pairs nothing', async () => {
  const world = scratchWorld();
  const run = await runCli(['pair-comms'], childEnv(world));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /usage: agent-bot daemon pair-comms --broker <account>/);
  assert.equal(existsSync(world.env.AGENT_BOT_COMMS_DAEMON_PATH), false);
});

test('GET /v0/comms/status reports pairing and live watch state', async () => {
  const world = scratchWorld();
  saveCommsCredential(
    { account: ME, secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z' },
    { env: world.env, home: '/nonexistent' },
  );
  const live = {
    connected: true,
    lastWakeAt: '2026-10-01T01:00:00.000Z',
    lastWake: { agentId: 'agent_x', count: 1, cursor: 3, messageIds: ['m1'] },
    lastError: null,
    reconnects: 1,
  };
  const server = createDaemonServer({ env: world.env, home: '/nonexistent', config: {}, comms: { getState: () => live } });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v0/comms/status`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.comms.paired, true);
    assert.equal(body.comms.account, ME);
    assert.equal(body.comms.connected, true);
    assert.equal(body.comms.lastWakeAt, '2026-10-01T01:00:00.000Z');

    const anonymous = await fetch(`http://127.0.0.1:${server.address().port}/v0/comms/status`);
    assert.equal(anonymous.status, 401);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

test('daemonStatus merges live comms state, and unpaired daemons report unpaired', async () => {
  const world = scratchWorld();
  const plain = await daemonStatus({ env: world.env, home: '/nonexistent' });
  assert.equal(plain.running, false);
  assert.equal(plain.comms.paired, false);

  saveCommsCredential(
    { account: ME, secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z' },
    { env: world.env, home: '/nonexistent' },
  );
  const server = createDaemonServer({
    env: world.env,
    home: '/nonexistent',
    config: {},
    comms: { getState: () => ({ connected: true, lastWakeAt: null, lastWake: null, lastError: null, reconnects: 0 }) },
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(world.env.AGENT_BOT_DAEMON_STATE_PATH, JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    host: '127.0.0.1',
    port: server.address().port,
    token: server.token,
    startedAt: '2026-10-01T00:00:00.000Z',
  }));
  try {
    const status = await daemonStatus({ env: world.env, home: '/nonexistent' });
    assert.equal(status.running, true);
    assert.equal(status.comms.paired, true);
    assert.equal(status.comms.account, ME);
    assert.equal(status.comms.connected, true);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

test('runDaemon opens account-watch when a credential exists and status shows it', async () => {
  const world = scratchWorld();
  saveCommsCredential(
    { account: ME, secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z' },
    { env: world.env, home: '/nonexistent' },
  );
  let watchSeen = null;
  let reportSeen = null;
  const broker = await startFakeBroker(world.socket, (line, { send }) => {
    if (line.op === 'account-watch') {
      watchSeen = line;
      assert.deepEqual(line.auth, { daemon: ME, secret: 's3cret' });
      send({ event: 'ready' });
      send({
        event: 'wake', agentId: 'agent_33333333-3333-4333-8333-333333333333', count: 1, cursor: 9, messageIds: ['mw1'],
      });
      return;
    }
    if (line.op === 'wake-report') {
      reportSeen = line;
      send({ v: 1, id: line.id, ok: true, recorded: true });
    }
  });
  const { server, comms } = await runDaemon({ env: childEnv(world), home: '/nonexistent', port: 0 });
  try {
    await waitFor(() => watchSeen);
    await waitFor(() => reportSeen);
    assert.equal(reportSeen.outcome, 'waiting');
    assert.deepEqual(reportSeen.messageIds, ['mw1']);
    assert.ok(comms.getState().connected);

    const status = await runCli(['status'], childEnv(world));
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /running \(pid \d+, port \d+/);
    assert.match(status.stdout, new RegExp(`comms: paired as ${ME}, account-watch connected`));

    const asJson = await runCli(['status', '--json'], childEnv(world));
    assert.equal(asJson.status, 0, asJson.stderr);
    const parsed = JSON.parse(asJson.stdout);
    assert.equal(parsed.comms.paired, true);
    assert.equal(parsed.comms.connected, true);
    assert.equal(parsed.comms.lastWake.messageIds[0], 'mw1');
  } finally {
    comms.stop();
    await new Promise((resolve) => { server.close(resolve); });
    rmSync(world.env.AGENT_BOT_DAEMON_STATE_PATH, { force: true });
    await broker.close();
  }
  assert.deepEqual(commsPaths({ env: world.env }).socket, world.socket);
});

test('runDaemon delivers a broker wake to the soul\'s warm socket and reports warm', async () => {
  const world = scratchWorld();
  saveCommsCredential(
    { account: ME, secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z' },
    { env: world.env, home: '/nonexistent' },
  );
  const agentId = 'agent_44444444-4444-4444-8444-444444444444';
  let wakeStream = null;
  const reports = [];
  const broker = await startFakeBroker(world.socket, (line, { send }) => {
    if (line.op === 'account-watch') {
      send({ event: 'ready' });
      wakeStream = send;
      return;
    }
    if (line.op === 'wake-report') {
      reports.push(line);
      send({ v: 1, id: line.id, ok: true, recorded: true });
    }
  });
  const { server, comms } = await runDaemon({ env: childEnv(world), home: '/nonexistent', port: 0, config: {} });
  const worktree = path.join(world.root, 'tree');
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', worktree]);
  const secret = server.bindings.bind({ agentId, worktree, gitDir: path.join(worktree, '.git') });
  const socket = net.connect(server.address().port, '127.0.0.1');
  let frames = '';
  socket.on('data', (chunk) => { frames += chunk.toString('latin1'); });
  try {
    await new Promise((resolve) => { socket.once('connect', resolve); });
    socket.write(`GET /v0/wake HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nx-agent-binding: ${secret}\r\n\r\n`);
    await waitFor(() => server.warmPool.has(agentId));
    await waitFor(() => wakeStream);
    wakeStream({ event: 'wake', agentId, count: 2, cursor: 11, messageIds: ['mw2', 'mw3'] });
    await waitFor(() => reports.length > 0);
    assert.equal(reports[0].outcome, 'warm');
    assert.deepEqual(reports[0].messageIds, ['mw2', 'mw3']);
    assert.match(frames, /"event":"wake"/);
    assert.match(frames, /mw2/);

    // A soul with no warm socket waits: cold wake is off and no executor runs.
    wakeStream({ event: 'wake', agentId: 'agent_55555555-5555-4555-8555-555555555555', count: 1, cursor: 12, messageIds: ['mw4'] });
    await waitFor(() => reports.length > 1);
    assert.equal(reports[1].outcome, 'waiting');
  } finally {
    socket.end();
    await waitFor(() => !server.warmPool.has(agentId));
    comms.stop();
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    rmSync(world.env.AGENT_BOT_DAEMON_STATE_PATH, { force: true });
    await broker.close();
  }
});
