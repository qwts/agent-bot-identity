// Disabled owner-decision prepare-side target resolution (agent-comms#77):
// every target the daemon cannot act for is the same early refusal, and the
// production resolver takes no injectable reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TARGET_REFUSAL, classifyOwnerDecisionTarget, resolveOwnerDecisionTarget } from '../owner-decision-target.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { mintAgentIdentity, retireAgentIdentity } from '../identity/agent-identity.mjs';

const soul = 'agent_11111111-1111-4111-8111-111111111111';
const daemonAccount = 'worker';
const row = { id: soul, status: 'active' };
const record = { id: soul, status: 'active' };

test('the classifier resolves only a live local soul of this account', () => {
  assert.deepEqual(classifyOwnerDecisionTarget({ account: daemonAccount, soul }, { daemonAccount, row, record }),
    { state: 'resolved', target: { account: daemonAccount, soul } });
  assert.equal(classifyOwnerDecisionTarget({ account: daemonAccount, soul }, { daemonAccount, row: { ...row, comms: false }, record: { ...record, status: 'finalized' } }).state, 'resolved');
});

test('every unavailable target classifies to the identical refusal', () => {
  const cases = {
    'missing from the census': [{ account: daemonAccount, soul }, { row: null }],
    'retired in the census': [{ account: daemonAccount, soul }, { row: { ...row, status: 'retired' } }],
    'missing identity': [{ account: daemonAccount, soul }, { record: null }],
    'retired identity': [{ account: daemonAccount, soul }, { record: { ...record, status: 'retired' } }],
    'identity for another soul': [{ account: daemonAccount, soul }, { record: { id: 'agent_22222222-2222-4222-8222-222222222222', status: 'active' } }],
    'another account': [{ account: 'someone-else', soul }, {}],
    'no daemon account': [{ account: daemonAccount, soul }, { daemonAccount: undefined }],
    'malformed soul': [{ account: daemonAccount, soul: 'agent_not-a-uuid' }, {}],
    'missing soul': [{ account: daemonAccount }, {}],
    'malformed account': [{ account: '', soul }, {}],
  };
  for (const [name, [request, overrides]] of Object.entries(cases)) {
    assert.equal(classifyOwnerDecisionTarget(request, { daemonAccount, row, record, ...overrides }), TARGET_REFUSAL, name);
  }
  assert.deepEqual(TARGET_REFUSAL, { state: 'refused', receiptDigest: null, outcome: { code: 'validation-refused', effectDigest: null } });
  assert(Object.isFrozen(TARGET_REFUSAL) && Object.isFrozen(TARGET_REFUSAL.outcome));
});

test('the production resolver takes no injectable read: only its fixed census and identity reads', (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-target-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'population.json'), stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const mint = (id) => mintAgentIdentity({ useGithub: false, gate: () => false, appSlug: null, harness: 'codex', transcript: { provider: 'codex', id: 't' },
    stateDir, idFactory: () => id, now: () => new Date('2026-10-12T00:00:00.000Z') });
  const census = (id, status = 'active') => upsertSoul({ id, appSlug: null, parentId: null, status, spacePath: `/spaces/${id}`, worktree: null,
    worktrees: [], transcriptLocator: null, lastSeen: '2026-10-12T00:00:00.000Z' }, { file });
  const live = soul, retired = 'agent_33333333-3333-4333-8333-333333333333', notInCensus = 'agent_44444444-4444-4444-8444-444444444444';
  mint(live); census(live);
  mint(retired); census(retired); retireAgentIdentity(retired, { stateDir });
  mint(notInCensus);
  const resolve = (request, options = {}) => resolveOwnerDecisionTarget(request, { daemonAccount, file, stateDir, ...options });
  assert.deepEqual(resolve({ account: daemonAccount, soul: live }), { state: 'resolved', target: { account: daemonAccount, soul: live } });
  for (const request of [{ account: daemonAccount, soul: retired }, { account: daemonAccount, soul: notInCensus },
    { account: daemonAccount, soul: 'agent_55555555-5555-4555-8555-555555555555' }, { account: 'someone-else', soul: live },
    { account: daemonAccount, soul: '../../etc/passwd' }]) {
    assert.equal(resolve(request), TARGET_REFUSAL, JSON.stringify(request));
  }
  // Read functions passed as options are ignored, never called.
  let called = false;
  const spy = () => { called = true; return record; };
  assert.equal(resolve({ account: daemonAccount, soul: retired }, { census: spy, identityRead: spy }), TARGET_REFUSAL);
  assert.equal(called, false);
});
