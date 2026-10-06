import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSouls, recordSoulLaunch, setSoulPaused, showSoul, soulPaused, upsertSoul } from '../agent-population.mjs';
import { createColdWaker } from '../cold-wake.mjs';
import { createTurnRegistry, createWakePlane } from '../wake-plane.mjs';
import { createLaunchHandler } from '../daemon-launch.mjs';
import { HARNESS_SESSION_EVENT } from '../executor-contract.mjs';

const ID = 'agent_66666666-6666-4666-8666-666666666666';
const OTHER = 'agent_77777777-7777-4777-8777-777777777777';
const wake = { event: 'wake', agentId: ID, count: 1, cursor: 1, messageIds: ['m1'] };
const binding = { worktree: '/work/tree', file: '/work/tree/binding.json' };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-pause-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, file: path.join(home, 'population.json') };
}

test('population defaults paused to false and preserves it through lifecycle and launch updates', (t) => {
  const f = fixture(t);
  const record = { id: ID, name: 'pause-me', status: 'active', spacePath: f.home };
  upsertSoul(record, f);
  // Legacy rows acquire the default without a migration write.
  const legacy = JSON.parse(readFileSync(f.file, 'utf8'));
  delete legacy.souls[ID].paused;
  writeFileSync(f.file, JSON.stringify(legacy));
  assert.equal(showSoul(ID, f).paused, false);
  assert.equal(setSoulPaused(ID, true, f).paused, true);
  upsertSoul(record, f);
  recordSoulLaunch(ID, { comms: false }, f);
  assert.equal(showSoul(ID, f).paused, true);
  assert.equal(listSouls(f)[0].paused, true);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).souls[ID].paused, true);
  assert.equal(setSoulPaused(ID, false, f).paused, false);
  assert.throws(() => setSoulPaused(ID, 'yes', f), /must be a boolean/);
  assert.throws(() => upsertSoul({ ...record, paused: 'yes' }, f), /must be a boolean/);
  assert.throws(() => setSoulPaused(OTHER, false, f), /no population record/);
  assert.equal(soulPaused(OTHER, f), false);
  const future = JSON.parse(readFileSync(f.file, 'utf8'));
  future.schemaVersion = 2;
  writeFileSync(f.file, JSON.stringify(future));
  assert.throws(() => setSoulPaused(ID, true, f), /future schemaVersion/);
});

for (const lane of ['acp', 'resume', 'webhook']) {
  test(`paused ${lane} wake leaves the inbox untouched and resumes on the next poll`, async (t) => {
    const f = fixture(t);
    let paused = true;
    let runs = 0;
    let reads = 0;
    let acks = 0;
    const receipts = [];
    const cold = createColdWaker({ isPaused: () => paused,
      settings: { [ID]: lane === 'acp' ? true : { lane, policy: 'read-only' } },
      lookupBinding: () => binding, identities: () => ({ harness: 'codex' }),
      executor: async () => { runs++; return { reply: '' }; },
      webhook: async () => { runs++; },
      relay: { read: async () => { reads++; return acks ? [] : [{ id: 'm1', body: 'hello', from: { principal: 'owner' } }]; },
        ack: async () => { acks++; } },
      threads: { stateDir: f.home }, receipt: (r) => receipts.push(r),
    });
    assert.deepEqual(await cold(wake), { outcome: 'waiting', detail: 'soul is paused' });
    await cold.idle();
    assert.deepEqual([runs, reads, acks], [0, 0, 0]);
    assert.deepEqual(receipts, [{ event: 'cold-wake', agentId: ID, decision: 'paused' }]);
    paused = false;
    assert.equal((await cold(wake)).outcome, 'cold');
    await cold.idle();
    assert.equal(runs, 1);
    assert.equal(acks, lane === 'webhook' ? 0 : 1);
  });
}

test('wake plane suppresses warm delivery as well as cold and resume execution while paused', async () => {
  let paused = true;
  let sends = 0;
  const receipts = [];
  const plane = createWakePlane({ isPaused: () => paused,
    pool: { has: () => true, send: () => { sends++; return 1; } },
    receipt: (r) => receipts.push(r) });
  const reports = [];
  const ports = { report: async (r) => reports.push(r) };
  assert.equal((await plane(wake, ports)).outcome, 'waiting');
  assert.equal(sends, 0);
  assert.equal(receipts.at(-1).decision, 'paused');
  assert.equal(reports.at(-1).detail, 'soul is paused');
  paused = false;
  assert.equal((await plane(wake, ports)).outcome, 'warm');
  assert.equal(sends, 1);
});

