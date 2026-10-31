import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRequest, requestCanonical, responseCanonical, bodySpan, verifyResponse,
  loadMachinePublicKey, machineCall, loadOrCreateMachineKey, pairedPublicKey, pinDaemonPub,
  writeAgentDaemonPeer, unpairAgentDaemon, assertPairingLayout, machineSocketPath, loadMachineSigner, machineStateDir } from '../machine-client.mjs';
import { loadOrCreateVouchKey } from '../identity-host.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const scratch = () => { const r = mkdtempSync(path.join(tmpdir(), 'machine-client-')); roots.push(r); return r; };

// Vectors produced by managed-machine internal/daemon (origin/main d90fcf0+)
// using its own Sign/signResponse/formatLine — see the PR description.
const GO_CLIENT_PUB = '79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664';
const GO_DAEMON_PUB = '274ed6b26805d2fe8d060529ee9a2f28763b6976d9c5fd1dee38ff36b3b76939';
const GO_REQ = '{"verb":"plan","name":"codex","option":"pin","target":"apps/x.y","plan_id":"p-1","soul":"agent_x","harness":"claude","session_id":"ses_u","timestamp":1730000000,"nonce":"AAAAAAAAAAAAAAAAAAAAAA","public_key":"ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=","signature":"Q/Y06A23Cq7f/I0txe06CgfuMRehIWjHlVxCg4DRpDBtU6IBDoZd2d1BN7cYrG2veza5YNKr0ntBBqfWCukZAA=="}';
const GO_RES = '{"ok":true,"message":"ok","state":"planned","body":{"a":"\\u003cb\\u003e\\u0026x","u":"héllo","n":{"k":[1,2]}},"timestamp":1730000001,"nonce":"BBBBBBBBBBBBBBBBBBBBBB","request_nonce":"AAAAAAAAAAAAAAAAAAAAAA","signature":"vt18S1HWZcUcIlzdodCc1TPSnPOOSn6Li09MqpzYRqIQEQ0KvYbG2uBQXQfxzsmj8tAARQYogJLRUl/QF8OJAQ=="}';
// The client key whose raw public half is GO_CLIENT_PUB (seed bytes 1..32).
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const JWK = { kty: 'OKP', crv: 'Ed25519', d: SEED.toString('base64url'), x: Buffer.from(GO_CLIENT_PUB, 'hex').toString('base64url') };

