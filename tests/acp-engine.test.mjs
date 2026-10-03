import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild } from 'node:child_process';

import {
  ACP_SPAWN_REGISTRY,
  HARNESS_KEY_PATTERN,
  resolveSpawn,
  validateSpawnRow,
} from '../acp-registry.mjs';
import {
  boundAcpUpdate,
  createAcpExecutor,
  mcpPermissionName,
  permissionToolName,
  recordAnnouncement,
} from '../acp-engine.mjs';
import { REACH_SERVER_NAME, reachPolicyRules } from '../daemon-mcp.mjs';
import {
  HARNESS_SESSION_EVENT,
  MAX_UPDATE_BYTES,
  STOP_EVENT,
  UPDATE_EVENT,
} from '../executor-contract.mjs';
import { EXECUTION_FAILED_ERROR, createInteractionService } from '../agent-interaction.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setOperations,
} from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';

const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const IDENTITY = { app: 'qwts-claude-agent', agentId: AGENT_ID };
const ALLOW_ALL = { version: 1, rules: [], fallback: 'allow' };
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

// One registry row that spawns the scripted fixture agent instead of a real
// harness; everything else about the engine path is identical to production.
const FAKE_REGISTRY = Object.freeze({
  claude: Object.freeze({
    harness: 'claude',
    enabled: true,
    command: process.execPath,
    args: Object.freeze([FIXTURE]),
    stripEnv: Object.freeze(['CLAUDECODE']),
    mcpToolNaming: 'claude-meta',
  }),
  codex: Object.freeze({
    harness: 'codex',
    enabled: true,
    command: process.execPath,
    args: Object.freeze([FIXTURE]),
    stripEnv: Object.freeze([]),
    mcpToolNaming: 'codex-invocation',
  }),
  opencode: Object.freeze({
    harness: 'opencode',
    enabled: true,
    command: process.execPath,
    args: Object.freeze([FIXTURE]),
    stripEnv: Object.freeze([]),
    mcpToolNaming: 'opencode-key',
  }),
});

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-engine-'));
  roots.push(root);
  const env = {
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
  };
  return { root, env };
}

