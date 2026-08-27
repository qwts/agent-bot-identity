#!/usr/bin/env node

// Executor port contract (#143, epic #142). The decision record for the shape
// of every harness executor, and the fail-closed assembly that enforces it.
//
// agent-interaction.mjs defines WHERE executors plug in: `executor({
// invocation, message, attachments, appendEvent, addArtifact,
// requestApproval, signal })`, with a deliberate unconfigured default that
// refuses every invocation. This module defines WHAT a real executor must
// look like, so the ACP drive engine, muse-acp, and every later adapter
// (#144, #145) implement one reviewed contract instead of re-deciding these
// questions per harness. Nothing here spawns a process or speaks a protocol;
// the daemon's default behavior is unchanged and the
// `no executor is configured for this daemon` refusal stands until an engine
// is wired in explicitly.
//
// The five decisions, from the spike evidence in #141:
//
// 1. Invocation ↔ harness-session binding. A daemon session (session_<uuid>)
//    maps to at most one harness session at a time. The executor reports the
//    binding it used — `new`, `resume`, or `fork`, plus the harness's own
//    opaque session id — as a `harness-session` event on the invocation. The
//    event log is the durable record: the authoritative binding of an
//    invocation is its latest `harness-session` event, and an engine that
//    wants continuity resumes the id recorded by the daemon session's most
//    recent invocation. No new store schema; the events stream (#56 req 3)
//    already carries it.
//
// 2. Turn model. One invocation is one turn: message in, streamed progress
//    out, one terminal stop. Progress uses ACP's `session/update` vocabulary
//    (#141 proved it is expressible from every harness we drive) recorded as
//    `update` events; the turn ends with a `stop` event carrying an ACP stop
//    reason. Cancellation stays cooperative exactly as agent-interaction.mjs
//    implements it: the AbortSignal fires, the engine stops, the invocation
//    lands on `cancelled` only when execution actually stopped.
//
// 3. Permissions are policy, never conversation. An executor answers a
//    harness's "may I run this tool?" from a pre-declared, validated policy.
//    The only escalation path is the daemon's immutable approval capability
//    (#59 req 8): a rule (or the fallback) that says `approval` parks the
//    invocation behind a digest-bound proposal. A conversational "yes" still
//    has no pathway to authorize anything.
//
// 4. Identity is a construction precondition. An executor exists only for a
//    specific harness key and bot identity — the `agentBot.app` slug and
//    `agentBot.agentId` this repo pins per worktree. Missing or malformed
//    identity fails construction, not the Nth invocation: a daemon can never
//    hold a half-bound executor. Fail closed, never fall back to a human
//    identity.
//
// 5. Attachments stay opaque references (#55): bounded printable strings the
//    executor resolves inside the soul's Agent Space boundary. The contract
//    re-exports the shape so engines validate references they pass onward.

import { validateAgentId } from './agent-identity.mjs';

export const EXECUTOR_CONTRACT_VERSION = 1;

// --- shared bounds -------------------------------------------------------

// Matches the job store's per-event data cap so a contract-valid update can
// never be refused by appendEvent after the fact.
export const MAX_UPDATE_BYTES = 8 * 1024;
export const MAX_HARNESS_SESSION_ID_LENGTH = 256;
const MAX_TOOL_NAME_LENGTH = 200;
const MAX_POLICY_RULES = 256;
const MAX_SUMMARY_LENGTH = 512;

// Harness keys are the config vocabulary from config.mjs ('claude', 'codex',
// 'muse', ...): short lowercase slugs.
const HARNESS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// App slugs like 'qwts-claude-agent' — same alphabet, longer bound.
const APP_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
// Visible ASCII, no whitespace: tool names as harnesses report them
// ('Bash', 'mcp__daemon__post_reply').
const TOOL_NAME_PATTERN = /^[\x21-\x7e]{1,200}$/;

function fail(message) {
  throw new Error(message);
}

function printableBounded(value, max) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= max
    // eslint-disable-next-line no-control-regex -- control characters are the thing being rejected
    && !/[\x00-\x1f\x7f]/.test(value)
  );
}

// --- 1. invocation ↔ harness-session binding -----------------------------

export const HARNESS_SESSION_EVENT = 'harness-session';
export const BINDING_MODES = Object.freeze(['new', 'resume', 'fork']);

