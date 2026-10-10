import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setSoulSandbox, upsertSoul } from '../agent-population.mjs';
import { REMOVAL_CATEGORIES, sandboxCommand, sandboxRemovalInventory } from '../sandbox.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const OTHER = 'agent_12345678-1234-4234-8234-123456789def';
const SENTINEL = 'NEVER-RETURN-THIS-SECRET';

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'sandbox-removal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_CONFIG: path.join(home, 'config', 'config.json') };
  mkdirSync(path.dirname(env.AGENT_BOT_CONFIG), { recursive: true });
  writeFileSync(env.AGENT_BOT_CONFIG, JSON.stringify({ features: { 'persona-accounts': true } }));
  const file = env.AGENT_BOT_POPULATION_PATH;
  upsertSoul({ id: ID, name: 'fixture-fern-11', displayName: 'Fixture', spacePath: path.join(home, 'space'), status: 'active', parentId: null, appSlug: null }, { file });
  return { home, env, file, options: { env, home } };
}

// A Mac with the persona account, one pairing and one joined soul for it.
// Every command is recorded, and anything that is not a read fails the test.
function machine({ exists = true } = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    const argv = args.join(' ');
    if (file === '/usr/bin/id') { if (exists) return '503\n'; throw Object.assign(new Error('no such user'), { status: 1 }); }
    if (file === '/usr/bin/dsmemberutil') return 'user is not a member of the group\n';
    if (file === '/usr/bin/dscl') return 'NFSHomeDirectory: /Users/geniusbar-agent\n';
    if (file === '/usr/bin/xcode-select') return '/Library/Developer/CommandLineTools\n';
    if (file === 'agent-comms' && argv === 'account pairings') {
      return JSON.stringify({ ok: true, pairings: [{ account: 'owner', uid: 501, state: 'approved' },
        { account: 'geniusbar-agent', uid: 503, state: 'approved', secret: SENTINEL }] });
    }
    if (file === 'agent-comms' && argv === 'census') {
      return JSON.stringify({ ok: true, souls: [{ account: 'geniusbar-agent', agentId: OTHER, presence: 'joined' }, { account: 'owner', agentId: ID, presence: 'joined' }] });
    }
    throw new Error(`unexpected command ${file} ${argv}`);
  };
  // The account's home is unreadable from the owner's account, as on a real Mac.
  const inspect = (p) => (p.startsWith('/Users/geniusbar-agent') ? 'unreadable' : 'absent');
  return { exec, calls, inspect, fileExists: (p) => p === '/Users/geniusbar-agent' };
}

test('the removal dry run lists every category with the owner\'s decided action, and changes nothing (#750)', (t) => {
  const f = fixture(t);
  setSoulSandbox(ID, 'sandboxed', { file: f.file });
  const m = machine();
  const result = sandboxRemovalInventory('geniusbar-agent', { ...f.options, platform: 'darwin', owner: 'owner', exec: m.exec, inspect: m.inspect, fileExists: m.fileExists });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.categories.map((category) => category.id), REMOVAL_CATEGORIES);
  const by = Object.fromEntries(result.categories.map((category) => [category.id, category]));
  assert.deepEqual(Object.fromEntries(result.categories.map((category) => [category.id, category.action])), {
    souls: 'export', workspaces: 'export', transcripts: 'export', pairings: 'remove-after-export',
    census: 'keep', 'harness-sign-ins': 'list-only', 'macos-account': 'manual',
  });
  // The local soul sandboxed into the account, and the one the broker's census has joined there.
  assert.deepEqual(by.souls.items.map((soul) => soul.agentId).sort(), [ID, OTHER].sort());
  assert.deepEqual(by.census.items, [{ agentId: OTHER, presence: 'joined' }]);
  // A pairing row is reduced to account, uid and state: never a secret.
  assert.deepEqual(by.pairings.items, [{ account: 'geniusbar-agent', uid: 503, state: 'approved' }]);
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
  // Paths in another account's home are reported as they are, not guessed.
  assert.deepEqual(by.workspaces.items, [{ path: '/Users/geniusbar-agent/.agent-bot/souls', state: 'unreadable' }]);
  assert.equal(by.transcripts.items.length, 2);
  assert.deepEqual(by['macos-account'].items, [{ account: 'geniusbar-agent', home: '/Users/geniusbar-agent' }]);
  // Only reads ran.
  for (const [file, ...args] of m.calls) {
    assert.ok(['/usr/bin/id', '/usr/bin/dsmemberutil', '/usr/bin/dscl', '/usr/bin/xcode-select', 'agent-comms'].includes(file), file);
    if (file === 'agent-comms') assert.ok(['account pairings', 'census'].includes(args.join(' ')));
  }
});

