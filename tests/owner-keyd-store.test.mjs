// The keyd store for owner statements (#753): keyd's `owner/statement-key`
// and `owner/sign`, as agent-bot calls them, against a stand-in keyd. No
// socket, no keychain, no prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519KeyLine, ownerCommand, parseSshPublicKey, readOwnerKeys, sshFingerprint, verifyStatement, writeOwnerKeys } from '../owner-statement.mjs';
import { keydStatementStore, verifyStatementKeyRecord } from '../owner-presence.mjs';

// Known vectors, shared with keyd/src/statement.rs (`matches_the_shared_vectors`).
const SEED = Buffer.alloc(32, 7);
const PUBLIC = '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=';
const FINGERPRINT = 'SHA256:z/fSv0Z0RZS+Lccbc6ZoOWwt/fbj1VFJGSBKQbo4icE';
const SEGMENT = 'eyJ2IjoxLCJhdWQiOiJhZ2VudC1ib3Qtb3duZXItc3RhdGVtZW50Iiwia2luZCI6InN0YXRlbWVudCIsImFsZyI6ImVkMjU1MTkiLCJrZXkiOiJTSEEyNTY6ei9mU3YwWjBSWlMrTGNjYmM2Wm9PV3d0L2ZiajFWRkpHU0JLUWJvNGljRSIsInRleHQiOiJTaGlwIHRoZSBrZXlkIG93bmVyL3NpZ24gc2xpY2UuIiwic2NvcGUiOnsicmVwbyI6InF3dHMvYWdlbnQtYm90LWlkZW50aXR5IiwibnVtYmVyIjo3NTN9LCJhY3Rpb24iOm51bGwsIm5vbmNlIjoidmVjdG9yLW5vbmNlLTAxMjM0NTY3ODkiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDYwNDgwMH0';
const SIGNATURE = 'rOHSC-6pyz8LQWNpdDOR2-M2FlI2Bkp0i0UkjHDKtBDThiIYHzQ8e8foA0vcUxJf5WFthc94yh6x6jyDgkmhBA';
const IAT = 1_800_000_000;
const NOW = IAT * 1000;
const NONCE = 'abcdefghijklmnopqrstuvwx';
const SCOPE = { repo: 'qwts/agent-bot-identity', number: 753 };

const privateFromSeed = (seed) => createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8',
});

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-keyd-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { HOME: dir } };
}

