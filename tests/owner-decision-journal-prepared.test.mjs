// Disabled daemon prepared-response composition (#1007) against agent-comms
// 0686f2c (#204). The eight preparedWrapperBounds vectors in the vendored
// budget fixture are the broker's conservative maximal wrappers; the daemon
// must compose exactly their challenge and stage from the same inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../canonical-json.mjs';
import { PREPARED_WRAPPER_CAP, composeOwnerDecisionPrepared } from '../identity/owner-decision-prepared.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/owner-decisions/journal-budget-v1.json', import.meta.url), 'utf8'));
const vectors = fixture.preparedWrapperBounds.records;
const namespaceDigest = 'a'.repeat(64);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = (reason, code = 'bad-request') => ({ reason, code });

// The saved admission behind one vector's challenge.
function inputs({ action, record: { challenge, stage } }, overrides = {}) {
  const actionBytes = Buffer.from(canonicalJson(action));
  const acceptance = {
    v: 1, kind: 'acceptance', requestId: challenge.requestId, principal: challenge.principal, account: challenge.account,
    soul: challenge.soul, operation: challenge.operation, payloadDigest: challenge.payloadDigest, namespaceDigest,
    acceptedAt: challenge.acceptedAt, daemonKey: challenge.daemonKey, daemonEpoch: challenge.daemonEpoch, watchId: challenge.watchId,
    reservationBytes: 524288,
  };
  return { actionBytes, acceptanceBytes: Buffer.from(canonicalJson(acceptance)), namespaceDigest, stage, nonce: challenge.nonce,
    preparedAt: challenge.preparedAt, now: challenge.preparedAt, ...overrides };
}

test('all eight shared prepared-wrapper vectors compose to their exact challenge, stage and wrapper bytes', () => {
  assert.equal(vectors.length, 8);
  assert.deepEqual(vectors.map(({ id }) => id), ['approve', 'reject', 'adopt', 'edit', 'off', 'on', 'resume', 'webhook']);
  for (const vector of vectors) {
    const composed = composeOwnerDecisionPrepared(inputs(vector));
    assert.deepEqual(composed.challenge, vector.record.challenge, vector.id);
    assert.deepEqual(composed.stage, vector.record.stage);
    assert.equal(composed.challengeBytes.length, vector.challengeBytes);
    assert.equal(sha256(composed.challengeBytes), sha256(Buffer.from(canonicalJson(vector.record.challenge))));
    const wrapper = canonicalJson({ challenge: composed.challenge, stage: composed.stage, v: 1 });
    assert.equal(wrapper, vector.canonicalJson); assert.equal(sha256(Buffer.from(wrapper)), vector.sha256);
    assert.equal(Buffer.byteLength(wrapper), vector.utf8Bytes); assert.equal(vector.cap, PREPARED_WRAPPER_CAP);
    assert.deepEqual(composed.request, {
      op: 'owner-decision-prepared', requestId: vector.record.challenge.requestId, payloadDigest: vector.record.challenge.payloadDigest,
      daemonKey: vector.record.challenge.daemonKey, daemonEpoch: vector.record.challenge.daemonEpoch, watchId: vector.record.challenge.watchId,
      nonce: vector.record.challenge.nonce, preparedAt: vector.record.challenge.preparedAt, exp: vector.record.challenge.exp, stage: vector.record.stage,
    });
    // A duplicate composes byte-identical output: nothing is regenerated.
    assert(composeOwnerDecisionPrepared(inputs(vector)).challengeBytes.equals(composed.challengeBytes));
  }
});

// A small realistic vector, so each deadline branch can be the minimum.
function realistic({ staged = true, stageExpiresAt = 1_800_000_500, ...overrides } = {}) {
  const base = vectors.find(({ id }) => id === (staged ? 'adopt' : 'approve'));
  const action = { ...base.action, parameters: staged
    ? { stagingId: '11111111-1111-4111-8111-111111111111', packageDigest: 'b'.repeat(64), expectedRevision: `sha256:${'c'.repeat(64)}`, reason: 'Adopt' }
    : { proposalId: '22222222-2222-4222-8222-222222222222', expectedRevision: `sha256:${'c'.repeat(64)}`, reason: 'Approve' } };
  const actionBytes = Buffer.from(canonicalJson(action));
  const challenge = { ...base.record.challenge, payloadDigest: sha256(actionBytes), acceptedAt: 1_800_000_000 };
  const stage = staged ? { stagingId: '11111111-1111-4111-8111-111111111111', kind: 'package', contentDigest: 'b'.repeat(64), expiresAt: stageExpiresAt } : null;
  return inputs({ action, record: { challenge, stage } }, { preparedAt: 1_800_000_010, now: 1_800_000_010, ...overrides });
}

