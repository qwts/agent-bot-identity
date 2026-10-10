import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';

import {
  COMMS_WATCH_MAX_BACKOFF_MS,
  COMMS_WATCH_MIN_BACKOFF_MS,
  CommsClient,
  checkBrokerCustody,
  commsPaths,
  createCommsSupervisor,
  daemonVouchKeyFile,
  ensureDaemonKeyPair,
  loadCommsCredential,
  nextCommsBackoffMs,
  pairDaemonComms,
  reportCommsWake,
  saveCommsCredential,
} from '../comms-client.mjs';

const roots = [];
const ME = userInfo().username;
const MY_UID = process.getuid();

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchWorld() {
  const root = mkdtempSync(path.join(tmpdir(), 'comms-client-'));
  roots.push(root);
  const shared = path.join(root, 'shared');
  const proofs = path.join(shared, 'pairing');
  mkdirSync(proofs, { recursive: true });
  chmodSync(proofs, 0o1777);
  const env = {
    AGENT_COMMS_SHARED_DIR: shared,
    XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_BOT_COMMS_DAEMON_PATH: path.join(root, 'comms-daemon.json'),
  };
  const socket = path.join(shared, 'broker.sock');
  return { root, shared, proofs, env, socket, paths: commsPaths({ env }) };
}

function testClient(world, { brokerUid = MY_UID } = {}) {
  return {
    client: new CommsClient({ socketPath: world.socket, brokerUid }),
    paths: world.paths,
  };
}