function seedSoul(env) {
  return upsertSoul({
    id: AGENT_ID,
    appSlug: IDENTITY.app,
    parentId: null,
    status: 'active',
    spacePath: `/spaces/${AGENT_ID}`,
    transcriptLocator: null,
    lastSeen: '2026-08-27T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
}

function seedPrincipal(env, { operations = ['message', 'observe', 'cancel', 'approve'] } = {}) {
  const options = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  const principal = enrollPrincipal({ label: 'owner' }, options);
  bindTransport(principal.principalId, { transport: 'web', providerId: 'owner-subject' }, options);
  authorizeSouls(principal.principalId, [AGENT_ID], options);
  return setOperations(principal.principalId, operations, options);
}

function service(env, overrides = {}) {
  return createInteractionService({ env, home: '/nonexistent', config: {}, log: () => {}, ...overrides });
}

async function waitFor(probe, { timeoutMs = 10_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

function begin(interaction, principal) {
  const { session } = interaction.createOrContinueSession({
    principal,
    transport: 'web',
    agentId: AGENT_ID,
  });
  return session;
}

// Drives one engine turn through the real daemon service and returns the
// terminal invocation plus its recorded events.
async function turn({ executorOptions = {}, message, attachments, expectStatus = 'completed', logs = [] }) {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const executor = createAcpExecutor({
    harness: 'claude',
    identity: IDENTITY,
    policy: ALLOW_ALL,
    registry: FAKE_REGISTRY,
    ...executorOptions,
  });
  const interaction = service(env, { executor, log: (line) => logs.push(line) });
  const session = begin(interaction, principal);
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message,
    attachments,
    idempotencyKey: `turn-${message}`,
  });
  const finished = await waitFor(() => {
    const { invocation: current } = interaction.getInvocation({
      principal,
      transport: 'web',
      invocationId: invocation.invocationId,
    });
    return current.status === expectStatus ? current : null;
  });
  const { events } = interaction.readEvents({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  return { finished, events, interaction, principal, session };
}

function chunkTexts(events) {
  return events
    .filter((event) => event.type === UPDATE_EVENT && event.data.sessionUpdate === 'agent_message_chunk')
    .map((event) => event.data.content.text);
}

// --- registry ---------------------------------------------------------------

test('the shipped registry rows validate and match the enablement checklist', () => {
  for (const [key, row] of Object.entries(ACP_SPAWN_REGISTRY)) {
    validateSpawnRow(row);
    assert.equal(row.harness, key);
    assert.ok(HARNESS_KEY_PATTERN.test(key));
  }
  assert.equal(ACP_SPAWN_REGISTRY.claude.enabled, true);
  assert.equal(ACP_SPAWN_REGISTRY.opencode.enabled, true);
  // Codex: adapter lane decided, spawn not yet verified — registered, disabled.
  assert.equal(ACP_SPAWN_REGISTRY.codex.enabled, false);
  // Muse: the co-shipped muse-acp adapter row (#145).
  assert.equal(ACP_SPAWN_REGISTRY.muse.enabled, true);
  // The claude row strips the nesting guard a Claude Code parent would leak;
  // the muse row strips the equivalent Muse session marker.
  assert.ok(ACP_SPAWN_REGISTRY.claude.stripEnv.includes('CLAUDECODE'));
  assert.ok(ACP_SPAWN_REGISTRY.muse.stripEnv.includes('MUSE_AGENT'));
  // No entry on this plane: isolated-store CLIs.
  for (const absent of ['cursor', 'copilot']) {
    assert.equal(ACP_SPAWN_REGISTRY[absent], undefined);
  }
});

test('resolveSpawn fails closed on unknown, disabled, and mis-keyed rows', () => {
  assert.equal(resolveSpawn(ACP_SPAWN_REGISTRY, 'opencode').command, 'opencode');
  assert.throws(() => resolveSpawn(ACP_SPAWN_REGISTRY, 'cursor'), /no ACP drive entry/);
  assert.throws(() => resolveSpawn(ACP_SPAWN_REGISTRY, 'codex'), /not enabled/);
  assert.throws(() => resolveSpawn(ACP_SPAWN_REGISTRY, 'Not A Key'), /harness must be a registry key/);
  assert.throws(() => resolveSpawn({ claude: { ...FAKE_REGISTRY.claude, harness: 'opencode' } }, 'claude'), /keyed as/);
  assert.throws(() => validateSpawnRow({ ...FAKE_REGISTRY.claude, args: ['ok', 7] }), /args/);
});

test('executor construction fails closed before any process is spawned', () => {
  const good = { harness: 'claude', identity: IDENTITY, policy: ALLOW_ALL, registry: FAKE_REGISTRY };
  createAcpExecutor(good);
  assert.throws(() => createAcpExecutor({ ...good, harness: 'cursor' }), /no ACP drive entry/);
  assert.throws(() => createAcpExecutor({ ...good, mcpServers: 'daemon' }), /mcpServers/);
  assert.throws(() => createAcpExecutor({ ...good, getHarnessSession: 'yes' }), /getHarnessSession/);
  assert.throws(() => createAcpExecutor({ ...good, turnTimeoutMs: 0 }), /turnTimeoutMs/);
  assert.throws(() => createAcpExecutor({ ...good, exitGraceMs: -1 }), /exitGraceMs/);
  assert.throws(() => createAcpExecutor({ ...good, env: 'PATH=x' }), /env must be an object/);
  assert.throws(() => createAcpExecutor({ ...good, spawn: 'sh' }), /spawn must be a function/);
  assert.throws(() => createAcpExecutor({ ...good, log: 'stdout' }), /log must be a function/);
  assert.throws(() => createAcpExecutor({ ...good, identity: { app: IDENTITY.app } }), /agentBot\.agentId/);
});

// --- update shaping (pure) --------------------------------------------------

test('boundAcpUpdate truncates chunks to the bound and skips foreign kinds', () => {
  const big = boundAcpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'x'.repeat(20_000) },
  });
  assert.ok(big !== null);
  assert.ok(Buffer.byteLength(JSON.stringify(big), 'utf8') <= MAX_UPDATE_BYTES);
  assert.ok(big.content.text.endsWith('…[truncated]'));
  assert.equal(boundAcpUpdate({ sessionUpdate: 'available_commands_update' }), null);
  assert.equal(boundAcpUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } }), null);
  assert.equal(boundAcpUpdate({ sessionUpdate: 'tool_call', toolCallId: 'call_untitled' }), null);
  assert.equal(boundAcpUpdate(null), null);
  const fine = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } };
  assert.deepEqual(boundAcpUpdate(fine), fine);
});

