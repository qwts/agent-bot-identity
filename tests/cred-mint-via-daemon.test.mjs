import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSoulBound, mintCredential, mintForCaller } from '../git-credential-bot.mjs';
import { buildGhShim } from '../gh-shim.mjs';

const root = mkdtempSync(join(tmpdir(), 'cred-mint-via-daemon-'));
const originalEnv = process.env;
// Shared identity readers invoke git themselves. Isolate their ambient env
// as well as the explicit env passed to the code under test.
process.env = {
  ...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: root,
  USER: 'credential-test-owner',
  AGENT_BOT_ACCOUNT: 'credential-test-owner',
  AGENT_BOT_CONFIG: join(root, 'config.json'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
writeFileSync(process.env.AGENT_BOT_CONFIG, JSON.stringify({
  prefix: 'test', features: { 'github-identity': true },
}));
after(() => {
  process.env = originalEnv;
  rmSync(root, { recursive: true, force: true });
});

const slug = 'test-codex-agent';
const agentId = `agent_${randomUUID()}`;
const secret = randomBytes(32).toString('base64url');
const token = randomBytes(32).toString('hex');
const grant = {
  schemaVersion: 1, agentId, appSlug: slug, token,
  expires_at: new Date(Date.now() + 3600_000).toISOString(), installation_id: 123,
};
const binding = { v: 1, agentId, secret, daemon: 'http://127.0.0.1:1/', account: 'test', parent: null };
const noLocalMint = () => { throw new Error('local mint must not run'); };

function checkout(t) {
  const cwd = mkdtempSync(join(root, 'checkout-'));
  execFileSync('git', ['init', '--quiet', cwd]);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function bind(cwd) {
  writeFileSync(join(cwd, '.git', 'agent-binding.json'), JSON.stringify(binding), { mode: 0o600 });
}

test('a soul-bound caller uses the daemon client and never mints locally', async (t) => {
  const cwd = checkout(t);
  bind(cwd);
  let requests = 0;
  const result = await mintCredential({
    slug, cwd, mintImpl: noLocalMint,
    clientFactory: (options) => {
      assert.equal(options.cwd, cwd);
      assert.equal(options.home, root);
      return { credential: async (...args) => {
        assert.ok(args.length === 1 && args[0] === secret, 'only the binding authenticates the request');
        requests++;
        return grant;
      } };
    },
  });
  assert.ok(result.token === token, 'returns the daemon grant');
  assert.equal(result.expires_at, grant.expires_at);
  assert.equal(result.installation_id, grant.installation_id);
  assert.equal(requests, 1);
});

test('an owner caller still mints locally without contacting the daemon', async (t) => {
  const cwd = checkout(t);
  let mints = 0;
  const result = await mintCredential({
    slug, cwd,
    mintImpl: async (options) => {
      assert.equal(options.slug, slug);
      assert.equal(options.env.HOME, root);
      mints++;
      return grant;
    },
    readBindingImpl: () => { throw new Error('owner must not request a binding'); },
    clientFactory: () => { throw new Error('owner must not contact the daemon'); },
  });
  assert.ok(result === grant);
  assert.equal(mints, 1);
});

test('a soul-bound caller fails clearly when the daemon is down, without leaking errors or falling back', async (t) => {
  const cwd = checkout(t);
  bind(cwd);
  await assert.rejects(mintCredential({
    slug, cwd, mintImpl: noLocalMint,
    clientFactory: () => ({ credential: async () => { throw new Error(secret); } }),
  }), (error) => {
    assert.match(error.message, /daemon.*could not provide.*credential/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('a soul-bound caller is told the daemon\'s own reason, such as a soul without an App', async (t) => {
  const cwd = checkout(t);
  bind(cwd);
  await assert.rejects(mintCredential({
    slug, cwd, mintImpl: noLocalMint,
    clientFactory: () => ({ credential: async () => { throw new Error('daemon POST /v0/credential failed: this soul has no GitHub App'); } }),
  }), /daemon refused a GitHub credential: this soul has no GitHub App$/);
  await assert.rejects(mintCredential({
    slug, cwd, mintImpl: noLocalMint,
    clientFactory: () => ({ credential: async () => { throw new Error('daemon POST /v0/credential failed: HTTP 502'); } }),
  }), /daemon.*could not provide.*credential/);
});

for (const key of ['AGENT_BOT_ID', 'QWTS_AGENT_ID', 'GH_AGENT_APP', 'AGENT_BOT_BINDING']) {
  test(`${key} without a binding cannot fall back to local mint`, async (t) => {
    const cwd = checkout(t);
    const env = { ...process.env, [key]: key === 'GH_AGENT_APP' ? slug : key === 'AGENT_BOT_BINDING' ? join(cwd, 'missing') : agentId };
    assert.equal(isSoulBound({ cwd, env }), true);
    await assert.rejects(mintCredential({ slug, cwd, env, mintImpl: noLocalMint }), /daemon binding/);
  });
}

for (const key of ['agentBot.app', 'qwts.agentApp', 'agentBot.agentId', 'qwts.agentId']) {
  test(`${key} pin without a binding cannot fall back to local mint`, async (t) => {
    const cwd = checkout(t);
    execFileSync('git', ['config', key, key.toLowerCase().endsWith('id') ? agentId : slug], { cwd });
    assert.equal(isSoulBound({ cwd }), true);
    await assert.rejects(mintCredential({ slug, cwd, mintImpl: noLocalMint }), /daemon binding/);
  });
}

test('a harness marker alone leaves the unpinned owner on the local path', (t) => {
  assert.equal(isSoulBound({ cwd: checkout(t), env: { ...process.env, CLAUDECODE: '1' } }), false);
});

test('an unreadable binding fails closed without reflecting its contents', async (t) => {
  const cwd = checkout(t);
  writeFileSync(join(cwd, '.git', 'agent-binding.json'), secret, { mode: 0o600 });
  await assert.rejects(mintCredential({ slug, cwd, mintImpl: noLocalMint }), /daemon.*binding is unreadable/);
});

for (const [name, change] of [
  ['another App', { appSlug: 'other-app' }],
  ['another soul', { agentId: `agent_${randomUUID()}` }],
  ['missing token', { token: undefined }],
  ['invalid expiry', { expires_at: 'invalid' }],
]) {
  test(`refuses a daemon response with ${name}`, async (t) => {
    const cwd = checkout(t);
    bind(cwd);
    await assert.rejects(mintCredential({
      slug, cwd, mintImpl: noLocalMint,
      clientFactory: () => ({ credential: async () => ({ ...grant, ...change }) }),
    }), /daemon.*(identity|invalid)/);
  });
}

// Exercise the real entrypoints and daemonClient with a fake transport. No
// socket, key store, GitHub account, login keychain, or real gh is used.
const preload = join(root, 'fake-daemon.mjs');
writeFileSync(preload, `
globalThis.fetch = async (url, options) => {
  if (process.env.TEST_DAEMON_DOWN) throw new Error('connection refused');
  if (url !== 'http://127.0.0.1:1/v0/credential' || options.method !== 'POST'
      || options.body !== '{}' || options.headers.authorization) throw new Error('unexpected daemon request');
  return { ok: true, json: async () => JSON.parse(process.env.TEST_DAEMON_GRANT) };
};
`);

function run(cwd, script, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL(`../${script}`, import.meta.url)), ...args], {
    cwd, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n',
    env: { ...process.env, TEST_DAEMON_GRANT: JSON.stringify(grant), ...extraEnv },
  });
}

for (const [name, script, args] of [
  ['git helper', 'git-credential-bot.mjs', [slug, 'get']],
  ['worktree token', 'worktree-token.mjs', []],
  ['desktop explicit mint', 'worktree-token.mjs', ['--mint-app', slug]],
]) {
  test(`${name} obtains the credential through the daemon`, (t) => {
    const cwd = checkout(t);
    bind(cwd);
    execFileSync('git', ['config', 'agentBot.app', slug], { cwd });
    const result = run(cwd, script, args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(token), 'entrypoint returns the daemon credential');
  });

  test(`${name} refuses a down daemon even with a usable local token cache`, (t) => {
    const cwd = checkout(t);
    bind(cwd);
    execFileSync('git', ['config', 'agentBot.app', slug], { cwd });
    writeFileSync(join(cwd, '.git', 'agent-bot-token.json'), JSON.stringify({ slug, ...grant }), { mode: 0o600 });
    const result = run(cwd, script, args, { TEST_DAEMON_DOWN: '1' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /daemon.*could not provide/);
  });
}

test('worktree token uses a binding even when no App slug resolves locally', (t) => {
  const cwd = checkout(t);
  bind(cwd);
  const result = run(cwd, 'worktree-token.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim() === token);
});

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
for (const desktop of [false, true]) {
  test(`installed ${desktop ? 'desktop' : 'normal'} gh shim requests daemon credentials and fails closed`, (t) => {
    const cwd = checkout(t);
    bind(cwd);
    const home = join(cwd, 'home');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const runtime = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
    writeFileSync(join(home, '.local', 'bin', 'agent-bot'), `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(preload)} ${quote(runtime)} "$@"\n`, { mode: 0o755 });
    const shim = join(cwd, 'shim');
    writeFileSync(shim, buildGhShim());
    const fakeGh = join(cwd, 'fake-gh');
    writeFileSync(fakeGh, '#!/bin/sh\ntouch "$TEST_GH_CALLED"\n[ "$GH_TOKEN" = "$TEST_EXPECTED_TOKEN" ] || exit 91\n', { mode: 0o755 });
    const env = {
      ...process.env, HOME: home, AGENT_BOT_REAL_GH: fakeGh, TEST_GH_CALLED: join(cwd, 'gh-called'),
      NODE_OPTIONS: `--import=${preload}`,
      TEST_EXPECTED_TOKEN: token, TEST_DAEMON_GRANT: JSON.stringify(grant),
      ...(desktop ? { AGENT_BOT_CODEX_DESKTOP: '1', CODEX_DESKTOP_GH: '1' } : {}),
    };
    const result = spawnSync('/bin/sh', [shim, 'api', 'repos/test/repo'], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    // An inherited token (the owner's, another bot's) is dropped: gh still
    // runs with the daemon's, and a down daemon still fails closed.
    const inherited = { ...env, GH_TOKEN: 'inherited-human-token', GITHUB_TOKEN: 'inherited-human-token' };
    const dropped = spawnSync('/bin/sh', [shim, 'api', 'repos/test/repo'], { cwd, env: inherited, encoding: 'utf8' });
    assert.equal(dropped.status, 0, dropped.stderr);
    const droppedDown = spawnSync('/bin/sh', [shim, 'api', 'repos/test/repo'], {
      cwd, env: { ...inherited, TEST_DAEMON_DOWN: '1' }, encoding: 'utf8',
    });
    assert.equal(droppedDown.status, 1);
    assert.match(droppedDown.stderr, /daemon.*could not provide/);
    // whoami for a soul with no App resolvable here answers locally.
    rmSync(join(cwd, 'gh-called'), { force: true });
    const who = spawnSync('/bin/sh', [shim, 'whoami'], { cwd, env: inherited, encoding: 'utf8' });
    assert.equal(who.status, 0, who.stderr);
    assert.match(who.stdout, /^soul-bound/);
    assert.equal(existsSync(join(cwd, 'gh-called')), false, 'stock gh was never run');
    const down = spawnSync('/bin/sh', [shim, 'api', 'repos/test/repo'], {
      cwd, env: { ...env, TEST_DAEMON_DOWN: '1' }, encoding: 'utf8',
    });
    assert.equal(down.status, 1);
    assert.equal(down.stdout, '');
    assert.match(down.stderr, /daemon.*could not provide/);
  });
}

// #775: mint-token, signed-commit and the gist handoff mint in the caller's
// process. In a bound checkout the soul's own App comes from the daemon;
// another App, a GH_AGENT_APP override or --permissions goes through the
// owner gate, receipted either way. Each case uses this file's scratch HOME
// and a fake daemon client, so no test reaches a live daemon.
function callerFixture(t, { bound = true, gate = async () => ({ method: 'presence', via: 'agent-bot-keyd' }) } = {}) {
  const cwd = checkout(t);
  if (bound) bind(cwd);
  const calls = { daemon: 0, local: [], gate: [], receipts: [], selected: [] };
  const options = {
    cwd,
    env: process.env,
    readIdentityImpl: (id) => { assert.equal(id, agentId); return { id, status: 'active', github: { appSlug: slug } }; },
    clientFactory: () => ({ credential: async () => { calls.daemon++; return grant; } }),
    mintImpl: async (request) => { calls.local.push(request); return { token: 'ghs_local', expires_at: grant.expires_at }; },
    approve: async (action, opts) => { calls.gate.push(action); return gate(action, opts); },
    receipt: (fields) => calls.receipts.push(fields),
    selected: (chosen) => calls.selected.push(chosen),
  };
  return { cwd, calls, options };
}

test('a bound soul\'s own App comes from the daemon with no gate and no local mint', async (t) => {
  const { calls, options } = callerFixture(t);
  for (const slugAsked of [null, slug]) {
    const result = await mintForCaller({ ...options, slug: slugAsked });
    assert.ok(result.token === token);
  }
  assert.equal(calls.daemon, 2);
  assert.deepEqual(calls.local, []);
  assert.deepEqual(calls.gate, []);
  assert.deepEqual(calls.selected.map((chosen) => chosen.reason), ['bound-soul-own-app', 'bound-soul-own-app']);
});

test('another App from a bound checkout asks the owner gate, receipts it, then mints that App', async (t) => {
  const { calls, options } = callerFixture(t);
  const result = await mintForCaller({ ...options, slug: 'other-app', operation: 'signed-commit' });
  assert.equal(result.token, 'ghs_local');
  assert.equal(calls.daemon, 0);
  assert.equal(calls.gate.length, 1);
  assert.match(calls.gate[0], /other-app\[bot\].*stated as agent_/);
  assert.deepEqual(calls.local.map((request) => request.slug), ['other-app']);
  calls.local[0].selected({ appSlug: 'other-app', reason: 'explicit-app' });
  assert.deepEqual(calls.selected, [{ appSlug: 'other-app', reason: 'owner-approved' }]);
  assert.deepEqual(calls.receipts, [{
    event: 'credential-mint', agentId, operation: 'signed-commit', decision: 'approved', appSlug: 'other-app', reason: 'owner-presence',
  }]);
});

test('a declined or headless owner gate refuses, mints nothing and receipts the refusal', async (t) => {
  const { calls, options } = callerFixture(t, {
    gate: async () => { throw new Error('owner approval needs the macOS authorization dialog — refusing on this platform'); },
  });
  await assert.rejects(mintForCaller({ ...options, slug: 'other-app' }), /refusing on this platform/);
  assert.equal(calls.daemon, 0);
  assert.deepEqual(calls.local, []);
  assert.deepEqual(calls.receipts.map((fields) => [fields.decision, fields.reason, fields.appSlug]), [['denied', 'owner-gate-refused', 'other-app']]);
});

test('GH_AGENT_APP and --permissions overrides in a bound checkout go through the owner gate', async (t) => {
  const { calls, options } = callerFixture(t);
  await mintForCaller({ ...options, env: { ...process.env, GH_AGENT_APP: 'other-app' } });
  await mintForCaller({ ...options, slug, permissions: { contents: 'read' } });
  assert.equal(calls.daemon, 0);
  assert.equal(calls.gate.length, 2);
  assert.match(calls.gate[1], /limited to contents=read/);
  assert.deepEqual(calls.local.map((request) => [request.slug, request.permissions]), [['other-app', null], [slug, { contents: 'read' }]]);
});

test('an unbound caller mints as before, without the gate or the daemon', async (t) => {
  const { calls, options } = callerFixture(t, { bound: false });
  const result = await mintForCaller({ ...options, slug: 'other-app', permissions: { contents: 'read' } });
  assert.equal(result.token, 'ghs_local');
  assert.equal(calls.daemon, 0);
  assert.deepEqual(calls.gate, []);
  assert.deepEqual(calls.local.map((request) => [request.slug, request.permissions]), [['other-app', { contents: 'read' }]]);
});

// #107 slice C: the Codex desktop UI is the owner's delegate surface. Its
// configured App mints locally with no gate, as before, and is receipted.
test('the owner\'s delegate surface mints its App with no gate and leaves a receipt', async (t) => {
  const { calls, options } = callerFixture(t, { bound: false });
  const result = await mintForCaller({ ...options, slug: 'codex-app', operation: 'codex-desktop-gh', delegate: true });
  assert.equal(result.token, 'ghs_local');
  assert.equal(calls.daemon, 0);
  assert.deepEqual(calls.gate, []);
  assert.deepEqual(calls.local.map((request) => request.slug), ['codex-app']);
  assert.deepEqual(calls.receipts, [{
    event: 'credential-mint', agentId: null, operation: 'codex-desktop-gh', decision: 'granted',
    appSlug: 'codex-app', reason: 'owner-delegate-surface',
  }]);
  assert.ok(!JSON.stringify(calls.receipts).includes('ghs_'), 'the receipt carries no token');
});

test('a failed delegate-surface mint is receipted and still fails', async (t) => {
  const { calls, options } = callerFixture(t, { bound: false });
  await assert.rejects(mintForCaller({
    ...options, slug: 'codex-app', operation: 'codex-desktop-gh', delegate: true,
    mintImpl: async () => { throw new Error('GitHub refused the installation token'); },
  }), /GitHub refused/);
  assert.deepEqual(calls.gate, []);
  assert.deepEqual(calls.receipts.map((fields) => [fields.decision, fields.reason, fields.appSlug]), [['failed', 'mint-failed', 'codex-app']]);
});

test('a receipt that cannot be written does not stop a delegate-surface mint', async (t) => {
  const { options } = callerFixture(t, { bound: false });
  const result = await mintForCaller({
    ...options, slug: 'codex-app', operation: 'codex-desktop-gh', delegate: true,
    receipt: () => { throw new Error('audit log is read-only'); },
  });
  assert.equal(result.token, 'ghs_local');
});

test('the delegate flag changes nothing for a marked caller or an ordinary unmarked mint', async (t) => {
  const bound = callerFixture(t);
  await mintForCaller({ ...bound.options, delegate: true });
  await mintForCaller({ ...bound.options, slug: 'other-app', delegate: true });
  assert.equal(bound.calls.daemon, 1, 'a bound soul\'s own App still comes from the daemon');
  assert.equal(bound.calls.gate.length, 1, 'another App still asks the owner');
  assert.deepEqual(bound.calls.receipts.map((fields) => [fields.decision, fields.reason]), [['approved', 'owner-presence']]);

  const plain = callerFixture(t, { bound: false });
  await mintForCaller({ ...plain.options, slug: 'other-app' });
  assert.deepEqual(plain.calls.receipts, [], 'without the flag an unmarked mint writes no receipt here, as before');
});

test('an unreadable binding refuses before any mint or gate', async (t) => {
  const { calls, options } = callerFixture(t, { bound: false });
  await assert.rejects(mintForCaller({ ...options, readBindingImpl: () => { throw new Error(secret); } }), (error) => {
    assert.match(error.message, /soul binding in this checkout is unreadable/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.deepEqual([calls.daemon, calls.local.length, calls.gate.length], [0, 0, 0]);
});

test('a soul checkout whose binding is gone still asks the owner for another App, and mints its own as before', async (t) => {
  const { cwd, calls, options } = callerFixture(t, { bound: false });
  execFileSync('git', ['config', 'agentBot.agentId', agentId], { cwd });
  await mintForCaller({ ...options, slug: 'other-app' });
  assert.equal(calls.gate.length, 1);
  assert.deepEqual(calls.receipts.map((fields) => [fields.agentId, fields.decision]), [[agentId, 'approved']]);
  await mintForCaller({ ...options });
  assert.equal(calls.gate.length, 1, 'its own App needs no gate');
  assert.equal(calls.daemon, 0);
  // Its own App resolves as before, so the receipt keeps the ambient selector.
  assert.deepEqual(calls.local.map((request) => request.slug), ['other-app', null]);
});

test('a stated App with no Agent ID (GH_AGENT_APP or the pin) asks the owner for a different App only', async (t) => {
  const { cwd, calls, options } = callerFixture(t, { bound: false });
  await mintForCaller({ ...options, env: { ...process.env, GH_AGENT_APP: slug } });
  assert.deepEqual(calls.gate, [], 'its stated App mints as before');
  await mintForCaller({ ...options, env: { ...process.env, GH_AGENT_APP: slug }, slug: 'other-app' });
  execFileSync('git', ['config', 'agentBot.app', slug], { cwd });
  await mintForCaller({ ...options, slug: 'other-app' });
  assert.equal(calls.gate.length, 2);
  assert.match(calls.gate[1], /other-app\[bot\].*stated as test-codex-agent/);
  assert.deepEqual(calls.receipts.map((fields) => [fields.agentId, fields.decision]), [[null, 'approved'], [null, 'approved']]);
  assert.equal(calls.daemon, 0);
});

test('mintForCaller treats registered multi-org Apps for the same soul harness as own Apps without owner gate (#1139)', async (t) => {
  const { cwd, calls, options } = callerFixture(t, { bound: false });
  const configFile = join(cwd, 'multi-org-config.json');
  writeFileSync(configFile, JSON.stringify({
    prefix: 'qwts',
    apps: { muse: 'qwts-muse-agent', claude: 'qwts-claude-agent' },
    identityApps: {
      'qwts-muse-agent': { store: 'pass-cli' },
      'trueline-muse-agent': { store: 'pass-cli' },
      'qwts-claude-agent': { store: 'pass-cli' },
    },
  }));
  const env = { ...process.env, AGENT_BOT_CONFIG: configFile, AGENT_BOT_ID: agentId };
  const readIdentityImpl = () => ({ id: agentId, harness: 'muse', github: { appSlug: 'qwts-muse-agent' } });
  const resolveSlugImpl = () => 'trueline-muse-agent';

  // Minting default checkout App (trueline-muse-agent) or explicit trueline-muse-agent / qwts-muse-agent needs no owner gate.
  await mintForCaller({ ...options, env, readIdentityImpl, resolveSlugImpl });
  await mintForCaller({ ...options, env, slug: 'trueline-muse-agent', readIdentityImpl, resolveSlugImpl });
  await mintForCaller({ ...options, env, slug: 'qwts-muse-agent', readIdentityImpl, resolveSlugImpl });
  assert.equal(calls.gate.length, 0, 'both org Apps for the soul harness are own Apps');
  assert.deepEqual(calls.local.map((req) => req.slug), ['trueline-muse-agent', 'trueline-muse-agent', 'qwts-muse-agent']);

  // Another harness App still triggers the owner gate.
  await mintForCaller({ ...options, env, slug: 'qwts-claude-agent', readIdentityImpl, resolveSlugImpl });
  assert.equal(calls.gate.length, 1);
});


// #1205: server mode end-to-end. A real daemon (its real /v0/credential route,
// real binding auth, real task/operation ids) mints through the enrolled
// identity service — the installed gh shim and the git credential helper see
// only their own token, receipts never carry it, and a down or revoking
// service fails closed with the stable code.
test('server mode: the gh shim and credential helper mint through the daemon, not a local key', async (t) => {
  const { BASE, fakeServer, sleep } = await import('./helpers/fake-identity-server.mjs');
  const { enroll, mintViaServer } = await import('../identity/server-client.mjs');
  const { createDaemonServer } = await import('../agent-daemon.mjs');
  const { ensureAgentIdentity } = await import('../agent-identity.mjs');
  const { stateDirectory } = await import('../state-paths.mjs');
  const { mintBindToken } = await import('../agent-binding.mjs');
  const { readFileSync, readdirSync } = await import('node:fs');

  const srv = fakeServer();
  const stateDir = mkdtempSync(join(tmpdir(), 'shim-server-mint-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    AGENT_BOT_SERVER: BASE,
    AGENT_BOT_SERVER_HARNESS: 'grok',
    AGENT_BOT_SERVER_STATE: join(stateDir, 'server'),
    XDG_STATE_HOME: join(stateDir, 'state'),
    AGENT_BOT_SPACES_HOME: join(stateDir, 'spaces'),
    AGENT_BOT_POPULATION_PATH: join(stateDir, 'population.json'),
    AGENT_BOT_INTERACTION_HOME: join(stateDir, 'interaction'),
    AGENT_BOT_DAEMON_STATE_PATH: join(stateDir, 'daemon.json'),
  };
  await enroll({ base: BASE, env, harnesses: ['grok'], enrollToken: 'abe_good', fetchImpl: srv.fetch, sleep });
  ensureAgentIdentity({
    gate: () => true, appSlug: slug, botUid: '308462948', harness: 'codex',
    transcript: { provider: 'codex', id: 'thread-server' },
    stateDir: stateDirectory({ env, home: '/nonexistent' }),
    idFactory: () => agentId, now: () => new Date('2026-08-12T08:00:00.000Z'),
  });
  // The real mint() routing runs: server mode is chosen by AGENT_BOT_SERVER,
  // and the only transport it may use is the fake service — any call that
  // reached a local App key would hit api.github.com through global fetch.
  const globalCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { globalCalls.push(String(args[0])); return realFetch(...args); };
  t.after(() => { globalThis.fetch = realFetch; });
  const daemon = createDaemonServer({
    env, home: '/nonexistent', config: { features: { 'github-identity': true } },
    serverFetch: srv.fetch,
  });
  await new Promise((resolve) => { daemon.listen(0, '127.0.0.1', resolve); });
  const port = daemon.address().port;
  t.after(() => new Promise((resolve) => { daemon.close(resolve); }));
  const cwd = checkout(t);
  const gitDir = join(cwd, '.git');
  const bindToken = mintBindToken({ gitDir, worktree: cwd, agentId });
  const bindRes = await fetch(`http://127.0.0.1:${port}/v0/bind`, {
    method: 'POST', headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ gitDir, token: bindToken.token, transcript: { provider: 'codex', id: 'thread-server' } }),
  });
  const bound = await bindRes.json();
  assert.equal(bindRes.status, 200, JSON.stringify(bound));
  assert.match(bound.secret, /^[A-Za-z0-9_-]{43}$/);
  writeFileSync(join(gitDir, 'agent-binding.json'), JSON.stringify({
    v: 1, agentId, secret: bound.secret, daemon: `http://127.0.0.1:${port}/`, account: 'test', parent: null,
  }), { mode: 0o600 });

  // The installed gh shim: a fake agent-bot CLI and a fake gh that records
  // the token it is handed.
  const home = join(cwd, 'home');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const runtime = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
  writeFileSync(join(home, '.local', 'bin', 'agent-bot'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runtime)} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(cwd, 'shim'), buildGhShim());
  writeFileSync(join(cwd, 'fake-gh'), '#!/bin/sh\ntouch "$TEST_GH_CALLED"\necho "$GH_TOKEN" > "$TEST_GH_TOKEN_OUT"\n', { mode: 0o755 });
  const shimEnv = { ...env, HOME: home, AGENT_BOT_REAL_GH: join(cwd, 'fake-gh'), TEST_GH_CALLED: join(cwd, 'gh-called'), TEST_GH_TOKEN_OUT: join(cwd, 'gh-token') };
  // Async spawn, never spawnSync: the daemon lives on this process's event
  // loop, and a synchronous child would freeze it and starve every request.
  const run = (file, args, { input, ...options }) => new Promise((resolve) => {
    const child = spawn(file, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const runShim = (extra = {}) => run('/bin/sh', [join(cwd, 'shim'), 'api', 'repos/test/repo'], { cwd, env: { ...shimEnv, ...extra } });
  const runHelper = (extra = {}) => run(process.execPath, [fileURLToPath(new URL('../git-credential-bot.mjs', import.meta.url)), slug, 'get'], {
    cwd, input: 'protocol=https\nhost=github.com\n\n', env: { ...env, ...extra },
  });

  // Two shim calls mint two operations of one task, recorded by the service.
  for (const n of [1, 2]) {
    rmSync(join(cwd, 'gh-token'), { force: true });
    const result = await runShim();
    assert.equal(result.status, 0, result.stderr);
    const issued = readFileSync(join(cwd, 'gh-token'), 'utf8').trim();
    assert.match(issued, /^ghs_op\d+$/);
    const opIds = [...srv.ops.keys()];
    assert.equal(opIds.length, n);
  }
  const records = [...srv.ops.values()];
  assert.equal(records.length, 2);
  assert.equal(records[0].task_id, records[1].task_id, 'the same conversation is the same task');
  assert.notEqual(records[0].operation_id, records[1].operation_id, 'a fresh operation per request');
  const helper = await runHelper();
  assert.equal(helper.status, 0, helper.stderr);
  assert.match(helper.stdout, /ghs_op3/, 'the helper prints the minted token');
  assert.equal(srv.ops.size, 3);

  // The local App-key path never ran: nothing reached the GitHub API (or any
  // host) through the ambient transport, and no App key exists to try.
  assert.deepEqual(globalCalls.filter((u) => !u.startsWith('http://127.0.0.1')), [], `no ambient fetch: ${globalCalls}`);

  // The token lives only on the wire: never a receipt, never a ledger file.
  const audit = readFileSync(join(env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8');
  assert.doesNotMatch(audit, /ghs_/, 'no token in audit receipts');
  const mints = audit.trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.event === 'credential-mint');
  assert.ok(mints.every((row) => row.taskId === records[0].task_id && /^op_/.test(row.operationId)));
  // The action ledger records identifiers and states only — scan it too.
  for (const file of readdirSync(join(env.AGENT_BOT_SERVER_STATE, 'actions'))) {
    assert.doesNotMatch(readFileSync(join(env.AGENT_BOT_SERVER_STATE, 'actions', file), 'utf8'), /ghs_/, `no token in the ledger (${file})`);
  }

  // Service down: both entrypoints fail closed — no token, no stock gh run.
  srv.signedUnavailable = true;
  rmSync(join(cwd, 'gh-called'), { force: true });
  const downShim = await runShim();
  assert.equal(downShim.status, 1);
  assert.equal(downShim.stdout, '');
  assert.match(downShim.stderr, /credential/);
  assert.equal(existsSync(join(cwd, 'gh-called')), false, 'stock gh never ran');
  const downHelper = await runHelper();
  assert.equal(downHelper.status, 1);
  assert.equal(downHelper.stdout, '');
  assert.match(downHelper.stderr, /credential/);
  assert.doesNotMatch(downHelper.stderr + downShim.stderr, /ghs_op/);
  srv.signedUnavailable = false;

  // Device revoked: same fail-closed path, and the token cache helps nobody.
  srv.revokedDevice = [...srv.devices.keys()][0];
  for (const revoked of [await runShim(), await runHelper()]) {
    assert.equal(revoked.status, 1);
    assert.equal(revoked.stdout, '');
    assert.match(revoked.stderr, /daemon|revoked|credential/);
    assert.doesNotMatch(revoked.stderr, /ghs_op/);
  }
});
