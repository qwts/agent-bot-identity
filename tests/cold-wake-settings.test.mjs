import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coldWakeCommand, coldWakeFile, readColdWakeSettings, setColdWake } from '../cold-wake-settings.mjs';
import { assertOwnerAction, consentOwner } from '../owner-gate.mjs';

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

// The owner gate stands in for the dialog: changes run in process, so no
// test raises a real authorization dialog.
function owned(env, gate = async () => ({ method: 'consent' })) {
  const out = [];
  const run = (args, extra = {}) => coldWakeCommand([id, ...args], { env, home: env.HOME, cwd: env.HOME, gate, write: (text) => out.push(text), ...extra });
  return { run, out };
}

test('soul cold-wake supports on, off, and show, and refuses agent accounts', () => withState(async ({ env }) => {
  const { run, out } = owned(env);
  await run(['on']);
  assert.equal(out.pop(), `${id} cold wake on\n`);
  let result = invoke(env, 'show');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'on\n');
  await run(['off']);
  assert.equal(out.pop(), `${id} cold wake off\n`);
  result = invoke(env, 'show');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'off\n');

  // A marked caller is refused by the real gate before any dialog.
  result = invoke({ ...env, GH_AGENT_APP: 'you-codex-agent' }, 'on');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /soul cold-wake .* on is owner only/);
  result = invoke({ ...env, GH_AGENT_APP: 'you-codex-agent' }, 'show');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cold wake settings are owner only/);
}));

test('every cold wake change passes the owner gate, which names the action and soul; show does not', () => withState(async ({ env }) => {
  const seen = [];
  const { run } = owned(env, async (action, { principal }) => { seen.push({ action, principal }); return { method: 'consent' }; });
  await run(['on']); await run(['off']); await run(['resume', 'read-only']);
  await run(['show']); await run([]);
  assert.deepEqual(seen.map((s) => s.action), [`soul cold-wake ${id} on`, `soul cold-wake ${id} off`, `soul cold-wake ${id} resume read-only`]);
  assert.ok(seen.every((s) => s.principal === null));
  // A refused gate changes nothing.
  const denied = owned(env, async () => { throw new Error('owner approval was cancelled — nothing was changed'); });
  await assert.rejects(denied.run(['on']), /cancelled/);
  assert.deepEqual(readColdWakeSettings({ env })[id], { lane: 'resume', policy: 'read-only' });
  // Usage errors are refused before the gate.
  for (const args of [['resume'], ['on', 'workspace'], ['show', '--principal-stdin']]) await assert.rejects(denied.run(args), /usage/);
}));

test('cold wake: a principal on stdin reaches the gate; a bound soul is refused whatever it presents', () => withState(async ({ env }) => {
  const credential = { principal: 'principal_12345678-1234-4123-8123-123456789abc', secret: 'f'.repeat(64), brokerUid: process.getuid() + 1, mode: 'group' };
  const seen = [];
  const { run } = owned(env, async (action, { principal }) => { seen.push(principal); return { method: 'principal', principal: principal.principal }; });
  assert.deepEqual(await run(['on', '--principal-stdin'], { readStdin: () => JSON.stringify(credential) }), { method: 'principal', principal: credential.principal });
  assert.deepEqual(seen, [credential]);
  await assert.rejects(run(['on', '--principal-stdin'], { readStdin: () => 'nope' }), /needs the principal credential as JSON/);
  // The real gate with a soul marker: neither proof is consulted.
  const pass = { verifyPrincipal: () => assert.fail('a bound soul never reaches the principal'), consent: () => assert.fail('nor the dialog') };
  for (const marker of [{ AGENT_BOT_ID: id }, { AGENT_BOT_BINDING: path.join(env.HOME, 'binding.json') }]) {
    const soulEnv = { ...env, AGENT_BOT_CONFIG: path.join(env.HOME, 'no-config.json'), ...marker };
    const gate = (action, { principal }) => assertOwnerAction(action, { principal, env: soulEnv, cwd: env.HOME, detect: false, ...pass });
    await assert.rejects(owned(soulEnv, gate).run(['off', '--principal-stdin'], { readStdin: () => JSON.stringify(credential) }), /owner only/);
    await assert.rejects(owned(soulEnv, gate).run(['off']), /owner only/);
  }
  assert.equal(readColdWakeSettings({ env })[id], true);
  // The consent path names the action and soul in the dialog.
  const prompts = [];
  const consent = owned(env, (action) => consentOwner(action, { platform: 'darwin', run: (argv) => { prompts.push(argv.at(-1)); return ''; } }));
  assert.deepEqual(await consent.run(['off']), { method: 'consent' });
  assert.match(prompts[0], new RegExp(`soul cold-wake ${id} off`));
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
  assert.match(result.stderr, /\[on\|off\|show\|resume read-only\|workspace\|webhook --url-file PATH --key-file PATH\|-\]/);
}));