test('permissionToolName prefers harness metadata, falls back to kind, never spaces', () => {
  assert.equal(permissionToolName({ kind: 'execute', _meta: { toolName: 'Bash' } }), 'Bash');
  assert.equal(permissionToolName({ kind: 'execute' }), 'execute');
  assert.equal(permissionToolName({ kind: 'run the thing' }), 'other');
  assert.equal(permissionToolName(undefined), 'other');
  assert.equal(permissionToolName({ _meta: { claudeCode: { toolName: 'Read' } } }), 'Read');
  assert.equal(permissionToolName({ title: 'mcp__agent-reach__fleet' }, 'mcp__agent-reach__fleet'), 'mcp__agent-reach__fleet');
  assert.equal(permissionToolName({ title: 'mcp__agent-reach__fleet' }), 'other', 'a title is never a name');
});

// --- full turns through the daemon service ----------------------------------

test('a full ACP turn drives spawn, bind, stream, and stop through the contract', async () => {
  const { finished, events } = await turn({ message: 'ping' });
  assert.equal(finished.status, 'completed');
  const binding = events.find((event) => event.type === HARNESS_SESSION_EVENT);
  assert.deepEqual(binding.data, { harness: 'claude', mode: 'new', harnessSessionId: 'fake-ses-1' });
  assert.deepEqual(chunkTexts(events), ['pong: ping']);
  const kinds = events
    .filter((event) => event.type === UPDATE_EVENT)
    .map((event) => event.data.sessionUpdate);
  assert.deepEqual(kinds, ['agent_message_chunk', 'tool_call', 'tool_call_update']);
  const stop = events.find((event) => event.type === STOP_EVENT);
  assert.deepEqual(stop.data, { stopReason: 'end_turn' });
});

test('the engine strips nesting guards, keeps the rest, and injects mcpServers', async () => {
  const mcpServers = [{ name: 'daemon', command: 'agent-bot-daemon-mcp', args: [] }];
  const { events } = await turn({
    message: 'env-probe',
    executorOptions: {
      env: { ...process.env, CLAUDECODE: '1', FAKE_KEEP: 'yes' },
      mcpServers,
      cwd: tmpdir(),
    },
  });
  const probe = JSON.parse(chunkTexts(events)[0]);
  assert.equal(probe.CLAUDECODE, null);
  assert.equal(probe.FAKE_KEEP, 'yes');
  assert.equal(probe.cwd, tmpdir());
  assert.deepEqual(probe.mcpServers, mcpServers);
  assert.equal(probe.loaded, false);
});

test('a per-invocation mcpServers factory sees the invocation and identity', async () => {
  const calls = [];
  const { finished, events } = await turn({
    message: 'env-probe',
    executorOptions: {
      cwd: tmpdir(),
      mcpServers: ({ invocation, identity, harness }) => {
        calls.push({ invocationId: invocation.invocationId, agentId: identity.agentId, harness });
        return [{ name: 'reach', command: 'agent-bot', args: ['reach-mcp'] }];
      },
    },
  });
  const probe = JSON.parse(chunkTexts(events)[0]);
  assert.deepEqual(probe.mcpServers, [{ name: 'reach', command: 'agent-bot', args: ['reach-mcp'] }]);
  assert.deepEqual(calls, [{
    invocationId: finished.invocationId,
    agentId: AGENT_ID,
    harness: 'claude',
  }]);
});

test('a factory that returns a non-array fails the turn closed', async () => {
  const { finished } = await turn({
    message: 'env-probe',
    executorOptions: { cwd: tmpdir(), mcpServers: () => 'nope' },
    expectStatus: 'failed',
  });
  assert.equal(finished.error, EXECUTION_FAILED_ERROR);
});

test('a prior harness session resumes via session/load without re-recording history', async () => {
  const seen = [];
  const { events } = await turn({
    message: 'env-probe',
    executorOptions: {
      getHarnessSession: (invocation) => {
        seen.push(invocation.invocationId);
        return { harnessSessionId: 'fake-ses-42' };
      },
    },
  });
  assert.equal(seen.length, 1);
  const binding = events.find((event) => event.type === HARNESS_SESSION_EVENT);
  assert.deepEqual(binding.data, { harness: 'claude', mode: 'resume', harnessSessionId: 'fake-ses-42' });
  const texts = chunkTexts(events);
  assert.ok(!texts.includes('replayed-history-line'));
  assert.equal(JSON.parse(texts[0]).loaded, true);
});

