import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coldWakeFile, readColdWakeSettings, setColdWake } from '../cold-wake-settings.mjs';

const id = 'agent_12345678-1234-4123-8123-123456789abc';
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

async function withState(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'cold-wake-'));
  try { return await run({ root, env: { ...process.env, XDG_STATE_HOME: path.join(root, 'state'), HOME: root, GIT_CONFIG_COUNT: '0', GH_AGENT_APP: '' } }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function invoke(env, ...args) {
  // Run outside any worktree: a bound checkout's agentBot.app pin would make
  // the caller an agent and the owner-only setting refuse.
  return spawnSync(process.execPath, [cli, 'soul', 'cold-wake', id, ...args], { encoding: 'utf8', env, cwd: env.HOME });
}

test('soul cold-wake supports on, off, and show, and refuses agent accounts', () => withState(({ env }) => {
  let result = invoke(env, 'on');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${id} cold wake on\n`);
  result = invoke(env, 'show');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'on\n');
  result = invoke(env, 'off');
  assert.equal(result.status, 0, result.stderr);
  result = invoke(env, 'show');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'off\n');

  result = invoke({ ...env, GH_AGENT_APP: 'you-codex-agent' }, 'on');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cold wake settings are owner only/);
}));

test('unset soul reports off and its cold wake result is waiting', async () => withState(async ({ env }) => {
  const result = invoke(env, 'show');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'off\n');
  const { createColdWaker } = await import('../cold-wake.mjs');
  const wake = createColdWaker({ executor: async () => assert.fail('disabled wake must not execute'), settings: () => readColdWakeSettings({ env }), lookupBinding: async () => ({}), identities: async () => ({}), receipt() {} });
  assert.deepEqual(await wake({ agentId: id, count: 1, messageIds: ['m1'] }), { outcome: 'waiting', detail: 'cold wake is disabled' });
}));

test('cold-wake settings persist atomically with mode 0600', () => withState(({ root, env }) => {
  assert.equal(setColdWake(id, true, { env }), true);
  const file = coldWakeFile({ env });
  assert.deepEqual(readColdWakeSettings({ env }), { [id]: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
  assert.match(readFileSync(file, 'utf8'), /"schemaVersion": 1/);
}));

test('concurrent changes to different souls are all kept', () => withState(async ({ env }) => {
  const module = new URL('../cold-wake-settings.mjs', import.meta.url).href;
  const ids = Array.from({ length: 6 }, (_, index) => `agent_12345678-1234-4123-8123-12345678900${index}`);
  await Promise.all(ids.map((agentId) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { setColdWake } from ${JSON.stringify(module)}; setColdWake(${JSON.stringify(agentId)}, true);`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  })));
  assert.deepEqual(Object.keys(readColdWakeSettings({ env })).sort(), ids);
}));

test('an unknown soul subcommand names the whole grammar', () => withState(({ env }) => {
  const result = spawnSync(process.execPath, [cli, 'soul', 'warm-wake', id], { encoding: 'utf8', env, cwd: env.HOME });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[on\|off\|show\|resume read-only\|workspace\]/);
}));
