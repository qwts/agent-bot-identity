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
import { composeTurnEnv } from './turn-env.mjs';

export { composeTurnEnv, createTurnRegistry };

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
// A maintenance caller can supply its cancellation signal and a facts-only
// history ID/kind. Neither creates an interaction-store or broker invocation.
// Its timeout may shorten the host bound, never extend it.
export const DREAM_REPLY_MAX_BYTES = 256 * 1024;

export function coldTurnExecutor({ executorFor, turnTimeoutMs = 30 * 60_000, onEvent = () => {}, approvals = null, turns = createTurnRegistry() }) {
  return async ({ invocation, message, attachments, env, onSession = null, onProcess = null, signal = null, kind = 'wake', historyId = null,
    timeoutMs = turnTimeoutMs, replyByteLimit = kind === 'dream' ? DREAM_REPLY_MAX_BYTES : null }) => {
    signal?.throwIfAborted(); // do not resolve runtime/provider credentials after a caller already cancelled
    if (!['wake', 'dream'].includes(kind)) throw new Error('cold turn kind must be wake or dream');
    if (![timeoutMs, turnTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff)) throw new Error('cold turn timeout must be a positive bounded integer');
    if (replyByteLimit === null ? kind === 'dream' : !Number.isSafeInteger(replyByteLimit) || replyByteLimit < 1 || replyByteLimit > DREAM_REPLY_MAX_BYTES) {
      throw new Error('cold turn reply limit must be a positive integer at most 256 KiB; dreams require a limit');
    }
    const executor = executorFor({ agentId: invocation.agentId, harness: invocation.harness, cwd: invocation.cwd, env });
    let reply = '', replyBytes = 0, replyTruncated = false;
    const denied = [];
    const collect = (type, update) => {
      if (type !== UPDATE_EVENT) return;
      if (update?.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
        const text = update.content.text;
        if (replyByteLimit === null) { reply += text; return; }
        if (replyTruncated) return;
        // A surrogate pair may cross event boundaries: concatenation replaces
        // two three-byte unpaired encodings with one four-byte code point.
        const paired = /[\uD800-\uDBFF]$/.test(reply) && /^[\uDC00-\uDFFF]/.test(text);
        const size = replyBytes + Buffer.byteLength(text) - (paired ? 2 : 0);
        if (size <= replyByteLimit) { reply += text; replyBytes = size; }
        else {
          // Slice before encoding, so even an oversized caller-supplied event
          // cannot allocate an unbounded temporary buffer here.
          const prefix = reply + text.slice(0, replyByteLimit - replyBytes + 3);
          reply = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.from(prefix).subarray(0, replyByteLimit), { stream: true });
          replyBytes = Buffer.byteLength(reply); replyTruncated = true;
        }
      } else if (update?.sessionUpdate === 'tool_call') {
        reply = ''; replyBytes = 0; replyTruncated = false;
      }
    };
    const result = await turns.run({ invocation, kind, ...(signal ? { signal } : {}), ...(historyId === null ? {} : { historyId }) }, async ({ signal, sessionGrants }) => executor({
      sessionGrants,
      invocation,
      message,
      attachments,
      signal,
      ...(onProcess === null ? {} : { onProcess }),
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
    }), { turnTimeoutMs: Math.min(timeoutMs, turnTimeoutMs) });
    return { ...result, reply, denied, ...(replyByteLimit === null ? {} : { replyTruncated }) };
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
    // The turn's executor in the mode this turn runs in.
    const build = (mode) => {
      const executor = createExecutor({
        harness,
        identity: { app, agentId },
        mode,
        model: modelFor(agentId, { harness, cwd }),
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
    // Read once per turn: a mode change applies to the next turn. The turn's
    // harness and cwd select the repo and package layers (#379). A loosening
    // the owner is asked about resolves later; the turn waits for the answer.
    const mode = modeFor(agentId, { harness, cwd });
    if (typeof mode?.then !== 'function') return build(mode);
    return async (input) => build(await mode)(input);
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
