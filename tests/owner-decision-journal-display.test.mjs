// The owner-display rejection policy (agent-comms#77): agent-comms
// tests/fixtures/owner-decisions/display-rejections-v1.json at 62aaba9 (merged
// PR #221, reviewed signed head cb7b8e9), copied byte for byte (SHA-256
// 2c2c7b75...). Every Unicode
// 17.0.0 Cc, Cf, Zl and Zp scalar is refused in a reason and in the rebuilt
// display text; everything else is kept exactly, with no trimming or
// normalization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OWNER_DISPLAY_REJECTED_RANGES, decodeOwnerDecisionAction, ownerDecisionCanonical } from '../identity/owner-decision-action.mjs';

const FIXTURE_URL = new URL('./fixtures/owner-decisions/display-rejections-v1.json', import.meta.url);
const SOURCE_URL = new URL('./fixtures/owner-decisions/v1.json', import.meta.url);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
const source = JSON.parse(readFileSync(SOURCE_URL, 'utf8'));
const approve = JSON.parse(source.positive.find(({ id }) => id === 'approve').actionJson);
const withReason = (reason) => Buffer.from(ownerDecisionCanonical({ ...approve, parameters: { ...approve.parameters, reason } }));

test('the vendored policy is the pinned copy, bound to the unchanged action vectors and Unicode 17.0.0', () => {
  assert.equal(sha256(readFileSync(FIXTURE_URL)), '2c2c7b75cf105db6e66e04c4e8d0ddf9ca844905b40e09a23a8ea11e4a02dec2');
  assert.equal(fixture.sourceFixtureSha256, '70706e7327b90f8649b0b1f8baa7b59d2e4e8f6f1f33b674dc8472cb7eb951ac');
  assert.equal(sha256(readFileSync(SOURCE_URL)), fixture.sourceFixtureSha256);
  assert.equal(fixture.unicodeVersion, '17.0.0');
  assert.equal(fixture.unicodeSourceSha256, 'd62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e');
  assert.deepEqual(fixture.rejectedCategories, ['Cc', 'Cf', 'Zl', 'Zp']);
});

test('the production table is exactly the fixture\'s 25 rejected ranges', () => {
  assert.equal(OWNER_DISPLAY_REJECTED_RANGES.length, 25);
  assert.deepEqual(OWNER_DISPLAY_REJECTED_RANGES.map(([first, last, category]) => ({ first, last, category })), fixture.rejectedRanges);
  assert(Object.isFrozen(OWNER_DISPLAY_REJECTED_RANGES) && OWNER_DISPLAY_REJECTED_RANGES.every(Object.isFrozen));
  // Sorted and disjoint, as the lookup assumes.
  for (let i = 1; i < OWNER_DISPLAY_REJECTED_RANGES.length; i++) assert(OWNER_DISPLAY_REJECTED_RANGES[i][0] > OWNER_DISPLAY_REJECTED_RANGES[i - 1][1]);
});

test('every negative case refuses, in a reason and therefore in the display text', () => {
  assert.equal(fixture.negative.length, 19);
  for (const c of fixture.negative) {
    const code = c.scalar.codePointAt(0);
    assert.equal(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`, c.codePoint, c.id);
    assert(OWNER_DISPLAY_REJECTED_RANGES.some(([first, last, category]) => code >= first && code <= last && category === c.category), c.id);
    assert.throws(() => decodeOwnerDecisionAction(withReason(c.reason)), { code: 'invalid-owner-decision' }, c.id);
  }
});

test('every positive reason is accepted exactly as written', () => {
  assert.equal(fixture.positiveReasons.length, 7);
  for (const reason of fixture.positiveReasons) {
    const decoded = decodeOwnerDecisionAction(withReason(reason));
    assert.equal(decoded.action.parameters.reason, reason);
    assert(decoded.summary.endsWith(`reason=${JSON.stringify(reason)}`), JSON.stringify(reason));
    assert(decoded.actionText.includes(JSON.stringify(reason)));
  }
});