// A stand-in keyd: a presence key that signs `k1.` records, and the vector
// seed as its owner statement key. `owner/sign` signs what it is sent unless
// `refuse` throws first. Every call goes to `calls`.
function fakeKeyd({ statementSeed = SEED, refuse = () => {}, record = null } = {}) {
  const presence = generateKeyPairSync('ed25519');
  const presenceRaw = Buffer.from(presence.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const statementKey = privateFromSeed(statementSeed);
  const statementRaw = Buffer.from(statementKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const calls = [];
  const keyRecord = (nonce, overrides = {}) => {
    const line = ed25519KeyLine(statementRaw);
    const segment = Buffer.from(JSON.stringify({ v: 1, aud: 'agent-bot-owner', kind: 'statement-key', key: statementRaw,
      fingerprint: sshFingerprint(parseSshPublicKey(line).blob), nonce, iat: IAT, exp: IAT + 60, ...overrides })).toString('base64url');
    return `k1.${segment}.${sign(null, Buffer.from(segment), presence.privateKey).toString('base64url')}`;
  };
  const request = async (socket, method, params, options) => {
    calls.push({ socket, method, params, options });
    if (method === 'owner/statement-key') return { record: record ? record(params.nonce, keyRecord) : keyRecord(params.nonce) };
    if (method === 'owner/sign') {
      refuse(params.payload);
      return { signature: sign(null, Buffer.from(params.payload, 'ascii'), statementKey).toString('base64url') };
    }
    throw Object.assign(new Error('method not found'), { code: 'keyd-refused', rpcCode: -32601 });
  };
  return { calls, request, pinned: () => presenceRaw, keyRecord };
}

const rpcError = (rpcCode, message = 'refused') => Object.assign(new Error(message),
  { code: rpcCode === -32002 ? 'keyd-untrusted' : 'keyd-refused', rpcCode });

test('agent-bot reads the shared keyd vectors: key, fingerprint and signature', () => {
  const line = ed25519KeyLine(PUBLIC);
  assert.equal(sshFingerprint(parseSshPublicKey(line).blob), FINGERPRINT);
  assert.equal(Buffer.from(privateFromSeed(SEED).export({ format: 'jwk' }).x, 'base64url').toString('base64'), PUBLIC);
  assert.equal(sign(null, Buffer.from(SEGMENT, 'ascii'), privateFromSeed(SEED)).toString('base64url'), SIGNATURE);
  const pin = { name: 'mac', store: 'keyd', alg: 'ed25519', publicKey: line, fingerprint: FINGERPRINT, verifyRequired: false,
    softwareKey: false, pinnedAt: '2026-10-11T00:00:00.000Z' };
  const { payload } = verifyStatement(`s1.${SEGMENT}.${SIGNATURE}`, { keys: [pin], now: NOW, repo: SCOPE.repo, issue: SCOPE.number });
  assert.deepEqual([payload.kind, payload.alg, payload.text], ['statement', 'ed25519', 'Ship the keyd owner/sign slice.']);
});

test('keydStatementStore takes the key from keyd\'s record under the presence key, and checks every signature', async (t) => {
  const { env } = home(t);
  const keyd = fakeKeyd();
  const seams = { env, pinned: keyd.pinned, request: keyd.request, now: () => NOW, nonce: () => NONCE };
  const store = await keydStatementStore(seams);
  assert.deepEqual([store.alg, store.fingerprint, store.publicKey], ['ed25519', FINGERPRINT, ed25519KeyLine(PUBLIC)]);
  assert.deepEqual(keyd.calls.map((c) => [c.method, c.params, c.options.timeoutMs]), [['owner/statement-key', { nonce: NONCE }, 10_000]]);
  assert.match(keyd.calls[0].socket, /keyd\/owner\.sock$/);
  assert.equal((await store.sign(SEGMENT)).toString('base64url'), SIGNATURE);
  assert.deepEqual(keyd.calls[1].params, { payload: SEGMENT }, 'keyd is sent exactly the segment');
  assert.equal(keyd.calls[1].options.timeoutMs, 150_000, 'the owner has as long as keyd waits');

  // The record must be keyd's, for this nonce, and its fingerprint the key's.
  await assert.rejects(keydStatementStore({ ...seams, pinned: fakeKeyd().pinned }), { code: 'statement-key-invalid' });
  await assert.rejects(keydStatementStore({ ...seams, request: fakeKeyd({ record: (nonce, make) => make('another-nonce-0123456') }).request,
    pinned: keyd.pinned }), { code: 'statement-key-invalid' });
  const lying = fakeKeyd({ record: (nonce, make) => make(nonce, { fingerprint: `SHA256:${'A'.repeat(43)}` }) });
  await assert.rejects(keydStatementStore({ ...seams, pinned: lying.pinned, request: lying.request }), { code: 'statement-key-invalid' });
  const pins = fakeKeyd({ record: (nonce, make) => make(nonce, { kind: 'pins' }) });
  await assert.rejects(keydStatementStore({ ...seams, pinned: pins.pinned, request: pins.request }), { code: 'statement-key-invalid' });
  assert.throws(() => verifyStatementKeyRecord('k1.x.y', { key: keyd.pinned(), nonce: NONCE, now: NOW }), { code: 'statement-key-invalid' });

  // A signature by any other key than the one in the record is refused.
  const switched = fakeKeyd();
  const realRequest = switched.request;
  const other = privateFromSeed(Buffer.alloc(32, 8));
  const store2 = await keydStatementStore({ ...seams, pinned: switched.pinned, request: async (socket, method, params, options) => (method === 'owner/sign'
    ? { signature: sign(null, Buffer.from(params.payload), other).toString('base64url') } : realRequest(socket, method, params, options)) });
  await assert.rejects(store2.sign(SEGMENT), { code: 'owner-sign-failed' });

  // keyd's refusals keep their meaning.
  await assert.rejects(keydStatementStore({ env, pinned: () => null }), { code: 'presence-unavailable' });
  for (const [error, code] of [
    [Object.assign(new Error('agent-bot-keyd is not running'), { code: 'keyd-unavailable' }), 'presence-unavailable'],
    [rpcError(-32601, 'method not found'), 'presence-unavailable'],
    [rpcError(-32002, 'not one agent-bot-keyd controls'), 'keyd-untrusted'],
  ]) {
    await assert.rejects(keydStatementStore({ ...seams, request: async () => { throw error; } }), { code }, error.message);
  }
  for (const [rpcCode, code] of [[-32001, 'presence-unavailable'], [-32000, 'owner-declined'], [-32002, 'keyd-untrusted'],
    [-32602, 'statement-invalid'], [-32601, 'presence-unavailable']]) {
    const refusing = fakeKeyd({ refuse: () => { throw rpcError(rpcCode); } });
    const refusingStore = await keydStatementStore({ ...seams, pinned: refusing.pinned, request: refusing.request });
    await assert.rejects(refusingStore.sign(SEGMENT), { code }, String(rpcCode));
  }
});

function command(t, { keyd = fakeKeyd(), markers = () => [], env: extra = {}, attest = async () => ({ digest: 'd'.repeat(64), generation: 1 }) } = {}) {
  const { dir, env } = home(t);
  const out = [];
  const err = [];
  const receipts = [];
  const attested = [];
  const run = (argv) => ownerCommand(argv, {
    env: { ...env, ...extra }, home: dir, now: () => NOW, write: (text) => out.push(text), writeErr: (text) => err.push(text),
    markers, receipt: (fields) => receipts.push(fields), host: () => 'studio',
    attest: async (pins, options) => { attested.push(pins.map((pin) => pin.name)); return attest(pins, options); },
    keydStore: (options) => keydStatementStore({ ...options, pinned: keyd.pinned, request: keyd.request, now: () => NOW }),
  });
  return { dir, env, out, err, receipts, attested, keyd, run };
}

const keydPin = (name = 'mac') => ({ name, store: 'keyd', alg: 'ed25519', publicKey: ed25519KeyLine(PUBLIC), fingerprint: FINGERPRINT,
  verifyRequired: false, softwareKey: false, pinnedAt: '2026-10-11T00:00:00.000Z' });

test('owner sign --store keyd has keyd sign the statement it shows, in an agent terminal too, never for a soul', async (t) => {
  // keyd shows the owner the text itself, so an agent harness may run it.
  const owner = command(t, { env: { CLAUDECODE: '1' } });
  const { token } = await owner.run(['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--store', 'keyd', '--expires', '2d']);
  const signed = owner.keyd.calls.find((c) => c.method === 'owner/sign');
  assert.equal(token.split('.')[1], signed.params.payload, 'keyd signed exactly the token\'s payload');
  const { payload } = verifyStatement(owner.out.join(''), { keys: [keydPin()], now: NOW, repo: SCOPE.repo, issue: 753 });
  assert.deepEqual([payload.kind, payload.alg, payload.key, payload.text, payload.scope, payload.exp - payload.iat],
    ['statement', 'ed25519', FINGERPRINT, 'Ship it.', SCOPE, 2 * 86_400]);
  assert.match(owner.err.join(''), /agent-bot-keyd shows you this text/);

  // A soul is refused before keyd is asked.
  const soul = command(t, { markers: () => ['Agent ID'] });
  await assert.rejects(soul.run(['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--store', 'keyd']),
    { code: 'owner-credential-required', message: /Agent ID/ });
  assert.deepEqual(soul.keyd.calls, []);

  // keyd's refusal is the answer; nothing is printed.
  const declined = command(t, { keyd: fakeKeyd({ refuse: () => { throw rpcError(-32000, 'the owner did not approve'); } }) });
  await assert.rejects(declined.run(['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--store', 'keyd']), { code: 'owner-declined' });
  assert.deepEqual(declined.out, []);

  for (const argv of [
    ['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--store', 'keyd', '--key', '/tmp/id'],
    ['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--store', 'phone'],
    ['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753'],
    ['sign', '--challenge', '{}', '--store', 'keyd'],
  ]) {
    await assert.rejects(owner.run(argv), { code: 'owner-usage' }, argv.join(' '));
  }
  // Without a keyd wired, nothing signs.
  const { dir, env } = home(t);
  await assert.rejects(ownerCommand(['sign', 'Ship it.', '--repo', SCOPE.repo, '--issue', '753', '--store', 'keyd'],
    { env, home: dir, now: () => NOW, write: () => {}, writeErr: () => {} }), { code: 'owner-store-unavailable' });
});

test('enroll --store keyd asks twice: keyd signs the enrolment, then trusts the new key set', async (t) => {
  const order = [];
  const keyd = fakeKeyd({ refuse: (segment) => order.push(['sign', JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))]) });
  const ctx = command(t, { keyd, attest: async (pins) => { order.push(['attest', pins.map((pin) => pin.name)]); return { digest: 'd'.repeat(64), generation: 2 }; } });
  const phone = { ...keydPin('phone'), publicKey: ed25519KeyLine(Buffer.alloc(32, 1).toString('base64')) };
  phone.fingerprint = sshFingerprint(parseSshPublicKey(phone.publicKey).blob);
  writeOwnerKeys([phone], { env: ctx.env });
  const pin = await ctx.run(['enroll', '--store', 'keyd', '--name', 'mac']);
  assert.deepEqual({ ...pin, pinnedAt: null }, { ...keydPin('mac'), pinnedAt: null });
  // Prompt one, keyd's signature of this enrolment; prompt two, the key set.
  assert.deepEqual(order.map(([step]) => step), ['sign', 'attest']);
  const challenge = order[0][1];
  assert.deepEqual([challenge.kind, challenge.alg, challenge.key, challenge.scope, challenge.text],
    ['challenge', 'ed25519', FINGERPRINT, { host: 'studio' }, `Enrol owner key mac (${FINGERPRINT}) on studio`]);
  assert.equal(challenge.action, createHash('sha256').update(`owner enroll mac ${FINGERPRINT}`, 'utf8').digest('hex'));
  assert.deepEqual(order[1][1], ['phone', 'mac']);
  assert.deepEqual(readOwnerKeys({ env: ctx.env }).map((p) => [p.name, p.store, p.fingerprint]), [['phone', 'keyd', phone.fingerprint], ['mac', 'keyd', FINGERPRINT]]);
  assert.deepEqual(ctx.receipts.map((r) => [r.operation, r.decision]), [['enroll', 'approved']]);
  assert.match(ctx.err.join(''), /asks you twice/);

  // Already pinned: refused before either prompt.
  await assert.rejects(ctx.run(['enroll', '--store', 'keyd', '--name', 'again']), { code: 'owner-key-exists' });
  assert.equal(order.length, 2);
  assert.equal(ctx.receipts.at(-1).decision, 'refused');
});

