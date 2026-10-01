import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonServer } from '../agent-daemon.mjs';
import { childBindingPath, createBindingRegistry, readBinding } from '../agent-binding.mjs';
import { mintAgentIdentity, readAgentIdentity, spawnIdentity, stateDirectory } from '../agent-identity.mjs';
import { runSpawnHooks } from '../agent-hook.mjs';

const cli = new URL('../agent-identity.mjs', import.meta.url).pathname;
async function fixture(t, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-spawn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'state'),
    AGENT_BOT_STATE_HOME: path.join(root, 'identities'), AGENT_BOT_HOOKS_DIR: path.join(root, 'hooks') };
  delete env.AGENT_BOT_BINDING;
  const gitDir = path.join(root, '.git');
  const parent = mintAgentIdentity({ appSlug: 'test-app', harness: 'codex', stateDir: stateDirectory({ env }) });
  const file = path.join(env.XDG_STATE_HOME, 'agent-bot', 'bindings.json');
  const registry = createBindingRegistry({ file });
  registry.rewrite('http://127.0.0.1:1234');
  const secret = registry.bind({ agentId: parent.id, gitDir, worktree: root, harness: 'codex' });
  const server = createDaemonServer({ env, home: root, config: {}, spawnHook: async () => null, ...extra });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = readBinding({ gitDir, env: {} }).daemon;
  const call = (route, body, auth = secret, method = 'POST') => fetch(`${url}${route}`, {
    method, headers: { 'x-agent-binding': auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { root, env, gitDir, parent, secret, file, call };
}
function run(args, f) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'spawn', ...args], { cwd: f.root, env: f.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('CLI JSON spawn writes its own private binding and vouched parent without touching parent', async (t) => {
  const f = await fixture(t);
  const out = await run(['--name', 'worker'], f);
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(result).sort(), ['agentId', 'binding', 'parent']);
  assert.equal(result.parent, f.parent.id);
  assert.equal(result.binding, childBindingPath(f.gitDir, result.agentId));
  assert.equal(statSync(result.binding).mode & 0o777, 0o600);
  const child = readBinding({ env: { AGENT_BOT_BINDING: result.binding } });
  assert.equal(child.agentId, result.agentId);
  assert.equal(child.parent, f.parent.id);
  assert.notEqual(child.secret, f.secret);
  assert.equal(readBinding({ env: {}, gitDir: f.gitDir }).secret, f.secret);
  assert.equal(readAgentIdentity(child.agentId, { stateDir: stateDirectory({ env: f.env }) }).parentId, f.parent.id);
  const entries = JSON.parse(readFileSync(f.file));
  const parentHash = Object.keys(entries).find((key) => entries[key].agentId === f.parent.id);
  assert.equal(Object.values(entries).find((entry) => entry.agentId === child.agentId).spawnedBy, parentHash);
});

test('command receives child environment and literal arguments; its exit code propagates', async (t) => {
  const f = await fixture(t);
  const out = await run(['--', process.execPath, '-e',
    'console.log(JSON.stringify({id:process.env.QWTS_AGENT_ID,binding:process.env.AGENT_BOT_BINDING,arg:process.argv[1]}));process.exitCode=7', '--', '--literal'], f);
  assert.equal(out.status, 7, out.stderr);
  const result = JSON.parse(out.stdout);
  assert.notEqual(result.id, f.parent.id);
  assert.equal(result.arg, '--literal');
  assert.equal(readBinding({ env: { AGENT_BOT_BINDING: result.binding } }).agentId, result.id);
  assert.notEqual((await run(['--'], f)).status, 0);
});

test('missing, invalid, revoked bindings and parent/App overrides fail closed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(spawnIdentity({ env: { ...f.env, AGENT_BOT_BINDING: path.join(f.root, 'missing') }, cwd: f.root }), /parent binding/);
  const unbound = mkdtempSync(path.join(tmpdir(), 'agent-spawn-unbound-'));
  t.after(() => rmSync(unbound, { recursive: true, force: true }));
  assert.equal(await spawnIdentity({ env: { ...f.env, AGENT_BOT_BINDING: '' }, cwd: unbound }), null);
  assert.equal((await f.call('/v0/spawn', {}, 'invalid')).status, 401);
  assert.equal((await f.call('/v0/spawn', { parent: 'forged' })).status, 403);
  assert.equal((await f.call('/v0/spawn', { app: 'other-app' })).status, 403);
  assert.equal((await f.call('/v0/binding', undefined, f.secret, 'DELETE')).status, 200);
  assert.equal((await f.call('/v0/spawn', {})).status, 401);
});

