// Live enablement checks for the ACP drive plane (#144): drive a REAL harness
// through the exact production engine path and prove the session lands in the
// harness's own store (turn 2 resumes turn 1's session and recalls a token).
//
// Gated: set AGENT_BOT_ACP_LIVE to a comma-separated list of harness keys
// (e.g. `AGENT_BOT_ACP_LIVE=opencode npm test`). Skipped otherwise — CI never
// spawns a real harness. Each live harness needs its own auth already in
// place (see the registry row's `auth` note).
//
// The claude row's check must run where the daemon is the parent process —
// spawning it from inside a Claude Code session trips the harness's own
// nesting refusal, which is the registry row's stripEnv story, not a lane
// this suite should launder around.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAcpExecutor } from '../acp-engine.mjs';
import { reachMcpServerEntry } from '../daemon-mcp.mjs';
import { HARNESS_SESSION_EVENT, STOP_EVENT, UPDATE_EVENT } from '../executor-contract.mjs';
import { createInteractionService } from '../agent-interaction.mjs';
import { readEvents } from '../agent-jobs.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setOperations,
} from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';

const LIVE = (process.env.AGENT_BOT_ACP_LIVE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const REACH_LIVE = (process.env.AGENT_BOT_REACH_LIVE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const IDENTITY = { app: 'qwts-claude-agent', agentId: AGENT_ID };
const ALLOW_ALL = { version: 1, rules: [], fallback: 'allow' };
const TOKEN = 'ACP_ENGINE_TOKEN_7391';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function harnessFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'acp-live-'));
  roots.push(root);
  const env = {
    AGENT_BOT_INTERACTION_HOME: path.join(root, 'interaction'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(root, 'principals.json'),
  };
  upsertSoul({
    id: AGENT_ID,
    appSlug: IDENTITY.app,
    parentId: null,
    status: 'active',
    spacePath: `/spaces/${AGENT_ID}`,
    transcriptLocator: null,
    lastSeen: '2026-08-27T08:00:00.000Z',
  }, { file: env.AGENT_BOT_POPULATION_PATH });
  const options = { file: env.AGENT_BOT_PRINCIPALS_PATH, env, home: '/nonexistent' };
  let principal = enrollPrincipal({ label: 'owner' }, options);
  bindTransport(principal.principalId, { transport: 'web', providerId: 'owner-subject' }, options);
  authorizeSouls(principal.principalId, [AGENT_ID], options);
  principal = setOperations(principal.principalId, ['message', 'observe', 'cancel', 'approve'], options);
  return { env, principal };
}

async function waitFor(probe, { timeoutMs = 180_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

async function liveTurn({ principal, interaction, message, key }) {
  const { session } = interaction.createOrContinueSession({
    principal,
    transport: 'web',
    agentId: AGENT_ID,
  });
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message,
    idempotencyKey: key,
  });
  const finished = await waitFor(() => {
    const { invocation: current } = interaction.getInvocation({
      principal,
      transport: 'web',
      invocationId: invocation.invocationId,
    });
    return ['completed', 'failed', 'cancelled'].includes(current.status) ? current : null;
  });
  const { events } = interaction.readEvents({
    principal,
    transport: 'web',
    invocationId: invocation.invocationId,
  });
  return { finished, events };
}

function harnessSession(events) {
  const binding = events.findLast((event) => event.type === HARNESS_SESSION_EVENT);
  return binding?.data ?? null;
}

function fullText(events) {
  return events
    .filter((event) => event.type === UPDATE_EVENT && event.data.sessionUpdate === 'agent_message_chunk')
    .map((event) => event.data.content?.text ?? '')
    .join('');
}

for (const harness of ['opencode', 'claude', 'muse']) {
  test(`live ${harness}: new turn, then resume recalls the prior session`, {
    skip: LIVE.includes(harness) ? false : `set AGENT_BOT_ACP_LIVE=${harness} to run`,
    timeout: 360_000,
  }, async (t) => {
    const { env, principal } = harnessFixture();

    const first = createAcpExecutor({ harness, identity: IDENTITY, policy: ALLOW_ALL });
    const interaction1 = createInteractionService({
      env, home: '/nonexistent', config: {}, log: () => {}, executor: first,
    });
    const turn1 = await liveTurn({
      principal,
      interaction: interaction1,
      message: `Remember the token ${TOKEN}. Reply with exactly OK.`,
      key: `live-${harness}-1`,
    });
    assert.equal(turn1.finished.status, 'completed');
    const binding = harnessSession(turn1.events);
    assert.equal(binding.mode, 'new');
    assert.ok(binding.harnessSessionId.length > 0);
    assert.ok(turn1.events.some((event) => event.type === STOP_EVENT));
    t.diagnostic(`${harness} session: ${binding.harnessSessionId}`);

    const second = createAcpExecutor({
      harness,
      identity: IDENTITY,
      policy: ALLOW_ALL,
      getHarnessSession: () => ({ harnessSessionId: binding.harnessSessionId }),
    });
    const interaction2 = createInteractionService({
      env, home: '/nonexistent', config: {}, log: () => {}, executor: second,
    });
    const turn2 = await liveTurn({
      principal,
      interaction: interaction2,
      message: 'What token did I ask you to remember? Reply with just the token.',
      key: `live-${harness}-2`,
    });
    assert.equal(turn2.finished.status, 'completed');
    assert.equal(harnessSession(turn2.events).mode, 'resume');
    assert.ok(
      fullText(turn2.events).includes(TOKEN),
      `resumed ${harness} session did not recall the token`,
    );
  });
}

