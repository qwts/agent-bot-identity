import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as published from '../identity-presence.mjs';
import { actionDigest, verifyPresence } from '../owner-presence.mjs';

const now = 2_000_000_000_000;
const seconds = now / 1000;
const action = 'Approve exact UTF-8: café 🐾';
const nonce = 'saved-daemon-nonce';
function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const payload = { v: 1, aud: 'agent-bot-owner', kind: 'presence', action: actionDigest(action), nonce,
    iat: seconds, exp: seconds + 120 };
  const signed = (text, padded = false) => {
    const segment = Buffer.from(text).toString(padded ? 'base64' : 'base64url');
    return `p1.${segment}.${sign(null, Buffer.from(segment), privateKey).toString('base64url')}`;
  };
  return { payload, signed, options: { key, action, nonce, now } };
}

test('public identity entry and legacy entry share the same pure verifier and exact action hash', () => {
  assert.deepEqual(Object.keys(published).sort(), ['actionDigest', 'verifyPresence']);
  assert.equal(published.actionDigest, actionDigest);
  assert.equal(published.verifyPresence, verifyPresence);
  assert.notEqual(actionDigest(action), actionDigest(action.normalize('NFD')));
  const { payload, signed, options } = fixture();
  assert.deepEqual(published.verifyPresence(signed(JSON.stringify(payload)), options), payload);
});

test('p1 retains signed-segment and original payload decoding rather than new canonical JSON rules', () => {
  const { payload, signed, options } = fixture();
  const original = { extra: 'existing p1 fields remain intact', ...payload };
  const text = JSON.stringify(original, null, 2) + '\n';
  const token = signed(text, true);
  assert.deepEqual(published.verifyPresence(token, options), original);
  // The signature authenticates the encoded segment, not decoded JSON bytes.
  const parts = token.split('.');
  parts[1] = Buffer.from(parts[1], 'base64').toString('base64url');
  if (parts[1] === token.split('.')[1]) parts[1] += '=';
  assert.throws(() => published.verifyPresence(parts.join('.'), options), { code: 'presence-invalid' });
  assert.throws(() => published.verifyPresence(token, { ...options, action: action.normalize('NFD') }), { code: 'presence-invalid' });
  assert.throws(() => published.verifyPresence(token, { ...options, nonce: nonce + 'x' }), { code: 'presence-invalid' });
});

test('public verifier keeps maximum lifetime and inclusive whole-second skew boundaries', () => {
  const { payload, signed, options } = fixture();
  const check = (changes = {}, at = now) => published.verifyPresence(signed(JSON.stringify({ ...payload, ...changes })), { ...options, now: at });
  assert.equal(check().exp, seconds + 120);
  assert.equal(check({}, (seconds + 150) * 1000 + 999).exp, seconds + 120);
  assert.throws(() => check({}, (seconds + 151) * 1000), { code: 'presence-invalid' });
  check({ iat: seconds + 30, exp: seconds + 150 });
  assert.throws(() => check({ iat: seconds + 31, exp: seconds + 151 }), { code: 'presence-invalid' });
  assert.throws(() => check({ exp: seconds + 121 }), { code: 'presence-invalid' });
});

test('public verification closure has no custody or prompt dependencies', () => {
  const entry = readFileSync(new URL('../identity-presence.mjs', import.meta.url), 'utf8');
  const leaf = readFileSync(new URL('../identity/presence-verifier.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...entry.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1]), ['./identity/presence-verifier.mjs']);
  assert.deepEqual([...leaf.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(m => m[1]), ['node:crypto']);
  assert.doesNotMatch(entry + leaf, /\bimport\s*\(|\brequire\s*\(/);
});