test('permission requests are answered from policy: allow picks allow, deny picks reject', async () => {
  const allowed = await turn({
    message: 'need-permission',
    executorOptions: { policy: { version: 1, rules: [{ tool: 'Bash', outcome: 'allow' }], fallback: 'deny' } },
  });
  assert.deepEqual(chunkTexts(allowed.events), ['permission:{"outcome":"selected","optionId":"opt-allow"}']);

  const denied = await turn({
    message: 'need-permission',
    executorOptions: { policy: { version: 1, rules: [], fallback: 'deny' } },
  });
  assert.deepEqual(chunkTexts(denied.events), ['permission:{"outcome":"selected","optionId":"opt-reject"}']);
});

test('a Claude permission request is named by the tool its tool_call announced, never by its title', async () => {
  const { events } = await turn({
    message: 'claude-mcp-permission',
    executorOptions: { policy: { version: 1, rules: [{ tool: 'mcp__agent-reach__send_message', outcome: 'allow' }], fallback: 'deny' } },
  });
  assert.deepEqual(chunkTexts(events).at(-1), 'mcp:allow bash:reject');
});

// The daemon's own reach rules over its default deny policy, as wake-plane
// composes them: only the injected server's tools get through.
const REACH_ONLY = { version: 1, rules: reachPolicyRules(), fallback: 'deny' };
const REACH_SERVERS = [{ name: REACH_SERVER_NAME, command: 'agent-bot', args: ['reach-mcp'], env: [] }];

test('a Codex MCP approval is named from its announced invocation; exec and foreign servers stay denied', async () => {
  const logs = [];
  const { events } = await turn({
    message: 'codex-mcp-permission',
    executorOptions: { harness: 'codex', policy: REACH_ONLY, mcpServers: REACH_SERVERS, log: (line) => logs.push(line) },
  });
  assert.equal(chunkTexts(events).at(-1), 'mcp:approved exec:cancel foreign:cancel');
  assert.ok(logs.some((line) => /codex permission for call_c2 has no verifiable tool name; policy sees 'execute'/.test(line)));
});

test('an OpenCode MCP permission is named by its tool key; a borrowed title never is', async () => {
  const { events } = await turn({
    message: 'opencode-mcp-permission',
    executorOptions: { harness: 'opencode', policy: REACH_ONLY, mcpServers: REACH_SERVERS },
  });
  assert.equal(chunkTexts(events).at(-1), 'mcp:once outside:reject unannounced:reject');
});

test('the Claude reach call is allowed by the daemon rules too', async () => {
  const { events } = await turn({
    message: 'claude-mcp-permission',
    executorOptions: { policy: REACH_ONLY, mcpServers: REACH_SERVERS },
  });
  assert.deepEqual(chunkTexts(events).at(-1), 'mcp:allow bash:reject');
});

test('mcpPermissionName only names calls to injected servers, from adapter-built fields', () => {
  const codexAnnounced = recordAnnouncement(undefined, {
    sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Tool: agent-reach/fleet', rawInput: { server: 'agent-reach', tool: 'fleet' },
  });
  const codexRequest = { toolCallId: 'c', rawInput: { server_name: 'agent-reach' } };
  assert.equal(mcpPermissionName('codex-invocation', codexRequest, codexAnnounced, ['agent-reach']), 'mcp__agent-reach__fleet');
  assert.equal(mcpPermissionName('codex-invocation', codexRequest, codexAnnounced, []), null, 'not injected');
  assert.equal(mcpPermissionName('codex-invocation', { rawInput: { server_name: 'x' } }, codexAnnounced, ['agent-reach']), null);
  assert.equal(mcpPermissionName('codex-invocation', codexRequest, { ...codexAnnounced, title: 'rm -rf /' }, ['agent-reach']), null);
  assert.equal(mcpPermissionName('opencode-key', codexRequest, codexAnnounced, ['agent-reach']), null, 'shapes never cross');
  assert.equal(mcpPermissionName(null, codexRequest, codexAnnounced, ['agent-reach']), null);

  const openAnnounced = recordAnnouncement(undefined, { sessionUpdate: 'tool_call', toolCallId: 'o', title: 'agent-reach_fleet', kind: 'other' });
  const openRequest = { toolCallId: 'o', title: 'agent-reach_fleet', kind: 'other' };
  assert.equal(mcpPermissionName('opencode-key', openRequest, openAnnounced, ['agent-reach']), 'mcp__agent-reach__fleet');
  assert.equal(mcpPermissionName('opencode-key', { ...openRequest, kind: 'execute' }, openAnnounced, ['agent-reach']), null);
  assert.equal(mcpPermissionName('opencode-key', openRequest, { ...openAnnounced, kind: 'execute' }, ['agent-reach']), null);
  assert.equal(mcpPermissionName('opencode-key', { ...openRequest, title: 'agent-reach_x y' },
    { ...openAnnounced, title: 'agent-reach_x y' }, ['agent-reach']), null, 'not a tool key');
  const sendKey = { title: 'agent-reach_send_message', kind: 'other' };
  assert.equal(mcpPermissionName('opencode-key', sendKey, sendKey, ['agent-reach', 'agent-reach_send']), null,
    'an ambiguous key is refused');
  assert.equal(mcpPermissionName('codex-invocation', codexRequest, null, ['agent-reach']), null);
});

