import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { auditFile } from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { initAgentSpace } from '../agent-space.mjs';
import { PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { ENV_CAPABILITIES, readSoulEnvironment } from '../soul-env.mjs';
import { adoptHostSignIn, ensureToolHome, inspectToolHomes, pendingSoulToolHome, prepareSoulToolHome, readMigrationJournal, soulEnvMigrateCommand, soulToolHomeEnv } from '../soul-env-migrate.mjs';
import { NEVER_ROUTED, TOOL_CONTAINMENTS, TOOL_HOME_REGISTRY, adoptCommand, adoptStepId, hostToolStore, toolHomeDecision, toolHomeEnv, toolHomeFiles, toolHomeFor, toolHomePath, validateToolHomeRow } from '../soul-tool-homes.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// What a sign-in file holds must never show up in a journal, a receipt or
// a command's output: adoption copies bytes and reports names.
const SECRET = 'sk-ant-NEVER-PRINT-THIS-SIGNIN-0123456789';
const put = (file, contents) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); };
const mode = (file) => statSync(file).mode & 0o777;

// A hermetic census under one temp HOME: identity, population row, souls
// root, state, and the host stores the harnesses would use. Nothing
// touches the real HOME or any keychain. The platform is pinned to linux,
// where a host sign-in is always a file; darwin's keychain case is tested
// by name.
function fixture(t, { harnesses = ['codex', 'claude', 'opencode'], identityHarness = 'codex', host = true, census = true, platform = 'linux' } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'soul-tool-homes-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_BOT_SPACES_HOME: path.join(home, 'spaces'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_DAEMON_STATE_PATH: path.join(home, 'daemon.json'), AGENT_BOT_CONFIG: path.join(home, 'no-config') };
  const dir = path.join(env.AGENT_BOT_SOULS_HOME, 'Billy.soul');
  const soul = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Billy', description: 'Tool-home tests', displaySeed: 'billy', preferredHarnesses: harnesses,
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  put(path.join(dir, 'soul.json'), JSON.stringify(soul));
  put(path.join(dir, 'AGENTS.md'), '# Billy\n');
  put(path.join(dir, '.soul-state', 'agent-id'), `${ID}\n`);
  if (host) {
    put(path.join(home, '.claude', '.credentials.json'), `{"claudeAiOauth":{"accessToken":"${SECRET}"}}`);
    put(path.join(home, '.claude.json'), '{"hasCompletedOnboarding":true}');
    put(path.join(home, '.codex', 'auth.json'), `{"OPENAI_API_KEY":"${SECRET}"}`);
    put(path.join(home, '.local', 'share', 'opencode', 'auth.json'), `{"openai":{"key":"${SECRET}"}}`);
    // Never adopted: sessions, caches and settings beside the sign-in.
    put(path.join(home, '.codex', 'sessions', '2026', 'rollout.jsonl'), 'history\n');
    put(path.join(home, '.claude', 'settings.json'), '{}');
  }
  if (census) {
    mintAgentIdentity({ stateDir: stateDirectory({ env, home }), idFactory: () => ID, harness: identityHarness, appSlug: null, useGithub: false });
    const space = initAgentSpace(ID, { env, home });
    upsertSoul({ id: ID, name: 'billy', displayName: 'Billy', soulDir: dir, spacePath: space.path, status: 'active', parentId: null, appSlug: null }, { file: env.AGENT_BOT_POPULATION_PATH });
  }
  const gates = [];
  const options = { env, home, cwd: home, file: env.AGENT_BOT_POPULATION_PATH, config: {}, platform, now: () => new Date('2026-10-07T10:00:00Z'),
    gate: async (action, { principal }) => { gates.push([action, principal]); return { method: 'consent' }; } };
  const tools = path.join(dir, '.soul-state', 'tools');
  return { home, env, dir, soul, options, gates, tools, receipts: () => { try { return readFileSync(auditFile({ env, home }), 'utf8').trim().split('\n').map((line) => JSON.parse(line)); } catch { return []; } } };
}

function assertNoLeak(root, label) {
  for (const file of readdirSync(root, { recursive: true }).map(String)) {
    const full = path.join(root, file);
    // The host stores and the adopted copies hold the value by design.
    if (!statSync(full).isFile() || /\.credentials\.json$|auth\.json$/.test(file)) continue;
    assert.ok(!readFileSync(full, 'latin1').includes(SECRET), `${label}: ${file} holds a sign-in value`);
  }
}

