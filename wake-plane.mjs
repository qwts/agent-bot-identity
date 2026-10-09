// The daemon's wake plane (agent-comms ADR-0008 decisions 7 to 9), assembled
// from its parts: the comms supervisor's `account-watch` stream hands each
// wake to the dispatcher (#256), which delivers it to a warm socket in the
// pool (#147) or, when the owner turned cold wake on for that soul, to the
// cold waker (#259), and reports the outcome back to the broker.
//
// Every part stays a port so the composition is testable without a broker,
// a socket, or a harness.

import path from 'node:path';
import { createTurnRegistry } from './turn-registry.mjs';

import { createAcpExecutor } from './acp-engine.mjs';
import { getInvocation, getSession, listInvocations, readEvents, TERMINAL_STATUSES, validateInvocationId } from './agent-jobs.mjs';
import { createColdWaker } from './cold-wake.mjs';
import { reachMcpServerEntry, reachPolicyRules } from './daemon-mcp.mjs';
import { HARNESS_SESSION_EVENT, UPDATE_EVENT, validateHarnessBinding } from './executor-contract.mjs';
import { keydMcpServerEntry, keydPolicyRules } from './keyd-client.mjs';
import { NEVER_ROUTED } from './soul-tool-homes.mjs';
import { createWakeDispatcher } from './wake-dispatch.mjs';

export { createTurnRegistry };

// The broker port the dispatcher wants, over the supervisor's report.
export function wakeReporter(report) {
  return (agentId, messageIds, outcome, detail) => report({ agentId, messageIds, outcome, detail: detail ?? '' });
}

// A cold turn has no principal watching it. Without an `approvals` port,
// nothing may escalate to an approval: whatever the policy does not allow
// outright is denied. With one (#85), an `approval` outcome becomes an open
// proposal naming the soul and the tool, and the turn waits for the owner (or
// an approving principal) to decide; expiry or the turn's timeout denies. The turn
// resolves with its `reply`: the agent's message text after its last tool
// call, which the cold waker's relay sends back, and `denied`: the tools the
// policy refused, so a turn that stopped on one is not answered with silence.
// `onSession` hears the harness session the turn's prompt goes into (#404).
export function coldTurnExecutor({ executorFor, turnTimeoutMs = 30 * 60_000, onEvent = () => {}, approvals = null, turns = createTurnRegistry() }) {
  return async ({ invocation, message, attachments, env, onSession = null }) => {
    const executor = executorFor({ agentId: invocation.agentId, harness: invocation.harness, cwd: invocation.cwd, env });
    let reply = '';
    const denied = [];
    const collect = (type, update) => {
      if (type !== UPDATE_EVENT) return;
      if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') reply += update.content.text;
      else if (update?.sessionUpdate === 'tool_call') reply = '';
    };
    const result = await turns.run({ invocation, kind: 'wake' }, async ({ signal, sessionGrants }) => executor({
      sessionGrants,
      invocation,
      message,
      attachments,
      signal,
      appendEvent: (type, data) => {
        if (type === HARNESS_SESSION_EVENT && typeof onSession === 'function') {
          try { onSession(data?.harnessSessionId ?? null); } catch { /* observation only */ }
        }
        collect(type, data);
        onEvent(type);
        return { type };
      },
      addArtifact: () => { throw new Error('a cold turn has no artifact store'); },
      requestApproval: approvals
        ? ({ operation, summary, ttlMs } = {}) => approvals({
          agentId: invocation.agentId,
          operation,
          summary,
          tool: typeof operation?.permission?.toolName === 'string' ? operation.permission.toolName : null,
          ...(ttlMs === undefined ? {} : { ttlMs }),
          signal,
        })
        : async () => ({ decision: 'deny' }),
      onPermission: ({ toolName, outcome }) => {
        if (outcome === 'deny' && typeof toolName === 'string' && !denied.includes(toolName)) denied.push(toolName);
      },
    }), { turnTimeoutMs });
    return { ...result, reply, denied };
  };
}

