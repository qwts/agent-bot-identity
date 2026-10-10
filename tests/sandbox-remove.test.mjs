import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditFile } from '../agent-principals.mjs';
import { sandboxCommand, sandboxRemovalInventory } from '../sandbox.mjs';
import { runSandboxRemoval } from '../sandbox-remove.mjs';

const JOINED = 'agent_12345678-1234-4234-8234-123456789abc';
const NEVER_RAN = 'agent_12345678-1234-4234-8234-123456789def';
const NOW = new Date('2026-10-10T19:00:00Z');
const SENTINEL = 'NEVER-RETURN-THIS-SECRET';
const lines = (file) => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };

// The owner's account, a broker that pairs geniusbar-agent (account and
// daemon) and has one soul joined from it. Every command is recorded; a
// revoke drops both pairings, as the broker does.
function fixture(t, { failRevoke = false } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'sandbox-remove-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_CONFIG: path.join(home, 'config', 'config.json') };
  mkdirSync(path.dirname(env.AGENT_BOT_CONFIG), { recursive: true });
  writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify({ features: { 'persona-accounts': true } }));
  let paired = true;
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args].join(' '));
    const argv = args.join(' ');
    if (file === '/usr/bin/id') return '503\n';
    if (file === '/usr/bin/dsmemberutil') return 'user is not a member of the group\n';
    if (file === '/usr/bin/dscl') return 'NFSHomeDirectory: /Users/geniusbar-agent\n';
    if (file === '/usr/bin/xcode-select') return '/Library/Developer/CommandLineTools\n';
    if (file === 'agent-comms' && argv === 'account pairings') {
      return JSON.stringify({ ok: true, pairings: [{ account: 'owner', uid: 501, state: 'approved' },
        ...(paired ? [{ account: 'geniusbar-agent', uid: 503, state: 'approved', secret: SENTINEL }, { account: 'geniusbar-agent', kind: 'daemon', uid: 503, state: 'approved' }] : [])] });
    }
    if (file === 'agent-comms' && argv === 'census') {
      return JSON.stringify({ ok: true, souls: [{ account: 'geniusbar-agent', agentId: JOINED, presence: paired ? 'joined' : 'left' }] });
    }
    if (file === 'agent-comms' && argv === 'account revoke geniusbar-agent') {
      if (failRevoke) throw Object.assign(new Error('broker unavailable'), { status: 1 });
      paired = false;
      return JSON.stringify({ ok: true, account: 'geniusbar-agent', state: 'revoked' });
    }
    throw new Error(`unexpected command ${file} ${argv}`);
  };
  const exported = { account: 'geniusbar-agent', dir: path.join(home, '.agent-bot', 'exports', 'geniusbar-agent', '2026-10-10T17-00-00Z'),
    categories: { souls: { state: 'exported', count: 2 }, workspaces: { state: 'empty', count: 0 }, transcripts: { state: 'exported', count: 1 } },
    souls: [JOINED], unexported: [NEVER_RAN], verified: true, files: 2, bytes: 10, problems: [] };
  const verifies = [];
  const gates = [];
  const options = { env, home, cwd: home, owner: 'owner', platform: 'darwin', exec,
    gate: async (action) => { gates.push(action); } };
  return { home, env, exec, calls, exported, verifies, gates, options, receipts: () => lines(auditFile({ env, home })) };
}

// The removal with the inventory the command reads, and a verify the test
// chooses (undefined: the real one).
function removeWith(f, verify) {
  const inventory = sandboxRemovalInventory('geniusbar-agent', f.options);
  return runSandboxRemoval(inventory, { ...f.options, verify });
}

