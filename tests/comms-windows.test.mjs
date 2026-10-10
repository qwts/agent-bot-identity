import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import {
  CommsClient, checkBrokerCustody, commsPaths, loadCommsCredential, pairDaemonComms,
  reportCommsLaunch, reportCommsLaunchProgress, reportCommsWake, saveCommsCredential,
} from '../comms-client.mjs';
import {
  createWindowsCommsTransport, isWindowsRelayFailure, readWindowsBrokerPin, windowsHandshakeMessage, windowsPipeName,
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

function fakeCustody({ foreignDirectories = [], failPrivateCreation = false, onPrivateCreateFailure = null } = {}) {
  const checked = [];
  const foreign = new Set(foreignDirectories);
  return {
    checked,
    currentSid: () => SID,
    assertOwnedDirectory(file, sid) { assert.equal(sid, SID); assert.ok(statSync(file).isDirectory()); checked.push(['directory', file]); },
    assertOwnedFile(file, sid) { assert.equal(sid, SID); assert.ok(statSync(file).isFile()); checked.push(['file', file]); },
    createOwnedDirectory(file, sid) {
      assert.equal(sid, SID);
      if (foreign.has(file)) throw new Error('refuse existing foreign directory');
      if (!existsSync(file)) mkdirSync(file);
      assert.ok(statSync(file).isDirectory());
      checked.push(['owned-directory', file]);
    },
    createPrivateFile(file, sid) {
      assert.equal(sid, SID);
      if (failPrivateCreation) {
        onPrivateCreateFailure?.(file);
        throw Object.assign(new Error('refuse private file creation'), { code: 'EEXIST' });
      }
      writeFileSync(file, '', { flag: 'wx' });
      assert.ok(statSync(file).isFile());
      assert.equal(readFileSync(file, 'utf8'), '', 'private file must be empty until creation returns');
      checked.push(['private-file', file]);
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
    assert.ok(custody.checked.some(([kind]) => kind === 'private-file'));
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

test('Windows credential save refuses an existing foreign state directory without adopting it', () => {
  const w = world();
  const foreignDir = path.join(w.root, 'foreign-state');
  mkdirSync(foreignDir);
  const marker = path.join(foreignDir, 'keep.txt');
  writeFileSync(marker, 'foreign owner data');
  const env = { ...w.env, AGENT_BOT_COMMS_DAEMON_PATH: path.join(foreignDir, 'daemon.json') };
  const custody = fakeCustody({ foreignDirectories: [foreignDir] });
  const credential = { account: 'worker', secret: 'must-not-write', brokerUid: SID,
    brokerKey: keys().brokerKey, mode: 'single-account', pairedAt: '2026-10-10T00:00:00Z' };
  assert.throws(() => saveCommsCredential(credential, { env, home: w.root, platform: 'win32', windowsCustody: custody }),
    { code: 'broker-untrusted' });
  assert.equal(readFileSync(marker, 'utf8'), 'foreign owner data');
  assert.deepEqual(readdirSync(foreignDir), ['keep.txt']);
  assert.ok(!readFileSync(marker, 'utf8').includes(credential.secret));
});

test('Windows credential and proof creation failures write no secret and preserve collisions', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const credential = { account: 'worker', secret: 'must-not-write', brokerUid: SID,
    brokerKey: k.brokerKey, mode: 'single-account', pairedAt: '2026-10-10T00:00:00Z' };
  const credentialCustody = fakeCustody({ failPrivateCreation: true });
  assert.throws(() => saveCommsCredential(credential, {
    env: w.env, home: w.root, platform: 'win32', windowsCustody: credentialCustody,
  }), { code: 'EEXIST' });
  assert.deepEqual(readdirSync(w.root).sort(), ['broker-state', 'shared']);

  const proofCustody = fakeCustody({
    failPrivateCreation: true,
    onPrivateCreateFailure(file) { writeFileSync(file, 'existing collision', { flag: 'wx' }); },
  });
  await assert.rejects(pairDaemonComms({
    env: w.env, home: w.root, account: 'worker', publicKey: k.vouchPublicKey,
    paths: w.paths, platform: 'win32', windowsCustody: proofCustody,
    windowsCreateConnection() { throw new Error('must not connect'); },
  }), { code: 'EEXIST' });
  const proofFiles = readdirSync(w.proofs);
  assert.equal(proofFiles.length, 1);
  assert.equal(readFileSync(path.join(w.proofs, proofFiles[0]), 'utf8'), 'existing collision');
  assert.ok(!readFileSync(path.join(w.proofs, proofFiles[0]), 'utf8').includes(credential.secret));
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

test('verified watch observes broker EOF and can reconnect without an abort', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const broker = await brokerHarness(k.privateKey, {
    onRequest(_line, socket) {
      socket.write(`${JSON.stringify({ ok: true })}\n`);
      setTimeout(() => socket.end(), 10);
    },
  });
  try {
    const client = new CommsClient({ socketPath: w.paths.socket, brokerUid: SID, brokerKey: k.brokerKey,
      mode: 'single-account', platform: 'win32', serviceLabel: w.paths.serviceLabel,
      brokerStateDir: w.brokerState, windowsCustody: fakeCustody(), windowsCreateConnection: broker.createConnection });
    await assert.rejects(client.stream({ op: 'account-watch' }, () => {}), { code: 'broker-unreachable' });
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

test('default Windows relay explicitly limits pipe-server impersonation and relays bytes', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const custody = fakeCustody();
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  let spawnCall;
  let seen = '';
  let handshaken = false;
  let request;
  child.stdin.on('data', (chunk) => {
    seen += chunk.toString('utf8');
    let newline;
    while ((newline = seen.indexOf('\n')) !== -1) {
      const line = JSON.parse(seen.slice(0, newline));
      seen = seen.slice(newline + 1);
      if (!handshaken) {
        handshaken = true;
        child.stdout.write(`${JSON.stringify({ v: 1, proof: sign(
          null, windowsHandshakeMessage(windowsPipeName(w.paths.serviceLabel, SID), line.hello), k.privateKey,
        ).toString('base64') })}\n`);
      } else {
        request = line;
        child.stdout.end(`${JSON.stringify({ v: 1, id: line.id, ok: true, accepted: line.op })}\n`);
        process.nextTick(() => { child.exitCode = 0; child.emit('exit', 0, null); });
      }
    }
  });
  child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true; };
  const env = { PATH: 'C:\\Windows\\System32', PSModulePath: 'C:\\pwsh7\\Modules', pSmOdUlEpAtH: 'C:\\other' };
  const originalEnv = { ...env };
  const channel = createWindowsCommsTransport({
    label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
    custody, handshakeTimeoutMs: 500, env,
    spawnProcess(file, args, options) {
      spawnCall = { file, args, options };
      process.nextTick(() => child.stderr.write('AGENT_COMMS_PIPE_READY\n'));
      return child;
    },
  });
  const result = new Promise((resolve, reject) => {
    channel.on('error', reject);
    channel.on('data', (chunk) => {
      const line = JSON.parse(chunk.toString('utf8'));
      if (line.accepted) resolve(line);
    });
    channel.once('connect', () => channel.write(`${JSON.stringify({ v: 1, id: 'relay-test', op: 'wake-report' })}\n`));
  });
  try {
    assert.deepEqual(await result, { v: 1, id: 'relay-test', ok: true, accepted: 'wake-report' });
    assert.equal(request.op, 'wake-report');
    assert.equal(spawnCall.file, 'powershell.exe');
    assert.deepEqual(spawnCall.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(spawnCall.options.env.PSModulePath, undefined);
    assert.equal(Object.keys(spawnCall.options.env).some((name) => name.toLowerCase() === 'psmodulepath'), false);
    assert.deepEqual(env, originalEnv);
    assert.equal(spawnCall.args.at(-2), '-Command');
    assert.equal(spawnCall.args.includes('-EncodedCommand'), false);
    const encodedScript = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(spawnCall.args.at(-1));
    assert.ok(encodedScript, 'only a base64 script can enter the fixed command expression');
    const script = Buffer.from(encodedScript[1], 'base64').toString('utf16le');
    assert.match(script, /NamedPipeClientStream/);
    assert.match(script, /TokenImpersonationLevel\.Identification/);
    assert.doesNotMatch(script, /TokenImpersonationLevel\.(None|Impersonation)/);
    assert.doesNotMatch(spawnCall.args.join(' '), /must-not-send|secret/i);
  } finally {
    channel.destroy();
    assert.equal(child.exitCode, 0);
  }
});

test('Windows relay forwards only grammar-validated fixed failure metadata', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.signalCode = 'SIGTERM'; return true; };
  const channel = createWindowsCommsTransport({
    label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
    custody: fakeCustody(), spawnProcess: () => {
      process.nextTick(() => child.stderr.end('AGENT_COMMS_PIPE_FAILURE:stdin-open:IOException:80070006\nAGENT_COMMS_PIPE_FAILED\n'));
      return child;
    },
  });
  const error = await new Promise((resolve) => channel.once('error', resolve));
  assert.equal(error.code, 'broker-unreachable');
  assert.equal(error.message, 'cannot reach the broker: broker-unreachable');
  assert.deepEqual(error.relayFailure, { stage: 'stdin-open', exception: 'IOException', hresult: '80070006' });
  assert.equal(Object.keys(error).includes('relayFailure'), false);
  assert.equal(JSON.stringify(error).includes('80070006'), false);
  assert.equal(isWindowsRelayFailure(error.relayFailure), true);

  const malformed = new EventEmitter();
  malformed.stdin = new PassThrough();
  malformed.stdout = new PassThrough();
  malformed.stderr = new PassThrough();
  malformed.exitCode = null;
  malformed.signalCode = null;
  malformed.kill = () => true;
  const rejected = createWindowsCommsTransport({
    label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
    custody: fakeCustody(), spawnProcess: () => {
      process.nextTick(() => malformed.stderr.end('AGENT_COMMS_PIPE_FAILURE:stdin-open:secret C:\\\\private:80070006\n'));
      return malformed;
    },
  });
  const invalid = await new Promise((resolve) => rejected.once('error', resolve));
  assert.equal(invalid.code, 'broker-unreachable');
  assert.deepEqual(invalid.relayFailure, { stage: 'host-stderr', format: 'other', reason: 'unexpected' });
  assert.equal(invalid.message.includes('private'), false);
  assert.equal(isWindowsRelayFailure({ stage: 'pipe-connect', exception: 'IOException', hresult: 'not-hex' }), false);
  assert.equal(isWindowsRelayFailure({ stage: 'compile', code: ['CS0246'] }), false);
  for (const stage of ['stdin-read', 'pipe-write', 'pipe-flush', 'pipe-read', 'stdout-write', 'stdout-flush']) {
    assert.equal(isWindowsRelayFailure({ stage, exception: 'IOException', hresult: '80070006' }), true);
  }

  const compile = new EventEmitter();
  compile.stdin = new PassThrough();
  compile.stdout = new PassThrough();
  compile.stderr = new PassThrough();
  compile.exitCode = null;
  compile.signalCode = null;
  compile.kill = () => true;
  const compileChannel = createWindowsCommsTransport({
    label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
    custody: fakeCustody(), spawnProcess: () => {
      process.nextTick(() => compile.stderr.end('AGENT_COMMS_PIPE_COMPILE_FAILURE:CS0246\n'));
      return compile;
    },
  });
  const compileError = await new Promise((resolve) => compileChannel.once('error', resolve));
  assert.equal(compileError.code, 'broker-unreachable');
  assert.deepEqual(compileError.relayFailure, { stage: 'compile', code: 'CS0246' });
  assert.equal(compileError.message, 'cannot reach the broker: broker-unreachable');
});

test('Windows relay reports only opted-in fixed milestones and parses worker failures after ready', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const originalWrite = process.stderr.write;
  let tapOutput = '';
  const capture = function capture(chunk, ...args) {
    tapOutput += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const callback = args.find((value) => typeof value === 'function');
    if (callback) callback();
    return true;
  };
  for (const diagnosticsEnabled of [false, true]) {
    tapOutput = '';
    process.stderr.write = capture;
    try {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => true;
      const channel = createWindowsCommsTransport({
        label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
        custody: fakeCustody(), env: diagnosticsEnabled ? { AGENT_BOT_WINDOWS_RELAY_DIAGNOSTICS: '1' } : {},
        spawnProcess: () => {
          process.nextTick(() => {
            child.stderr.write('AGENT_COMMS_PIPE_READY\n');
            child.stderr.write('AGENT_COMMS_PIPE_DIAG:stdin-read-enter\n');
            child.stderr.end('AGENT_COMMS_PIPE_FAILURE:pipe-write:IOException:80070006\nAGENT_COMMS_PIPE_FAILED\n');
          });
          return child;
        },
      });
      const error = await new Promise((resolve) => channel.once('error', resolve));
      assert.equal(error.code, 'broker-unreachable');
      assert.deepEqual(error.relayFailure, { stage: 'pipe-write', exception: 'IOException', hresult: '80070006' });
      assert.equal(error.message, 'cannot reach the broker: broker-unreachable');
      assert.equal(tapOutput, diagnosticsEnabled ? '# windows-relay stdin-read-enter\n' : '');
      assert.doesNotMatch(tapOutput, /secret|80070006|private/i);
    } finally {
      process.stderr.write = originalWrite;
    }
  }

  tapOutput = '';
  process.stderr.write = capture;
  try {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    const channel = createWindowsCommsTransport({
      label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
      custody: fakeCustody(), env: { AGENT_BOT_WINDOWS_RELAY_DIAGNOSTICS: '1' },
      spawnProcess: () => {
        process.nextTick(() => {
          child.stderr.write('AGENT_COMMS_PIPE_READY\n');
          child.stderr.end('private C:\\credential\\path token=hidden\n');
        });
        return child;
      },
    });
    const error = await new Promise((resolve) => channel.once('error', resolve));
    assert.equal(error.code, 'broker-unreachable');
    assert.deepEqual(error.relayFailure, { stage: 'host-stderr', format: 'other', reason: 'unexpected' });
    assert.equal(tapOutput, '');
    assert.doesNotMatch(error.message + JSON.stringify(error) + tapOutput, /credential|path|hidden|token/i);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('Windows relay bounds and redacts unknown host stderr and process failures', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const cases = [
    {
      name: 'CLIXML preamble',
      emit(child) { child.stderr.end('#< CLIXML\r\n<Objs>private secret</Objs>\n'); },
      failure: { stage: 'host-stderr', format: 'clixml', reason: 'unexpected' },
    },
    {
      name: 'other unexpected stderr',
      emit(child) { child.stderr.end('C:\\\\private\\\\secrets.txt token=hidden\n'); },
      failure: { stage: 'host-stderr', format: 'other', reason: 'unexpected' },
    },
    {
      name: 'oversized CLIXML stderr',
      emit(child) { child.stderr.end(`#< CLIXML${'x'.repeat(1024)}`); },
      failure: { stage: 'host-stderr', format: 'clixml', reason: 'limit' },
    },
    {
      name: 'process spawn failure',
      emit(child) { child.emit('error', new Error('private spawn path')); },
      failure: { stage: 'host-process', event: 'spawn-error' },
    },
    {
      name: 'stdin failure',
      emit(child) { child.stdin.emit('error', new Error('private stdin path')); },
      failure: { stage: 'host-process', event: 'stdin-error' },
    },
    {
      name: 'stdout failure',
      emit(child) { child.stdout.emit('error', new Error('private stdout path')); },
      failure: { stage: 'host-process', event: 'stdout-error' },
    },
    {
      name: 'stderr failure',
      emit(child) { child.stderr.emit('error', new Error('private stderr path')); },
      failure: { stage: 'host-process', event: 'stderr-error' },
    },
    {
      name: 'stderr ended before ready',
      emit(child) { child.stderr.end(); },
      failure: { stage: 'host-process', event: 'stderr-end' },
    },
    {
      name: 'process exited before ready',
      emit(child) { child.exitCode = 1; child.emit('exit', 1, null); child.stderr.end(); },
      failure: { stage: 'host-process', event: 'exit' },
    },
  ];

  for (const scenario of cases) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    const channel = createWindowsCommsTransport({
      label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
      custody: fakeCustody(), spawnProcess: () => {
        process.nextTick(() => scenario.emit(child));
        return child;
      },
    });
    const error = await new Promise((resolve) => channel.once('error', resolve));
    assert.equal(error.code, 'broker-unreachable', scenario.name);
    assert.deepEqual(error.relayFailure, scenario.failure, scenario.name);
    assert.equal(isWindowsRelayFailure(error.relayFailure), true, scenario.name);
    assert.equal(Object.keys(error).includes('relayFailure'), false, scenario.name);
    assert.equal(error.message, 'cannot reach the broker: broker-unreachable', scenario.name);
    assert.doesNotMatch(JSON.stringify(error), /private|secret|hidden|secrets\.txt/i, scenario.name);
  }

  assert.throws(() => createWindowsCommsTransport({
    label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
    custody: fakeCustody(), spawnProcess() { throw new Error('private executable path'); },
  }), (error) => {
    assert.equal(error.code, 'broker-unreachable');
    assert.equal(error.message, 'cannot reach the broker: broker-unreachable');
    assert.deepEqual(error.relayFailure, { stage: 'host-process', event: 'spawn-error' });
    assert.equal(error.message.includes('private'), false);
    return true;
  });

  assert.equal(isWindowsRelayFailure({ stage: 'host-stderr', format: 'clixml', reason: 'unexpected', raw: 'secret' }), false);
  assert.equal(isWindowsRelayFailure({ stage: 'host-process', event: 'other' }), false);
});

test('CommsClient preserves validated Windows relay diagnostics without changing its public error', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const raw = new PassThrough();
  const relayFailure = { stage: 'compile', code: 'CS0246' };
  Object.defineProperty(raw, 'relayFailure', { value: relayFailure, enumerable: false });
  const client = new CommsClient({
    socketPath: windowsPipeName(w.paths.serviceLabel, SID), brokerUid: SID, brokerKey: k.brokerKey,
    brokerStateDir: w.brokerState, mode: 'single-account', platform: 'win32', windowsCustody: fakeCustody(),
    windowsCreateConnection: () => {
      process.nextTick(() => raw.emit('error', Object.assign(new Error('private raw error'), {
        code: 'broker-unreachable', relayFailure,
      })));
      return raw;
    },
  });
  await assert.rejects(client.request({ op: 'ping' }, { paths: w.paths }), (error) => {
    assert.equal(error.code, 'broker-unreachable');
    assert.equal(error.message, 'cannot reach the broker: broker-unreachable');
    assert.deepEqual(error.relayFailure, relayFailure);
    assert.equal(Object.keys(error).includes('relayFailure'), false);
    assert.equal(JSON.stringify(error).includes('CS0246'), false);
    assert.equal(error.message.includes('private'), false);
    return true;
  });
});

test('silent Windows relay startup is bounded and kills its child', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true; };
  const channel = createWindowsCommsTransport({
    label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
    custody: fakeCustody(), handshakeTimeoutMs: 20, spawnProcess: () => child,
  });
  await assert.rejects(new Promise((resolve, reject) => {
    channel.once('connect', resolve);
    channel.once('error', reject);
  }), { code: 'broker-timeout' });
  assert.equal(child.signalCode, 'SIGTERM');
});

test('Windows relay treats child stdin EPIPE as a bounded connection failure', async () => {
  const w = world();
  const k = keys();
  writeIdentity(w, k.brokerKey);
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true; };
  child.stdin.once('data', () => child.stdin.destroy(Object.assign(new Error('EPIPE'), { code: 'EPIPE' })));
  const channel = createWindowsCommsTransport({
    label: w.paths.serviceLabel, brokerStateDir: w.brokerState, brokerUid: SID, brokerKey: k.brokerKey,
    custody: fakeCustody(), handshakeTimeoutMs: 500,
    spawnProcess: () => {
      process.nextTick(() => child.stderr.write('AGENT_COMMS_PIPE_READY\n'));
      return child;
    },
  });
  const failure = new Promise((resolve, reject) => {
    channel.once('error', resolve);
    setTimeout(() => reject(new Error('relay did not report stdin failure')), 500).unref();
  });
  assert.equal((await failure).code, 'broker-unreachable');
  assert.equal(child.signalCode, 'SIGTERM');
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