export function validateHarnessBinding({ harness, mode, harnessSessionId } = {}) {
  if (typeof harness !== 'string' || !HARNESS_PATTERN.test(harness)) {
    fail('harness must be a short lowercase slug');
  }
  if (!BINDING_MODES.includes(mode)) {
    fail(`binding mode must be one of: ${BINDING_MODES.join(', ')}`);
  }
  if (!printableBounded(harnessSessionId, MAX_HARNESS_SESSION_ID_LENGTH)) {
    fail('harnessSessionId must be a bounded opaque printable string');
  }
  return Object.freeze({ harness, mode, harnessSessionId });
}

// --- 2. turn model: updates and stop -------------------------------------

export const UPDATE_EVENT = 'update';
export const STOP_EVENT = 'stop';

// The ACP session/update kinds an executor reports. `user_message_chunk` is
// deliberately absent: the daemon already holds the user's message and never
// needs a harness echo of it.
export const UPDATE_KINDS = Object.freeze([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
]);

// ACP stop reasons, plus nothing: a turn that ends outside this vocabulary is
// a failed invocation, not a new reason.
export const STOP_REASONS = Object.freeze([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

// Structural validation only: the vocabulary is ACP's, and harness adapters
// own the fidelity of what goes inside `content`/`fields`. What the contract
// pins is the discriminator, the per-kind required fields, and the size
// bound the job store will enforce anyway.
export function validateUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    fail('update must be an object');
  }
  const kind = update.sessionUpdate;
  if (!UPDATE_KINDS.includes(kind)) {
    fail(`sessionUpdate must be one of: ${UPDATE_KINDS.join(', ')}`);
  }
  if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
    && (!update.content || typeof update.content !== 'object')) {
    fail(`${kind} requires a content object`);
  }
  if (kind === 'tool_call' && !printableBounded(update.toolCallId, 128)) {
    fail('tool_call requires a bounded toolCallId');
  }
  if (kind === 'tool_call_update') {
    if (!printableBounded(update.toolCallId, 128)) {
      fail('tool_call_update requires a bounded toolCallId');
    }
    if (Object.keys(update).length < 3) {
      fail('tool_call_update must carry at least one changed field');
    }
  }
  if (kind === 'plan' && !Array.isArray(update.entries)) {
    fail('plan requires an entries array');
  }
  let serialized;
  try {
    serialized = JSON.stringify(update);
  } catch {
    fail('update must be JSON-serializable');
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_UPDATE_BYTES) {
    fail('update exceeds the bounded event size');
  }
  return update;
}

export function validateStop({ stopReason } = {}) {
  if (!STOP_REASONS.includes(stopReason)) {
    fail(`stopReason must be one of: ${STOP_REASONS.join(', ')}`);
  }
  return Object.freeze({ stopReason });
}

// --- 3. permission policy -------------------------------------------------

export const PERMISSION_OUTCOMES = Object.freeze(['allow', 'deny', 'approval']);

// A rule's `tool` is an exact tool name or a prefix wildcard
// ('mcp__daemon__*'). First matching rule wins; no match falls through to
// `fallback`. The safe default policy is no rules and fallback 'deny'.
export function validatePermissionPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('permission policy must be an object');
  }
  if (policy.version !== 1) fail('permission policy version must be 1');
  if (!Array.isArray(policy.rules) || policy.rules.length > MAX_POLICY_RULES) {
    fail('permission policy rules must be a bounded array');
  }
  for (const rule of policy.rules) {
    if (!rule || typeof rule !== 'object') fail('permission rule must be an object');
    const { tool, outcome } = rule;
    if (typeof tool !== 'string' || tool.length === 0 || tool.length > MAX_TOOL_NAME_LENGTH) {
      fail('permission rule tool must be a bounded string');
    }
    const literal = tool.endsWith('*') ? tool.slice(0, -1) : tool;
    if (literal.length > 0 && !TOOL_NAME_PATTERN.test(literal)) {
      fail('permission rule tool must be visible ASCII, optionally ending in *');
    }
    if (!PERMISSION_OUTCOMES.includes(outcome)) {
      fail(`permission rule outcome must be one of: ${PERMISSION_OUTCOMES.join(', ')}`);
    }
  }
  if (!PERMISSION_OUTCOMES.includes(policy.fallback)) {
    fail(`permission policy fallback must be one of: ${PERMISSION_OUTCOMES.join(', ')}`);
  }
  return policy;
}

// Pure and total over requests: a malformed request is denied, never thrown
// on, so a hostile or buggy harness cannot crash the executor by asking a
// strange question. The policy itself is assumed validated at construction.
export function decidePermission(policy, { toolName } = {}) {
  if (!TOOL_NAME_PATTERN.test(typeof toolName === 'string' ? toolName : '')) {
    return 'deny';
  }
  for (const rule of policy.rules) {
    if (rule.tool.endsWith('*')
      ? toolName.startsWith(rule.tool.slice(0, -1))
      : toolName === rule.tool) {
      return rule.outcome;
    }
  }
  return policy.fallback;
}

