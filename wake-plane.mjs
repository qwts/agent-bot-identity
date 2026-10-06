// The daemon's wake plane (agent-comms ADR-0008 decisions 7 to 9), assembled
// from its parts: the comms supervisor's `account-watch` stream hands each
// wake to the dispatcher (#256), which delivers it to a warm socket in the
// pool (#147) or, when the owner turned cold wake on for that soul, to the
// cold waker (#259), and reports the outcome back to the broker.
//
// Every part stays a port so the composition is testable without a broker,
// a socket, or a harness.

import path from 'node:path';
import { createSessionGrants } from './session-approvals.mjs';
import { assertSoulUnpaused } from './agent-population.mjs';

import { createAcpExecutor } from './acp-engine.mjs';
import { validateInvocationId } from './agent-jobs.mjs';
import { createColdWaker } from './cold-wake.mjs';
import { reachMcpServerEntry, reachPolicyRules } from './daemon-mcp.mjs';
import { HARNESS_SESSION_EVENT, UPDATE_EVENT } from './executor-contract.mjs';
import { keydMcpServerEntry, keydPolicyRules } from './keyd-client.mjs';
import { createWakeDispatcher } from './wake-dispatch.mjs';

// Shared by cold, launch and interactive turns. Keep each controller until
// its executor settles: abort requests cancellation, it does not prove exit.
// A soul may have overlapping interactive sessions; stop reaches every turn.
export function createTurnRegistry({ isPaused = () => false } = {}) {
  const active = new Map();
  const sessionGrants = createSessionGrants();
  const track = (agentId, controller) => {
    const turns = active.get(agentId) ?? new Set();
    active.set(agentId, turns);
    turns.add(controller);
    return () => {
      turns.delete(controller);
      if (!turns.size) active.delete(agentId);
    };
  };
  return {
    track,
    sessionGrants,
    busy: () => [...active.keys()],
    stop(agentId) {
      sessionGrants.clear(agentId);
      let stopped = false;
      for (const controller of active.get(agentId) ?? []) {
        if (!controller.signal.aborted) { controller.abort(); stopped = true; }
      }
      return stopped;
    },
    async run(input, executor, { turnTimeoutMs = 30 * 60_000 } = {}) {
      assertSoulUnpaused(isPaused(input.invocation.agentId));
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(turnTimeoutMs), ...(input.signal ? [input.signal] : [])]);
      const release = track(input.invocation.agentId, controller);
      try {
        signal.throwIfAborted();
        const result = await executor({ ...input, signal, sessionGrants });
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (signal.aborted) throw new DOMException('turn cancelled', 'AbortError');
        throw error;
      } finally {
        release();
      }
    },
  };
}

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
    const result = await turns.run({ invocation }, async ({ signal, sessionGrants }) => executor({
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
// dropped.
export function acpExecutorFor({
  identities, policy, baseEnv, onHarnessSession = null, createExecutor = createAcpExecutor,
  identityFor = null,
  commsFor = () => true, modeFor = () => 'safe', modelFor = () => null, onModels = null, reachEnv = {}, keydFor = () => null, harnessDirsFor = () => [], log = null,
}) {
  return ({ agentId, harness, cwd, env }) => {
    const identity = identities(agentId);
    // A soul without the github-identity add-on runs with no App (#297).
    const app = identity?.github?.appSlug ?? null;
    const turnEnv = { ...baseEnv, ...env, QWTS_AGENT_ID: agentId, AGENT_BOT_ID: agentId };
    let comms = true;
    try { comms = commsFor(agentId) !== false; } catch { /* no recorded setting: the default */ }
    let keyd = null;
    try { keyd = app ? keydFor(agentId) : null; } catch { /* no keyd: the #395 stores */ }
    const binding = typeof turnEnv.AGENT_BOT_BINDING === 'string' && path.isAbsolute(turnEnv.AGENT_BOT_BINDING)
      ? turnEnv.AGENT_BOT_BINDING : null;
    const mcpServers = ({ invocation }) => [reachMcpServerEntry({
      invocationId: storeInvocationId(invocation),
      agentId,
      env: { ...turnEnv, ...reachEnv },
      worktree: typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null,
      binding,
      comms,
      correlation: typeof invocation?.correlation === 'string' ? invocation.correlation : null,
      turnId: typeof invocation?.turnId === 'string' ? invocation.turnId : null,
    }), ...(keyd ? [keydMcpServerEntry({ bin: keyd, binding, env: turnEnv })] : [])];
    const executor = createExecutor({
      harness,
      identity: { app, agentId },
      // Read once per turn: a mode change applies to the next turn.
      mode: modeFor(agentId),
      model: modelFor(agentId),
      identityFor,
      onModels: (models) => onModels?.(agentId, models),
      policy: withReachRules(policy, { keyd: Boolean(keyd) }),
      cwd,
      // Where the soul's own harness install lives when its checkout has none (#417).
      harnessDirs: (() => { try { return harnessDirsFor(agentId) ?? []; } catch { return []; } })(),
      mcpServers,
      env: turnEnv,
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
        resumeTurn: resumeExecutor ? (input) => turns.run(input, resumeExecutor, { turnTimeoutMs }) : null }),
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
