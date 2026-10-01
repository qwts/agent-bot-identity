import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadOrCreateVouchKey,
  signSoulToken,
  verifySoulToken,
  vouchKeyPath,
  vouchStateDir,
} from '../vouch.mjs';

const AGENT_ID = 'agent_33333333-3333-4333-8333-333333333333';
const PARENT_ID = 'agent_22222222-2222-4222-8222-222222222222';
const DAEMON = fileURLToPath(new URL('../agent-daemon.mjs', import.meta.url));
const ISSUED_AT = new Date('2026-08-12T08:00:00.000Z');
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratchDir() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-vouch-'));
  roots.push(root);
  return root;
}

function claims(overrides = {}) {
  return {
    account: 'ada',
    agentId: AGENT_ID,
    parent: PARENT_ID,
    ...overrides,
  };
}

test('the default vouch key path is the account state file (#254)', () => {
  assert.equal(
    vouchKeyPath(vouchStateDir({ env: {}, home: '/home/test' })),
    '/home/test/.local/state/agent-bot/vouch-key.pem',
  );
  assert.equal(
    vouchKeyPath(vouchStateDir({ env: { XDG_STATE_HOME: '/tmp/state' }, home: '/home/test' })),
    '/tmp/state/agent-bot/vouch-key.pem',
  );
});

test('loadOrCreateVouchKey writes one Ed25519 PKCS#8 key, mode 0600 (#254)', () => {
  const dir = scratchDir();
  const first = loadOrCreateVouchKey(dir);
  assert.equal(first.created, true);
  assert.equal(first.file, vouchKeyPath(dir));
  assert.equal(first.privateKey.asymmetricKeyType, 'ed25519');
  const pem = readFileSync(first.file, 'utf8');
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
  assert.match(pem, /-----END PRIVATE KEY-----\n$/);
  assert.equal(createPrivateKey(pem).asymmetricKeyType, 'ed25519');
  assert.match(first.publicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
  assert.equal(statSync(first.file).mode & 0o777, 0o600);

  chmodSync(first.file, 0o644);
  assert.equal(statSync(first.file).mode & 0o777, 0o644);
  const second = loadOrCreateVouchKey(dir);
  assert.equal(second.created, false);
  assert.equal(second.publicKeyPem, first.publicKeyPem);
  assert.equal(readFileSync(second.file, 'utf8'), pem);
  assert.equal(statSync(second.file).mode & 0o777, 0o600);
});

test('a corrupt vouch key is not replaced (#254)', () => {
  const dir = scratchDir();
  const file = vouchKeyPath(dir);
  writeFileSync(file, 'not a key\n', { mode: 0o600 });
  assert.throws(() => loadOrCreateVouchKey(dir), /Ed25519 PKCS#8/);
  assert.equal(readFileSync(file, 'utf8'), 'not a key\n');
});

test('signSoulToken builds a v1 token node:crypto verifies against the SPKI key (#254)', () => {
  const dir = scratchDir();
  const key = loadOrCreateVouchKey(dir);
  const token = signSoulToken(claims(), key, () => ISSUED_AT);
  const again = signSoulToken(claims({ parent: null }), key.privateKey, ISSUED_AT);
  const [version, payloadSegment, signatureSegment] = token.split('.');
  assert.equal(version, 'v1');
  const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload), ['v', 'aud', 'account', 'agentId', 'parent', 'iat', 'exp', 'nonce']);
  assert.equal(payload.aud, 'agent-comms');
  assert.equal(payload.account, 'ada');
  assert.equal(payload.agentId, AGENT_ID);
  assert.equal(payload.parent, PARENT_ID);
  assert.equal(payload.exp - payload.iat, 300);
  assert.equal(payload.iat, Math.floor(ISSUED_AT.getTime() / 1000));
  assert.equal(Buffer.from(payload.nonce, 'base64url').length, 16);
  assert.notEqual(token.split('.')[1], again.split('.')[1]);

  const publicKey = createPublicKey(key.publicKeyPem);
  const signature = Buffer.from(signatureSegment, 'base64url');
  assert.equal(verify(null, Buffer.from(payloadSegment), publicKey, signature), true);
  assert.equal(verify(null, Buffer.from(`v1.${payloadSegment}`), publicKey, signature), false);
  assert.deepEqual(verifySoulToken(token, key.publicKeyPem, () => ISSUED_AT), payload);
  assert.equal(verifySoulToken(again, key, () => ISSUED_AT).parent, null);

  const expMs = ISSUED_AT.getTime() + 300_000;
  assert.ok(verifySoulToken(token, publicKey, () => new Date(expMs - 1000)));
  assert.equal(verifySoulToken(token, publicKey, () => new Date(expMs)), null);
});