test('the registry routes claude, codex and opencode with harness-specific variables only, and reports every other harness unsupported with a reason', () => {
  assert.deepEqual(Object.keys(TOOL_HOME_REGISTRY), ['claude', 'codex', 'opencode', 'kiro', 'muse', 'gemini', 'copilot']);
  assert.deepEqual(Object.values(TOOL_HOME_REGISTRY).filter((row) => row.routable).map((row) => row.harness), ['claude', 'codex', 'opencode']);
  assert.deepEqual(TOOL_CONTAINMENTS, ['soul', 'shared-host', 'unsupported']);
  assert.deepEqual(NEVER_ROUTED, ['HOME', 'XDG_STATE_HOME']);
  const soulDir = '/souls/Billy.soul';
  const tools = path.join(soulDir, '.soul-state', 'tools');
  assert.deepEqual(toolHomeEnv(soulDir, 'claude'), { env: { CLAUDE_CONFIG_DIR: path.join(tools, 'claude') }, routing: ['CLAUDE_CONFIG_DIR'], home: path.join(tools, 'claude'),
    dirs: [path.join(tools, 'claude')], routable: true, reason: null });
  assert.deepEqual(toolHomeEnv(soulDir, 'codex'), { env: { CODEX_HOME: path.join(tools, 'codex') }, routing: ['CODEX_HOME'], home: path.join(tools, 'codex'),
    dirs: [path.join(tools, 'codex')], routable: true, reason: null });
  assert.deepEqual(toolHomeEnv(soulDir, 'opencode'), {
    env: { XDG_CONFIG_HOME: path.join(tools, 'opencode', 'config'), XDG_DATA_HOME: path.join(tools, 'opencode', 'data'), XDG_CACHE_HOME: path.join(tools, 'opencode', 'cache') },
    routing: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'], home: path.join(tools, 'opencode'),
    dirs: [path.join(tools, 'opencode'), path.join(tools, 'opencode', 'config'), path.join(tools, 'opencode', 'data'), path.join(tools, 'opencode', 'cache')], routable: true, reason: null });
  for (const row of Object.values(TOOL_HOME_REGISTRY)) {
    for (const route of row.routes) assert.ok(!NEVER_ROUTED.includes(route.env), `${row.harness} routes ${route.env}`);
    assert.ok(Object.isFrozen(row));
  }
  for (const harness of ['kiro', 'muse', 'gemini', 'copilot', 'cursor', 'nope', null]) {
    const routed = toolHomeEnv(soulDir, harness ?? 'nope');
    assert.deepEqual([routed.env, routed.routing, routed.dirs, routed.routable], [{}, [], [], false], String(harness));
    assert.match(routed.reason, /no variable|no tool-home routing|nothing to route/);
    assert.equal(toolHomeFor(harness).routable, false);
  }
  assert.match(toolHomeFor('kiro').reason, /kiro-cli/);
  // The guard refuses what decision 5 forbids, so a future row cannot route HOME.
  assert.throws(() => validateToolHomeRow({ harness: 'x', routable: true, reason: null, routes: [{ env: 'HOME', dir: null, host: { env: 'HOME', default: '' } }], files: [] }), /HOME may not be routed/);
  assert.throws(() => validateToolHomeRow({ harness: 'x', routable: true, reason: null, routes: [{ env: 'XDG_STATE_HOME', dir: 'state', host: { env: 'XDG_STATE_HOME', default: '' } }], files: [] }), /XDG_STATE_HOME may not be routed/);
  assert.throws(() => validateToolHomeRow({ harness: 'x', routable: true, reason: null, routes: [{ env: 'X_HOME', dir: null, host: { env: 'X_HOME', default: '.x' } }], files: [] }), /names its sign-in file/);
  assert.throws(() => validateToolHomeRow({ harness: 'x', routable: false, reason: null, routes: [], files: [] }), /needs a reason/);
  // Host stores follow the variable the host honours, absolute only.
  assert.equal(hostToolStore('claude', { env: {}, home: '/h' }), path.join('/h', '.claude'));
  assert.equal(hostToolStore('claude', { env: { CLAUDE_CONFIG_DIR: '/custom/claude' }, home: '/h' }), '/custom/claude');
  assert.equal(hostToolStore('claude', { env: { CLAUDE_CONFIG_DIR: 'relative' }, home: '/h' }), path.join('/h', '.claude'));
  assert.equal(hostToolStore('codex', { env: { CODEX_HOME: '/custom/codex' }, home: '/h' }), '/custom/codex');
  assert.equal(hostToolStore('opencode', { env: {}, home: '/h' }), path.join('/h', '.local', 'share', 'opencode'));
  assert.equal(hostToolStore('opencode', { env: { XDG_DATA_HOME: '/xdg/data' }, home: '/h' }), path.join('/xdg/data', 'opencode'));
  assert.equal(hostToolStore('kiro', { env: {}, home: '/h' }), null);
  assert.deepEqual(toolHomeFiles(soulDir, 'claude', { env: {}, home: '/h' }), [
    { kind: 'sign-in', path: '.credentials.json', route: 'CLAUDE_CONFIG_DIR', soulPath: path.join(tools, 'claude', '.credentials.json'), hostPath: path.join('/h', '.claude', '.credentials.json') },
    { kind: 'state', path: '.claude.json', route: 'CLAUDE_CONFIG_DIR', soulPath: path.join(tools, 'claude', '.claude.json'), hostPath: path.join('/h', '.claude.json') },
  ]);
  assert.equal(toolHomeFiles(soulDir, 'claude', { env: { CLAUDE_CONFIG_DIR: '/custom/claude' }, home: '/h' })[1].hostPath, path.join('/custom/claude', '.claude.json'));
  assert.deepEqual(toolHomeFiles(soulDir, 'codex', { env: {}, home: '/h' }).map((file) => [file.kind, file.soulPath, file.hostPath]),
    [['sign-in', path.join(tools, 'codex', 'auth.json'), path.join('/h', '.codex', 'auth.json')]]);
  assert.deepEqual(toolHomeFiles(soulDir, 'opencode', { env: {}, home: '/h' }).map((file) => [file.kind, file.soulPath, file.hostPath]),
    [['sign-in', path.join(tools, 'opencode', 'data', 'opencode', 'auth.json'), path.join('/h', '.local', 'share', 'opencode', 'auth.json')]]);
  assert.deepEqual(toolHomeFiles(soulDir, 'kiro', { env: {}, home: '/h' }), []);
  assert.equal(toolHomePath(soulDir, 'codex'), path.join(tools, 'codex'));
  assert.equal(adoptCommand(ID, 'codex'), `agent-bot soul env migrate ${ID} --adopt-host-signin --harness codex`);
  assert.equal(adoptCommand(ID), `agent-bot soul env migrate ${ID} --adopt-host-signin`);
  assert.equal(adoptStepId('codex'), 'adopt-host-signin:codex');
  assert.ok(ENV_CAPABILITIES.includes('tool-homes'));
});

