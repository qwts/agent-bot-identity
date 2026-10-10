import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import {
  CommsClient, checkBrokerCustody, commsPaths, loadCommsCredential, pairDaemonComms,
  reportCommsLaunch, reportCommsLaunchProgress, reportCommsWake, saveCommsCredential,
} from '../comms-client.mjs';
import {
  createWindowsCommsTransport, readWindowsBrokerPin, windowsHandshakeMessage, windowsPipeName,
} from '../comms-windows.mjs';

const SID = 'S-1-5-21-111-222-333-1001';
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(path.join(tmpdir(), 'comms-windows-'));
  roots.push(root);
  const shared = path.join(root, 'shared');
  const proofs = path.join(shared, 'pairing');
  const brokerState = path.join(root, 'broker-state');
  mkdirSync(proofs, { recursive: true });
  mkdirSync(brokerState, { recursive: true });
  const env = {
    AGENT_COMMS_SHARED_DIR: shared,
    AGENT_COMMS_BROKER_STATE_DIR: brokerState,
    AGENT_BOT_COMMS_DAEMON_PATH: path.join(root, 'daemon.json'),
  };
  return { root, shared, proofs, brokerState, env, paths: commsPaths({ env }) };
}

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    brokerKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    vouchPublicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function fakeCustody() {
  const checked = [];
  return {
    checked,
    currentSid: () => SID,
    assertOwnedDirectory(file, sid) { assert.equal(sid, SID); assert.ok(statSync(file).isDirectory()); checked.push(['directory', file]); },
    assertOwnedFile(file, sid) { assert.equal(sid, SID); assert.ok(statSync(file).isFile()); checked.push(['file', file]); },
    restrictPrivateFile(file, sid) {
      assert.equal(sid, SID);
      assert.ok(statSync(file).isFile());
      assert.equal(readFileSync(file, 'utf8'), '', 'private file must be empty until its ACL is restricted');
      checked.push(['restrict', file]);
    },
  };
}

function writeIdentity(w, brokerKey) {
  writeFileSync(path.join(w.brokerState, 'identity.json'), JSON.stringify({ v: 1, algorithm: 'ed25519', publicKey: brokerKey }));
}