test('pause during cold setup or an inbox read prevents execution and leaves the message unacked', async (t) => {
  const f = fixture(t);
  for (const phase of ['binding', 'read', 'brief']) {
    let paused = false;
    const entered = deferred();
    const proceed = deferred();
    const receipts = [];
    const cold = createColdWaker({ isPaused: () => paused, settings: { [ID]: true },
      lookupBinding: async () => { if (phase === 'binding') { entered.resolve(); await proceed.promise; } return binding; },
      identities: () => ({ harness: 'codex' }), executor: () => assert.fail('paused turn must not run'),
      relay: {
        read: async () => {
          if (phase === 'read') { entered.resolve(); await proceed.promise; }
          return [{ id: 'm1', body: 'hello', from: { principal: 'owner' }, ...(phase === 'brief' ? { kind: 'task-event' } : {}) }];
        },
        brief: async () => { entered.resolve(); await proceed.promise; return { turn: true, linked: false, prompt: 'task' }; },
        ack: () => assert.fail('paused message must stay unacked'),
      }, threads: { stateDir: f.home }, receipt: (r) => receipts.push(r),
    });
    const dispatched = cold(wake);
    await entered.promise;
    paused = true;
    proceed.resolve();
    await dispatched;
    await cold.idle();
    assert.ok(receipts.some((r) => r.decision === 'paused'), phase);
    assert.deepEqual(cold.busy(), []);
  }
});

test('resume lane uses the same pause guard, retains inbox messages and runs after resume', async () => {
  let paused = true;
  let runs = 0;
  let acked = false;
  const receipts = [];
  const plane = createWakePlane({ isPaused: () => paused,
    settings: { [ID]: { lane: 'resume', policy: 'read-only' } },
    pool: { has: () => false, send: () => 0 }, lookupSoul: () => binding,
    identities: () => ({ harness: 'codex' }),
    resumeExecutor: async ({ policy }) => { assert.equal(policy, 'read-only'); runs++; return { reply: '' }; },
    relay: { read: async () => acked ? [] : [{ id: 'm1', body: 'hello', from: { principal: 'owner' } }], ack: async () => { acked = true; } },
    receipt: (r) => receipts.push(r),
  });
  // The process HOME is isolated by the test runner command, including journals.
  const ports = { report: async () => {} };
  await plane(wake, ports);
  await plane.idle();
  assert.equal(runs, 0);
  assert.equal(acked, false);
  paused = false;
  await plane(wake, ports);
  await plane.idle();
  assert.equal(runs, 1);
  assert.equal(acked, true);
  assert.ok(receipts.some((r) => r.decision === 'paused'));
});

test('paused launches by ID or installed folder fail with soul-paused before provisioning; resume permits launch', async (t) => {
  const f = fixture(t);
  let paused = true;
  let executions = 0;
  let joins = 0;
  const reports = [];
  const launch = createLaunchHandler({ file: path.join(f.home, 'launch.json'), isPaused: () => paused,
    identities: () => ({ id: ID }), lookupBinding: () => binding,
    locatePackage: () => ({ status: 'installed', agentId: ID }),
    joinSoul: () => { joins++; },
    executorFor: () => async (input) => { executions++; input.appendEvent(HARNESS_SESSION_EVENT, { harnessSessionId: 'session' }); },
  });
  const ports = { account: 'owner', report: async (r) => reports.push(r) };
  for (const [index, target] of [{ soul: ID }, { package: '/soul' }].entries()) {
    await launch({ ...target, requestId: `r${index}`, account: 'owner', harness: 'codex' }, ports);
    assert.equal(reports.at(-1).status, 'failed');
    assert.equal(reports.at(-1).code, 'soul-paused');
  }
  assert.deepEqual([executions, joins], [0, 0]);
  paused = false;
  await launch({ soul: ID, requestId: 'resumed', account: 'owner', harness: 'codex' }, ports);
  assert.equal(reports.at(-1).status, 'launched');
  assert.deepEqual([executions, joins], [1, 1]);
});

test('turn registry checks persistent pause at execution time', async () => {
  let paused = true;
  const turns = createTurnRegistry({ isPaused: () => paused });
  const input = { invocation: { agentId: ID } };
  await assert.rejects(turns.run(input, () => assert.fail('must not execute')), { code: 'soul-paused' });
  assert.deepEqual(turns.busy(), []);
  paused = false;
  assert.equal(await turns.run(input, () => 'ran'), 'ran');
});
