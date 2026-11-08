// Golden surface, slice 1 (#1379): the parts of the agent-bot surface that can
// be read without running a command's work. The daemon split
// (true-line/agent-bot-daemon docs/daemon-plugin-split.md, steps 3-11) moves
// code under all of these; any user-visible change must show up here as a
// reviewed golden diff.
//
// A golden changes only on purpose. To accept a change, regenerate with
//   AGENT_BOT_UPDATE_GOLDEN=1 node --test tests/golden-surface.test.mjs
// and commit the diff in tests/golden/surface/ with the change that caused it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../cli/parse.mjs';
import { MODULES } from '../cli/dispatch.mjs';
import { createMcpState, handleMcpMessage as handleAgentMcp } from '../agent-mcp.mjs';
import { createReachState, handleMcpMessage as handleReachMcp } from '../daemon-mcp.mjs';

const root = path.join(import.meta.dirname, '..');
const goldenDir = path.join(import.meta.dirname, 'golden', 'surface');
const UPDATE = process.env.AGENT_BOT_UPDATE_GOLDEN === '1';

function golden(name, actual) {
  const file = path.join(goldenDir, name);
  const text = typeof actual === 'string' ? actual : `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  let expected;
  try {
    expected = readFileSync(file, 'utf8');
  } catch {
    assert.fail(`missing golden ${name}; regenerate with AGENT_BOT_UPDATE_GOLDEN=1`);
  }
  assert.equal(text, expected, `${name} changed; if intended, regenerate with AGENT_BOT_UPDATE_GOLDEN=1 and commit the diff`);
}

// Runs the real entry point in a sealed environment: a fresh HOME and no
// inherited agent-bot, QWTS or harness variables, so nothing on this machine
// can change the output and nothing here can touch this machine's state.
function cli(args) {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-bot-golden-'));
  try {
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'C', NO_COLOR: '1' };
    const result = spawnSync(process.execPath, [path.join(root, 'agent-bot.mjs'), ...args],
      { cwd: home, env, encoding: 'utf8', timeout: 20_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('public commands and their dispatch modules', () => {
  golden('commands.json', {
    public: [...PUBLIC_COMMANDS].sort(),
    modules: Object.fromEntries([...MODULES].sort(([a], [b]) => a.localeCompare(b))),
  });
});

for (const [name, args] of [['help.txt', ['--help']], ['soul-help.txt', ['soul', '--help']], ['broker-help.txt', ['broker', '--help']]]) {
  test(`agent-bot ${args.join(' ')} output and exit code`, () => {
    const result = cli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    golden(name, result.stdout);
  });
}

test('agent-bot with an unknown command fails with exit code 1', () => {
  const result = cli(['no-such-command-golden']);
  assert.equal(result.status, 1);
  golden('unknown-command.txt', `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

const listTools = async (handle, state) => (await handle(state, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;

test('agent-bot MCP server tools', async () => {
  golden('mcp-agent-bot-tools.json', await listTools(handleAgentMcp, createMcpState({ client: {} })));
});

test('agent-reach MCP server tools', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-bot-golden-'));
  try {
    golden('mcp-agent-reach-tools.json', await listTools(handleReachMcp, createReachState({ env: {}, cwd: home })));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The route classes from docs/daemon-api.md. tests/daemon-route-auth.test.mjs
// keeps that table equal to the routes the daemon handles; this golden makes
// any change to a route or its class an explicit, reviewed diff.
test('daemon route authorization table', () => {
  const doc = readFileSync(path.join(root, 'docs', 'daemon-api.md'), 'utf8');
  const section = doc.slice(doc.indexOf('# Route authorization'));
  const rows = [...section.matchAll(/^\| `([A-Z]+ \/[^`]+)` \| ([a-z-]+) \|/gm)].map((m) => [m[1], m[2]]);
  assert.ok(rows.length > 0, 'route table not found in docs/daemon-api.md');
  golden('routes.json', Object.fromEntries(rows.sort(([a], [b]) => a.localeCompare(b))));
});
