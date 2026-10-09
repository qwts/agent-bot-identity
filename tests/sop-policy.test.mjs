import test from 'node:test';
import assert from 'node:assert/strict';
import { ACP_SPAWN_REGISTRY } from '../acp-registry.mjs';
import { parseSopPolicy, evaluateSopPolicy, SOP_POLICY_LIMITS } from '../sop-policy.mjs';
const options = { canonicalHarnesses: Object.keys(ACP_SPAWN_REGISTRY) };
const rule = (extra = {}) => ({ id: 'no-codex', event: 'before-launch', decision: 'deny', when: { harnesses: ['codex'] }, reason: 'Codex is unavailable under this policy.', ...extra });
const document = rules => ({ schemaVersion: 1, rules });
const parse = value => parseSopPolicy(JSON.stringify(value), options);
const evaluate = (value, harness = 'codex') => evaluateSopPolicy(value, { event: 'before-launch', harness }, options);

test('a matching restriction denies; no match only continues product checks', () => {
  const policy = parse(document([rule()]));
  assert.equal(evaluate(policy).decision, 'deny');
  assert.equal(evaluate(policy).ruleId, 'no-codex');
  assert.deepEqual(evaluate(policy, 'claude'), { decision: 'continue', event: 'before-launch', ruleId: null, reason: null });
  assert.equal(evaluate(parse(document([]))).decision, 'continue');
  const all = parse(document([rule({ id: 'all', when: {} }), rule()]));
  assert.equal(evaluate(all).ruleId, 'all');
  assert.equal(evaluate(all, 'claude').ruleId, 'all');
});

test('all aliases or unknown execution keys refuse unless the host resolved them first', () => {
  const policy = parse(document([rule({ when: { harnesses: ['claude'] } })]));
  assert.equal(evaluate(policy, 'claude').decision, 'deny');
  // claude-code is an identity label, not the actual ACP execution key.
  for (const harness of ['claude-code', 'Claude', undefined, '', 'vscode']) {
    assert.throws(() => evaluate(policy, harness === undefined ? null : harness), error => error.code === 'policy-context-invalid');
  }
  assert.throws(() => parse(document([rule({ when: { harnesses: ['claude-code'] } })])), /canonical execution keys/);
  // Distinct execution keys remain distinct if a future host supports both.
  const distinct = { canonicalHarnesses: ['copilot', 'vscode'] };
  const value = parseSopPolicy(JSON.stringify(document([rule({ when: { harnesses: ['copilot'] } })])), distinct);
  assert.equal(evaluateSopPolicy(value, { event: 'before-launch', harness: 'copilot' }, distinct).decision, 'deny');
  assert.equal(evaluateSopPolicy(value, { event: 'before-launch', harness: 'vscode' }, distinct).decision, 'continue');
});

test('unsupported events and missing host context never quietly allow', () => {
  for (const event of ['before-bind', 'before-spawn', 'before-send', 'before-commit', 'before-push', 'wake', 'resume', 'unknown']) {
    assert.throws(() => parse(document([rule({ event })])), error => error.code === 'policy-event-unsupported');
    assert.throws(() => evaluateSopPolicy(parse(document([])), { event, harness: 'codex' }, options), error => error.code === 'policy-event-unsupported');
  }
  for (const canonicalHarnesses of [undefined, [], ['codex', 'codex'], ['Not a key']]) {
    assert.throws(() => parseSopPolicy(JSON.stringify(document([])), { canonicalHarnesses }), error => error.code === 'policy-context-invalid');
  }
});

test('policy rejects grants, code, unknown fields, conditions and malformed rules', () => {
  const bad = [null, [], {}, { ...document([]), schemaVersion: 2 }, { ...document([]), command: 'touch CANARY' },
    document([rule({ decision: 'allow' })]), document([rule({ script: 'touch CANARY' })]),
    document([rule({ when: { regex: '.*' } })]), document([rule({ when: { harnesses: [] } })]),
    document([rule({ when: { harnesses: ['codex', 'codex'] } })]), document([rule(), rule()]),
    document([rule({ id: '../escape' })]), document([rule({ reason: 'line\nline' })]),
    document([rule({ reason: 'x'.repeat(SOP_POLICY_LIMITS.reason + 1) })]),
    document([rule({ reason: '' })]), document([rule({ when: null })])];
  for (const value of bad) assert.throws(() => parse(value), error => error.code === 'policy-invalid');
  const missing = rule(); delete missing.reason;
  assert.throws(() => parse(document([missing])), /missing or unsupported fields/);
});

test('byte, count and UTF-8 boundaries are strict and parser errors do not reflect input', () => {
  for (const input of [' '.repeat(SOP_POLICY_LIMITS.bytes + 1), Buffer.from([0xff]), Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), '{CANARY', '\ud800']) {
    assert.throws(() => parseSopPolicy(input, options), error => error.code === 'policy-invalid' && !error.message.includes('CANARY'));
  }
  assert.throws(() => parse(document(Array.from({ length: 65 }, (_, i) => rule({ id: `rule-${i}` })))), /bound/);
  const text = JSON.stringify(document([]));
  assert.equal(parseSopPolicy(text + ' '.repeat(SOP_POLICY_LIMITS.bytes - Buffer.byteLength(text)), options).rules.length, 0);
});

test('parsed data is frozen and evaluator revalidates caller-supplied objects', () => {
  const input = document([rule()]);
  const parsed = parse(input);
  assert.throws(() => { parsed.rules[0].when.harnesses.push('claude'); }, TypeError);
  input.rules[0].decision = 'allow';
  assert.equal(evaluate(parsed).decision, 'deny');
  assert.throws(() => evaluate(input), /only deny/);
});