function craft(payload, privateKey) {
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(segment), privateKey);
  return `v1.${segment}.${Buffer.from(signature).toString('base64url')}`;
}

test('verifySoulToken rejects a bad signature, a long lifetime, and expiry (#254)', () => {
  const key = loadOrCreateVouchKey(scratchDir());
  const iat = Math.floor(ISSUED_AT.getTime() / 1000);
  const minted = JSON.parse(Buffer.from(
    signSoulToken(claims(), key, () => ISSUED_AT).split('.')[1],
    'base64url',
  ).toString('utf8'));
  const payload = {
    v: 1,
    aud: 'agent-comms',
    account: 'ada',
    agentId: AGENT_ID,
    parent: null,
    iat,
    exp: iat + 300,
    nonce: minted.nonce,
  };
  const token = craft(payload, key.privateKey);
  assert.equal(verifySoulToken(token, key.publicKey, () => ISSUED_AT).account, 'ada');

  const longer = craft({ ...payload, exp: iat + 301 }, key.privateKey);
  assert.equal(verifySoulToken(longer, key.publicKey, () => ISSUED_AT), null);
  const shorter = craft({ ...payload, exp: iat + 299 }, key.privateKey);
  assert.equal(verifySoulToken(shorter, key.publicKey, () => ISSUED_AT).exp, iat + 299);
  const wrongAud = craft({ ...payload, aud: 'other' }, key.privateKey);
  assert.equal(verifySoulToken(wrongAud, key.publicKey, () => ISSUED_AT), null);

  const [version, segment, signatureSegment] = token.split('.');
  const flipped = `${version}.${segment.slice(0, -1)}${segment.endsWith('A') ? 'B' : 'A'}.${signatureSegment}`;
  assert.equal(verifySoulToken(flipped, key.publicKey, () => ISSUED_AT), null);
  const wrongBytes = sign(null, Buffer.from(`v1.${segment}`), key.privateKey);
  const prefixed = `${version}.${segment}.${Buffer.from(wrongBytes).toString('base64url')}`;
  assert.equal(verifySoulToken(prefixed, key.publicKey, () => ISSUED_AT), null);
  assert.equal(verifySoulToken('nope', key.publicKey, () => ISSUED_AT), null);
  assert.equal(verifySoulToken(token, 'not-a-key', () => ISSUED_AT), null);
});

test('daemon vouch-key prints the SPKI public key and creates it once (#254)', () => {
  const root = scratchDir();
  const env = {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: path.join(root, 'state'),
  };
  delete env.AGENT_BOT_DAEMON_STATE_PATH;
  const run = () => spawnSync(process.execPath, [DAEMON, 'vouch-key'], { encoding: 'utf8', env });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^-----BEGIN PUBLIC KEY-----\n/);
  assert.match(first.stdout, /-----END PUBLIC KEY-----\n$/);
  assert.doesNotMatch(first.stdout, /PRIVATE KEY/);
  const file = vouchKeyPath(vouchStateDir({ env, home: root }));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const pem = readFileSync(file, 'utf8');
  assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.equal(readFileSync(file, 'utf8'), pem);

  const token = signSoulToken(claims(), loadOrCreateVouchKey(vouchStateDir({ env, home: root })), () => ISSUED_AT);
  const [, payloadSegment, signatureSegment] = token.split('.');
  assert.equal(
    verify(null, Buffer.from(payloadSegment), createPublicKey(first.stdout), Buffer.from(signatureSegment, 'base64url')),
    true,
  );

  const extra = spawnSync(process.execPath, [DAEMON, 'vouch-key', '--json'], { encoding: 'utf8', env });
  assert.equal(extra.status, 0, extra.stderr);
  assert.equal(extra.stdout, first.stdout);
  const rejected = spawnSync(process.execPath, [DAEMON, 'vouch-key', 'extra'], { encoding: 'utf8', env });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /usage: agent-bot daemon vouch-key/);
});

test('a symlinked vouch key is refused, not read or chmodded through', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vouch-link-'));
  try {
    const real = path.join(dir, 'elsewhere.pem');
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(real, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o644 });
    symlinkSync(real, vouchKeyPath(dir));
    assert.throws(() => loadOrCreateVouchKey(dir), /not a regular file owned by this account/);
    assert.equal(statSync(real).mode & 0o777, 0o644);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