// --- reach-back live proofs (#146) ------------------------------------------
// Gated the same way: AGENT_BOT_REACH_LIVE=<harness keys>. The injected proof
// drives the harness through the production engine path with the reach server
// stamped into session/new mcpServers[]; the registered proof mounts the same
// server from a live desktop harness config and lands a reply addressed by
// explicit invocation id.

const REACH_TOKEN = 'REACH_LOOP_TOKEN_4172';

for (const harness of ['opencode', 'claude', 'muse']) {
  test(`live ${harness}: injected reach server closes the loop with a reply event`, {
    skip: REACH_LIVE.includes(harness) ? false : `set AGENT_BOT_REACH_LIVE=${harness} to run`,
    timeout: 360_000,
  }, async (t) => {
    const { env, principal } = harnessFixture();
    const executor = createAcpExecutor({
      harness,
      identity: IDENTITY,
      policy: ALLOW_ALL,
      mcpServers: ({ invocation, identity }) => [reachMcpServerEntry({
        invocationId: invocation.invocationId,
        agentId: identity.agentId,
        env,
      })],
    });
    const interaction = createInteractionService({
      env, home: '/nonexistent', config: {}, log: (line) => t.diagnostic(String(line)), executor,
    });
    const { finished, events } = await liveTurn({
      principal,
      interaction,
      message:
        `The token is ${REACH_TOKEN}. Using the agent-reach MCP tools: call `
        + 'fetch_context, then call post_reply with text set to exactly the '
        + 'token from the fetched message. Then reply DONE.',
      key: `reach-${harness}-injected`,
    });
    assert.equal(finished.status, 'completed');
    const reply = events.findLast((event) => event.type === 'reply');
    assert.ok(reply, 'no reply event landed on the invocation stream');
    assert.ok(
      reply.data.text.includes(REACH_TOKEN),
      `reply did not carry the fetched token: ${reply.data.text}`,
    );
    assert.equal(reply.data.agentId, AGENT_ID);
    t.diagnostic(`${harness} injected reply: ${reply.data.text}`);
  });
}

test('live opencode (registered): a desktop harness config lands a reply by invocation id', {
  skip: REACH_LIVE.includes('opencode') ? false : 'set AGENT_BOT_REACH_LIVE=opencode to run',
  timeout: 360_000,
}, async (t) => {
  const { env, principal } = harnessFixture();
  const options = { env, home: '/nonexistent' };

  // The thread this desktop session will reach into.
  const { invocation } = seedReachThread(env, principal);

  // A configured worktree is the registered placement's identity: the pin in
  // git config, the server mounted by the harness's own MCP config.
  const workspace = mkdtempSync(path.join(tmpdir(), 'reach-registered-'));
  roots.push(workspace);
  execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['config', 'agentBot.agentId', AGENT_ID], { cwd: workspace, stdio: 'ignore' });
  const serverPath = fileURLToPath(new URL('../daemon-mcp.mjs', import.meta.url));
  writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      'agent-reach': {
        type: 'local',
        command: [process.execPath, serverPath],
        environment: {
          AGENT_BOT_INTERACTION_HOME: env.AGENT_BOT_INTERACTION_HOME,
          AGENT_BOT_POPULATION_PATH: env.AGENT_BOT_POPULATION_PATH,
        },
        enabled: true,
      },
    },
  }, null, 2), { mode: 0o600 });

  const prompt =
    'Using the agent-reach MCP tools with invocation_id '
    + `"${invocation.invocationId}": call fetch_context, then call post_reply `
    + 'with text set to exactly the token from the fetched message. Then say DONE.';
  await new Promise((resolve, reject) => {
    // --dir plus a corrected PWD: opencode resolves its project from the
    // inherited PWD (the repo worktree under npm test), not the spawn cwd,
    // and a repo-bound session never sees the workspace's opencode.json.
    const child = spawn('opencode', ['run', '--dir', workspace, prompt], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PWD: workspace },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('close', (code) => {
      t.diagnostic(`opencode run exited ${code}: ${output.slice(-2000)}`);
      if (code === 0) resolve();
      else reject(new Error(`opencode run exited ${code}: ${output.slice(-2000)}`));
    });
  });

  const reply = readEvents(invocation.invocationId, {}, options)
    .findLast((event) => event.type === 'reply');
  assert.ok(reply, 'no reply event landed from the registered desktop session');
  assert.ok(
    reply.data.text.includes(REACH_TOKEN),
    `registered reply did not carry the token: ${reply.data.text}`,
  );
  assert.equal(reply.data.agentId, AGENT_ID);
  t.diagnostic(`registered reply: ${reply.data.text}`);
});

// Seeds a session + invocation + payload through the interaction service, so
// the registered proof reaches into a thread created exactly the way the
// local plug (web adapter) creates them. The no-op executor completes the
// invocation immediately: the desktop session, not the daemon, answers it.
function seedReachThread(env, principal) {
  const interaction = createInteractionService({
    env, home: '/nonexistent', config: {}, log: () => {}, executor: async () => {},
  });
  const { session } = interaction.createOrContinueSession({
    principal, transport: 'web', agentId: AGENT_ID,
  });
  const { invocation } = interaction.submitMessage({
    principal,
    transport: 'web',
    sessionId: session.sessionId,
    message: `The token is ${REACH_TOKEN}. A desktop session will reach back with it.`,
    idempotencyKey: 'reach-registered-1',
  });
  return { session, invocation };
}