// --- 4. identity binding --------------------------------------------------

export function validateExecutorIdentity({ app, agentId } = {}) {
  if (typeof app !== 'string' || !APP_SLUG_PATTERN.test(app)) {
    fail('executor identity requires the agentBot.app slug');
  }
  let id;
  try {
    id = validateAgentId(agentId);
  } catch {
    fail('executor identity requires a valid agentBot.agentId');
  }
  return Object.freeze({ app, agentId: id });
}

// --- 5. attachment references ---------------------------------------------

// Opaque references, resolved by the executor inside the soul's Agent Space
// boundary; same bound agent-interaction.mjs accepts. Never bytes, never
// filesystem paths.
export const MAX_ATTACHMENT_REF_LENGTH = 256;

export function validateAttachmentReference(reference) {
  if (!printableBounded(reference, MAX_ATTACHMENT_REF_LENGTH)) {
    fail('attachment reference must be a bounded opaque printable string');
  }
  return reference;
}

// --- assembly -------------------------------------------------------------

// Builds an executor the daemon can inject. Everything identity- and
// policy-shaped is validated HERE, at construction: a daemon process either
// holds a fully bound executor or none at all, and the unconfigured default
// keeps refusing. `run` receives the raw port fields plus the contract
// toolkit and owns the actual engine work (out of scope until #144).
//
// A conforming `run`:
//   - records its binding with bindHarnessSession before the first update,
//   - streams progress through emitUpdate,
//   - asks requestPermission before privileged tool use and honors 'deny',
//   - ends a surviving turn with emitStop (engines that die mid-turn land on
//     'failed' through the service's own handling),
//   - treats `signal` abort as the instruction to stop promptly.
export function createContractExecutor({ harness, identity, policy, run } = {}) {
  if (typeof harness !== 'string' || !HARNESS_PATTERN.test(harness)) {
    fail('executor requires a harness key');
  }
  const boundIdentity = validateExecutorIdentity(identity ?? {});
  const boundPolicy = validatePermissionPolicy(policy ?? {});
  if (typeof run !== 'function') fail('executor requires a run function');

  return async function contractExecutor({
    invocation,
    message,
    attachments,
    appendEvent,
    addArtifact,
    requestApproval,
    signal,
  }) {
    if (!invocation || typeof appendEvent !== 'function'
      || typeof addArtifact !== 'function' || typeof requestApproval !== 'function'
      || !signal || typeof signal.aborted !== 'boolean') {
      fail('executor port is missing required capabilities');
    }

    const bindHarnessSession = ({ mode, harnessSessionId } = {}) => {
      const binding = validateHarnessBinding({ harness, mode, harnessSessionId });
      appendEvent(HARNESS_SESSION_EVENT, binding);
      return binding;
    };

    const emitUpdate = (update) => appendEvent(UPDATE_EVENT, validateUpdate(update));

    const emitStop = ({ stopReason } = {}) => appendEvent(STOP_EVENT, validateStop({ stopReason }));

    // Policy answers first; only an 'approval' outcome reaches the immutable
    // proposal flow, and its decision maps back to allow/deny. `decidedBy`
    // lets engines and audits distinguish the two paths.
    const requestPermission = async ({ toolName, operation = null, summary = null, ttlMs } = {}) => {
      const outcome = decidePermission(boundPolicy, { toolName });
      if (outcome !== 'approval') return { outcome, decidedBy: 'policy' };
      const wantedSummary = typeof summary === 'string' && summary.length > 0
        ? summary.slice(0, MAX_SUMMARY_LENGTH)
        : `permission: ${toolName}`;
      const decision = await requestApproval({
        operation: operation ?? { permission: { toolName } },
        summary: wantedSummary,
        ...(ttlMs === undefined ? {} : { ttlMs }),
      });
      return {
        outcome: decision.decision === 'approve' ? 'allow' : 'deny',
        decidedBy: 'approval',
        ...(decision.expired ? { expired: true } : {}),
        ...(decision.cancelled ? { cancelled: true } : {}),
      };
    };

    return run({
      invocation,
      message,
      attachments,
      identity: boundIdentity,
      harness,
      signal,
      appendEvent,
      addArtifact,
      bindHarnessSession,
      emitUpdate,
      emitStop,
      requestPermission,
    });
  };
}