// Only a well-formed interaction-store id is stamped; a comms turn has none.
// A task turn's invocation (cold-wake.mjs, `taskId` set) is minted for task
// reporting alone and is never in the store: stamping it would offer
// fetch_context, post_reply and report_status, and every call would fail
// with "unknown invocation", so the reach server withholds them instead (#407).
function storeInvocationId(invocation) {
  if (invocation?.taskId !== undefined && invocation.taskId !== null) return null;
  try { return validateInvocationId(invocation?.invocationId); } catch { return null; }
}

// The owner's policy with the soul's own reach-back tools allowed first, and
// keyd's (which mint only for the calling soul) only for a soul that gets
// keyd's relay: any other soul must not inherit an allow for those names. A
// malformed policy passes through untouched so the contract still refuses it.
export function withReachRules(policy, { keyd = false } = {}) {
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.rules)) return policy;
  return { ...policy, rules: [...reachPolicyRules(), ...(keyd ? keydPolicyRules() : []), ...policy.rules] };
}

// The interaction event log, not the soul's last observed cold-wake session,
// owns /v1 continuity. Never cross a principal, soul, transport or session.
// Cold/launch invocations have no interaction session and stay independent.
function interactionHarnessSession(invocation, { agentId, harness, store }) {
  if (invocation?.sessionId === undefined || invocation.sessionId === null) return null;
  const session = getSession(invocation.sessionId, store);
  const current = getInvocation(invocation.invocationId, store);
  const owns = (record) => record && record.agentId === agentId
    && record.sessionId === invocation.sessionId
    && record.principalId === invocation.principalId && record.transport === invocation.transport;
  if (!owns(invocation) || !owns(session) || !owns(current)) throw new Error('interaction session ownership mismatch');
  const unavailable = (reason) => {
    throw Object.assign(new Error(`interaction continuity unavailable: ${reason}`), { continuityReason: reason });
  };
  const prior = listInvocations({ sessionId: session.sessionId }, store)
    .filter((record) => record.invocationId !== current.invocationId);
  if (prior.some((record) => !owns(record))) throw new Error('interaction session ownership mismatch');
  // A cancellation request is still running. Loading its native session
  // before the executor actually stops can corrupt history or fork it.
  if (prior.some((record) => !TERMINAL_STATUSES.includes(record.status))) unavailable('session-busy');
  for (const record of prior.reverse()) {
    const event = readEvents(record.invocationId, {}, store).findLast((item) => item.type === HARNESS_SESSION_EVENT);
    if (!event) {
      // A rejected turn never replaced the previous binding. A successful
      // non-ACP turn, however, cannot silently disappear from the context.
      if (record.status === 'completed') unavailable('binding-unavailable');
      continue;
    }
    const binding = validateHarnessBinding(event.data);
    if (binding.harness !== harness) unavailable('harness-changed');
    return { harnessSessionId: binding.harnessSessionId };
  }
  return null;
}

// The environment a soul's harness turn runs with, composed once so the
// executor and anything that must see the same store (the launch's
// sign-in probe, #536) cannot drift: `{ turnEnv, mcpEnv, harnessEnv,
// routed, stripped }`.
export function composeTurnEnv({ agentId, harness, env = {}, baseEnv = {}, runtimeEnvFor = null, toolHomeEnvFor = null, providerEnvFor = null }) {
  const turnEnv = { ...baseEnv, ...env, QWTS_AGENT_ID: agentId, AGENT_BOT_ID: agentId };
  // The soul's own runtimes and harness installs first on PATH, with
  // their env (GOROOT, UV_*), never HOME (#583 slice 3). A soul with no
  // folder yet runs with the host's PATH as before.
  // A failed lookup cannot establish that host tools satisfy the soul's
  // declarations. Refuse before creating or resuming a harness.
  if (runtimeEnvFor) Object.assign(turnEnv, runtimeEnvFor({ agentId, harness, env: turnEnv }) ?? {});
  // The harness's native state in the soul's tool home (#583 slice 2),
  // harness-specific variables only: HOME and XDG_STATE_HOME are dropped
  // whatever the port says. A soul with no folder (a lookup that fails
  // without a code) runs on the host store as before; a tool home that
  // cannot be made is a coded failure of the turn, never a silent fallback.
  const routed = [];
  if (toolHomeEnvFor) {
    let patch = {};
    try { patch = toolHomeEnvFor({ agentId, harness }) ?? {}; } catch (error) { if (error?.code === 'tool-home-unwritable') throw error; }
    for (const [name, value] of Object.entries(patch)) {
      if (NEVER_ROUTED.includes(name) || typeof value !== 'string') continue;
      turnEnv[name] = value;
      routed.push(name);
    }
  }
  // The provider secret (#583 slice 4) goes to the launched harness and
  // nowhere else: `mcpEnv` is the turn env without it, for the reach
  // server and keyd's relay. A secret the store cannot give fails the
  // turn here (coded `provider-secret-missing`), never silently.
  const provided = providerEnvFor ? providerEnvFor({ agentId, harness }) ?? {} : {};
  const stripped = provided.envKey ? [provided.envKey] : [];
  const mcpEnv = { ...turnEnv };
  for (const name of stripped) delete mcpEnv[name];
  const harnessEnv = { ...turnEnv, ...(provided.env ?? {}) };
  return { turnEnv, mcpEnv, harnessEnv, routed, stripped };
}

