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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAcpExecutor } from '../acp-engine.mjs';
import { HARNESS_SESSION_EVENT, STOP_EVENT, UPDATE_EVENT } from '../executor-contract.mjs';
import { createInteractionService } from '../agent-interaction.mjs';
import {
  authorizeSouls,
  bindTransport,
  enrollPrincipal,
  setOperations,
} from '../agent-principals.mjs';
import { upsertSoul } from '../agent-population.mjs';

const LIVE = (process.env.AGENT_BOT_ACP_LIVE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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

async function liveTurn({ env, principal, executor, interaction, message, key }) {
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

for (const harness of ['opencode', 'claude']) {
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
      env,
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
      env,
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