test('the containment decision routes a soul that holds its sign-in or a host with none to lose, keeps a host sign-in the soul lacks on the host store, and never guesses', () => {
  const decide = (harness, signIn, hostSignIn, adopted = false) => toolHomeDecision(harness, { signIn, hostSignIn, adopted });
  // The four cases of the rule, per routable harness.
  for (const harness of ['claude', 'codex', 'opencode']) {
    assert.deepEqual(decide(harness, 'present', 'present'), { containment: 'soul', reason: null }, `${harness} present/present`);
    assert.deepEqual(decide(harness, 'present', 'missing'), { containment: 'soul', reason: null }, `${harness} present/missing`);
    assert.deepEqual(decide(harness, 'missing', 'missing'), { containment: 'soul', reason: null }, `${harness} missing/missing: a fresh Mac is contained from the first launch`);
    const shared = decide(harness, 'missing', 'present');
    assert.equal(shared.containment, 'shared-host', `${harness} missing/present`);
    assert.match(shared.reason, new RegExp(`the host store holds ${harness}'s sign-in and the soul's tool home does not; the launch keeps the host store until the owner adopts it`));
    // A host sign-in no file shows (the keychain) may still be one to lose.
    const unknown = decide(harness, 'missing', 'unknown');
    assert.equal(unknown.containment, 'shared-host', `${harness} missing/unknown`);
    assert.match(unknown.reason, /may hold .* where no file shows it/);
    assert.deepEqual(decide(harness, 'unknown', 'unknown'), unknown);
    // The owner's adoption is the decision, whatever a file copy could carry.
    assert.deepEqual(decide(harness, 'missing', 'present', true), { containment: 'soul', reason: null }, `${harness} adopted`);
    assert.deepEqual(decide(harness, 'missing', 'unknown', true), { containment: 'soul', reason: null }, `${harness} adopted, keychain`);
  }
  assert.match(decide('claude', 'missing', 'unknown').reason, /login keychain/);
  assert.deepEqual(toolHomeDecision('claude'), toolHomeDecision('claude', { signIn: 'unknown', hostSignIn: 'unknown' }));
  for (const harness of ['kiro', 'muse', 'gemini', 'copilot', 'nope']) {
    for (const [signIn, hostSignIn] of [['present', 'present'], ['missing', 'present'], ['missing', 'missing'], ['unknown', 'unknown']]) {
      const decision = decide(harness, signIn, hostSignIn, true);
      assert.equal(decision.containment, 'unsupported', `${harness} ${signIn}/${hostSignIn}`);
      assert.equal(decision.reason, toolHomeFor(harness).reason);
    }
  }
});

