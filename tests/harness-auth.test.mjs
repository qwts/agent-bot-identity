import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { upsertSoul, registerSoulDir } from '../agent-population.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authCommand, harnessAuth } from '../harness-auth.mjs';
import { ACP_SPAWN_REGISTRY } from '../acp-registry.mjs';

const row = ACP_SPAWN_REGISTRY.claude;

test('uses the Claude CLI installed in the soul home, else claude on PATH', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'harness-auth-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(authCommand(row, home), { command: 'claude', args: [] });
  const sdk = path.join(home, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(path.join(sdk, 'cli.js'), '');
  assert.deepEqual(authCommand(row, home, { node: '/app/node' }), { command: '/app/node', args: [path.join(sdk, 'cli.js')] });
  assert.throws(() => authCommand(ACP_SPAWN_REGISTRY.opencode, home), /no sign-in support/);
});

test('reports loggedIn from the harness status, and signs in before re-checking', async () => {
  const calls = [];
  let signedIn = false;
  const runImpl = async (command, args, options) => {
    calls.push(args.join(' '));
    assert.equal('CLAUDECODE' in options.env, false, 'nested-session variables are stripped');
    if (args.includes('login')) signedIn = true;
    return { stdout: JSON.stringify({ loggedIn: signedIn }) };
  };
  const env = { CLAUDECODE: '1', PATH: '/usr/bin' };
  assert.deepEqual(await harnessAuth('status', 'claude', { home: null, env, runImpl }), { harness: 'claude', loggedIn: false });
  assert.deepEqual(await harnessAuth('login', 'claude', { home: null, env, runImpl }), { harness: 'claude', loggedIn: true });
  assert.deepEqual(calls, ['auth status --json', 'auth login', 'auth status --json']);
});

test('an unreadable or failing status counts as signed out', async () => {
  const runImpl = async () => { throw Object.assign(new Error('exit 1'), { stdout: 'not json' }); };
  assert.equal((await harnessAuth('status', 'claude', { home: null, runImpl })).loggedIn, false);
  await assert.rejects(harnessAuth('logout', 'claude', { runImpl }), /usage/);
});

test('harness auth CLI uses the registered soul home and its installed CLI', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-auth-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = 'agent_33333333-3333-4333-8333-333333333333';
  const file = path.join(root, 'population.json');
  const dir = path.join(root, 'external.soul');
  const home = path.join(dir, '.soul-state', 'home');
  const sdk = path.join(home, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(path.join(dir, '.soul-state', 'agent-id'), id);
  writeFileSync(path.join(sdk, 'cli.js'), `process.stdout.write(JSON.stringify({ loggedIn: process.cwd() === ${JSON.stringify(realpathSync(home))} }));`);
  upsertSoul({ id, status: 'active', spacePath: path.join(root, 'space') }, { file });
  registerSoulDir(id, dir, { file });
  const result = spawnSync(process.execPath, [new URL('../agent-bot.mjs', import.meta.url).pathname, 'harness', 'auth', 'status', 'claude', '--soul', id], {
    encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH, AGENT_BOT_POPULATION_PATH: file },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { harness: 'claude', loggedIn: true });
});

test('sign-in failures are told apart from other turn failures (#84)', async () => {
  const { harnessAuthFailure, harnessAuthNotice } = await import('../harness-auth.mjs');
  for (const [text, want] of [
    ['claude turn failed: Not logged in · Please run /login', 'signed-out'],
    ['acp engine: agent error for session/new: Authentication required', 'signed-out'],
    ['acp engine: agent error for session/prompt: OAuth access token has expired', 'expired'],
    ['codex turn failed: Your refresh token has already been used to generate a new access token. Please try signing in again.', 'expired'],
    ['codex turn failed: refresh_token_expired: Your refresh token has expired', 'expired'],
    ['acp engine: agent process exited before the turn finished', null],
    ['policy denied Bash', null],
  ]) assert.equal(harnessAuthFailure(new Error(text)), want, text);
  assert.equal(harnessAuthFailure({ harnessAuth: 'expired' }), 'expired');
  assert.equal(harnessAuthFailure(null), null);
  assert.match(harnessAuthNotice('codex', 'signed-out'), /my Codex sign-in is missing/);
  assert.match(harnessAuthNotice('unknown', 'expired'), /my harness sign-in has expired/);
});

test('the census records, keeps and clears a soul\'s sign-in failure', async (t) => {
  const { recordHarnessAuth, showSoul } = await import('../agent-population.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'harness-auth-census-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'population.json');
  const agent = 'agent_12345678-1234-4123-8123-123456789abc';
  upsertSoul({ id: agent, appSlug: null, parentId: null, status: 'active', spacePath: root, transcriptLocator: null }, { file });
  assert.equal(recordHarnessAuth('agent_99999999-9999-4999-8999-999999999999', null, { file }), null);
  assert.equal('harnessAuth' in recordHarnessAuth(agent, null, { file }), false);
  const first = recordHarnessAuth(agent, { status: 'signed-out', harness: 'claude' }, { file, now: () => new Date('2026-10-03T10:00:00.000Z') });
  assert.deepEqual(first.harnessAuth, { status: 'signed-out', harness: 'claude', since: '2026-10-03T10:00:00.000Z' });
  recordHarnessAuth(agent, { status: 'signed-out', harness: 'claude' }, { file, now: () => new Date('2026-10-03T11:00:00.000Z') });
  assert.equal(showSoul(agent, { file }).harnessAuth.since, '2026-10-03T10:00:00.000Z');
  assert.throws(() => recordHarnessAuth(agent, { status: 'weird', harness: 'claude' }, { file }), /harnessAuth.status/);
  // Signing a different harness in leaves this failure in place.
  assert.equal(recordHarnessAuth(agent, null, { file, only: 'codex' }).harnessAuth.status, 'signed-out');
  assert.equal('harnessAuth' in recordHarnessAuth(agent, null, { file, only: 'claude' }), false);
  assert.equal('harnessAuth' in showSoul(agent, { file }), false);
});
