// Disabled owner-decision prepare-side target resolution (agent-comms#77):
// every target the daemon cannot act for is the same early refusal, after
// exactly one census read and one identity read, through the only export.
// Reads are counted by instrumenting the node builtins (never by injecting
// anything into production code): the census opens the population file with
// fs.openSync (non-blocking, then reads that descriptor), and the identity
// read runs the identity entry with
// child_process.execFileSync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as target from '../owner-decision-target.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { mintAgentIdentity, retireAgentIdentity } from '../identity/agent-identity.mjs';

const { TARGET_REFUSAL, resolveOwnerDecisionTarget } = target;
const daemonAccount = 'worker';
const PLACEHOLDER = 'agent_00000000-0000-4000-8000-000000000000';
const ids = {
  live: 'agent_11111111-1111-4111-8111-111111111111',
  finalized: 'agent_22222222-2222-4222-8222-222222222222',
  retiredIdentity: 'agent_33333333-3333-4333-8333-333333333333',
  retiredCensus: 'agent_44444444-4444-4444-8444-444444444444',
  notInCensus: 'agent_55555555-5555-4555-8555-555555555555',
  unknown: 'agent_66666666-6666-4666-8666-666666666666',
  unreadableIdentity: 'agent_77777777-7777-4777-8777-777777777777',
};

// A scratch census and identity state with one soul per case.
function fixtures(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'owner-target-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'population.json'), stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const mint = (id) => mintAgentIdentity({ useGithub: false, gate: () => false, appSlug: null, harness: 'codex',
    transcript: { provider: 'codex', id: 't' }, stateDir, idFactory: () => id, now: () => new Date('2026-10-12T00:00:00.000Z') });
  const census = (id, status = 'active') => upsertSoul({ id, appSlug: null, parentId: null, status, spacePath: `/spaces/${id}`,
    worktree: null, worktrees: [], transcriptLocator: null, lastSeen: '2026-10-12T00:00:00.000Z' }, { file });
  for (const id of [ids.live, ids.finalized, ids.retiredIdentity, ids.retiredCensus, ids.unreadableIdentity]) { mint(id); census(id); }
  mint(ids.notInCensus);
  retireAgentIdentity(ids.retiredIdentity, { stateDir });
  census(ids.retiredCensus, 'retired');
  // An identity record that cannot be parsed.
  const record = fs.readdirSync(stateDir, { recursive: true }).map(String).find((name) => name.includes(ids.unreadableIdentity.slice(6)));
  fs.writeFileSync(path.join(stateDir, record), '{not json');
  return { file, stateDir };
}

// Runs the real resolver while counting its census and identity reads.
function counted({ file, stateDir }, request, options = {}) {
  const reads = { census: 0, identity: [] };
  const openSync = fs.openSync, execFileSync = childProcess.execFileSync;
  fs.openSync = function counting(target, ...rest) {
    if (target === file) reads.census++;
    return openSync.call(this, target, ...rest);
  };
  childProcess.execFileSync = function counting(command, args, options) {
    if (Array.isArray(args) && args.at(-1) === 'read') reads.identity.push(JSON.parse(options.input).id);
    return execFileSync.call(this, command, args, options);
  };
  syncBuiltinESMExports();
  try {
    return { result: resolveOwnerDecisionTarget(request, { daemonAccount, file, stateDir, ...options }), reads };
  } finally {
    fs.openSync = openSync; childProcess.execFileSync = execFileSync;
    syncBuiltinESMExports();
  }
}

test('only the resolver that performs its own reads is exported', () => {
  assert.deepEqual(Object.keys(target).sort(), ['TARGET_REFUSAL', 'resolveOwnerDecisionTarget', 'resolveOwnerDecisionTargetLocked']);
});

test('a live local soul of this account resolves after one census and one identity read', (t) => {
  const state = fixtures(t);
  for (const soul of [ids.live, ids.finalized]) {
    const { result, reads } = counted(state, { account: daemonAccount, soul });
    assert.deepEqual(result, { state: 'resolved', target: { account: daemonAccount, soul } });
    assert.deepEqual(reads, { census: 1, identity: [soul] });
  }
});

test('every unavailable target is the identical refusal after exactly the same reads', (t) => {
  const state = fixtures(t);
  const cases = {
    'retired identity': { account: daemonAccount, soul: ids.retiredIdentity },
    'retired in the census': { account: daemonAccount, soul: ids.retiredCensus },
    'identity but not in the census': { account: daemonAccount, soul: ids.notInCensus },
    'unknown soul': { account: daemonAccount, soul: ids.unknown },
    'unreadable identity record': { account: daemonAccount, soul: ids.unreadableIdentity },
    'another account': { account: 'someone-else', soul: ids.live },
    'malformed account': { account: '', soul: ids.live },
    'malformed soul': { account: daemonAccount, soul: '../../etc/passwd' },
    'missing soul': { account: daemonAccount },
  };
  // No daemon account configured: the live soul still refuses identically.
  cases['no daemon account'] = [{ account: daemonAccount, soul: ids.live }, { daemonAccount: undefined }];
  for (const [name, entry] of Object.entries(cases)) {
    const [request, options] = Array.isArray(entry) ? entry : [entry, {}];
    const { result, reads } = counted(state, request, options);
    assert.equal(result, TARGET_REFUSAL, name);
    assert.equal(reads.census, 1, `${name}: one census read`);
    assert.equal(reads.identity.length, 1, `${name}: one identity read`);
  }
  assert.deepEqual(TARGET_REFUSAL, { state: 'refused', receiptDigest: null, outcome: { code: 'validation-refused', effectDigest: null } });
  assert(Object.isFrozen(TARGET_REFUSAL) && Object.isFrozen(TARGET_REFUSAL.outcome));
});

test('a malformed Agent ID reads the fixed placeholder, never its input', (t) => {
  const state = fixtures(t);
  for (const soul of ['../../etc/passwd', 'agent_not-a-uuid', undefined, 42]) {
    assert.deepEqual(counted(state, { account: daemonAccount, soul }).reads, { census: 1, identity: [PLACEHOLDER] });
  }
});

test('an unreadable census refuses identically after the same reads', (t) => {
  const state = fixtures(t);
  fs.writeFileSync(state.file, '{not json');
  const { result, reads } = counted(state, { account: daemonAccount, soul: ids.live });
  assert.equal(result, TARGET_REFUSAL);
  assert.deepEqual(reads, { census: 1, identity: [ids.live] });
});
