// The daemon's wake plane (agent-comms ADR-0008 decisions 7 to 9), assembled
// from its parts: the comms supervisor's `account-watch` stream hands each
// wake to the dispatcher (#256), which delivers it to a warm socket in the
// pool (#147) or, when the owner turned cold wake on for that soul, to the
// cold waker (#259), and reports the outcome back to the broker.
//
// Every part stays a port so the composition is testable without a broker,
// a socket, or a harness.

import { createAcpExecutor } from './acp-engine.mjs';
import { createColdWaker } from './cold-wake.mjs';
import { UPDATE_EVENT } from './executor-contract.mjs';
import { createWakeDispatcher } from './wake-dispatch.mjs';

// The broker port the dispatcher wants, over the supervisor's report.
export function wakeReporter(report) {
  return (agentId, messageIds, outcome, detail) => report({ agentId, messageIds, outcome, detail: detail ?? '' });
}

// A cold turn has no principal watching it, so nothing may escalate to an
// approval: whatever the policy does not allow outright is denied. The turn
// resolves with its `reply`: the agent's message text after its last tool
// call, which the cold waker's relay sends back.
export function coldTurnExecutor({ executorFor, turnTimeoutMs = 30 * 60_000, onEvent = () => {} }) {
  return async ({ invocation, message, attachments, env }) => {
    const executor = executorFor({ agentId: invocation.agentId, harness: invocation.harness, cwd: invocation.cwd, env });
    const signal = AbortSignal.timeout(turnTimeoutMs);
    let reply = '';
    const collect = (type, update) => {
      if (type !== UPDATE_EVENT) return;
      if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') reply += update.content.text;
      else if (update?.sessionUpdate === 'tool_call') reply = '';
    };
    const result = await executor({
      invocation,
      message,
      attachments,
      signal,
      appendEvent: (type, data) => { collect(type, data); onEvent(type); return { type }; },
      addArtifact: () => { throw new Error('a cold turn has no artifact store'); },
      requestApproval: async () => ({ decision: 'deny' }),
    });
    return { ...result, reply };
  };
}

// The production executor factory: one ACP turn under the soul's own
// identity, in its worktree, with its binding in the environment.
export function acpExecutorFor({ identities, policy, baseEnv }) {
  return ({ agentId, harness, cwd, env }) => {
    const identity = identities(agentId);
    // A soul without the github-identity add-on runs with no App (#297).
    const app = identity?.github?.appSlug ?? null;
    return createAcpExecutor({
      harness,
      identity: { app, agentId },
      policy,
      cwd,
      env: { ...baseEnv, ...env, QWTS_AGENT_ID: agentId, AGENT_BOT_ID: agentId },
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
// neither the ACP executor nor the resume executor, which leaves every soul
// without a warm socket `waiting`.
export function createWakePlane({ pool, settings, lookupSoul, identities, executorFor = null, resumeExecutor = null, relay = null, receipt, turnTimeoutMs }) {
  const coldWake = executorFor || resumeExecutor
    ? createColdWaker({
      executor: laneExecutor({ acpTurn: executorFor ? coldTurnExecutor({ executorFor, turnTimeoutMs }) : null, resumeTurn: resumeExecutor }),
      settings,
      lookupBinding: async (agentId) => lookupSoul(agentId),
      identities: async (agentId) => identities(agentId),
      relay,
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
    coldWake: cold,
    report: (...args) => wakeReporter(currentReport)(...args),
    receipt,
  });
  const onWake = (wake, { report }) => {
    currentReport = report;
    return dispatch(wake);
  };
  onWake.idle = () => coldWake?.idle() ?? Promise.resolve();
  return onWake;
}
