import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordSoulSighting, setSoulSandbox, upsertSoul } from '../agent-population.mjs';
import { auditFile } from '../agent-principals.mjs';
import { sandboxCommand, sandboxRemovalInventory } from '../sandbox.mjs';
import { runSandboxRemoval } from '../sandbox-remove.mjs';

const JOINED = 'agent_12345678-1234-4234-8234-123456789abc';
const LOCAL = 'agent_12345678-1234-4234-8234-123456789def';
const NOW = new Date('2026-10-10T19:00:00Z');
const DONE = '2026-10-10T18:00:00.000Z';
const SENTINEL = 'NEVER-RETURN-THIS-SECRET';
const lines = (file) => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };

// The owner's account and a broker pairing geniusbar-agent (account and
// daemon, or only a daemon), with one soul joined from it, stopped. The
// local census sends LOCAL to the account. Every command is recorded; a
// revoke drops the account's pairings, as the broker does.
function fixture(t, { failRevoke = false, presence = 'left', daemonOnly = false, absentHome = false } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'sandbox-remove-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_CONFIG: path.join(home, 'config', 'config.json') };
  mkdirSync(path.dirname(env.AGENT_BOT_CONFIG), { recursive: true });
  writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify({ features: { 'persona-accounts': true } }));
  const file = env.AGENT_BOT_POPULATION_PATH;
  upsertSoul({ id: LOCAL, name: 'fixture-fern-11', displayName: null, spacePath: path.join(home, 'space'), status: 'active', parentId: null, appSlug: null }, { file });
  setSoulSandbox(LOCAL, 'sandboxed', { file });
  let paired = true;
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const argv = args.join(' ');
    if (cmd === '/usr/bin/id') return '503\n';
    if (cmd === '/usr/bin/dsmemberutil') return 'user is not a member of the group\n';
    if (cmd === '/usr/bin/dscl') return 'NFSHomeDirectory: /Users/geniusbar-agent\n';
    if (cmd === '/usr/bin/xcode-select') return '/Library/Developer/CommandLineTools\n';
    if (cmd === 'agent-comms' && argv === 'account pairings') {
      const own = [{ account: 'geniusbar-agent', uid: 503, state: 'approved', secret: SENTINEL }, { account: 'geniusbar-agent', kind: 'daemon', uid: 503, state: 'approved' }];
      return JSON.stringify({ ok: true, pairings: [{ account: 'owner', uid: 501, state: 'approved' }, ...(paired ? (daemonOnly ? own.slice(1) : own) : [])] });
    }
    if (cmd === 'agent-comms' && argv === 'census') {
      return JSON.stringify({ ok: true, souls: [{ account: 'geniusbar-agent', agentId: JOINED, presence: paired ? presence : 'left' }] });
    }
    if (cmd === 'agent-comms' && (argv === 'account revoke geniusbar-agent' || argv === 'account revoke geniusbar-agent --kind daemon')) {
      if (failRevoke) throw Object.assign(new Error('broker unavailable'), { status: 1 });
      paired = false;
      return JSON.stringify({ ok: true, account: 'geniusbar-agent', state: 'revoked' });
    }
    throw new Error(`unexpected command ${cmd} ${argv}`);
  };
  const exported = { account: 'geniusbar-agent', dir: path.join(home, '.agent-bot', 'exports', 'geniusbar-agent', '2026-10-10T17-00-00Z'),
    categories: { souls: { state: 'exported', count: 2 }, workspaces: { state: 'empty', count: 0 }, transcripts: { state: 'exported', count: 1 } },
    completedAt: DONE, souls: [JOINED, LOCAL], unexported: [], verified: true, files: 3, bytes: 10, problems: [] };
  const gates = [];
  // Another account's home reads unreadable, as on a real Mac, unless the test says it is gone.
  const inspect = (p) => (absentHome ? 'absent' : p.startsWith('/Users/geniusbar-agent') ? 'unreadable' : 'absent');
  const options = { env, home, cwd: home, owner: 'owner', platform: 'darwin', exec, inspect, fileExists: (p) => p === '/Users/geniusbar-agent',
    now: () => NOW, gate: async (action) => { gates.push(action); } };
  const remove = (manifest = exported, extra = {}) => runSandboxRemoval(sandboxRemovalInventory('geniusbar-agent', options),
    { ...options, verify: async () => manifest, ...extra });
  const refuses = (manifest, code, pattern = /./) => assert.rejects(remove(manifest), (error) => error.code === code && pattern.test(error.message));
  return { home, env, file, exec, calls, exported, gates, options, remove, refuses,
    revokes: () => calls.filter((call) => call.includes('revoke')), receipts: () => lines(auditFile({ env, home })).filter((row) => row.event === 'sandbox-remove') };
}

