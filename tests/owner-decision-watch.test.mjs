// Owner-decision watch identity (agent-comms#77, C0): pure checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  OWNER_DECISION_EVENTS, daemonKeyFromPublicKeyPem, ownerDecisionIntakeBound, watchIdentityFromReady,
} from '../owner-decision-watch.mjs';

const { publicKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const daemonKey = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const ready = { event: 'ready', watchId: '11111111-1111-4111-8111-111111111111', daemonEpoch: 3, daemonKey };

test('the expected daemonKey is SHA-256 of our own vouch SPKI DER', () => {
  assert.equal(daemonKeyFromPublicKeyPem(pem), daemonKey);
});

test('a ready event binds only a complete, well-formed identity carrying our daemonKey', () => {
  assert.deepEqual(watchIdentityFromReady(ready, { daemonKey }), { watchId: ready.watchId, daemonEpoch: 3, daemonKey });
  assert(Object.isFrozen(watchIdentityFromReady(ready, { daemonKey })));
  // Extra ready fields are not part of the identity.
  assert.deepEqual(watchIdentityFromReady({ ...ready, extra: 1 }, { daemonKey }), { watchId: ready.watchId, daemonEpoch: 3, daemonKey });
  // Silent: an old broker's bare ready, a non-object, or owner intake not configured here.
  for (const event of [{ event: 'ready' }, { ok: true }, null, 'ready']) assert.equal(watchIdentityFromReady(event, { daemonKey }), null);
  for (const options of [{}, { daemonKey: null }]) assert.equal(watchIdentityFromReady(ready, options), null);
  // Diagnosable: partial or malformed fields, and above all a daemonKey that is not ours.
  const diagnosable = { code: 'owner-watch-identity' };
  for (const event of [{ ...ready, watchId: undefined }, { event: 'ready', watchId: ready.watchId }, { ...ready, watchId: `${ready.watchId}x` },
    { ...ready, watchId: '11111111-1111-1111-8111-111111111111' }, { ...ready, daemonEpoch: 0 }, { ...ready, daemonEpoch: '3' },
    { ...ready, daemonEpoch: 1.5 }, { ...ready, daemonKey: daemonKey.toUpperCase() }]) {
    assert.throws(() => watchIdentityFromReady(event, { daemonKey }), diagnosable, JSON.stringify(event));
  }
  assert.throws(() => watchIdentityFromReady({ ...ready, daemonKey: 'f'.repeat(64) }, { daemonKey }), { code: 'owner-watch-identity', message: /does not match/ });
  assert.throws(() => watchIdentityFromReady(ready, { daemonKey: 'x' }), diagnosable);
});

test('owner-decision intake is bound to exactly the socket identity', () => {
  const identity = watchIdentityFromReady(ready, { daemonKey });
  assert.deepEqual(OWNER_DECISION_EVENTS, ['owner-decision-prepare', 'owner-decision', 'owner-decision-cancel']);
  for (const name of OWNER_DECISION_EVENTS) {
    const event = { event: name, requestId: 'r', watchId: ready.watchId, daemonEpoch: 3, daemonKey };
    assert.equal(ownerDecisionIntakeBound(event, identity), true, name);
    for (const change of [{ watchId: '22222222-2222-4222-8222-222222222222' }, { daemonEpoch: 4 }, { daemonEpoch: '3' },
      { daemonKey: 'f'.repeat(64) }, { watchId: undefined }]) {
      assert.equal(ownerDecisionIntakeBound({ ...event, ...change }, identity), false, `${name} ${JSON.stringify(change)}`);
    }
    assert.equal(ownerDecisionIntakeBound(event, null), false);
  }
  assert.equal(ownerDecisionIntakeBound({ event: 'wake', watchId: ready.watchId, daemonEpoch: 3, daemonKey }, identity), false);
});