test('removal revokes only the pairing, after the export verifies again, and keeps census rows (#750)', async (t) => {
  const f = fixture(t);
  const verify = async (account, options) => { f.verifies.push([account, options.owner]); return f.exported; };
  const result = await removeWith(f, verify);
  assert.deepEqual(f.verifies, [['geniusbar-agent', 'owner']], 'the export is read back before anything changes');
  assert.equal(f.gates.length, 1);
  assert.match(f.gates[0], /^revoke geniusbar-agent's broker pairing and its daemon pairing, after the export verified in /);
  const by = Object.fromEntries(result.categories.map((entry) => [entry.id, entry]));
  assert.deepEqual(by.pairings, { id: 'pairings', state: 'removed', count: 2 });
  assert.equal(by.census.state, 'kept');
  assert.equal(by['harness-sign-ins'].state, 'listed');
  assert.deepEqual([by['macos-account'].state, by['macos-account'].command], ['manual', 'sudo /usr/sbin/sysadminctl -deleteUser geniusbar-agent -keepHome']);
  for (const id of ['souls', 'workspaces', 'transcripts']) assert.equal(by[id].state, 'exported');
  // The only write is the revoke; no census, soul or account command ran.
  const writes = f.calls.filter((call) => !['account pairings', 'census'].some((read) => call === `agent-comms ${read}`) && !call.startsWith('/usr/bin/'));
  assert.deepEqual(writes, ['agent-comms account revoke geniusbar-agent']);
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
  assert.equal(f.receipts().at(-1).decision, 'removed');
});

test('nothing is removed without a verified, complete export that holds every joined soul', async (t) => {
  const f = fixture(t);
  // No export copied over: the real verify refuses, and the broker is untouched.
  await assert.rejects(removeWith(f, undefined), { code: 'sandbox-export-not-found' });
  await assert.rejects(removeWith(f, async () => { throw Object.assign(new Error('1 of 2 file(s) do not match'), { code: 'sandbox-export-unverified' }); }), { code: 'sandbox-export-unverified' });
  await assert.rejects(removeWith(f, async () => ({ ...f.exported, categories: { ...f.exported.categories, transcripts: { state: 'skipped', count: 0 } } })),
    (error) => error.code === 'sandbox-remove-export-incomplete' && /without --skip/.test(error.action));
  await assert.rejects(removeWith(f, async () => ({ ...f.exported, souls: [] })),
    (error) => error.code === 'sandbox-remove-soul-not-exported' && error.message.includes(JOINED));
  // A soul that never ran counts as exported: there was no life to carry.
  await removeWith(f, async () => ({ ...f.exported, souls: [], unexported: [JOINED] }));
  assert.equal(f.calls.filter((call) => call.includes('revoke')).length, 1);
  assert.equal(f.gates.length, 1, 'refusals ask no gate');
});

test('a declined gate or a failed revoke stops; running it again carries on, and a pairing already gone is not revoked twice', async (t) => {
  const f = fixture(t, { failRevoke: true });
  const verify = async () => f.exported;
  const declined = Object.assign(new Error('the owner declined'), { code: 'owner-declined' });
  await assert.rejects(runSandboxRemoval(sandboxRemovalInventory('geniusbar-agent', f.options),
    { ...f.options, verify, gate: async () => { throw declined; } }), { code: 'owner-declined' });
  assert.ok(!f.calls.some((call) => call.includes('revoke')));
  const failed = await removeWith(f, verify).then(() => null, (error) => error);
  assert.equal(failed.action, 'run agent-bot sandbox remove geniusbar-agent again; nothing else was changed');
  assert.equal(f.receipts().at(-1).decision, 'failed');

  const g = fixture(t);
  await removeWith(g, verify);
  g.gates.length = 0;
  const again = await removeWith(g, async () => g.exported);
  assert.equal(again.categories.find((entry) => entry.id === 'pairings').state, 'already-removed');
  assert.deepEqual(g.gates, [], 'nothing to revoke, nothing to confirm');
  assert.equal(g.calls.filter((call) => call.includes('revoke')).length, 1);
});

test('sandbox remove without --dry-run runs the removal; the dry run still changes nothing', async (t) => {
  const f = fixture(t);
  let out = '';
  const write = (text) => { out += text; };
  // The real verify finds no export here, so the command refuses before the broker.
  await assert.rejects(sandboxCommand(['remove', 'geniusbar-agent'], { ...f.options, write }), { code: 'sandbox-export-not-found' });
  await assert.rejects(sandboxCommand(['remove', '--dry-run', '--principal-stdin'], { ...f.options, write }), /usage: agent-bot sandbox/);
  await sandboxCommand(['remove', 'geniusbar-agent', '--dry-run'], { ...f.options, write });
  assert.match(out, /census: keep/);
  assert.ok(!f.calls.some((call) => call.includes('revoke')));
  assert.deepEqual(f.gates, []);
});