test('adoption copies only the named sign-in and state files, privately, once; a rerun skips, a missing host store skips with its reason, and nothing it writes holds a value', (t) => {
  const f = fixture(t, { census: false });
  const before = inspectToolHomes(f.dir, ['codex', 'claude', 'opencode', 'kiro'], f.options);
  assert.deepEqual(before.map((row) => [row.harness, row.containment, row.signIn, row.hostSignIn, row.routing, row.adopted]), [
    ['codex', 'shared-host', 'missing', 'present', [], false], ['claude', 'shared-host', 'missing', 'present', [], false],
    ['opencode', 'shared-host', 'missing', 'present', [], false], ['kiro', 'unsupported', 'unknown', 'unknown', [], false]]);
  assert.match(before[0].reason, /the host store holds codex's sign-in/);
  assert.deepEqual(before[1].files, [{ kind: 'sign-in', path: '.credentials.json', soul: 'missing', host: 'present' }, { kind: 'state', path: '.claude.json', soul: 'missing', host: 'present' }]);
  assert.equal(before[0].hostPath, path.join(f.home, '.codex'));
  assert.equal(before[3].hostPath, null);
  assert.match(before[3].reason, /kiro-cli/);
  assert.equal(existsSync(f.tools), false, 'inspection creates nothing');

  const codex = adoptHostSignIn(f.dir, { harness: 'codex', ...f.options });
  assert.deepEqual(codex, { id: 'adopt-host-signin:codex', status: 'done', from: path.join(f.home, '.codex'), to: path.join(f.tools, 'codex'), at: '2026-10-07T10:00:00.000Z',
    note: 'copied auth.json', files: [{ path: 'auth.json', kind: 'sign-in', status: 'copied' }] });
  assert.equal(readFileSync(path.join(f.tools, 'codex', 'auth.json'), 'utf8'), `{"OPENAI_API_KEY":"${SECRET}"}`);
  assert.equal(mode(path.join(f.tools, 'codex', 'auth.json')), 0o600);
  assert.equal(mode(path.join(f.tools, 'codex')), 0o700);
  assert.equal(mode(f.tools), 0o700);
  assert.deepEqual(readdirSync(path.join(f.tools, 'codex')), ['auth.json'], 'sessions never come along');
  const claude = adoptHostSignIn(f.dir, { harness: 'claude', ...f.options });
  assert.equal(claude.status, 'done');
  assert.deepEqual(claude.files, [{ path: '.credentials.json', kind: 'sign-in', status: 'copied' }, { path: '.claude.json', kind: 'state', status: 'copied' }]);
  assert.equal(claude.note, 'copied .credentials.json, .claude.json');
  assert.deepEqual(readdirSync(path.join(f.tools, 'claude')).sort(), ['.claude.json', '.credentials.json'], 'settings.json is not adopted');
  const opencode = adoptHostSignIn(f.dir, { harness: 'opencode', ...f.options });
  assert.equal(opencode.status, 'done');
  assert.equal(mode(path.join(f.tools, 'opencode', 'data', 'opencode', 'auth.json')), 0o600);
  assert.equal(mode(path.join(f.tools, 'opencode', 'data', 'opencode')), 0o700);
  assert.ok(['config', 'data', 'cache'].every((name) => statSync(path.join(f.tools, 'opencode', name)).isDirectory()));
  assert.deepEqual(readMigrationJournal(f.dir).map((step) => [step.id, step.status]), [['adopt-host-signin:codex', 'done'], ['adopt-host-signin:claude', 'done'], ['adopt-host-signin:opencode', 'done']]);
  assert.equal(mode(path.join(f.dir, '.soul-state', 'migration.json')), 0o600);
  // Adopted, the next launch routes.
  const after = inspectToolHomes(f.dir, ['codex', 'claude', 'opencode'], f.options);
  assert.deepEqual(after.map((row) => [row.containment, row.signIn, row.adopted, row.routing]),
    [['soul', 'present', true, ['CODEX_HOME']], ['soul', 'present', true, ['CLAUDE_CONFIG_DIR']], ['soul', 'present', true, ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']]]);

  // A second run changes nothing and says so; the journal keeps one entry per step.
  put(path.join(f.home, '.codex', 'auth.json'), '{"OPENAI_API_KEY":"a-newer-host-login"}');
  const again = adoptHostSignIn(f.dir, { harness: 'codex', ...f.options });
  assert.deepEqual([again.status, again.note, again.files], ['skipped', 'already adopted', [{ path: 'auth.json', kind: 'sign-in', status: 'present' }]]);
  assert.equal(readFileSync(path.join(f.tools, 'codex', 'auth.json'), 'utf8'), `{"OPENAI_API_KEY":"${SECRET}"}`, 'the soul\'s copy is never overwritten');
  assert.deepEqual(readMigrationJournal(f.dir).map((step) => [step.id, step.status]), [['adopt-host-signin:claude', 'done'], ['adopt-host-signin:opencode', 'done'], ['adopt-host-signin:codex', 'skipped']]);
  // An unroutable harness is skipped with the registry's reason and nothing on disk.
  const kiro = adoptHostSignIn(f.dir, { harness: 'kiro', ...f.options });
  assert.deepEqual([kiro.status, kiro.files, existsSync(path.join(f.tools, 'kiro'))], ['skipped', [], false]);
  assert.match(kiro.note, /kiro-cli/);
  assertNoLeak(path.join(f.dir, '.soul-state'), 'journal');

  // No host store at all: nothing to lose, routed from the first launch;
  // the adoption is skipped with the harness's own next step.
  const bare = fixture(t, { host: false, census: false });
  assert.deepEqual(inspectToolHomes(bare.dir, ['codex'], bare.options).map((row) => [row.containment, row.signIn, row.hostSignIn, row.routing]), [['soul', 'missing', 'missing', ['CODEX_HOME']]]);
  const none = adoptHostSignIn(bare.dir, { harness: 'codex', ...bare.options });
  assert.deepEqual([none.status, none.files], ['skipped', [{ path: 'auth.json', kind: 'sign-in', status: 'absent' }]]);
  assert.match(none.note, /no sign-in file for this harness; sign in once inside the soul/);
  assert.ok(statSync(path.join(bare.tools, 'codex')).isDirectory(), 'the tool home exists for the harness to sign in to');
  // Claude on macOS: the keychain may hold a sign-in no file shows, so the
  // host store is kept (`unknown`) until the owner adopts; the adoption
  // carries .claude.json, says why the sign-in did not come along, and
  // counts as the owner's decision, so the next launch routes.
  put(path.join(bare.home, '.claude.json'), '{"hasCompletedOnboarding":true}');
  const darwin = { ...bare.options, platform: 'darwin' };
  const mac = inspectToolHomes(bare.dir, ['claude', 'codex'], darwin);
  assert.deepEqual(mac.map((row) => [row.harness, row.containment, row.signIn, row.hostSignIn, row.routing]), [['claude', 'shared-host', 'missing', 'unknown', []], ['codex', 'soul', 'missing', 'missing', ['CODEX_HOME']]]);
  assert.match(mac[0].reason, /may hold claude's sign-in where no file shows it .*login keychain/);
  assert.deepEqual(inspectToolHomes(bare.dir, ['claude'], bare.options).map((row) => [row.containment, row.hostSignIn]), [['soul', 'missing']], 'on linux the file is the sign-in');
  const keychain = adoptHostSignIn(bare.dir, { harness: 'claude', ...darwin });
  assert.equal(keychain.status, 'done');
  assert.deepEqual(keychain.files, [{ path: '.credentials.json', kind: 'sign-in', status: 'absent' }, { path: '.claude.json', kind: 'state', status: 'copied' }]);
  assert.match(keychain.note, /^copied \.claude\.json; on macOS Claude Code keeps its OAuth sign-in in the login keychain, per user/);
  assert.deepEqual(inspectToolHomes(bare.dir, ['claude'], darwin).map((row) => [row.containment, row.signIn, row.hostSignIn, row.adopted, row.routing]), [['soul', 'missing', 'unknown', true, ['CLAUDE_CONFIG_DIR']]]);
  // The same on a Mac with nothing at all to adopt: a skipped step is still the owner's call.
  const empty = fixture(t, { host: false, census: false });
  assert.equal(inspectToolHomes(empty.dir, ['claude'], { ...empty.options, platform: 'darwin' })[0].containment, 'shared-host');
  assert.equal(adoptHostSignIn(empty.dir, { harness: 'claude', ...empty.options, platform: 'darwin' }).status, 'skipped');
  assert.equal(inspectToolHomes(empty.dir, ['claude'], { ...empty.options, platform: 'darwin' })[0].containment, 'soul');
  // A linked host file is never followed.
  const linked = fixture(t, { host: false, census: false });
  mkdirSync(path.join(linked.home, '.codex'), { recursive: true });
  put(path.join(linked.home, 'elsewhere.json'), `{"OPENAI_API_KEY":"${SECRET}"}`);
  spawnSync('ln', ['-s', path.join(linked.home, 'elsewhere.json'), path.join(linked.home, '.codex', 'auth.json')]);
  assert.equal(adoptHostSignIn(linked.dir, { harness: 'codex', ...linked.options }).files[0].status, 'absent');
});

test('soul env migrate --adopt-host-signin is owner gated, filters by --harness, receipts names only, and refuses what it cannot do with a code', async (t) => {
  const f = fixture(t);
  let out = '';
  const write = (value) => { out += value; };
  const result = await soulEnvMigrateCommand(['billy', '--adopt-host-signin', '--json', '--principal-stdin'], { ...f.options, write, readStdin: () => '{"principalId":"p1"}' });
  assert.deepEqual(JSON.parse(out), result);
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'agentId', 'soulDir', 'operation', 'decision', 'steps', 'root']);
  assert.deepEqual([result.schemaVersion, result.agentId, result.soulDir, result.operation, result.decision, result.root], [1, ID, f.dir, 'adopt-host-signin', 'adopted', f.tools]);
  // The identity's harness first, then the manifest's preferred ones, routable only.
  assert.deepEqual(result.steps.map((step) => [step.id, step.status]), [['adopt-host-signin:codex', 'done'], ['adopt-host-signin:claude', 'done'], ['adopt-host-signin:opencode', 'done']]);
  assert.deepEqual(f.gates, [[`adopt the host's codex, claude, opencode sign-in into ${ID}'s soul folder`, { principalId: 'p1' }]]);
  const receipts = f.receipts().filter((receipt) => receipt.event === 'soul-env-migrate');
  assert.equal(receipts.length, 1);
  assert.deepEqual([receipts[0].agentId, receipts[0].operation, receipts[0].decision], [ID, 'adopt-host-signin', 'adopted']);
  assert.equal(receipts[0].detail, 'codex: done (auth.json copied); claude: done (.credentials.json copied, .claude.json copied); opencode: done (opencode/auth.json copied)');
  assert.ok(!out.includes(SECRET) && !JSON.stringify(receipts).includes(SECRET), 'no value in the output or the receipt');
  assertNoLeak(path.join(f.env.XDG_STATE_HOME), 'state');

  // A rerun of one harness is a no-op that still says what it found.
  out = '';
  const rerun = await soulEnvMigrateCommand([ID, '--adopt-host-signin', '--harness', 'codex', '--json'], { ...f.options, write });
  assert.deepEqual([rerun.decision, rerun.steps.map((step) => [step.id, step.status, step.note])], ['skipped', [['adopt-host-signin:codex', 'skipped', 'already adopted']]]);
  assert.equal(f.gates.at(-1)[0], `adopt the host's codex sign-in into ${ID}'s soul folder`);
  assert.match(f.receipts().at(-1).detail, /^codex: skipped \(auth\.json present\)$/);
  out = '';
  await soulEnvMigrateCommand(['billy', '--adopt-host-signin'], { ...f.options, write });
  assert.match(out, new RegExp(`^agentId: ${ID}\\nsoulDir: .*\\noperation: adopt-host-signin\\ndecision: skipped\\n\\nadopt-host-signin:codex: skipped - already adopted\\n  auth\\.json: present\\n`));

  // The gate refusing copies nothing and leaves no receipt.
  const g = fixture(t);
  await assert.rejects(soulEnvMigrateCommand(['billy', '--adopt-host-signin'], { ...g.options, write: () => {}, gate: async () => { throw Object.assign(new Error('owner only'), { code: 'owner-required' }); } }), /owner only/);
  assert.equal(existsSync(g.tools), false);
  assert.deepEqual(g.receipts(), []);
  assert.equal(existsSync(path.join(g.dir, '.soul-state', 'migration.json')), false);
  // Coded refusals, before the gate.
  await assert.rejects(soulEnvMigrateCommand(['billy', '--adopt-host-signin', '--harness', 'kiro'], { ...g.options, write: () => {} }), (error) => error.code === 'tool-home-unsupported' && /kiro-cli/.test(error.message));
  await assert.rejects(soulEnvMigrateCommand(['billy', '--adopt-host-signin', '--harness', 'ruby'], { ...g.options, write: () => {} }), /--harness must be one of/);
  await assert.rejects(soulEnvMigrateCommand(['nobody', '--adopt-host-signin'], { ...g.options, write: () => {} }), (error) => error.code === 'soul-not-found');
  rmSync(path.join(g.dir, '.soul-state'), { recursive: true });
  await assert.rejects(soulEnvMigrateCommand(['billy', '--adopt-host-signin'], { ...g.options, write: () => {} }), (error) => error.code === 'soul-state-missing');
  assert.deepEqual(g.gates, [], 'nothing reached the gate');
  for (const args of [[], ['billy'], ['--adopt-host-signin'], ['billy', '--adopt-host-signin', 'extra'], ['billy', '--adopt-host-signin', '--harness'], ['billy', '--adopt-host-signin', '--nope']]) {
    await assert.rejects(soulEnvMigrateCommand(args, { ...g.options, write: () => {} }), /usage: agent-bot soul env migrate/, args.join(' '));
  }
  // The stable CLI: a coded failure prints JSON and exits 1, and the help names the command.
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', 'env', 'migrate', 'nobody', '--adopt-host-signin', '--json'], { cwd: g.home, env: { ...g.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).error.code, 'soul-not-found');
  const help = spawnSync(process.execPath, [path.join(ROOT, 'agent-bot.mjs'), 'soul', '--help'], { cwd: g.home, env: { ...g.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
  assert.match(help.stdout, /soul env migrate <agentId\|name> --adopt-host-signin \[--harness NAME\]/);
});

test('the descriptor reports each tool home\'s containment and sign-in by existence, keeps a host sign-in shared until adopted with the command as the action, and lists the journal (#583 slice 2)', async (t) => {
  const f = fixture(t);
  const toolState = (result) => result.components.find((component) => component.id === 'tool-state');
  const problems = (result, code) => result.readiness.problems.filter((problem) => problem.code === code);
  let result = readSoulEnvironment(ID, f.options);
  assert.deepEqual(toolState(result).entries.map((row) => [row.harness, row.containment, row.routing, row.signIn, row.hostSignIn, row.hostPath]), [
    ['codex', 'shared-host', [], 'missing', 'present', path.join(f.home, '.codex')],
    ['claude', 'shared-host', [], 'missing', 'present', path.join(f.home, '.claude')],
    ['opencode', 'shared-host', [], 'missing', 'present', path.join(f.home, '.local', 'share', 'opencode')]]);
  assert.match(toolState(result).entries[0].reason, /the host store holds codex's sign-in/);
  assert.match(toolState(result).entries[1].note, /keychain/);
  assert.equal(result.harnesses.selected, 'codex');
  assert.equal(result.launch.routing.toolHome, 'host');
  assert.deepEqual(result.launch.routing.env, []);
  assert.deepEqual(result.launch.limitations.map((row) => row.harness), ['codex', 'claude', 'opencode']);
  assert.match(result.launch.limitations[0].message, /stays shared on the host .* the host store holds codex's sign-in/);
  assert.deepEqual(problems(result, 'tool-signin-missing'), [{ code: 'tool-signin-missing', severity: 'warning', component: 'tool-state',
    message: `codex's sign-in is on the host (${path.join(f.home, '.codex')}) but not in the soul's tool home, so the launch keeps the shared host store; adopt it once to contain this soul`,
    action: `agent-bot soul env migrate ${ID} --adopt-host-signin --harness codex` }]);
  assert.equal(result.readiness.ready, true, 'a warning');
  assert.deepEqual(result.migration.steps.filter((step) => step.id.startsWith('adopt-')), [
    { id: 'adopt-host-signin:codex', status: 'pending', from: path.join(f.home, '.codex'), to: path.join(f.tools, 'codex') },
    { id: 'adopt-host-signin:claude', status: 'pending', from: path.join(f.home, '.claude'), to: path.join(f.tools, 'claude') },
    { id: 'adopt-host-signin:opencode', status: 'pending', from: path.join(f.home, '.local', 'share', 'opencode'), to: path.join(f.tools, 'opencode') }]);
  assert.equal(result.migration.status, 'pending');
  assert.equal(existsSync(f.tools), false, 'reading creates no tool home');
  assert.ok(!JSON.stringify(result).includes(SECRET));

  await soulEnvMigrateCommand([ID, '--adopt-host-signin', '--harness', 'codex'], { ...f.options, write: () => {} });
  result = readSoulEnvironment(ID, f.options);
  assert.deepEqual(toolState(result).entries.map((row) => [row.harness, row.containment, row.routing, row.signIn]), [['codex', 'soul', ['CODEX_HOME'], 'present'], ['claude', 'shared-host', [], 'missing'], ['opencode', 'shared-host', [], 'missing']]);
  assert.equal(result.launch.routing.toolHome, 'soul');
  assert.deepEqual(result.launch.routing.env, ['CODEX_HOME']);
  assert.deepEqual(result.launch.limitations.map((row) => row.harness), ['claude', 'opencode']);
  assert.deepEqual(problems(result, 'tool-signin-missing'), []);
  assert.deepEqual(result.migration.steps.filter((step) => step.id.startsWith('adopt-')), [
    { id: 'adopt-host-signin:codex', status: 'done', from: path.join(f.home, '.codex'), to: path.join(f.tools, 'codex'), at: '2026-10-07T10:00:00.000Z', note: 'copied auth.json' },
    { id: 'adopt-host-signin:claude', status: 'pending', from: path.join(f.home, '.claude'), to: path.join(f.tools, 'claude') },
    { id: 'adopt-host-signin:opencode', status: 'pending', from: path.join(f.home, '.local', 'share', 'opencode'), to: path.join(f.tools, 'opencode') }]);
  assert.ok(!JSON.stringify(result).includes(SECRET), 'the journal never carries a value into the descriptor');
  // A tampered journal is read as empty rather than echoed.
  put(path.join(f.dir, '.soul-state', 'migration.json'), '{"steps":[{"id":"x","status":"weird","from":1},"junk"]}');
  assert.deepEqual(readMigrationJournal(f.dir), []);

  // Without a sign-in on the host there is nothing to lose: contained from
  // the first launch, nothing to adopt and nothing to warn about.
  const bare = fixture(t, { host: false });
  const quiet = readSoulEnvironment(ID, bare.options);
  assert.deepEqual(toolState(quiet).entries.map((row) => [row.containment, row.signIn, row.hostSignIn, row.routing]),
    [['soul', 'missing', 'missing', ['CODEX_HOME']], ['soul', 'missing', 'missing', ['CLAUDE_CONFIG_DIR']], ['soul', 'missing', 'missing', ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']]]);
  assert.equal(quiet.launch.routing.toolHome, 'soul');
  assert.deepEqual(quiet.launch.routing.env, ['CODEX_HOME']);
  assert.deepEqual(quiet.launch.limitations, []);
  assert.deepEqual(problems(quiet, 'tool-signin-missing'), []);
  assert.deepEqual(quiet.migration.steps.filter((step) => step.id.startsWith('adopt-')), []);
  // A Mac's Claude: the keychain may hold a sign-in, so the host store is kept and the warning says so.
  const mac = fixture(t, { host: false, harnesses: ['claude'], identityHarness: 'claude', platform: 'darwin' });
  const keychain = readSoulEnvironment(ID, mac.options);
  assert.deepEqual(toolState(keychain).entries.map((row) => [row.harness, row.containment, row.signIn, row.hostSignIn, row.routing]), [['claude', 'shared-host', 'missing', 'unknown', []]]);
  assert.equal(keychain.launch.routing.toolHome, 'host');
  assert.match(problems(keychain, 'tool-signin-missing')[0].message, /^claude's sign-in may be on the host where no file shows it/);
  assert.equal(problems(keychain, 'tool-signin-missing')[0].action, `agent-bot soul env migrate ${ID} --adopt-host-signin --harness claude`);
  assert.deepEqual(keychain.migration.steps.filter((step) => step.id.startsWith('adopt-')).map((step) => [step.id, step.status]), [['adopt-host-signin:claude', 'pending']]);

  // An unroutable harness is reported as such, with its reason, and stays a launch limitation.
  const kiro = fixture(t, { harnesses: ['kiro'], identityHarness: 'kiro' });
  const shared = readSoulEnvironment(ID, kiro.options);
  assert.deepEqual(toolState(shared).entries.map((row) => [row.harness, row.containment, row.routing, row.signIn, row.hostSignIn, row.hostPath]),
    [['kiro', 'unsupported', [], 'unknown', 'unknown', path.join(kiro.home, '.kiro')]]);
  assert.match(toolState(shared).entries[0].reason, /kiro-cli/);
  assert.equal(shared.launch.routing.toolHome, 'host');
  assert.deepEqual(shared.launch.routing.env, []);
  assert.equal(shared.launch.limitations.length, 1);
  assert.match(shared.launch.limitations[0].message, /stays shared on the host .* kiro-cli/);
  assert.deepEqual(problems(shared, 'tool-signin-missing'), []);
  assert.deepEqual(shared.migration.steps.filter((step) => step.id.startsWith('adopt-')), []);
});

test('the launch helpers route only what the decision contains, create the tool home privately, route nothing without a folder or for an unroutable harness, and fail unwritable with a code', (t) => {
  // A host with sign-ins the soul lacks: the launch keeps the host store,
  // nothing pending, no patch, nothing created.
  const shared = fixture(t);
  assert.deepEqual(pendingSoulToolHome(ID, { ...shared.options, harness: 'codex' }), []);
  assert.deepEqual(soulToolHomeEnv(ID, { ...shared.options, harness: 'codex' }), {});
  assert.equal(prepareSoulToolHome(ID, { ...shared.options, harness: 'codex' }), null);
  assert.equal(existsSync(shared.tools), false);
  adoptHostSignIn(shared.dir, { harness: 'codex', ...shared.options });
  assert.deepEqual(pendingSoulToolHome(ID, { ...shared.options, harness: 'codex' }), ['tool-home:codex']);
  assert.deepEqual(soulToolHomeEnv(ID, { ...shared.options, harness: 'codex' }), { CODEX_HOME: path.join(shared.tools, 'codex') }, 'adopted, the next launch routes');
  assert.deepEqual(soulToolHomeEnv(ID, { ...shared.options, harness: 'claude' }), {}, 'another harness still waits for its adoption');
  // No host sign-in to lose: contained from the first launch.
  const f = fixture(t, { host: false });
  assert.deepEqual(pendingSoulToolHome(ID, { ...f.options, harness: 'claude' }), ['tool-home:claude']);
  assert.deepEqual(pendingSoulToolHome(ID, { ...f.options, harness: 'kiro' }), []);
  assert.deepEqual(pendingSoulToolHome('nobody', { ...f.options, harness: 'claude' }), []);
  assert.equal(prepareSoulToolHome(ID, { ...f.options, harness: 'claude' }), path.join(f.tools, 'claude'));
  assert.equal(mode(path.join(f.tools, 'claude')), 0o700);
  const patch = soulToolHomeEnv(ID, { ...f.options, harness: 'opencode' });
  assert.deepEqual(patch, { XDG_CONFIG_HOME: path.join(f.tools, 'opencode', 'config'), XDG_DATA_HOME: path.join(f.tools, 'opencode', 'data'), XDG_CACHE_HOME: path.join(f.tools, 'opencode', 'cache') });
  assert.ok(Object.values(patch).every((dir) => mode(dir) === 0o700));
  assert.ok(!('HOME' in patch) && !('XDG_STATE_HOME' in patch));
  assert.deepEqual(soulToolHomeEnv(ID, { ...f.options, harness: 'kiro' }), {});
  assert.deepEqual(soulToolHomeEnv(ID, { ...f.options, harness: null }), {});
  assert.equal(prepareSoulToolHome(ID, { ...f.options, harness: 'muse' }), null);
  // On a Mac, Claude's keychain may hold a sign-in: kept on the host until adopted; codex is contained.
  assert.deepEqual(soulToolHomeEnv(ID, { ...f.options, harness: 'claude', platform: 'darwin' }), {});
  assert.deepEqual(pendingSoulToolHome(ID, { ...f.options, harness: 'claude', platform: 'darwin' }), []);
  assert.deepEqual(pendingSoulToolHome(ID, { ...f.options, harness: 'codex', platform: 'darwin' }), ['tool-home:codex']);
  // No folder yet: unrouted, as before.
  const fresh = fixture(t, { host: false });
  rmSync(path.join(fresh.dir, '.soul-state'), { recursive: true });
  assert.deepEqual(soulToolHomeEnv(ID, { ...fresh.options, harness: 'codex' }), {});
  assert.deepEqual(pendingSoulToolHome(ID, { ...fresh.options, harness: 'codex' }), []);
  // A tools path that is not a directory cannot become one silently.
  const blocked = fixture(t, { host: false });
  put(blocked.tools, 'not a directory\n');
  for (const call of [() => soulToolHomeEnv(ID, { ...blocked.options, harness: 'codex' }), () => prepareSoulToolHome(ID, { ...blocked.options, harness: 'codex' }), () => ensureToolHome(blocked.dir, 'codex')]) {
    assert.throws(call, (error) => error.code === 'tool-home-unwritable' && /codex's tool home/.test(error.message));
  }
  assert.rejects(soulEnvMigrateCommand([ID, '--adopt-host-signin', '--harness', 'codex'], { ...blocked.options, write: () => {} }), (error) => error.code === 'tool-home-unwritable');
});
