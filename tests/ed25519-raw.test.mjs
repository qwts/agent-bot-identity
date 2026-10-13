// The tests' raw Ed25519 key helper (#1111): the SPKI DER export's last 32
// bytes are exactly a JWK `x`, so tests can avoid Node 20's JWK export abort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { rawEd25519 } from './helpers/ed25519-raw.mjs';

test('the raw Ed25519 key from SPKI DER is the JWK x, and other keys refuse', () => {
  for (let i = 0; i < 8; i += 1) {
    const { publicKey } = generateKeyPairSync('ed25519');
    assert.equal(rawEd25519(publicKey), publicKey.export({ format: 'jwk' }).x);
  }
  // Another key type refuses, including X25519, whose SPKI is also 44 bytes.
  for (const pair of [generateKeyPairSync('ec', { namedCurve: 'P-256' }), generateKeyPairSync('x25519')]) {
    assert.throws(() => rawEd25519(pair.publicKey), /not an Ed25519 SPKI public key/);
  }
});