async function brokerHarness(privateKey, { proof = null, onRequest = null } = {}) {
  const requests = [];
  const hellos = [];
  const sockets = new Set();
  let pipe;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let handshaken = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!raw) continue;
        const line = JSON.parse(raw);
        if (!handshaken) {
          hellos.push(line);
          handshaken = true;
          const response = proof
            ? proof(line)
            : `${JSON.stringify({ v: 1, proof: sign(null, windowsHandshakeMessage(pipe, line.hello), privateKey).toString('base64') })}\n`;
          socket.write(response);
          continue;
        }
        requests.push(line);
        if (onRequest) onRequest(line, socket);
        else socket.write(`${JSON.stringify({ v: 1, id: line.id, ok: true, accepted: line.op })}\n`);
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  pipe = windowsPipeName('dev.qwts.agent-comms.broker', SID);
  return {
    requests, hellos, pipe,
    createConnection(name) {
      assert.equal(name, pipe);
      return net.createConnection({ host: '127.0.0.1', port: address.port });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('Windows pairing pins identity.json key and persists the SID/key for later operations', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  assert.equal(loadCommsCredential({ env: w.env, home: w.root, platform: 'win32', windowsCustody: custody }), null);
  assert.equal(custody.checked.length, 0);
  const broker = await brokerHarness(k.privateKey);
  try {
    // Inject the daemon vouch key only to isolate broker transport; this does
    // not claim the default Windows vouch-key custody path is supported.
    const paired = await pairDaemonComms({
      env: w.env, home: w.root, account: userInfo().username, publicKey: k.vouchPublicKey,
      paths: w.paths, platform: 'win32', windowsCustody: custody,
      windowsCreateConnection: broker.createConnection,
    });
    assert.equal(paired.brokerUid, SID);
    assert.equal(broker.hellos.length, 1);
    assert.equal(broker.requests[0].op, 'daemon-pair-request');
    assert.equal(broker.requests[0].account, userInfo().username);
    assert.equal(broker.requests[0].publicKey, k.vouchPublicKey);
    const credential = loadCommsCredential({ env: w.env, home: w.root, platform: 'win32', windowsCustody: custody });
    assert.equal(credential.brokerUid, SID);
    assert.equal(credential.brokerKey, k.brokerKey);
    assert.equal(credential.mode, 'single-account');
    assert.equal(JSON.parse(readFileSync(w.env.AGENT_BOT_COMMS_DAEMON_PATH, 'utf8')).brokerKey, k.brokerKey);
    await reportCommsWake({ agentId: 'agent-1', messageIds: ['m1'], outcome: 'waiting' }, {
      env: w.env, home: w.root, paths: w.paths, platform: 'win32', windowsCustody: custody,
      windowsCreateConnection: broker.createConnection,
    });
    assert.deepEqual(broker.requests.map(({ op }) => op), ['daemon-pair-request', 'wake-report']);
    assert.ok(custody.checked.some(([kind]) => kind === 'restrict'));
  } finally {
    await broker.close();
  }
});

test('Windows pairing requires the broker host shared-directory override', async () => {
  const w = world();
  const missingShared = { ...w.env };
  delete missingShared.AGENT_COMMS_SHARED_DIR;
  await assert.rejects(pairDaemonComms({ env: missingShared, home: w.root, platform: 'win32',
    windowsCustody: fakeCustody(), publicKey: keys().vouchPublicKey }),
  { code: 'usage' });
});

test('saved Windows credentials drive wake and launch operations through the same pinned handshake', async () => {
  const w = world();
  const k = keys();
  const credential = {
    account: 'worker', secret: 'daemon-secret', brokerUid: SID, brokerKey: k.brokerKey,
    mode: 'single-account', pairedAt: '2026-10-10T00:00:00.000Z',
  };
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  saveCommsCredential(credential, { env: w.env, home: w.root, platform: 'win32', windowsCustody: custody });
  const broker = await brokerHarness(k.privateKey);
  try {
    const clientFactory = (options) => new CommsClient({ ...options,
      windowsCustody: custody, windowsCreateConnection: broker.createConnection });
    const reportOptions = { env: w.env, home: w.root, paths: w.paths, platform: 'win32', windowsCustody: custody,
      windowsCreateConnection: broker.createConnection, clientFactory };
    await reportCommsWake({ agentId: 'agent-1', messageIds: ['m1'], outcome: 'waiting' }, reportOptions);
    await reportCommsLaunchProgress({ requestId: 'launch-1', stage: 'provider' }, reportOptions);
    await reportCommsLaunch({ requestId: 'launch-1', status: 'launched', agentId: 'agent-1' }, reportOptions);
    assert.deepEqual(broker.requests.map(({ op }) => op), ['wake-report', 'launch-progress', 'launch-result']);
    assert.ok(broker.requests.every((request) => request.auth?.secret === 'daemon-secret'));
    assert.equal(broker.hellos.length, 3);
  } finally {
    await broker.close();
  }
});

test('watch abort after verified hello keeps the authenticated stream behavior', async () => {
  const w = world();
  const k = keys();
  const custody = fakeCustody();
  writeIdentity(w, k.brokerKey);
  const events = [];
  const broker = await brokerHarness(k.privateKey, {
    onRequest(line, socket) {
      socket.write(`${JSON.stringify({ event: 'ready' })}\n`);
      socket.write(`${JSON.stringify({ event: 'wake', agentId: 'agent-1', messageIds: ['m1'] })}\n`);
    },
  });
  try {
    const client = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: k.brokerKey,
      mode: 'single-account', platform: 'win32', serviceLabel: w.paths.serviceLabel,
      windowsCustody: custody, windowsCreateConnection: broker.createConnection });
    const abort = new AbortController();
    const stream = client.stream({ op: 'account-watch', auth: { daemon: 'worker', secret: 'daemon-secret' } },
      (event) => { events.push(event); if (event.event === 'wake') abort.abort(); },
      { paths: w.paths, signal: abort.signal });
    await stream;
    assert.deepEqual(events.map(({ event }) => event), ['ready', 'wake']);
    assert.equal(broker.requests[0].op, 'account-watch');
    assert.equal(broker.requests[0].auth.secret, 'daemon-secret');
  } finally {
    await broker.close();
  }
});

test('aborting a watch before broker proof sends no daemon request', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  const broker = await brokerHarness(k.privateKey, { proof: () => '' });
  try {
    const client = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: k.brokerKey,
      mode: 'single-account', platform: 'win32', serviceLabel: w.paths.serviceLabel,
      windowsCustody: custody, windowsCreateConnection: broker.createConnection });
    const abort = new AbortController();
    const stream = client.stream({ op: 'account-watch', auth: { daemon: 'worker', secret: 'do-not-send' } }, () => {},
      { paths: w.paths, signal: abort.signal });
    const deadline = Date.now() + 1000;
    while (broker.hellos.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(broker.hellos.length, 1);
    abort.abort();
    await stream;
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});