test('recordAnnouncement keeps the first tool_call shape and lets a later update add only the name', () => {
  const first = recordAnnouncement(undefined, { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'agent-reach_fleet', kind: 'other' });
  const rewritten = recordAnnouncement(first, { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'other', kind: 'execute' });
  assert.equal(rewritten, first);
  const named = recordAnnouncement(first, { sessionUpdate: 'tool_call_update', toolCallId: 'x', _meta: { claudeCode: { toolName: 'Read' } } });
  assert.deepEqual(named, { ...first, name: 'Read' });
  assert.equal(recordAnnouncement(undefined, { sessionUpdate: 'tool_call_update', toolCallId: 'x', title: 'y' }), null);
  assert.equal(recordAnnouncement(undefined, { sessionUpdate: 'agent_message_chunk' }), null);
});

test('oversized chunks are truncated, foreign update kinds are skipped, turns survive', async () => {
  const oversize = await turn({ message: 'oversize' });
  const [first, second] = chunkTexts(oversize.events);
  assert.ok(first.endsWith('…[truncated]'));
  assert.equal(second, 'after-oversize');
  for (const event of oversize.events) {
    assert.ok(Buffer.byteLength(JSON.stringify(event.data), 'utf8') <= MAX_UPDATE_BYTES);
  }

  const weird = await turn({ message: 'weird-update' });
  assert.deepEqual(chunkTexts(weird.events), ['still-fine']);
  const kinds = weird.events
    .filter((event) => event.type === UPDATE_EVENT)
    .map((event) => event.data.sessionUpdate);
  assert.deepEqual(kinds, ['agent_message_chunk']);
});

test('a stop reason outside the ACP vocabulary fails the turn', async () => {
  const logs = [];
  const { finished } = await turn({ message: 'bad-stop', expectStatus: 'failed', logs });
  assert.equal(finished.error, EXECUTION_FAILED_ERROR);
  assert.ok(logs.some((line) => /stopReason/.test(line)));
});

test('attachments without a reach channel are refused rather than silently dropped', async () => {
  const logs = [];
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const executor = createAcpExecutor({
    harness: 'claude',
    identity: IDENTITY,
    policy: ALLOW_ALL,
    registry: FAKE_REGISTRY,
  });
  const interaction = service(env, { executor, log: (line) => logs.push(line) });
  const session = begin(interaction, principal);
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'ping',
    attachments: ['space://reports/latest.md'],
    idempotencyKey: 'turn-attachment',
  });
  const failed = await waitFor(() => {
    const { invocation: current } = interaction.getInvocation({
      principal,
      transport: 'web',
      invocationId: invocation.invocationId,
    });
    return current.status === 'failed' ? current : null;
  });
  assert.equal(failed.error, EXECUTION_FAILED_ERROR);
  assert.ok(logs.some((line) => /attachments need an injected reach-back MCP server/.test(line)));
});

test('an attached turn proceeds when a reach channel is injected', async () => {
  const { events } = await turn({
    message: 'env-probe',
    executorOptions: {
      cwd: tmpdir(),
      mcpServers: [{ name: 'reach', command: 'agent-bot', args: ['reach-mcp'] }],
    },
    attachments: ['space://reports/latest.md'],
  });
  const probe = JSON.parse(chunkTexts(events)[0]);
  assert.equal(probe.mcpServers.length, 1);
});

