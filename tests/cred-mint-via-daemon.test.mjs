import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSoulBound, mintCredential } from '../git-credential-bot.mjs';
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
