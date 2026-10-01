import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBindingRegistry, readBinding, revokeBinding } from '../agent-binding.mjs';
import { createMcpState, handleMcpMessage } from '../agent-mcp.mjs';
import { runHooks } from '../agent-hook.mjs';
import { signBindingProof } from '../binding-proof.mjs';

const agentId = 'agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'binding-persistence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const gitDir = path.join(root, '.git');
  const file = path.join(root, 'state', 'bindings.json');
  let clock = new Date('2026-10-01T00:00:00Z');
  const options = { file, account: 'test-account', now: () => clock };
  const store = createBindingRegistry(options);
  store.rewrite('http://127.0.0.1:1234');
  const secret = store.bind({ agentId, parent: null, app: 'test-app', gitDir, worktree: root });
  return { root, gitDir, file, options, store, secret, tick: (days) => { clock = new Date(clock.getTime() + days * 86400000); } };
}

test('private binding and hashed registry persist, reload, rewrite URL, and revoke', async (t) => {
  const f = fixture(t);
  const bindingPath = path.join(f.gitDir, 'agent-binding.json');
  const binding = readBinding({ cwd: f.root, env: {} });
  assert.deepEqual(binding, { v: 1, agentId, parent: null, account: 'test-account', daemon: 'http://127.0.0.1:1234', secret: f.secret });
  assert.equal(Buffer.from(binding.secret, 'base64url').length, 32);
  for (const file of [bindingPath, f.file]) assert.equal(statSync(file).mode & 0o777, 0o600);
  const disk = readFileSync(f.file, 'utf8');
  assert.ok(!disk.includes(f.secret));
  const [key] = Object.keys(JSON.parse(disk));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(disk)[key].app, 'test-app');
  const restarted = createBindingRegistry(f.options);
  restarted.rewrite('http://127.0.0.1:5678');
  assert.equal(readBinding({ cwd: f.root, env: {} }).daemon, 'http://127.0.0.1:5678');
  assert.equal(restarted.resolve(f.secret).agentId, agentId);
  await revokeBinding({ cwd: f.root, env: {}, now: f.options.now, fetchImpl: async (url, request) => {
    assert.equal(url, 'http://127.0.0.1:5678/v0/binding');
    assert.equal(request.method, 'DELETE');
    assert.equal(request.headers.authorization, undefined);
    // #270: the secret never goes on the wire, only a one-time proof.
    assert.equal(request.headers['x-agent-binding'], undefined);
    assert.equal(JSON.stringify(request.headers).includes(f.secret), false);
    const proof = request.headers['x-agent-binding-proof'];
    // A proof made for another daemon address is refused.
    assert.equal(restarted.releaseProof(proof, { method: 'DELETE', path: '/v0/binding', authority: '127.0.0.1:9999' }), false);
    return { ok: restarted.releaseProof(proof, { method: 'DELETE', path: '/v0/binding', authority: '127.0.0.1:5678' }) };
  } });
  assert.equal(existsSync(bindingPath), false);
  assert.equal(createBindingRegistry(f.options).resolve(f.secret), null);
});

test('expiry is thirty idle days and successful use persists the idle clock', (t) => {
  const f = fixture(t);
  f.tick(29);
  assert.equal(f.store.resolve(f.secret).agentId, agentId);
  f.tick(29);
  const restarted = createBindingRegistry(f.options);
  restarted.rewrite('http://127.0.0.1:9999');
  assert.equal(restarted.size(), 1);
  f.tick(1);
  assert.equal(restarted.resolve(f.secret), null);
  assert.equal(readBinding({ cwd: f.root, env: {} }), null);
});

test('startup prunes missing private git dirs', (t) => {
  const f = fixture(t);
  rmSync(f.gitDir, { recursive: true });
  const restarted = createBindingRegistry(f.options);
  restarted.rewrite('http://127.0.0.1:9999');
  assert.equal(restarted.size(), 0);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), {});
});

test('reader honors override and refuses wrong mode, owner, symlink, or remote URL', (t) => {
  const f = fixture(t);
  const file = path.join(f.gitDir, 'agent-binding.json');
  const env = { AGENT_BOT_BINDING: file };
  assert.equal(readBinding({ env, cwd: '/nonexistent' }).secret, f.secret);
  assert.throws(() => readBinding({ env, uid: process.getuid() + 1 }), /untrusted/);
  chmodSync(file, 0o644);
  assert.throws(() => readBinding({ env }), /untrusted/);
  chmodSync(file, 0o600);
  const link = path.join(f.root, 'link');
  symlinkSync(file, link);
  assert.throws(() => readBinding({ env: { AGENT_BOT_BINDING: link } }), /untrusted/);
  const record = JSON.parse(readFileSync(file));
  writeFileSync(file, JSON.stringify({ ...record, daemon: 'http://evil.example' }));
  assert.throws(() => readBinding({ env }), /unsupported/);
});