test('removal revokes only the pairing, after the export verifies again, and keeps census rows (#750)', async (t) => {
  const f = fixture(t);
  const seen = [];
  const result = await f.remove(f.exported, { verify: async (account, options) => { seen.push([account, options.owner]); return f.exported; } });
  assert.deepEqual(seen, [['geniusbar-agent', 'owner']], 'the export is read back before anything changes');
  assert.equal(f.gates.length, 1);
  assert.match(f.gates[0], /^revoke geniusbar-agent's broker pairing and its daemon pairing, after the export verified in .* \(finished 60 minute\(s\) ago\)/);
  // An empty category the owner's side cannot see into is named for the owner to weigh.
  assert.match(f.gates[0], /the export says workspaces is empty, which cannot be checked from this account$/);
  const by = Object.fromEntries(result.categories.map((entry) => [entry.id, entry]));
  assert.deepEqual(by.pairings, { id: 'pairings', state: 'removed', count: 2 });
  assert.equal(by.census.state, 'kept');
  assert.equal(by['harness-sign-ins'].state, 'listed');
  assert.deepEqual([by['macos-account'].state, by['macos-account'].command], ['manual', 'sudo /usr/sbin/sysadminctl -deleteUser geniusbar-agent -keepHome']);
  assert.deepEqual([by.souls.state, by.workspaces.state, by.transcripts.state], ['exported', 'empty', 'exported']);
  // The only write is the revoke; no census, soul or account command ran.
  const writes = f.calls.filter((call) => !['agent-comms account pairings', 'agent-comms census'].includes(call) && !call.startsWith('/usr/bin/'));
  assert.deepEqual(writes, ['agent-comms account revoke geniusbar-agent']);
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
  assert.equal(f.receipts().at(-1).decision, 'removed');
});

test('a forged manifest from the persona account does not get the pairing revoked', async (t) => {
  const f = fixture(t);
  const forged = (change) => ({ ...f.exported, ...change, categories: { ...f.exported.categories, ...(change.categories ?? {}) } });
  // A soul that ran drops its archive and claims it never did.
  await f.refuses(forged({ souls: [LOCAL], unexported: [JOINED] }), 'sandbox-remove-soul-not-exported', /it has run/);
  // ...or the export says there were no souls at all.
  await f.refuses(forged({ souls: [], categories: { souls: { state: 'empty', count: 0 } } }), 'sandbox-remove-export-incomplete', /2 soul\(s\) run as geniusbar-agent/);
  // A category missing, skipped or in any other state is not done.
  const { transcripts, ...partial } = f.exported.categories;
  await f.refuses({ ...f.exported, categories: partial }, 'sandbox-remove-export-incomplete', /transcripts missing/);
  await f.refuses(forged({ categories: { transcripts: { state: 'skipped', count: 0 } } }), 'sandbox-remove-export-incomplete', /transcripts skipped/);
  await f.refuses(forged({ categories: { transcripts: { state: 'exporting', count: 0 } } }), 'sandbox-remove-export-incomplete');
  await f.refuses(forged({ completedAt: null }), 'sandbox-remove-export-incomplete', /no completion time/);
  // An unverified copy, or none at all (the real verify), stops it too.
  await assert.rejects(f.remove(undefined, { verify: undefined }), { code: 'sandbox-export-not-found' });
  assert.deepEqual(f.revokes(), []);
  assert.deepEqual(f.gates, [], 'refusals ask no gate');
  // Every refusal left a receipt.
  assert.equal(f.receipts().filter((row) => row.decision === 'refused').length, 7);
});

test('the local census souls that run as the account must be in the export, and "never ran" is believed only when nothing saw them run', async (t) => {
  const f = fixture(t);
  await f.refuses({ ...f.exported, souls: [JOINED] }, 'sandbox-remove-soul-not-exported', new RegExp(LOCAL));
  // Never sighted here and unknown to the broker: a never-run soul is accepted.
  await f.remove({ ...f.exported, souls: [JOINED], unexported: [LOCAL] });
  assert.equal(f.revokes().length, 1);

  const g = fixture(t);
  recordSoulSighting(LOCAL, { file: g.file, now: () => new Date('2026-10-10T16:00:00Z') });
  await g.refuses({ ...g.exported, souls: [JOINED], unexported: [LOCAL] }, 'sandbox-remove-soul-not-exported', /it has run/);
  assert.deepEqual(g.revokes(), []);
});

test('an export older than the souls\' last run, or with a soul running now, is stale', async (t) => {
  const f = fixture(t);
  recordSoulSighting(LOCAL, { file: f.file, now: () => new Date('2026-10-10T18:30:00Z') });
  await f.refuses(f.exported, 'sandbox-remove-export-stale', new RegExp(`${LOCAL} ran after the export finished`));
  const g = fixture(t, { presence: 'watching' });
  await g.refuses(g.exported, 'sandbox-remove-export-stale', new RegExp(`${JOINED} is running as geniusbar-agent now`));
  assert.deepEqual([...f.revokes(), ...g.revokes()], []);
  // With the account's home gone, an empty category is confirmed and not named.
  const h = fixture(t, { absentHome: true });
  await h.remove();
  assert.doesNotMatch(h.gates[0], /cannot be checked/);
});

test('a declined gate or a failed revoke stops with a receipt; running it again carries on, and a gone pairing is not revoked twice', async (t) => {
  const f = fixture(t, { failRevoke: true });
  const declined = Object.assign(new Error('the owner declined'), { code: 'owner-declined' });
  await assert.rejects(f.remove(f.exported, { gate: async () => { throw declined; } }), { code: 'owner-declined' });
  assert.deepEqual(f.revokes(), []);
  assert.equal(f.receipts().at(-1).decision, 'declined');
  const failed = await f.remove().then(() => null, (error) => error);
  assert.equal(failed.action, 'run agent-bot sandbox remove geniusbar-agent again; nothing else was changed');
  assert.equal(f.receipts().at(-1).decision, 'failed');

  const g = fixture(t);
  await g.remove();
  g.gates.length = 0;
  const again = await g.remove();
  assert.equal(again.categories.find((entry) => entry.id === 'pairings').state, 'already-removed');
  assert.deepEqual(g.gates, [], 'nothing to revoke, nothing to confirm');
  assert.equal(g.revokes().length, 1);
});

test('a daemon pairing left on its own is revoked as a daemon pairing', async (t) => {
  const f = fixture(t, { daemonOnly: true });
  const result = await f.remove();
  assert.deepEqual(f.revokes(), ['agent-comms account revoke geniusbar-agent --kind daemon']);
  assert.match(f.gates[0], /^revoke geniusbar-agent's broker pairing and its daemon pairing/);
  assert.deepEqual(result.categories.find((entry) => entry.id === 'pairings'), { id: 'pairings', state: 'removed', count: 1 });
});

test('sandbox remove without --dry-run is owner only: a caller with a soul\'s markers is refused before the broker', async (t) => {
  const f = fixture(t);
  let out = '';
  const write = (text) => { out += text; };
  const { gate, ...ungated } = f.options;
  const soul = { ...ungated, env: { ...f.env, AGENT_BOT_ID: JOINED }, write, verifyExport: async () => f.exported };
  await assert.rejects(sandboxCommand(['remove', 'geniusbar-agent'], soul), { code: 'owner-credential-required' });
  assert.deepEqual(f.revokes(), []);
  assert.equal(f.receipts().at(-1).decision, 'declined');
  // The real verify finds no export here, so the command refuses before the broker.
  await assert.rejects(sandboxCommand(['remove', 'geniusbar-agent'], { ...f.options, write }), { code: 'sandbox-export-not-found' });
  await assert.rejects(sandboxCommand(['remove', '--dry-run', '--principal-stdin'], { ...f.options, write }), /usage: agent-bot sandbox/);
  await sandboxCommand(['remove', 'geniusbar-agent', '--dry-run'], { ...f.options, write });
  assert.match(out, /census: keep/);
  assert.deepEqual(f.revokes(), []);
});