test('unary deadline includes a silent Windows handshake and sends no request', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  const broker = await brokerHarness(k.privateKey, { proof: () => '' });
  try {
    const client = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: k.brokerKey,
      mode: 'single-account', platform: 'win32', serviceLabel: w.paths.serviceLabel,
      brokerStateDir: w.brokerState, timeoutMs: 30, handshakeTimeoutMs: 1000,
      windowsCustody: custody, windowsCreateConnection: broker.createConnection });
    await assert.rejects(client.request({ op: 'wake-report', auth: { daemon: 'worker', secret: 'never-send' } }),
      { code: 'broker-timeout' });
    assert.equal(broker.hellos.length, 1);
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});

test('watch has a bounded handshake deadline but no deadline after verification', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  const broker = await brokerHarness(k.privateKey, { proof: () => '' });
  try {
    const client = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: k.brokerKey,
      mode: 'single-account', platform: 'win32', serviceLabel: w.paths.serviceLabel,
      brokerStateDir: w.brokerState, handshakeTimeoutMs: 25,
      windowsCustody: custody, windowsCreateConnection: broker.createConnection });
    await assert.rejects(client.stream({ op: 'account-watch', auth: { daemon: 'worker', secret: 'never-send' } }, () => {}),
      { code: 'broker-timeout' });
    assert.equal(broker.hellos.length, 1);
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});

test('verified watch remains open beyond its handshake deadline', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  const broker = await brokerHarness(k.privateKey, {
    onRequest(_line, socket) { socket.write(`${JSON.stringify({ event: 'ready' })}\n`); },
  });
  try {
    const client = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: k.brokerKey,
      mode: 'single-account', platform: 'win32', serviceLabel: w.paths.serviceLabel,
      brokerStateDir: w.brokerState, handshakeTimeoutMs: 25,
      windowsCustody: custody, windowsCreateConnection: broker.createConnection });
    const abort = new AbortController();
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const stream = client.stream({ op: 'account-watch', auth: { daemon: 'worker', secret: 'daemon-secret' } },
      (event) => { if (event.event === 'ready') resolveReady(); }, { signal: abort.signal });
    await ready;
    const state = await Promise.race([
      stream.then(() => 'closed', () => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('open'), 60)),
    ]);
    assert.equal(state, 'open');
    assert.equal(broker.requests.length, 1);
    abort.abort();
    await stream;
  } finally {
    await broker.close();
  }
});

test('constructor brokerStateDir is used for custody and connection without per-request paths', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  const broker = await brokerHarness(k.privateKey);
  try {
    const client = new CommsClient({ socketPath: 'unused-on-windows', brokerUid: SID, brokerKey: k.brokerKey,
      mode: 'single-account', platform: 'win32', serviceLabel: w.paths.serviceLabel,
      brokerStateDir: w.brokerState, windowsCustody: custody,
      windowsCreateConnection: broker.createConnection });
    const result = await client.request({ op: 'ping' });
    assert.equal(result.accepted, 'ping');
    assert.ok(custody.checked.some(([kind, file]) => kind === 'directory' && file === w.brokerState));
    assert.ok(custody.checked.some(([kind, file]) => kind === 'file' && file === path.join(w.brokerState, 'identity.json')));
    const hostState = path.resolve(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'agent-comms-broker');
    assert.ok(custody.checked.every(([, file]) => !file.startsWith(hostState)));
  } finally {
    await broker.close();
  }
});