test('persistent writes refuse directories other than the worktree private git dir', (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.bind({ agentId, gitDir: f.root, worktree: f.root }), /private git dir/);
  assert.equal(existsSync(path.join(f.root, 'agent-binding.json')), false);
});

test('MCP reuses a binding with no token and never exposes its secret', async (t) => {
  const f = fixture(t);
  const state = createMcpState({ env: {}, cwd: f.root, client: {
    binding: async (secret) => { assert.equal(secret, f.secret); return f.store.resolve(secret); },
    bind: async () => { throw new Error('must not consume a token'); },
  } });
  const response = await handleMcpMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bind', arguments: {} } });
  assert.equal(state.agentId, agentId);
  assert.ok(!JSON.stringify(response).includes(f.secret));
  assert.ok(!response.result.isError);
});

test('hooks refuse an untrusted binding before executing hooks', (t) => {
  const f = fixture(t);
  const file = path.join(f.gitDir, 'agent-binding.json');
  chmodSync(file, 0o644);
  const result = runHooks({ dialectKey: 'claude', event: 'session-start', payload: { cwd: f.root }, dir: f.root, env: { AGENT_BOT_BINDING: file } });
  assert.equal(result.decision, 'deny');
});

test('setup-worktree reuses the binding without minting another token', async (t) => {
  const f = fixture(t);
  const { prepareWorktreeBinding } = await import('../setup-worktree.mjs');
  assert.equal(prepareWorktreeBinding({ gitDir: f.gitDir, worktree: f.root, agentId }), 'binding reused');
  assert.equal(existsSync(path.join(f.gitDir, 'agent-bind-token.json')), false);
  assert.equal(readBinding({ env: {}, cwd: f.root }).secret, f.secret);
});

test('linked worktree binding stays in its private git dir', (t) => {
  const f = fixture(t);
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: f.root, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const linked = path.join(f.root, 'linked');
  execFileSync('git', ['worktree', 'add', '-qb', 'linked', linked], { cwd: f.root });
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: linked, encoding: 'utf8' }).trim();
  const secret = f.store.bind({ agentId, gitDir, worktree: linked });
  assert.equal(readBinding({ env: {}, cwd: linked }).secret, secret);
  assert.notEqual(secret, readBinding({ env: {}, cwd: f.root }).secret);
  assert.ok(existsSync(path.join(gitDir, 'agent-binding.json')));
});

test('untrusted or malformed registry fails closed at startup', (t) => {
  const f = fixture(t);
  chmodSync(f.file, 0o644);
  assert.throws(() => createBindingRegistry(f.options), /untrusted/);
  chmodSync(f.file, 0o600);
  writeFileSync(f.file, '[]');
  assert.throws(() => createBindingRegistry(f.options), /invalid binding store/);
});

test('a binding whose file turned untrusted is pruned at startup instead of stopping the daemon', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'abi-prune-'));
  const gitDir = path.join(dir, 'git');
  mkdirSync(gitDir);
  const file = path.join(dir, 'bindings.json');
  const key = 'a'.repeat(64);
  const at = new Date().toISOString();
  writeFileSync(file, JSON.stringify({ [key]: {
    agentId: 'agent_00000000-0000-4000-8000-000000000000', parent: null, gitDir, worktree: dir, createdAt: at, lastUsedAt: at,
  } }), { mode: 0o600 });
  writeFileSync(path.join(gitDir, 'agent-binding.json'), '{}');
  chmodSync(path.join(gitDir, 'agent-binding.json'), 0o644);
  const registry = createBindingRegistry({ file });
  assert.doesNotThrow(() => registry.rewrite('http://127.0.0.1:1/'));
  assert.equal(registry.size(), 0);
});

test('a proof captured before a daemon restart is refused after it, even on the same port (#270)', (t) => {
  const f = fixture(t);
  const request = { method: 'GET', path: '/v0/binding', authority: '127.0.0.1:1234' };
  // Made while the daemon is down, i.e. before the restarted registry exists.
  const captured = signBindingProof({ secret: f.secret, ...request, now: f.options.now().getTime() - 1 });
  const restarted = createBindingRegistry(f.options);
  assert.equal(restarted.resolveProof(captured, request), null);
  // A proof made after the restart works once.
  const fresh = signBindingProof({ secret: f.secret, ...request, now: f.options.now().getTime() });
  assert.equal(restarted.resolveProof(fresh, request).agentId, agentId);
  assert.equal(restarted.resolveProof(fresh, request), null);
});