test('restart rewrites child URLs; parent revoke cascades through grandchildren only', async (t) => {
  const f = await fixture(t);
  const child = await (await f.call('/v0/spawn', {})).json();
  const childSecret = readBinding({ env: { AGENT_BOT_BINDING: child.binding } }).secret;
  const grandchild = await (await f.call('/v0/spawn', {}, childSecret)).json();
  const grandSecret = readBinding({ env: { AGENT_BOT_BINDING: grandchild.binding } }).secret;
  const registry = createBindingRegistry({ file: f.file });
  registry.rewrite('http://127.0.0.1:4321');
  assert.equal(readBinding({ env: { AGENT_BOT_BINDING: grandchild.binding } }).daemon, 'http://127.0.0.1:4321');
  assert.equal(registry.release(childSecret), true);
  assert.ok(registry.resolve(f.secret));
  assert.equal(registry.resolve(grandSecret), null);
  assert.equal(existsSync(grandchild.binding), false);
  assert.equal(existsSync(child.binding), false);
  registry.release(f.secret);
  assert.equal(createBindingRegistry({ file: f.file }).size(), 0);
});

test('spawn hook runs after write; installed comms and custom hooks receive child identity', async (t) => {
  let invocation;
  const f = await fixture(t, { spawnHook: async (args) => {
    assert.equal(readBinding({ env: { AGENT_BOT_BINDING: args.binding } }).agentId, args.agentId);
    invocation = args;
    return runSpawnHooks(args);
  } });
  const bin = path.join(f.root, 'bin'); mkdirSync(bin);
  const log = path.join(f.root, 'join.json');
  writeFileSync(path.join(bin, 'agent-comms'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),id:process.env.QWTS_AGENT_ID,binding:process.env.AGENT_BOT_BINDING}));\n`, { mode: 0o755 });
  f.env.PATH = `${bin}:${process.env.PATH}`;
  mkdirSync(path.join(f.env.AGENT_BOT_HOOKS_DIR, 'spawn'), { recursive: true });
  writeFileSync(path.join(f.env.AGENT_BOT_HOOKS_DIR, 'spawn', '10-observe'), '#!/bin/sh\nprintf "%s" "$QWTS_AGENT_ID" > hook-id\n', { mode: 0o755 });
  const result = await (await f.call('/v0/spawn', { name: 'worker', harness: 'codex' })).json();
  assert.equal(invocation.agentId, result.agentId);
  assert.deepEqual(JSON.parse(readFileSync(log)), { argv: ['join', '--name', 'worker', '--harness', 'codex'], id: result.agentId, binding: result.binding });
  assert.equal(readFileSync(path.join(f.root, 'hook-id'), 'utf8'), result.agentId);
  writeFileSync(path.join(bin, 'agent-comms'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const failedJoin = await run([], f);
  assert.equal(failedJoin.status, 0);
  assert.match(failedJoin.stderr, /join failed/);
  rmSync(path.join(bin, 'agent-comms'));
  f.env.PATH = bin;
  assert.equal((await (await f.call('/v0/spawn', {})).json()).warning, undefined);
});

test('unexpected hook errors remain nonfatal and are reported', async (t) => {
  const f = await fixture(t, { spawnHook: async () => { throw new Error('private details'); } });
  const out = await run([], f);
  assert.equal(out.status, 0);
  assert.match(out.stderr, /spawn hook failed/);
  assert.ok(!out.stderr.includes('private details'));
});


test('child bindings cannot escape through a symlinked directory', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, path.join(f.gitDir, 'agent-bindings'));
  assert.equal((await f.call('/v0/spawn', {})).status, 400);
  assert.equal(Object.keys(JSON.parse(readFileSync(f.file))).length, 1);
  assert.equal(readBinding({ env: {}, gitDir: f.gitDir }).secret, f.secret);
});