test('exp is exactly the minimum of acceptedAt+180, preparedAt+180 and the stage expiry', () => {
  assert.equal(composeOwnerDecisionPrepared(realistic({ stageExpiresAt: 1_800_009_999 })).challenge.exp, 1_800_000_180);
  assert.equal(composeOwnerDecisionPrepared(realistic({ stageExpiresAt: 1_800_000_100 })).challenge.exp, 1_800_000_100);
  assert.equal(composeOwnerDecisionPrepared(realistic({ staged: false })).challenge.exp, 1_800_000_180);
  // preparedAt before acceptedAt (within skew) makes its own window the minimum.
  assert.equal(composeOwnerDecisionPrepared(realistic({ staged: false, preparedAt: 1_799_999_990, now: 1_800_000_000 })).challenge.exp, 1_800_000_170);
});

test('deadline and clock-window violations are preparation-stale, never an extended deadline', () => {
  const stale = refused('owner-prepare-stale', 'preparation-stale');
  for (const overrides of [
    { now: 1_800_000_180 }, // the acceptance window has closed
    { now: 1_799_999_969, preparedAt: 1_799_999_990 }, // acceptedAt is more than 30 s ahead of now
    { preparedAt: 1_799_999_969 }, // preparedAt more than 30 s before acceptance
    { preparedAt: 1_800_000_041 }, // preparedAt more than 30 s ahead of now
    { stageExpiresAt: 1_800_000_010 }, // the stage has already expired
    { preparedAt: -1 }, { now: 1.5 }, { now: Number.MAX_SAFE_INTEGER },
  ]) assert.throws(() => composeOwnerDecisionPrepared(realistic(overrides)), stale, JSON.stringify(overrides));
});

test('the stage must be exactly the one the action names, or null when unstaged', () => {
  const staged = realistic(), unstaged = realistic({ staged: false });
  const stageRefusal = refused('owner-prepare-stage');
  assert.throws(() => composeOwnerDecisionPrepared({ ...unstaged, stage: staged.stage }), stageRefusal);
  assert.throws(() => composeOwnerDecisionPrepared({ ...staged, stage: null }), stageRefusal);
  for (const change of [{ stagingId: '33333333-3333-4333-8333-333333333333' }, { kind: 'webhook' }, { contentDigest: 'd'.repeat(64) },
    { expiresAt: -1 }, { expiresAt: '1800000500' }, { extra: true }]) {
    assert.throws(() => composeOwnerDecisionPrepared({ ...staged, stage: { ...staged.stage, ...change } }), stageRefusal, JSON.stringify(change));
  }
  const webhook = vectors.find(({ id }) => id === 'webhook');
  assert.throws(() => composeOwnerDecisionPrepared(inputs(webhook, { stage: { ...webhook.record.stage, kind: 'package' } })), stageRefusal);
});

test('the nonce and saved admission are exact', () => {
  const good = realistic(), raw = Buffer.from(good.nonce, 'base64url');
  for (const nonce of [`${good.nonce}=`, raw.toString('base64'), raw.subarray(0, 31).toString('base64url'), '', null]) {
    if (nonce === raw.toString('base64') && !/[+/=]/.test(nonce)) continue;
    assert.throws(() => composeOwnerDecisionPrepared({ ...good, nonce }), refused('owner-prepare-nonce'));
  }
  assert.throws(() => composeOwnerDecisionPrepared({ ...good, namespaceDigest: 'b'.repeat(64) }), refused('owner-prepare-admission'));
  assert.throws(() => composeOwnerDecisionPrepared({ ...good, actionBytes: Buffer.from(`${good.actionBytes} `) }), refused('owner-prepare-admission'));
});
