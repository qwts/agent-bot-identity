import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareAndSetSoulComputerUse, populationFile, soulComputerUse, updateSoulStatus, upsertSoul } from '../agent-population.mjs';
import { applyComputerUseSetting } from '../soul-computer-use-effect.mjs';
import { withPermissionReceipts } from '../agent-daemon.mjs';
import { auditFile } from '../identity-format.mjs';
import { createComputerUseActivity } from '../computer-use-activity.mjs';
import { createContractExecutor } from '../executor-contract.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const TOOL = 'mcp__computer-use__left_click';
const AT = '2026-10-13T12:00:00.000Z';

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-computer-use-effect-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_CONFIG: path.join(home, 'config.json'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction') };
  const file = populationFile({ env, home });
  upsertSoul({ id: ID, name: 'bill', displayName: 'Bill', status: 'active', spacePath: home }, { file });
  const opts = { env, home, file, now: () => new Date(AT) };
  return { ...opts, opts,
    receipts: () => existsSync(auditFile(opts)) ? readFileSync(auditFile(opts), 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('compare-and-set binds the owner decision to the boolean state the owner saw', (t) => {
  const f = fixture(t);
  // A legacy record without the field reads as on, as soulComputerUse does.
  const stored = JSON.parse(readFileSync(f.file));
  delete stored.souls[ID].computerUse;
  writeFileSync(f.file, JSON.stringify(stored));
  assert.deepEqual(compareAndSetSoulComputerUse(ID, true, false, f), { before: true, after: false, written: true });
  assert.equal(soulComputerUse(ID, f), false);
  // Already at the desired value: nothing is written.
  const unchanged = readFileSync(f.file, 'utf8');
  assert.deepEqual(compareAndSetSoulComputerUse(ID, false, false, f), { before: false, after: false, written: false });
  assert.equal(readFileSync(f.file, 'utf8'), unchanged);
  // A stale expected state refuses and writes nothing.
  assert.throws(() => compareAndSetSoulComputerUse(ID, true, false, f), (error) => error.code === 'stale-expected-state');
  assert.throws(() => compareAndSetSoulComputerUse(ID, true, true, f), (error) => error.code === 'stale-expected-state');
  assert.equal(readFileSync(f.file, 'utf8'), unchanged);
  // An absent or retired soul refuses.
  assert.throws(() => compareAndSetSoulComputerUse(OTHER, true, false, f), (error) => error.code === 'soul-not-found');
  updateSoulStatus(ID, 'retired', f);
  assert.throws(() => compareAndSetSoulComputerUse(ID, false, true, f), (error) => error.code === 'soul-not-found');
  for (const value of [null, 'true', 1, undefined]) {
    assert.throws(() => compareAndSetSoulComputerUse(OTHER, value, true, f), /booleans/);
    assert.throws(() => compareAndSetSoulComputerUse(OTHER, true, value, f), /booleans/);
  }
});

test('the effect validates its request, writes one owner-decision audit line, and refuses stale state without a write', (t) => {
  const f = fixture(t);
  for (const request of [{}, { agentId: ID, enabled: false }, { agentId: ID, expectedEnabled: true },
    { agentId: ID, enabled: 'false', expectedEnabled: true }, { agentId: ID, enabled: false, expectedEnabled: 1 }, { enabled: false, expectedEnabled: true }]) {
    assert.throws(() => applyComputerUseSetting(request, f.opts), (error) => error.code === 'invalid-request', JSON.stringify(request));
  }
  assert.deepEqual(applyComputerUseSetting({ agentId: ID, enabled: false, expectedEnabled: true }, f.opts),
    { agentId: ID, before: true, after: false, written: true, audited: true });
  assert.deepEqual(f.receipts().map(({ event, operation, decision, detail, agentId }) => ({ event, operation, decision, detail, agentId })),
    [{ event: 'computer-use', operation: 'set', decision: 'off', detail: 'owner-decision', agentId: ID }]);
  // Replaying the same decision against the new state is stale and writes nothing.
  assert.throws(() => applyComputerUseSetting({ agentId: ID, enabled: false, expectedEnabled: true }, f.opts),
    (error) => error.code === 'stale-expected-state');
  assert.equal(f.receipts().length, 1);
  // A no-op leaves no audit line.
  assert.deepEqual(applyComputerUseSetting({ agentId: ID, enabled: false, expectedEnabled: false }, f.opts),
    { agentId: ID, before: false, after: false, written: false, audited: false });
  assert.equal(f.receipts().length, 1);
});

test('a failed audit write does not turn an applied setting into a failed effect', (t) => {
  const f = fixture(t);
  // The audit file's directory is a regular file, so the append fails.
  const audit = auditFile(f.opts);
  writeFileSync(path.dirname(audit), 'not a directory');
  const result = applyComputerUseSetting({ agentId: ID, enabled: false, expectedEnabled: true }, f.opts);
  assert.deepEqual(result, { agentId: ID, before: true, after: false, written: true, audited: false });
  assert.equal(soulComputerUse(ID, f), false);
});

// Permission only (agent-comms#250, owner decision): disabling denies the
// next computer-use call in a running turn, and the turn itself runs on.
test('disabling mid-turn denies the next computer-use call and never stops the turn', async (t) => {
  const f = fixture(t);
  const activity = createComputerUseActivity({ now: f.now });
  const controller = new AbortController();
  const executor = withPermissionReceipts(createContractExecutor({ harness: 'claude', identity: { agentId: ID }, mode: 'autopilot',
    policy: { version: 1, rules: [], fallback: 'approval' },
    run: async ({ requestPermission, emitStop }) => {
      assert.deepEqual(await requestPermission({ toolName: TOOL }), { outcome: 'allow', decidedBy: 'autopilot' });
      assert.deepEqual(activity.list().map(({ agentId }) => agentId), [ID], 'computer use is active in this turn');
      applyComputerUseSetting({ agentId: ID, enabled: false, expectedEnabled: true }, f.opts);
      assert.deepEqual(await requestPermission({ toolName: TOOL }), { outcome: 'deny', decidedBy: 'computer-use' });
      // Other tools are unaffected, and the turn is not aborted.
      assert.equal((await requestPermission({ toolName: 'Bash' })).outcome, 'allow');
      assert.equal(controller.signal.aborted, false);
      emitStop({ stopReason: 'end_turn' });
      return 'finished';
    } }), { ...f.opts, computerUse: activity });
  const result = await executor({ invocation: { agentId: ID }, message: 'go', attachments: [], signal: controller.signal,
    appendEvent: () => ({}), addArtifact: () => ({}), requestApproval: () => assert.fail('must not prompt') });
  assert.equal(controller.signal.aborted, false);
  assert.ok(result, 'the turn ran to its own end');
});

test('the effect module has nothing that could stop a turn', () => {
  const source = readFileSync(fileURLToPath(new URL('../soul-computer-use-effect.mjs', import.meta.url)), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['./agent-population.mjs', './identity-format.mjs']);
  assert.doesNotMatch(code, /\bstop\b|wakePlane|turns|abort/i);
});
