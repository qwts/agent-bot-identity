import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