test('the dry run refuses the owner\'s own account and a bad name, and lists little for a missing account or off macOS', (t) => {
  const f = fixture(t);
  const m = machine();
  const options = { ...f.options, platform: 'darwin', owner: 'owner', exec: m.exec, inspect: m.inspect, fileExists: m.fileExists };
  assert.throws(() => sandboxRemovalInventory('owner', options), { code: 'sandbox-remove-self' });
  assert.throws(() => sandboxRemovalInventory('../etc', options), { code: 'invalid-account' });
  const gone = machine({ exists: false });
  const missing = sandboxRemovalInventory('geniusbar-agent', { ...options, exec: gone.exec, inspect: gone.inspect });
  assert.equal(missing.exists, false);
  const by = Object.fromEntries(missing.categories.map((category) => [category.id, category]));
  assert.deepEqual(by['macos-account'].items, []);
  assert.deepEqual(by.workspaces.items, []);
  // A leftover pairing for a deleted account still shows up for cleanup.
  assert.equal(by.pairings.items.length, 1);
  const linux = sandboxRemovalInventory('geniusbar-agent', { ...f.options, platform: 'linux', owner: 'owner', exec: () => { throw new Error('never'); } });
  assert.deepEqual({ supported: linux.supported, categories: linux.categories }, { supported: false, categories: [] });
});

test('sandbox remove --dry-run takes no principal, and defaults to the configured account', async (t) => {
  const f = fixture(t);
  const m = machine();
  let out = '';
  const gated = [];
  const run = (argv) => { out = ''; return sandboxCommand(argv, { ...f.options, platform: 'darwin', exec: m.exec, owner: 'owner',
    gate: async (action) => { gated.push(action); }, write: (text) => { out += text; } }); };
  await assert.rejects(run(['remove', '--dry-run', '--principal-stdin']), /usage: agent-bot sandbox/);
  await assert.rejects(run(['remove', 'a', 'b', '--dry-run']), /usage: agent-bot sandbox/);
  const result = await run(['remove', '--dry-run', '--json']);
  assert.equal(result.account, 'geniusbar-agent');
  assert.equal(JSON.parse(out).dryRun, true);
  await run(['remove', 'geniusbar-agent', '--dry-run']);
  assert.match(out, /^dry run: removing persona account geniusbar-agent \(nothing is changed\)/);
  assert.match(out, /pairings: remove-after-export/);
  assert.ok(!out.includes(SENTINEL));
  assert.deepEqual(gated, [], 'a dry run asks no owner gate');
});

test('a category read only in part, or only at default locations, says it may be incomplete', (t) => {
  const f = fixture(t);
  const m = machine();
  const options = { ...f.options, platform: 'darwin', owner: 'owner', exec: m.exec, inspect: m.inspect, fileExists: m.fileExists };
  const known = (result) => Object.fromEntries(result.categories.map((category) => [category.id, category.known]));
  assert.deepEqual(known(sandboxRemovalInventory('geniusbar-agent', options)), {
    souls: true, workspaces: false, transcripts: false, pairings: true, census: true, 'harness-sign-ins': false, 'macos-account': true,
  });
  // An unreadable local census is not an empty one, even when the broker's reads.
  writeFileSync(f.file, '{not json');
  assert.equal(known(sandboxRemovalInventory('geniusbar-agent', options)).souls, false);
  // Nor is an unreadable broker census, with the local one readable.
  const g = fixture(t);
  const broken = (file, args) => (file === 'agent-comms' && args.join(' ') === 'census' ? 'not json' : m.exec(file, args));
  const result = sandboxRemovalInventory('geniusbar-agent', { ...options, ...g.options, exec: broken });
  assert.deepEqual({ souls: known(result).souls, census: known(result).census }, { souls: false, census: false });
});