// The production executor factory: one ACP turn under the soul's own
// identity, in its worktree, with its binding in the environment, and the
// reach-back MCP server (#146) injected so the soul can see its teammates and
// message them as itself. `commsFor(agentId)` is the soul's comms setting as
// recorded at its launch (true unless that launch turned comms off); `false`
// keeps the reach server but withholds its teammate tools. `reachEnv` adds
// variables only the reach server needs, such as a PATH that reaches
// agent-comms. `onHarnessSession` sees each turn's harness session binding,
// so the daemon can record which harness session belongs to which soul (the
// metrics collector reads Claude's log by that id). A failing recorder never
// fails the turn. `keydFor(agentId)` is the agent-bot-keyd binary when keyd
// holds that soul's App key (#397); its relay is injected next to the reach
// server so the soul mints tokens without ever seeing a key. `log` receives
// the engine's one-line diagnostics (`acp engine: …`); without it they are
// dropped. `toolHomeEnvFor({ agentId, harness })` (#583 slice 2) is the
// harness's own store routed into the soul (`CLAUDE_CONFIG_DIR`,
// `CODEX_HOME`, OpenCode's XDG bases); it is not a secret, so the reach
// server and keyd's relay carry it too, and a child they start reads the
// same store as the harness.
// `interactionStore` is the daemon's /v1 job store (env/home), deliberately
// separate from the routed harness environment. Persisted binding events
// resume only the matching principal/soul/transport/session; cold turns do
// not acquire an interaction session merely by sharing the same soul.
export function acpExecutorFor({
  identities, policy, baseEnv, onHarnessSession = null, createExecutor = createAcpExecutor,
  interactionStore = { env: baseEnv },
  identityFor = null,
  commsFor = () => true, modeFor = () => 'safe', modelFor = () => null, onModels = null, reachEnv = {}, keydFor = () => null, harnessDirsFor = () => [], runtimeEnvFor = null, toolHomeEnvFor = null, providerEnvFor = null, log = null,
}) {
  return ({ agentId, harness, cwd, env }) => {
    const identity = identities(agentId);
    // A soul without the github-identity add-on runs with no App (#297).
    const app = identity?.github?.appSlug ?? null;
    const { turnEnv, mcpEnv, harnessEnv, routed, stripped } = composeTurnEnv({ agentId, harness, env, baseEnv, runtimeEnvFor, toolHomeEnvFor, providerEnvFor });
    let comms = true;
    try { comms = commsFor(agentId) !== false; } catch { /* no recorded setting: the default */ }
    let keyd = null;
    try { keyd = app ? keydFor(agentId) : null; } catch { /* no keyd: the #395 stores */ }
    const binding = typeof turnEnv.AGENT_BOT_BINDING === 'string' && path.isAbsolute(turnEnv.AGENT_BOT_BINDING)
      ? turnEnv.AGENT_BOT_BINDING : null;
    const mcpServers = ({ invocation }) => [reachMcpServerEntry({
      invocationId: storeInvocationId(invocation),
      agentId,
      env: { ...mcpEnv, ...reachEnv },
      worktree: typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null,
      binding,
      comms,
      correlation: typeof invocation?.correlation === 'string' ? invocation.correlation : null,
      turnId: typeof invocation?.turnId === 'string' ? invocation.turnId : null,
      strip: stripped,
      forward: routed,
    }), ...(keyd ? [keydMcpServerEntry({ bin: keyd, binding, env: mcpEnv, forward: routed })] : [])];
    const executor = createExecutor({
      harness,
      identity: { app, agentId },
      // Read once per turn: a mode change applies to the next turn.
      mode: modeFor(agentId),
      model: modelFor(agentId),
      identityFor,
      getHarnessSession: (invocation) => interactionHarnessSession(invocation, { agentId, harness, store: interactionStore }),
      onModels: (models) => onModels?.(agentId, models),
      policy: withReachRules(policy, { keyd: Boolean(keyd) }),
      cwd,
      // Where the soul's own harness install lives when its checkout has none (#417).
      harnessDirs: (() => { try { return harnessDirsFor(agentId) ?? []; } catch { return []; } })(),
      mcpServers,
      env: harnessEnv,
      ...(typeof log === 'function' ? { log } : {}),
    });
    if (typeof onHarnessSession !== 'function') return executor;
    return (input) => executor({
      ...input,
      appendEvent: (type, data) => {
        if (type === HARNESS_SESSION_EVENT) {
          try { onHarnessSession({ agentId, harness, harnessSessionId: data?.harnessSessionId }); } catch { /* best effort */ }
        }
        return input.appendEvent(type, data);
      },
    });
  };
}

