// Draft, disabled producer-owned validation of daemon slot 14,
// local-lifecycle-outcome (agent-comms#77). The vectors are ours, generated
// from this repo's codec and kept here for the agent-comms coordinator: each
// carries its graph context, exact record bytes, their SHA-256 and the SHA-256
// of the daemon slot-14 frame for the fixed namespace and request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../canonical-json.mjs';
import { encodeDaemonJournalFrame } from '../identity/owner-decision-journal-frame.mjs';
import { LOCAL_OUTCOME_CAP, validateLocalLifecycleOutcome } from '../identity/owner-decision-local-outcome.mjs';

const URL_ = new URL('./fixtures/owner-decisions/local-lifecycle-outcome-v1-draft.json', import.meta.url);
const SHA256 = '066548f37d074169c3bdfa3e7f956747142fadb6b5500b869bfcdbff31265551';
const fixture = JSON.parse(readFileSync(URL_, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const outcome = (bytes, context) => { try { validateLocalLifecycleOutcome(bytes, context); return 'valid'; } catch (error) { return error.reason; } };

test('the draft vectors are pinned and every one gives its expected result', () => {
  assert.equal(sha256(readFileSync(URL_)), SHA256);
  assert.equal(fixture.slot, 'local-lifecycle-outcome'); assert.equal(fixture.cap, LOCAL_OUTCOME_CAP);
  assert.equal(fixture.vectors.length, 37);
  assert.equal(fixture.vectors.filter(({ expected }) => expected === 'valid').length, 13);
  for (const vector of fixture.vectors) {
    const bytes = Buffer.from(vector.canonicalJson);
    assert.equal(bytes.length, vector.utf8Bytes, vector.id); assert.equal(sha256(bytes), vector.sha256, vector.id);
    assert.equal(outcome(bytes, vector.context), vector.expected, vector.id);
    const frame = encodeDaemonJournalFrame(bytes, { namespaceDigest: fixture.frame.namespaceDigest, requestId: fixture.frame.requestId, slot: 'local-lifecycle-outcome' });
    assert.equal(sha256(frame), vector.frameSha256, vector.id);
  }
});

// Every graph phase allows exactly the outcomes the effect-outcomes-v1 mapping
// and the lifecycle permit, and nothing else.
test('each phase admits exactly its own findings', () => {
  const base = fixture.vectors.find(({ id }) => id === 'applied-applied');
  const record = JSON.parse(base.canonicalJson);
  const acceptance = base.context.acceptance, receipt = base.context.receiptDigest, digest = 'd'.repeat(64);
  const contexts = {
    admitted: { phase: 'admitted', acceptance, receiptDigest: null, effectDigest: null },
    prepared: { phase: 'prepared', acceptance, receiptDigest: null, effectDigest: null },
    authorizing: { phase: 'authorizing', acceptance, receiptDigest: receipt, effectDigest: null },
    released: { phase: 'released', acceptance, receiptDigest: receipt, effectDigest: null },
    indeterminate: { phase: 'indeterminate', acceptance, receiptDigest: receipt, effectDigest: null },
    applied: { phase: 'applied', acceptance, receiptDigest: receipt, effectDigest: digest },
  };
  const findings = [['applied', 'applied', digest], ['refused', 'validation-refused', null], ['refused', 'authority-refused', null],
    ['refused', 'deadline-expired', null], ['refused', 'storage-refused', null], ['cancelled', 'cancelled', null], ['expired', 'deadline-expired', null],
    ['indeterminate', 'effect-uncertain', null]];
  const allowed = {
    admitted: ['refused:validation-refused', 'refused:authority-refused', 'refused:deadline-expired', 'cancelled:cancelled', 'expired:deadline-expired'],
    prepared: ['refused:validation-refused', 'refused:authority-refused', 'refused:deadline-expired', 'cancelled:cancelled', 'expired:deadline-expired'],
    authorizing: ['refused:validation-refused', 'refused:authority-refused', 'refused:deadline-expired', 'expired:deadline-expired'],
    released: [], indeterminate: ['indeterminate:effect-uncertain'], applied: ['applied:applied'],
  };
  for (const [phase, context] of Object.entries(contexts)) {
    const accepted = findings.filter(([state, code, effectDigest]) => outcome(Buffer.from(canonicalJson({ ...record, state, receiptDigest: context.receiptDigest,
      outcome: { code, effectDigest } })), context) === 'valid').map(([state, code]) => `${state}:${code}`);
    assert.deepEqual(accepted, allowed[phase], phase);
  }
  // Every final-refusal reason maps exactly through effect-outcomes-v1.
  for (const [reason, code] of [['expired', 'deadline-expired'], ['expected-state-changed', 'validation-refused'], ['target-unavailable', 'validation-refused'],
    ['storage-unavailable', 'storage-refused'], ['trust-unavailable', 'authority-refused']]) {
    const context = { phase: 'refused', acceptance, receiptDigest: receipt, effectDigest: digest, refusalCode: reason };
    assert.equal(outcome(Buffer.from(canonicalJson({ ...record, state: 'refused', outcome: { code, effectDigest: digest } })), context), 'valid', reason);
  }
});

test('an inconsistent context refuses before any record is read', () => {
  const base = fixture.vectors.find(({ id }) => id === 'applied-applied');
  const bytes = Buffer.from(base.canonicalJson), c = base.context;
  for (const context of [null, { ...c, phase: 'done' }, { ...c, acceptance: { ...c.acceptance, daemonEpoch: 0 } }, { ...c, effectDigest: null },
    { ...c, phase: 'indeterminate' }, { ...c, phase: 'refused' }, { ...c, phase: 'prepared', effectDigest: null }, { ...c, refusalCode: 'expired' },
    { ...c, receiptDigest: 'x' }]) {
    assert.equal(outcome(bytes, context), 'owner-outcome-context', JSON.stringify(context));
  }
  assert.equal(outcome(Buffer.alloc(LOCAL_OUTCOME_CAP + 1, 0x20), c), 'owner-outcome-encoding');
  assert.equal(outcome('{}', c), 'owner-outcome-encoding');
});
