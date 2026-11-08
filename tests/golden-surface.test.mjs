// Golden surface, slice 1 (#1379): the parts of the agent-bot surface that can
// be read without running a command's work. The daemon split
// (true-line/agent-bot-daemon docs/daemon-plugin-split.md, steps 3-11) moves
// code under all of these; any user-visible change must show up here as a
// reviewed golden diff. Slices 2-4 are golden-command-help, golden-json-shapes
// and golden-hooks-env; tests/helpers/golden.mjs says how to regenerate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PUBLIC_COMMANDS } from '../cli/parse.mjs';
import { MODULES } from '../cli/dispatch.mjs';
import { createMcpState, handleMcpMessage as handleAgentMcp } from '../agent-mcp.mjs';
import { createReachState, handleMcpMessage as handleReachMcp } from '../daemon-mcp.mjs';
import { ROOT as root, cli, golden } from './helpers/golden.mjs';

test('public commands and their dispatch modules', () => {
  golden('commands.json', {
    public: [...PUBLIC_COMMANDS].sort(),
    modules: Object.fromEntries([...MODULES].sort(([a], [b]) => a.localeCompare(b))),
  });
});

test('top-level help lists every public command', async () => {
  const listed = new Set((await cli(['--help'])).stdout.split('\n').map((line) => /^  ([a-z][a-z-]*)\s/.exec(line)?.[1]).filter(Boolean));
  assert.deepEqual([...PUBLIC_COMMANDS].filter((command) => !listed.has(command)), []);
});

for (const [name, args] of [['help.txt', ['--help']], ['soul-help.txt', ['soul', '--help']], ['broker-help.txt', ['broker', '--help']]]) {
  test(`agent-bot ${args.join(' ')} output and exit code`, async () => {
    const result = await cli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.refused, []);
    golden(name, result.stdout);
  });
}

test('agent-bot with an unknown command fails with exit code 1', async () => {
  const result = await cli(['no-such-command-golden']);
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