test('a request built with fixed fields signs byte-identically to Go', async () => {
  const key = createPrivateKey({ format: 'jwk', key: JWK });
  const signer = { publicKeyRaw: Buffer.from(GO_CLIENT_PUB, 'hex'), sign: (bytes) => edSign(null, bytes, key) };
  const req = buildRequest(
    { verb: 'plan', name: 'codex', option: 'pin', target: 'apps/x.y', plan_id: 'p-1', soul: 'agent_x', harness: 'claude', session_id: 'ses_u' },
    signer, { now: 1730000000, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' });
  const go = JSON.parse(GO_REQ);
  assert.equal(req.signature, go.signature, 'JS signature must equal the Go golden');
  assert.equal(req.public_key, go.public_key);
});

test('verifyResponse accepts the Go golden line, raw escaped body and all', () => {
  const out = verifyResponse(GO_RES, Buffer.from(GO_DAEMON_PUB, 'hex'), { expectedNonce: 'AAAAAAAAAAAAAAAAAAAAAA', now: 1730000001 * 1000 + 10 });
  assert.equal(out.ok, true);
  assert.equal(out.state, 'planned');
  assert.deepEqual(out.body.a, '<b>&x');
  assert.equal(out.body.u, 'héllo');
});

test('tamper cases: bad signature, wrong key, stale timestamp, edited body', () => {
  const pub = Buffer.from(GO_DAEMON_PUB, 'hex');
  const now = 1730000001 * 1000;
  const expected = { expectedNonce: 'AAAAAAAAAAAAAAAAAAAAAA', now };
  assert.throws(() => verifyResponse(GO_RES.replace('"ok":true', '"ok":false'), pub, expected), /machine-reply-tampered/);
  const other = generateKeyPairSync('ed25519');
  const otherRaw = Buffer.from(other.publicKey.export({ format: 'jwk' }).x, 'base64url');
  assert.throws(() => verifyResponse(GO_RES, otherRaw, expected), /machine-reply-tampered/);
  assert.throws(() => verifyResponse(GO_RES, pub, { expectedNonce: 'AAAAAAAAAAAAAAAAAAAAAA', now: now + 10 * 60 * 1000 }), /machine-reply-stale/);
  // A byte inside the body span breaks the signature but not JSON parsing.
  const edited = GO_RES.replace('"n":{"k":[1,2]}', '"n":{"k":[1,3]}');
  assert.throws(() => verifyResponse(edited, pub, expected), /machine-reply-tampered/);
});

test('the reply must be bound to the request nonce (#410)', () => {
  const pub = Buffer.from(GO_DAEMON_PUB, 'hex');
  const now = 1730000001 * 1000;
  // A correctly signed reply for another request is refused.
  assert.throws(() => verifyResponse(GO_RES, pub, { expectedNonce: 'CCCCCCCCCCCCCCCCCCCCCC', now }), /machine-reply-unbound/);
  // A reply validly signed with no request_nonce is refused as unbound.
  const keypair = generateKeyPairSync('ed25519');
  const pub2 = Buffer.from(keypair.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const res2 = { ok: true, state: 'ready' };
  res2.timestamp = Math.floor(Date.now() / 1000);
  res2.nonce = 'TESTNONCE00000000000001';
  const payload2 = [String(res2.ok), '', '', res2.state, '', String(res2.timestamp), res2.nonce, ''].join('\n');
  res2.signature = edSign(null, Buffer.from(payload2), keypair.privateKey).toString('base64');
  assert.throws(() => verifyResponse(JSON.stringify(res2), pub2, { expectedNonce: 'Q', now: Date.now() }), /machine-reply-unbound/);
});

test('bodySpan finds the raw body value inside a line', () => {
  const span = bodySpan(GO_RES);
  assert.equal(span.toString('utf8'), '{"a":"\\u003cb\\u003e\\u0026x","u":"héllo","n":{"k":[1,2]}}');
  // A "body" string inside another value is not the key.
  const tricky = '{"ok":true,"message":"set \"body\":{x} here","body":"s","timestamp":1,"nonce":"n"}';
  assert.equal(bodySpan(tricky).toString(), '"s"');
  // An escaped quote inside an earlier key does not split it early.
  assert.equal(bodySpan('{"we\\"ird":"v","body":{"n":1},"ok":true}').toString(), '{"n":1}');

  // Scalar bodies scan the same way.
  assert.equal(bodySpan('{"ok":true,"body":7,"timestamp":1}').toString(), '7');
  assert.equal(bodySpan('{"body":{"k":[1]},"ok":true}').toString(), '{"k":[1]}');
});

// A fake agent-machine: unix socket, verifies the request signature against
// the client key, answers with a signed response.
async function fakeMachine(root, { keypair = generateKeyPairSync('ed25519'), handler } = {}) {
  const dir = path.join(root, 'am'); mkdirSync(dir, { recursive: true });
  const sock = path.join(dir, 'daemon.sock');
  const daemonPub = Buffer.from(keypair.publicKey.export({ format: 'jwk' }).x, 'base64url');
  writeFileSync(path.join(dir, 'daemon.pub'), daemonPub);
  const received = [];
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      received.push(req);
      const res = handler(req, daemonPub);
      conn.end(`${JSON.stringify(res)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  server.unref();
  return { sock, dir, daemonPub, received, server };
}

function signResponse(res, priv) {
  const body = res.body !== undefined ? JSON.stringify(res.body) : '';
  res.timestamp = Math.floor(Date.now() / 1000);
  res.nonce = 'TESTNONCE00000000000001';
  const payload = [String(res.ok), res.diagnostic ?? '', res.message ?? '', res.state ?? '', body, String(res.timestamp), res.nonce, res.request_nonce ?? ''].join('\n');
  res.signature = edSign(null, Buffer.from(payload), priv).toString('base64');
  return res;
}

test('a signed request round-trips through a fake agent-machine', async () => {
  const root = scratch();
  const keypair = generateKeyPairSync('ed25519');
  const fm = await fakeMachine(root, {
    keypair,
    handler: (req) => signResponse({ ok: true, state: 'ready', request_nonce: req.nonce }, keypair.privateKey),
  });
  const home = path.join(root, 'home'); mkdirSync(path.join(home, '.config', 'agent-machine'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'agent-machine', 'daemon.pub'), fm.daemonPub);
  const env = { AGENT_BOT_SERVER_STATE: path.join(home, 'bot-state') };
  const signer = loadOrCreateMachineKey({ env, home });
  pinDaemonPub({ env, home });
  const req = buildRequest({ verb: 'status' }, signer);
  const line = await machineCall({ socketPath: fm.sock, request: req });
  const out = verifyResponse(line, fm.daemonPub, { expectedNonce: req.nonce });
  assert.equal(out.ok, true);
  assert.equal(fm.received.length, 1);
  assert.equal(fm.received[0].verb, 'status');
  assert.equal(fm.received[0].public_key, signer.publicKeyRaw.toString('base64'));
});

test('a multibyte reply split across socket chunks decodes whole', async () => {
  const root = scratch();
  const dir = path.join(root, 'am'); mkdirSync(dir, { recursive: true });
  const sock = path.join(dir, 'daemon.sock');
  const server = createServer((conn) => {
    conn.on('data', () => {
      const line = Buffer.from(`${JSON.stringify({ ok: true, message: 'héllo' })}\n`, 'utf8');
      // Split inside the 'é' (0xC3 0xA9) so no chunk holds a complete char.
      const cut = line.indexOf(0xc3);
      conn.write(line.subarray(0, cut));
      setImmediate(() => conn.end(line.subarray(cut)));
    });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  server.unref();
  try {
    const line = await machineCall({ socketPath: sock, request: { verb: 'status' } });
    assert.equal(JSON.parse(line).message, 'héllo');
  } finally {
    server.close();
  }
});

test('pairing file rules: legacy peer.* refuses, unknown peers/ entry refuses, terminal untouched', async () => {
  const root = scratch();
  const dir = path.join(root, '.config', 'agent-machine');
  mkdirSync(path.join(dir, 'peers'), { recursive: true });
  writeFileSync(path.join(dir, 'peer.pub'), Buffer.alloc(32, 9));
  assert.throws(() => assertPairingLayout(dir), /machine-legacy-peers/);
  rmSync(path.join(dir, 'peer.pub'));
  writeFileSync(path.join(dir, 'peers', 'bogus.pub'), Buffer.alloc(32, 1));
  assert.throws(() => assertPairingLayout(dir), /machine-peers-invalid/);
  rmSync(path.join(dir, 'peers', 'bogus.pub'));
  // terminal files are never touched.
  writeFileSync(path.join(dir, 'peers', 'terminal.pub'), Buffer.alloc(32, 7));
  const before = readFileSync(path.join(dir, 'peers', 'terminal.pub'));
  writeAgentDaemonPeer({ home: root, publicKeyRaw: Buffer.alloc(32, 5) });
  assert.deepEqual(readFileSync(path.join(dir, 'peers', 'terminal.pub')), before);
  assert.equal(readFileSync(path.join(dir, 'peers', 'agent-daemon.next')).length, 32);
  assert.equal(readFileSync(path.join(dir, 'peers', 'agent-daemon.confirm'), 'utf8').length, 64);
  assert.deepEqual(readdirSync(path.join(dir, 'peers')).sort(), ['agent-daemon.confirm', 'agent-daemon.next', 'terminal.pub']);
  unpairAgentDaemon({ home: root });
  assert.ok(readFileSync(path.join(dir, 'peers', 'terminal.pub')).equals(before));
  assert.equal(readFileSync(path.join(dir, 'peers', 'agent-daemon.revoked')).length, 0);
});

test('pin mismatch refuses send; no pin refuses with machine-not-paired', () => {
  const root = scratch();
  const env = { AGENT_BOT_SERVER_STATE: path.join(root, 'state') };
  const dir = path.join(root, '.config', 'agent-machine');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'daemon.pub'), Buffer.alloc(32, 3));
  assert.throws(() => pairedPublicKey({ env, home: root }), /machine-not-paired/);
  pinDaemonPub({ env, home: root });
  writeFileSync(path.join(dir, 'daemon.pub'), Buffer.alloc(32, 4));
  assert.throws(() => pairedPublicKey({ env, home: root }), /machine-pin-mismatch/);
});

test('loadMachineSigner is load-only, and on win32 loads an existing key through vouch', () => {
  const root = scratch();
  const env = { AGENT_BOT_SERVER_STATE: path.join(root, 'state') };
  const custody = { currentSid: () => 'S-1', assertOwnedFile: () => {}, restrictPrivateFile: () => {} };
  assert.equal(loadMachineSigner({ env, home: root, platform: 'win32', custody }), null);
  const signer = loadOrCreateMachineKey({ env, home: root });
  const loaded = loadMachineSigner({ env, home: root, platform: 'win32', custody });
  assert.deepEqual(loaded.publicKeyRaw, signer.publicKeyRaw);
  assert.ok(loaded.sign(Buffer.from('x')).length === 64, 'the win32 signer signs');
});

test('load-only key readers keep vouch custody: symlink, FIFO and foreign file refused', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX custody checks');
  const root = scratch();
  const env = { AGENT_BOT_SERVER_STATE: path.join(root, 'state') };
  const dir = machineStateDir({ env, home: root });
  const file = path.join(dir, 'vouch-key.pem');
  // Absent: null, and nothing was created.
  assert.equal(loadMachinePublicKey({ env, home: root }), null);
  assert.equal(loadMachineSigner({ env, home: root }), null);
  assert.equal(existsSync(dir), false);
  // A symlink at the key path is refused, not followed and signed with.
  mkdirSync(dir, { recursive: true });
  const real = path.join(dir, 'real.pem');
  writeFileSync(real, loadOrCreateVouchKey(path.join(dir, 'src')).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  symlinkSync(real, file);
  assert.throws(() => loadMachineSigner({ env, home: root }), /not a regular file owned by this account/);
  assert.throws(() => loadMachinePublicKey({ env, home: root }), /not a regular file owned by this account/);
  // A FIFO opens without blocking (O_NONBLOCK) and fails the file check.
  rmSync(file);
  const { execFileSync } = await import('node:child_process');
  execFileSync('mkfifo', [file]);
  assert.throws(() => loadMachinePublicKey({ env, home: root }), /not a regular file owned by this account/);
});

test('a reply exceeding the 64 KiB cap is refused, never buffered', async () => {
  const root = scratch();
  const dir = path.join(root, 'am'); mkdirSync(dir, { recursive: true });
  const sock = path.join(dir, 'daemon.sock');
  const server = createServer((conn) => {
    conn.on('data', () => { conn.write(Buffer.alloc(64 * 1024 + 1, 0x61)); });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  server.unref();
  try {
    await assert.rejects(() => machineCall({ socketPath: sock, request: { verb: 'status' } }),
      (error) => error.code === 'machine-reply-invalid');
  } finally {
    server.close();
  }
});

test('catalog verb: request matches the Go golden signature byte-for-byte', () => {
  // Scratch Go (managed-machine catalogCanonical + ed25519, /tmp/catgolden):
  // identical key seed, fields, timestamp and nonce must sign identically.
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const signer = {
    publicKeyRaw: Buffer.from('A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=', 'base64'),
    sign: (bytes) => edSign(null, bytes, privateKey),
  };
  const catalog_key = { public_key: `ed25519:${Buffer.alloc(32).toString('base64')}`, key_id: 'aaaaaaaabbbbcccc' };
  const floor = { key_id: 'aaaaaaaabbbbcccc', min_version: 7 };
  const envelope = {
    format: 'agent-bot-catalog/1', key_id: 'aaaaaaaabbbbcccc', version: 9, issued_at: 1700000000,
    catalog: Buffer.from('{}').toString('base64'), sig: Buffer.alloc(64).toString('base64'),
  };
  const req = buildRequest({ verb: 'catalog', catalog_key, floor, envelope }, signer,
    { now: 1700000001, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(req.signature, Buffer.from('409e670116e9cc968357ebae6eb4fa99c28e7afb2bf1c703fcd408ff53d4213b2baec059ac066ac35d1e5c34f544e3d146fc9ce55ee6a016cac60c18e598630a', 'hex').toString('base64'));
  // catalog fields are refused on other verbs; op fields on catalog.
  assert.throws(() => buildRequest({ verb: 'status', catalog_key }, signer), /catalog fields belong only/);
  assert.throws(() => buildRequest({ verb: 'catalog', catalog_key, soul: 'x' }, signer), /catalog carries only/);
});

test('runMachineCli: pair, pair --repin, unpair, status and --help run through the owner gate', async () => {
  const { runMachineCli } = await import('../cli/machine.mjs');
  const root = scratch();
  const keypair = generateKeyPairSync('ed25519');
  const fm = await fakeMachine(root, {
    keypair,
    handler: (req) => signResponse({ ok: true, state: 'ready', request_nonce: req.nonce }, keypair.privateKey),
  });
  const home = path.join(root, 'home');
  const amDir = path.join(home, '.config', 'agent-machine');
  mkdirSync(amDir, { recursive: true });
  writeFileSync(path.join(amDir, 'daemon.pub'), fm.daemonPub);
  const env = { AGENT_BOT_SERVER_STATE: path.join(home, 'bot-state') };
  const actions = [];
  const run = async (argv) => {
    let out = '';
    let err = '';
    const code = await runMachineCli(argv, {
      env,
      home,
      socketPath: fm.sock,
      gate: async (action) => { actions.push(action); },
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
    });
    return { code, out, err };
  };

  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /agent-bot pair \[--repin\]/);

  const bad = await run(['pair', '--bogus']);
  assert.equal(bad.code, 1);
  assert.equal(actions.length, 0, 'unknown option fails before the owner gate');

  const paired = await run(['pair']);
  assert.equal(paired.code, 0, paired.err);
  assert.deepEqual(actions, ['machine-pair']);
  assert.match(paired.out, /agent-machine pinned: sha256 [0-9a-f]{64}/);
  assert.match(paired.out, /paired: agent-machine accepted the agent-daemon key \(ready\)/);
  assert.ok(existsSync(path.join(amDir, 'peers', 'agent-daemon.next')));
  assert.ok(existsSync(path.join(amDir, 'peers', 'agent-daemon.confirm')));

  // Rotate daemon.pub: pair without --repin refuses; pair --repin succeeds.
  const rotated = generateKeyPairSync('ed25519');
  const rotatedPub = Buffer.from(rotated.publicKey.export({ format: 'jwk' }).x, 'base64url');
  writeFileSync(path.join(amDir, 'daemon.pub'), rotatedPub);
  await assert.rejects(() => run(['pair']), (e) => e.code === 'machine-pin-mismatch');
  fm.server.close();
  const fm2 = await fakeMachine(root, {
    keypair: rotated,
    handler: (req) => signResponse({ ok: true, state: 'ready', request_nonce: req.nonce }, rotated.privateKey),
  });
  let repinOut = '';
  const repinCode = await runMachineCli(['pair', '--repin'], {
    env,
    home,
    socketPath: fm2.sock,
    gate: async (action) => { actions.push(action); },
    stdout: { write: (s) => { repinOut += s; } },
    stderr: { write: () => {} },
  });
  assert.equal(repinCode, 0);
  assert.match(repinOut, /daemon\.pub changed:/);

  const st = await runMachineCli(['status'], {
    env,
    home,
    socketPath: fm2.sock,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  assert.equal(st, 0);

  const unpaired = await run(['unpair']);
  assert.equal(unpaired.code, 0);
  assert.equal(actions.at(-1), 'machine-unpair');
  assert.match(unpaired.out, /unpaired: peers\/agent-daemon\.revoked written/);
});
