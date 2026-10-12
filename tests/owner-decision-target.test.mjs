// Disabled owner-decision prepare-side target resolution (agent-comms#77):
// every target the daemon cannot act for is the same early refusal, after the
// same local reads, so results never reveal whether or whose a soul is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGET_REFUSAL, resolveOwnerDecisionTarget } from '../owner-decision-target.mjs';

const soul = 'agent_11111111-1111-4111-8111-111111111111';
const daemonAccount = 'worker';
const liveRow = { id: soul, status: 'active' };
const liveRecord = { id: soul, status: 'active' };

// Counts every local read, so each case can be shown to do the same work.
function run(request, options = {}) {
  const { row = liveRow, record = liveRecord, censusThrows = false, identityThrows = false } = options;
  const account = Object.hasOwn(options, 'account') ? options.account : daemonAccount;
  const reads = { census: [], identity: [] };
  const result = resolveOwnerDecisionTarget(request, {
    daemonAccount: account,
    census: (id) => { reads.census.push(id); if (censusThrows || row === null) throw new Error(`no population record for ${id}`); return row; },
    identityRead: (id) => { reads.identity.push(id); if (identityThrows || record === null) throw new Error(`could not read Agent ID ${id}`); return record; },
  });
  return { result, reads };
}

test('a live local soul of this account resolves', () => {
  const { result, reads } = run({ account: daemonAccount, soul });
  assert.deepEqual(result, { state: 'resolved', target: { account: daemonAccount, soul } });
  assert.deepEqual(reads, { census: [soul], identity: [soul] });
  // Finalized identities are live too; resolution never consults hub membership.
  assert.equal(run({ account: daemonAccount, soul }, { record: { id: soul, status: 'finalized' }, row: { id: soul, status: 'active', comms: false } }).result.state, 'resolved');
});

test('every unavailable target is the identical refusal after identical local work', () => {
  const cases = {
    'missing from the census': [{ account: daemonAccount, soul }, { row: null }],
    'census unreadable': [{ account: daemonAccount, soul }, { censusThrows: true }],
    'retired in the census': [{ account: daemonAccount, soul }, { row: { id: soul, status: 'retired' } }],
    'missing identity': [{ account: daemonAccount, soul }, { record: null }],
    'identity unreadable': [{ account: daemonAccount, soul }, { identityThrows: true }],
    'retired identity': [{ account: daemonAccount, soul }, { record: { id: soul, status: 'retired' } }],
    'identity for another soul': [{ account: daemonAccount, soul }, { record: { id: 'agent_22222222-2222-4222-8222-222222222222', status: 'active' } }],
    'another account': [{ account: 'someone-else', soul }, {}],
    'no daemon account': [{ account: daemonAccount, soul }, { account: undefined }],
    'malformed soul': [{ account: daemonAccount, soul: 'agent_not-a-uuid' }, {}],
    'missing soul': [{ account: daemonAccount }, {}],
    'malformed account': [{ account: '', soul }, {}],
  };
  const seen = new Set();
  for (const [name, [request, options]] of Object.entries(cases)) {
    const { result, reads } = run(request, options);
    assert.equal(result, TARGET_REFUSAL, name);
    seen.add(JSON.stringify(result));
    assert.equal(reads.census.length, 1, `${name}: one census read`);
    assert.equal(reads.identity.length, 1, `${name}: one identity read`);
  }
  assert.equal(seen.size, 1);
  assert.deepEqual(JSON.parse([...seen][0]), { state: 'refused', receiptDigest: null, outcome: { code: 'validation-refused', effectDigest: null } });
  assert(Object.isFrozen(TARGET_REFUSAL) && Object.isFrozen(TARGET_REFUSAL.outcome));
});

test('a malformed Agent ID still does the same reads, of a fixed placeholder, never of its input', () => {
  const { reads } = run({ account: daemonAccount, soul: '../../etc/passwd' });
  assert.deepEqual(reads.census, ['agent_00000000-0000-4000-8000-000000000000']);
  assert.deepEqual(reads.identity, ['agent_00000000-0000-4000-8000-000000000000']);
});