// The cold waker's executor: each turn goes down the lane its soul's setting
// picked. A lane the daemon has no executor for fails the turn, which leaves
// the message unacked for a later wake.
export function laneExecutor({ acpTurn = null, resumeTurn = null }) {
  return (input) => {
    if (input.wake?.lane === 'resume') {
      if (!resumeTurn) throw new Error('resume wake is not available in this daemon');
      return resumeTurn({ ...input, policy: input.wake.policy });
    }
    if (!acpTurn) throw new Error('no executor is configured for this daemon');
    return acpTurn(input);
  };
}

// onWake for createCommsSupervisor. `coldWake` is null when the daemon has
// no ACP executor, no resume executor, and no webhook waker, which leaves
// every soul without a warm socket `waiting`.
export function createWakePlane({ isPaused = () => false, pool, settings, lookupSoul, identities, executorFor = null, resumeExecutor = null, webhookWaker = null, relay = null, taskReporter = null, authStatus = null, receipt, turnTimeoutMs, approvals = null, turns = createTurnRegistry() }) {
  const coldWake = executorFor || resumeExecutor || webhookWaker
    ? createColdWaker({
      isPaused,
      executor: laneExecutor({ acpTurn: executorFor ? coldTurnExecutor({ executorFor, turnTimeoutMs, approvals, turns }) : null,
        resumeTurn: resumeExecutor ? (input) => turns.run({ ...input, kind: 'wake' }, resumeExecutor, { turnTimeoutMs }) : null }),
      settings,
      lookupBinding: async (agentId) => lookupSoul(agentId),
      identities: async (agentId) => identities(agentId),
      relay,
      taskReporter,
      webhook: webhookWaker,
      authStatus,
      receipt,
    })
    : null;
  // The dispatcher asks the cold path only when no socket is warm. A cold
  // waker answering `waiting` is the setting being off; pass it through as
  // the dispatcher's own `null` so its detail stays the documented one.
  const cold = coldWake
    ? async (wake) => {
      const result = await coldWake(wake);
      return result.outcome === 'waiting' ? null : result;
    }
    : null;
  // The supervisor hands each wake a report bound to the current pairing.
  // One dispatcher keeps wakes for a soul in order, so it reports through
  // the newest pairing it has seen: a re-pair replaces the credential.
  let currentReport = null;
  const dispatch = createWakeDispatcher({
    pool,
    isPaused,
    coldWake: cold,
    report: (...args) => wakeReporter(currentReport)(...args),
    receipt,
  });
  const onWake = (wake, { report }) => {
    currentReport = report;
    return dispatch(wake);
  };
  onWake.idle = () => coldWake?.idle() ?? Promise.resolve();
  onWake.busy = () => [...new Set([...turns.busy(), ...(coldWake?.busy?.() ?? [])])];
  onWake.stop = turns.stop;
  return onWake;
}