test('verified transport preserves bytes coalesced after the proof and flushes queued writes', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  const broker = await brokerHarness(k.privateKey, { proof: (hello) => `${JSON.stringify({
    v: 1, proof: sign(null, windowsHandshakeMessage(broker.pipe, hello.hello), k.privateKey).toString('base64'),
  })}\nTAIL` });
  const channel = createWindowsCommsTransport({
    label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
    custody, createConnection: broker.createConnection,
  });
  let response = '';
  channel.on('data', (chunk) => { response += chunk.toString(); });
  try {
    const connected = new Promise((resolve) => channel.once('connect', resolve));
    channel.write(`${JSON.stringify({ v: 1, id: 'queued', op: 'ping' })}\n`);
    await connected;
    const deadline = Date.now() + 1000;
    while (broker.requests.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(broker.requests[0].id, 'queued');
    const responseDeadline = Date.now() + 1000;
    while (!response.includes('accepted') && Date.now() < responseDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(response, /^TAIL/);
    assert.match(response, /"accepted":"ping"/);
  } finally {
    channel.destroy();
    await broker.close();
  }
});

test('wrong broker proof, missing pin, invalid SID, and group mode fail before credentials', async () => {
  const w = world();
  const trusted = keys();
  const impostor = keys();
  const custody = fakeCustody();
  writeIdentity(w, trusted.brokerKey);
  const broker = await brokerHarness(trusted.privateKey);
  try {
    const wrong = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: impostor.brokerKey,
      mode: 'single-account', platform: 'win32', windowsCustody: custody,
      windowsCreateConnection: broker.createConnection });
    await assert.rejects(wrong.request({ op: 'wake-report', auth: { daemon: 'worker', secret: 'never-send' } }, { paths: w.paths }),
      (error) => error.code === 'broker-untrusted');
    assert.equal(broker.requests.length, 0);
    assert.equal(broker.hellos.length, 1);

    const noPin = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, mode: 'single-account',
      platform: 'win32', windowsCustody: custody, windowsCreateConnection: broker.createConnection });
    await assert.rejects(noPin.request({ op: 'ping' }, { paths: w.paths }), { code: 'broker-untrusted' });
    assert.equal(broker.hellos.length, 1);

    const wrongSid = new CommsClient({ socketPath: w.paths.socket, brokerUid: 'S-1-5-21-1-2-3-4',
      brokerKey: trusted.brokerKey, mode: 'single-account', platform: 'win32', windowsCustody: custody,
      windowsCreateConnection: broker.createConnection });
    await assert.rejects(wrongSid.request({ op: 'ping' }, { paths: w.paths }), { code: 'broker-untrusted' });
    const group = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: trusted.brokerKey,
      mode: 'group', platform: 'win32', windowsCustody: custody, windowsCreateConnection: broker.createConnection });
    await assert.rejects(group.request({ op: 'ping' }, { paths: w.paths }), { code: 'platform-not-implemented' });
    const legacy = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: trusted.brokerKey,
      platform: 'win32', windowsCustody: custody, windowsCreateConnection: broker.createConnection });
    await assert.rejects(legacy.request({ op: 'ping' }, { paths: w.paths }), { code: 'platform-not-implemented' });
    const invalidPin = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: 'not-a-public-key',
      mode: 'single-account', platform: 'win32', windowsCustody: custody,
      windowsCreateConnection: broker.createConnection });
    await assert.rejects(invalidPin.request({ op: 'ping' }, { paths: w.paths }), { code: 'broker-untrusted' });
    assert.equal(broker.hellos.length, 1);
  } finally {
    await broker.close();
  }
});

test('truncated, malformed, and oversized proofs never release the queued request', async () => {
  const w = world();
  const k = keys();
  const custody = fakeCustody();
  writeIdentity(w, k.brokerKey);
  let responseKind = 0;
  const broker = await brokerHarness(k.privateKey, { proof: () => {
    if (responseKind === 0) return '{"v":1,"proof":"';
    if (responseKind === 1) return 'not-json\n';
    return `${'x'.repeat(128 * 1024 + 1)}\n`;
  } });
  try {
    const client = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: k.brokerKey,
      mode: 'single-account', platform: 'win32', windowsCustody: custody,
      windowsCreateConnection: broker.createConnection, handshakeTimeoutMs: 25 });
    await assert.rejects(client.request({ op: 'ping' }, { paths: w.paths }), { code: 'broker-timeout' });
    responseKind = 1;
    await assert.rejects(client.request({ op: 'ping' }, { paths: w.paths }), { code: 'broker-untrusted' });
    responseKind = 2;
    await assert.rejects(client.request({ op: 'ping' }, { paths: w.paths }), { code: 'bad-response' });
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});

test('broker identity pin is read only after its state directory and file custody checks', () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  assert.equal(readWindowsBrokerPin({ brokerStateDir: w.brokerState, brokerUid: SID, custody }), k.brokerKey);
  assert.deepEqual(custody.checked.map(([kind]) => kind), ['directory', 'file']);
  checkBrokerCustody(w.paths, SID, 'single-account', { platform: 'win32', windowsCustody: custody });
  assert.throws(() => readWindowsBrokerPin({ brokerStateDir: w.brokerState, brokerUid: userInfo().username, custody }),
    { code: 'broker-untrusted' });
  rmSync(path.join(w.brokerState, 'identity.json'));
  assert.throws(() => checkBrokerCustody(w.paths, SID, 'single-account', { platform: 'win32', windowsCustody: custody }),
    { code: 'broker-untrusted' });
});