test('enroll --store keyd changes nothing when keyd declines either prompt, cannot ask, or the caller is a soul', async (t) => {
  // The owner declines the enrolment signature: the key set is never shown.
  const declined = command(t, { keyd: fakeKeyd({ refuse: () => { throw rpcError(-32000, 'the owner did not approve'); } }) });
  await assert.rejects(declined.run(['enroll', '--store', 'keyd']), { code: 'owner-declined' });
  assert.deepEqual(declined.attested, []);
  assert.deepEqual(readOwnerKeys({ env: declined.env }), []);
  assert.deepEqual(declined.receipts.map((r) => r.decision), ['failed']);

  // The owner signs, then declines the key set.
  const second = command(t, { attest: async () => { throw Object.assign(new Error('the owner did not approve'), { code: 'owner-declined' }); } });
  await assert.rejects(second.run(['enroll', '--store', 'keyd']), { code: 'owner-declined' });
  assert.deepEqual(second.attested, [['keyd']]);
  assert.deepEqual(readOwnerKeys({ env: second.env }), []);
  assert.deepEqual(second.receipts.map((r) => r.decision), ['refused']);

  // No keyd to ask.
  const absent = command(t, { keyd: { ...fakeKeyd(), request: async () => { throw Object.assign(new Error('agent-bot-keyd is not running'), { code: 'keyd-unavailable' }); } } });
  await assert.rejects(absent.run(['enroll', '--store', 'keyd']), { code: 'presence-unavailable' });
  assert.deepEqual(readOwnerKeys({ env: absent.env }), []);

  // A keyd that signs with another key than it reports proves nothing.
  const other = privateFromSeed(Buffer.alloc(32, 8));
  const base = fakeKeyd();
  const swapped = command(t, { keyd: { ...base, request: async (socket, method, params, options) => (method === 'owner/sign'
    ? { signature: sign(null, Buffer.from(params.payload), other).toString('base64url') } : base.request(socket, method, params, options)) } });
  await assert.rejects(swapped.run(['enroll', '--store', 'keyd']), { code: 'owner-sign-failed' });
  assert.deepEqual(swapped.attested, []);

  // A soul is refused before keyd is asked anything.
  const soul = command(t, { markers: () => ['binding'] });
  await assert.rejects(soul.run(['enroll', '--store', 'keyd']), { code: 'owner-credential-required' });
  assert.deepEqual(soul.keyd.calls, []);
  assert.deepEqual(soul.receipts.map((r) => r.decision), ['refused']);

  // keyd always asks with Touch ID or the password; ssh-only flags are usage errors.
  for (const flag of [['--key', '/tmp/id'], ['--verify-required'], ['--allow-software-key']]) {
    await assert.rejects(soul.run(['enroll', '--store', 'keyd', ...flag]), { code: 'owner-usage' }, flag[0]);
  }
  await assert.rejects(soul.run(['enroll', '--store', 'phone']), { code: 'owner-usage' });
});