test('cancellation sends session/cancel and lands the invocation on cancelled', async () => {
  const { env } = scratch();
  seedSoul(env);
  const principal = seedPrincipal(env);
  const executor = createAcpExecutor({
    harness: 'claude',
    identity: IDENTITY,
    policy: ALLOW_ALL,
    registry: FAKE_REGISTRY,
  });
  const interaction = service(env, { executor });
  const session = begin(interaction, principal);
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: 'hang',
    idempotencyKey: 'turn-hang',
  });
  // The turn is live once its binding event exists; cancel after that.
  await waitFor(() => {
    const { events } = interaction.readEvents({
      principal,
      transport: 'web',
      invocationId: invocation.invocationId,
    });
    return events.some((event) => event.type === HARNESS_SESSION_EVENT) ? true : null;
  });
  const outcome = await interaction.cancelInvocation({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.stopped, true);
});

test('a turn that outlives its timeout fails instead of hanging the daemon', async () => {
  const logs = [];
  const { finished } = await turn({
    message: 'hang',
    expectStatus: 'failed',
    logs,
    executorOptions: { turnTimeoutMs: 300 },
  });
  assert.equal(finished.error, EXECUTION_FAILED_ERROR);
  assert.ok(logs.some((line) => /turn exceeded 300ms/.test(line)));
});

test('the whole process tree dies with the turn, not just the spawn runner', async () => {
  const RUNNER = fileURLToPath(new URL('./fixtures/spawn-runner.mjs', import.meta.url));
  const logs = [];
  const { finished, events } = await turn({
    message: 'hang',
    expectStatus: 'failed',
    logs,
    executorOptions: {
      // Allow the nested Node process to start on slower CI hosts before the
      // deadline proves that the entire tree is terminated.
      turnTimeoutMs: 2500,
      registry: {
        claude: {
          ...FAKE_REGISTRY.claude,
          // npx-shaped row: the agent runs as a grandchild on inherited pipes.
          args: [RUNNER, FIXTURE],
        },
      },
    },
  });
  // The deadline fires even though the grandchild holds the stdio pipes open.
  assert.equal(finished.error, EXECUTION_FAILED_ERROR);
  assert.ok(logs.some((line) => /turn exceeded 2500ms/.test(line)));
  const pidText = chunkTexts(events).find((text) => text.startsWith('pid:'));
  const agentPid = Number(pidText.slice('pid:'.length));
  assert.ok(Number.isSafeInteger(agentPid) && agentPid > 0);
  await waitFor(() => {
    try {
      process.kill(agentPid, 0);
      return null;
    } catch {
      return true;
    }
  });
});

// --- teardown ---------------------------------------------------------------

// A harness that writes its session log as it exits must get to exit: a
// SIGKILL right after the turn left Claude Code logs with no messages.
test('a finished turn lets the agent exit and flush after stdin closes', async () => {
  const flushFile = path.join(scratch().root, 'flushed');
  const { finished } = await turn({
    message: 'hello',
    executorOptions: { env: { ...process.env, FAKE_FLUSH_FILE: flushFile } },
  });
  assert.equal(finished.status, 'completed');
  assert.equal(existsSync(flushFile), true);
});

test('an agent that ignores stdin EOF gets SIGTERM and still flushes', async () => {
  const flushFile = path.join(scratch().root, 'flushed');
  const { finished } = await turn({
    message: 'hello',
    executorOptions: { env: { ...process.env, FAKE_FLUSH_FILE: flushFile, FAKE_IGNORE_EOF: '1' }, exitGraceMs: 200 },
  });
  assert.equal(finished.status, 'completed');
  assert.equal(existsSync(flushFile), true);
});

test('an agent that ignores EOF and SIGTERM is killed after the grace period', async () => {
  const pids = [];
  const flushFile = path.join(scratch().root, 'flushed');
  const { finished } = await turn({
    message: 'hello',
    executorOptions: {
      env: { ...process.env, FAKE_FLUSH_FILE: flushFile, FAKE_IGNORE_EOF: '1', FAKE_IGNORE_TERM: '1' },
      exitGraceMs: 100,
      spawn: (command, args, options) => {
        const child = spawnChild(command, args, options);
        pids.push(child.pid);
        return child;
      },
    },
  });
  assert.equal(finished.status, 'completed');
  assert.equal(existsSync(flushFile), false);
  assert.equal(pids.length, 1);
  assert.throws(() => process.kill(-pids[0], 0), /ESRCH/);
});