async function waitFor(predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the fake broker');
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

// Minimal NDJSON broker: one JSON line in, programmed lines out. Records
// every request line and every proof the client leaves behind.
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

test('comms paths follow AGENT_COMMS_SHARED_DIR', () => {
  const paths = commsPaths({ env: { AGENT_COMMS_SHARED_DIR: '/tmp/iso' } });
  assert.equal(paths.socket, '/tmp/iso/broker.sock');
  assert.equal(paths.proofs, '/tmp/iso/pairing');
});

test('a broker request is one v1 line and resolves with result', async () => {
  const world = scratchWorld();
  const broker = await startFakeBroker(world.socket, (line, { send }) => {
    assert.equal(line.v, 1);
    assert.match(line.id, /^[0-9a-f]+$/);
    assert.equal(line.op, 'ping');
    assert.deepEqual(line.auth, { daemon: 'worker', secret: 's3cret' });
    send({ v: 1, id: line.id, ok: true, pong: true });
  });
  try {
    const { client, paths } = testClient(world);
    const result = await client.request({ op: 'ping', auth: { daemon: 'worker', secret: 's3cret' } }, { paths });
    assert.deepEqual(result, { pong: true });
    assert.equal(broker.requests.length, 1);
  } finally {
    await broker.close();
  }
});

test('a broker refusal surfaces as a coded error', async () => {
  const world = scratchWorld();
  const broker = await startFakeBroker(world.socket, (line, { send }) => {
    send({ v: 1, id: line.id, ok: false, error: { code: 'not-approved', message: 'the owner has not approved this pairing yet' } });
  });
  try {
    const { client, paths } = testClient(world);
    await assert.rejects(
      client.request({ op: 'account-watch', auth: { daemon: 'worker', secret: 'nope' } }, { paths }),
      (error) => error.code === 'not-approved' && /not approved/.test(error.message),
    );
  } finally {
    await broker.close();
  }
});

test('custody refuses untrusted brokers before connecting', async () => {
  const world = scratchWorld();
  const broker = await startFakeBroker(world.socket, () => {});
  try {
    // A pinned uid that owns nothing here.
    const { client, paths } = testClient(world, { brokerUid: 60001 });
    await assert.rejects(client.request({ op: 'ping' }, { paths }), { code: 'broker-untrusted' });
    assert.equal(broker.requests.length, 0);

    // No socket at all.
    const missing = new CommsClient({ socketPath: path.join(world.root, 'absent.sock'), brokerUid: MY_UID });
    await assert.rejects(missing.request({ op: 'ping' }, { paths }), { code: 'broker-unreachable' });

    // A shared dir writable by other accounts.
    chmodSync(world.shared, 0o775);
    try {
      const { client: loose, paths: loosePaths } = testClient(world);
      await assert.rejects(loose.request({ op: 'ping' }, { paths: loosePaths }), { code: 'broker-untrusted' });
    } finally {
      chmodSync(world.shared, 0o755);
    }
  } finally {
    await broker.close();
  }
  assert.throws(() => checkBrokerCustody(world.paths, null), /no broker account is pinned/);
});

test('daemon pairing writes a proof file and persists the credential', async () => {
  const world = scratchWorld();
  let seenProofBody = null;
  let seenProofMode = null;
  const broker = await startFakeBroker(world.socket, (line, { send }) => {
    assert.equal(line.op, 'daemon-pair-request');
    assert.equal(line.account, 'worker-daemon');
    assert.match(line.secretHash, /^[0-9a-f]{64}$/);
    assert.match(line.proof, /^[0-9a-f]{32}\.proof$/);
    assert.ok(line.publicKey.includes('BEGIN PUBLIC KEY'));
    const proofFile = path.join(world.proofs, line.proof);
    seenProofBody = readFileSync(proofFile, 'utf8');
    seenProofMode = statSync(proofFile).mode & 0o777;
    assert.equal(seenProofBody, line.secretHash);
    send({ v: 1, id: line.id, ok: true, account: line.account, code: 'K7Q2XD', state: 'pending' });
  });
  try {
    const pairing = await pairDaemonComms({
      env: world.env,
      home: '/nonexistent',
      brokerAccount: ME,
      account: 'worker-daemon',
    });
    assert.deepEqual(pairing, { account: 'worker-daemon', brokerUid: MY_UID, code: 'K7Q2XD', state: 'pending' });

    // The proof carried sha256(secret) with wx creation and mode 0644, and
    // the client removed it after the reply.
    assert.match(seenProofBody, /^[0-9a-f]{64}$/);
    assert.equal(seenProofMode, 0o644);
    assert.deepEqual(readdirSync(world.proofs), []);

    // The credential persists at 0600 with the secret behind the proof hash.
    const credentialFile = world.env.AGENT_BOT_COMMS_DAEMON_PATH;
    assert.equal(statSync(credentialFile).mode & 0o777, 0o600);
    const credential = JSON.parse(readFileSync(credentialFile, 'utf8'));
    assert.equal(credential.account, 'worker-daemon');
    assert.equal(credential.brokerUid, MY_UID);
    assert.equal(typeof credential.secret, 'string');
    assert.ok(credential.secret.length > 0);
    assert.equal(createHash('sha256').update(credential.secret).digest('hex'), seenProofBody);
    assert.deepEqual(loadCommsCredential({ env: world.env, home: '/nonexistent' }), credential);

    // The vouch key file exists at 0600 for the sibling's signer.
    assert.equal(statSync(daemonVouchKeyFile({ env: world.env, home: '/nonexistent' })).mode & 0o777, 0o600);
    const again = ensureDaemonKeyPair({ env: world.env, home: '/nonexistent' });
    assert.ok(again.publicKeyPem.includes('BEGIN PUBLIC KEY'));
  } finally {
    await broker.close();
  }
});

test('the pairing proof is 0644 even under a restrictive umask', async () => {
  const world = scratchWorld();
  let seenProofMode = null;
  const broker = await startFakeBroker(world.socket, (line, { send }) => {
    seenProofMode = statSync(path.join(world.proofs, line.proof)).mode & 0o777;
    send({ v: 1, id: line.id, ok: true, account: line.account, code: 'K7Q2XD', state: 'pending' });
  });
  const previous = process.umask(0o077);
  try {
    await pairDaemonComms({ env: world.env, home: '/nonexistent', brokerAccount: ME, account: 'worker-daemon' });
  } finally {
    process.umask(previous);
    await broker.close();
  }
  assert.equal(seenProofMode, 0o644);
  assert.deepEqual(readdirSync(world.proofs), []);
});

test('saving the credential leaves no temp file and concurrent saves stay whole', () => {
  const world = scratchWorld();
  const file = world.env.AGENT_BOT_COMMS_DAEMON_PATH;
  for (const secret of ['first', 'second']) {
    saveCommsCredential(
      { account: 'worker', secret, brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z' },
      { env: world.env, home: '/nonexistent' },
    );
  }
  assert.equal(loadCommsCredential({ env: world.env, home: '/nonexistent' }).secret, 'second');
  assert.deepEqual(readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
});

test('the vouch key is reused, never replaced, and must be an owner-only Ed25519 key', () => {
  const world = scratchWorld();
  const options = { env: world.env, home: '/nonexistent' };
  const first = ensureDaemonKeyPair(options);
  const file = daemonVouchKeyFile(options);
  assert.equal(ensureDaemonKeyPair(options).publicKeyPem, first.publicKeyPem);

  // A loosened mode is tightened back to 0600 rather than advertised as is.
  chmodSync(file, 0o644);
  assert.equal(ensureDaemonKeyPair(options).publicKeyPem, first.publicKeyPem);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  // A key of the wrong type is refused and left in place, not rotated.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(file, rsa, { mode: 0o600 });
  assert.throws(() => ensureDaemonKeyPair(options), /not an Ed25519 PKCS#8 key/);
  assert.equal(readFileSync(file, 'utf8'), rsa);
});

test('pairing fails closed with an unknown broker account', async () => {
  const world = scratchWorld();
  await assert.rejects(
    pairDaemonComms({ env: world.env, home: '/nonexistent', brokerAccount: 'no-such-account-xyz' }),
    /no account named/,
  );
  assert.equal(existsSync(world.env.AGENT_BOT_COMMS_DAEMON_PATH), false);
});

test('missing and corrupt credentials read as unpaired, never as half a secret', async () => {
  const world = scratchWorld();
  assert.equal(loadCommsCredential({ env: world.env, home: '/nonexistent' }), null);
  const saved = saveCommsCredential(
    { account: 'worker', secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z' },
    { env: world.env, home: '/nonexistent' },
  );
  assert.equal(statSync(world.env.AGENT_BOT_COMMS_DAEMON_PATH).mode & 0o777, 0o600);
  assert.deepEqual(loadCommsCredential({ env: world.env, home: '/nonexistent' }), saved);
  writeFileSync(world.env.AGENT_BOT_COMMS_DAEMON_PATH, '{corrupt');
  assert.throws(() => loadCommsCredential({ env: world.env, home: '/nonexistent' }), /pair again/);
});

test('account-watch delivers wakes and the default handler answers waiting', async () => {
  const world = scratchWorld();
  const credential = saveCommsCredential(
    { account: 'worker', secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z' },
    { env: world.env, home: '/nonexistent' },
  );
  let watchAuth = null;
  let reportLine = null;
  const broker = await startFakeBroker(world.socket, (line, { send, socket }) => {
    if (line.op === 'account-watch') {
      watchAuth = line.auth;
      send({ event: 'ready' });
      send({
        event: 'wake', agentId: 'agent_11111111-1111-4111-8111-111111111111', count: 2, cursor: 7, messageIds: ['m1', 'm2'],
      });
      return;
    }
    if (line.op === 'wake-report') {
      reportLine = line;
      send({ v: 1, id: line.id, ok: true, recorded: true });
      socket.destroy();
    }
  });
  const supervisor = createCommsSupervisor({
    env: world.env,
    home: '/nonexistent',
    credential,
    paths: world.paths,
    sleepImpl: async () => {},
  });
  try {
    supervisor.start();
    await waitFor(() => supervisor.getState().connected);
    await waitFor(() => reportLine);
    assert.deepEqual(watchAuth, { daemon: 'worker', secret: 's3cret' });
    assert.equal(reportLine.op, 'wake-report');
    assert.deepEqual(reportLine.auth, { daemon: 'worker', secret: 's3cret' });
    assert.equal(reportLine.agentId, 'agent_11111111-1111-4111-8111-111111111111');
    assert.deepEqual(reportLine.messageIds, ['m1', 'm2']);
    assert.equal(reportLine.outcome, 'waiting');
    assert.equal(typeof reportLine.detail, 'string');
    const state = supervisor.getState();
    assert.equal(state.lastWake.agentId, 'agent_11111111-1111-4111-8111-111111111111');
    assert.deepEqual(state.lastWake.messageIds, ['m1', 'm2']);
    assert.ok(state.lastWakeAt);
  } finally {
    supervisor.stop();
    await broker.close();
  }
});

test('the watch reconnects with capped exponential backoff', async () => {
  const world = scratchWorld();
  const credential = {
    account: 'worker', secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z',
  };
  let connections = 0;
  const broker = await startFakeBroker(world.socket, (line, { send, socket }) => {
    if (line.op !== 'account-watch') return;
    connections += 1;
    send({ event: 'ready' });
    setTimeout(() => socket.destroy(), 20);
  });
  const sleeps = [];
  const supervisor = createCommsSupervisor({
    env: world.env,
    home: '/nonexistent',
    credential,
    paths: world.paths,
    onWake: async () => {},
    sleepImpl: async (ms) => { sleeps.push(ms); },
  });
  try {
    supervisor.start();
    await waitFor(() => connections >= 3);
    // Every connection reached `ready`, which resets the backoff to 1 s.
    assert.deepEqual(sleeps.slice(0, 2), [COMMS_WATCH_MIN_BACKOFF_MS, COMMS_WATCH_MIN_BACKOFF_MS]);
    assert.ok(supervisor.getState().reconnects >= 2);
  } finally {
    supervisor.stop();
    await broker.close();
  }
  assert.equal(nextCommsBackoffMs(COMMS_WATCH_MIN_BACKOFF_MS), 2 * COMMS_WATCH_MIN_BACKOFF_MS);
  assert.equal(nextCommsBackoffMs(16_000), COMMS_WATCH_MAX_BACKOFF_MS);
  assert.equal(nextCommsBackoffMs(COMMS_WATCH_MAX_BACKOFF_MS), COMMS_WATCH_MAX_BACKOFF_MS);
});

test('without a ready the reconnect delay doubles up to the cap', async () => {
  const world = scratchWorld();
  const credential = {
    account: 'worker', secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z',
  };
  let connections = 0;
  const broker = await startFakeBroker(world.socket, (line, { socket }) => {
    if (line.op !== 'account-watch') return;
    connections += 1;
    // Drop the connection before any event: the backoff must grow.
    socket.destroy();
  });
  const sleeps = [];
  const supervisor = createCommsSupervisor({
    env: world.env,
    home: '/nonexistent',
    credential,
    paths: world.paths,
    onWake: async () => {},
    sleepImpl: async (ms) => { sleeps.push(ms); },
  });
  try {
    supervisor.start();
    await waitFor(() => connections >= 3);
    assert.deepEqual(sleeps.slice(0, 2), [COMMS_WATCH_MIN_BACKOFF_MS, 2 * COMMS_WATCH_MIN_BACKOFF_MS]);
  } finally {
    supervisor.stop();
    await broker.close();
  }
});

test('wake reports are validated and framed with daemon auth', async () => {
  const world = scratchWorld();
  const credential = {
    account: 'worker', secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z',
  };
  await assert.rejects(
    reportCommsWake({ agentId: 'a', messageIds: ['m'], outcome: 'lukewarm' }, { credential, env: world.env }),
    /outcome must be one of warm, cold, waiting, failed/,
  );
  await assert.rejects(
    reportCommsWake({ agentId: 'a', messageIds: [], outcome: 'warm' }, { credential, env: world.env }),
    /at least one message ID/,
  );
  const broker = await startFakeBroker(world.socket, (line, { send }) => {
    assert.equal(line.op, 'wake-report');
    assert.deepEqual(line.auth, { daemon: 'worker', secret: 's3cret' });
    assert.equal(line.agentId, 'agent_22222222-2222-4222-8222-222222222222');
    assert.deepEqual(line.messageIds, ['m9']);
    assert.equal(line.outcome, 'cold');
    send({ v: 1, id: line.id, ok: true, recorded: true });
  });
  try {
    const result = await reportCommsWake(
      { agentId: 'agent_22222222-2222-4222-8222-222222222222', messageIds: ['m9'], outcome: 'cold', detail: 'woke' },
      { credential, env: world.env, home: '/nonexistent' },
    );
    assert.deepEqual(result, { recorded: true });
  } finally {
    await broker.close();
  }
});

test('an over-limit broker line fails the request instead of buffering forever', async () => {
  const world = scratchWorld();
  const broker = await startFakeBroker(world.socket, (line, { socket }) => {
    socket.write(`${'x'.repeat(200 * 1024)}\n`);
  });
  try {
    const { client, paths } = testClient(world);
    await assert.rejects(client.request({ op: 'ping' }, { paths }), /protocol limit/);
  } finally {
    await broker.close();
  }
});


test('private custody rejects loose directories, socket, wrong owner, and unknown mode', async () => {
  const world = scratchWorld();
  chmodSync(world.shared, 0o700);
  chmodSync(world.proofs, 0o700);
  const broker = await startFakeBroker(world.socket, () => {});
  chmodSync(world.socket, 0o600);
  try {
    checkBrokerCustody(world.paths, MY_UID, 'single-account');
    for (const [file, good, bad] of [
      [world.shared, 0o700, 0o750],
      [world.proofs, 0o700, 0o1777],
      [world.socket, 0o600, 0o660],
    ]) {
      chmodSync(file, bad);
      await assert.rejects(pairDaemonComms({ env: world.env }), { code: 'broker-untrusted' });
      chmodSync(file, good);
    }
    assert.throws(() => checkBrokerCustody(world.paths, MY_UID + 1, 'single-account'), /this account/);
    assert.throws(() => checkBrokerCustody(world.paths, MY_UID, 'unknown'), /unknown broker mode/);
    // Naming even our own account retains group mode's 1777 proof check.
    await assert.rejects(pairDaemonComms({ env: world.env, brokerAccount: ME }), /expected 1777/);
    assert.equal(broker.requests.length, 0);
    assert.equal(existsSync(world.env.AGENT_BOT_COMMS_DAEMON_PATH), false);
  } finally {
    await broker.close();
  }
});

test('credential mode round-trips, old credentials remain group, invalid modes fail closed', () => {
  const world = scratchWorld();
  const legacy = { account: ME, secret: 'test', brokerUid: MY_UID, pairedAt: '2026-10-01' };
  for (const mode of ['single-account', 'group']) {
    saveCommsCredential({ ...legacy, mode }, { env: world.env });
    assert.equal(loadCommsCredential({ env: world.env }).mode, mode);
  }
  assert.equal(saveCommsCredential(legacy, { env: world.env }).mode, 'group');
  writeFileSync(world.env.AGENT_BOT_COMMS_DAEMON_PATH, JSON.stringify(legacy));
  assert.equal(loadCommsCredential({ env: world.env }).mode, undefined);
  for (const mode of ['invalid', null, false]) {
    assert.throws(() => saveCommsCredential({ ...legacy, mode }, { env: world.env }), /pair again/);
    writeFileSync(world.env.AGENT_BOT_COMMS_DAEMON_PATH, JSON.stringify({ ...legacy, mode }));
    assert.throws(() => loadCommsCredential({ env: world.env }), /pair again/);
  }
});

test('account-watch routes launches and recovery with fresh daemon-authenticated result connections', async () => {
  const world = scratchWorld();
  const credential = { account: 'worker', secret: 's3cret', brokerUid: MY_UID, pairedAt: '2026-10-01T00:00:00.000Z' };
  const reports = [];
  let recovered = false;
  const onLaunch = async (event, { account, report }) => {
    assert.equal(account, 'worker');
    assert.equal(event.soul, 'soul');
    assert.equal(event.brief, 'Review this change.\nReport findings.');
    await report({ requestId: event.requestId, status: 'launched', agentId: 'soul' });
  };
  onLaunch.recover = async ({ report }) => {
    recovered = true;
    await report({ requestId: 'old', status: 'failed', agentId: null, detail: 'restarted' });
  };
  let watchSocket;
  const broker = await startFakeBroker(world.socket, (line, { send, socket }) => {
    if (line.op === 'account-watch') {
      watchSocket = socket;
      send({ event: 'ready' });
      send({ event: 'launch', requestId: 'new', principal: 'p', account: 'worker', soul: 'soul', harness: 'claude', brief: 'Review this change.\nReport findings.' });
    } else {
      assert.notEqual(socket, watchSocket);
      reports.push(line);
      send({ v: 1, id: line.id, ok: true });
    }
  });
  const supervisor = createCommsSupervisor({ env: world.env, credential, paths: world.paths, onLaunch });
  try {
    supervisor.start();
    await waitFor(() => reports.length === 2);
    assert.equal(recovered, true);
    for (const result of reports) {
      assert.equal(result.op, 'launch-result');
      assert.deepEqual(result.auth, { daemon: 'worker', secret: 's3cret' });
    }
    assert.equal(reports.find((r) => r.requestId === 'new').status, 'launched');
    assert.equal(reports.find((r) => r.requestId === 'old').agentId, null);
  } finally { supervisor.stop(); await broker.close(); }
});

test('launch-result rejects invalid correlation, status, and identity fields before connecting', async () => {
  const { reportCommsLaunch } = await import('../comms-client.mjs');
  for (const fields of [
    { requestId: '', status: 'failed' },
    { requestId: 'r', status: 'pending' },
    { requestId: 'r', status: 'launched' },
    { requestId: 'r', status: 'failed', agentId: 'a' },
    { requestId: 'r', status: 'failed', detail: 42 },
    { requestId: 'r', status: 'failed', code: 'bad_code' },
    { requestId: 'r', status: 'failed', code: 'a'.repeat(65) },
  ]) await assert.rejects(reportCommsLaunch(fields, {
    clientFactory: () => { throw new Error('must not connect'); },
  }), /invalid launch result/);

  const requests = [];
  const credential = { account: 'worker', secret: 'secret', brokerUid: 1, pairedAt: '2026-10-09T00:00:00.000Z' };
  await reportCommsLaunch({ requestId: 'r', status: 'failed', agentId: null, detail: 'failed', code: 'runtime-checksum-mismatch' }, {
    credential, paths: { socket: '/unused' },
    clientFactory: () => ({ request: (request) => { requests.push(request); return { ok: true }; } }),
  });
  assert.deepEqual(requests[0], { op: 'launch-result', auth: { daemon: 'worker', secret: 'secret' },
    requestId: 'r', status: 'failed', agentId: null, detail: 'failed', code: 'runtime-checksum-mismatch' });
});

test('launch-progress rejects a bad correlation or an unknown stage before connecting (#536)', async () => {
  const { reportCommsLaunchProgress, LAUNCH_STAGES } = await import('../comms-client.mjs');
  assert.deepEqual([...LAUNCH_STAGES], ['checking', 'account', 'runtimes', 'tool-home', 'provider', 'sign-in', 'joining', 'harness', 'session']);
  for (const fields of [
    { requestId: '', stage: 'account' },
    { requestId: 'r', stage: 'done' },
    { requestId: 'r', stage: 'unknown-stage' },
    { requestId: 'r' },
  ]) await assert.rejects(reportCommsLaunchProgress(fields, {
    clientFactory: () => { throw new Error('must not connect'); },
  }), /invalid launch progress/);
});
