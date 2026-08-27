// ACP drive engine (#144) — the one harness-agnostic way this daemon drives a
// real harness turn. It satisfies the executor port contract (#143) by
// construction: createAcpExecutor wraps createContractExecutor, so every
// invocation gets the contract's identity precondition, event ordering, and
// policy-gated permissions for free, and every per-harness difference stays in
// the spawn registry (acp-registry.mjs).
//
// Shape of a turn, in ACP vocabulary:
//   spawn(registry row) → initialize → session/new | session/load
//     → session/prompt → stream session/update → stopReason
//
// Decisions this module pins:
//   - Transport is newline-delimited JSON-RPC 2.0 over the child's stdio —
//     what claude-code-acp and `opencode acp` both speak (#141 spike).
//   - The daemon's MCP reach-back config is injected via the `mcpServers`
//     param on session/new and session/load from day one, even while the
//     server itself (#146) does not exist; the plumbing is this issue's.
//   - session/load replays the session's history as session/update
//     notifications; the engine drops everything received before the load
//     response resolves so replayed history is never re-recorded as fresh
//     turn events.
//   - Updates stream through the contract's bounded `update` events. Oversized
//     message/thought chunks are truncated to fit the bound; structurally
//     invalid or unknown update kinds are counted and skipped rather than
//     failing the turn — the harness owns its own stream's fidelity, the
//     daemon's log stays well-formed.
//   - session/request_permission maps onto the contract's requestPermission:
//     the policy decides, only an 'approval' outcome escalates to the
//     proposal flow, and the agent's option list is answered with an
//     allow-or-reject option accordingly. The tool name offered to the policy
//     is the ACP tool-call `kind` (execute, read, edit, fetch, ...) unless the
//     harness supplies a more specific name in the tool call's metadata.
//   - Cancellation is cooperative and matches the contract: signal abort
//     sends session/cancel, waits briefly for the harness to wind down, then
//     kills the child; the run rejects so the service records 'cancelled'.
//   - An unknown stop reason fails the turn (the contract's stop vocabulary
//     is ACP's own; a mismatch is a protocol violation, not noise).
//   - Attachments are not driven over ACP yet: the engine refuses an
//     invocation that carries attachments instead of silently dropping them.

import { spawn as spawnChild } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  MAX_UPDATE_BYTES,
  UPDATE_KINDS,
  createContractExecutor,
  validateUpdate,
} from './executor-contract.mjs';
import { ACP_SPAWN_REGISTRY, resolveSpawn } from './acp-registry.mjs';

export const ACP_PROTOCOL_VERSION = 1;
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const CANCEL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 2_048;

function failEngine(message) {
  throw new Error(`acp engine: ${message}`);
}

// --- JSON-RPC 2.0 over ndjson stdio ---------------------------------------

// Minimal client for one child process: outgoing requests and notifications,
// incoming responses, notifications, and agent-initiated requests. Non-JSON
// stdout lines are tolerated (adapters occasionally log around the protocol).
function createRpcChannel(child, { onNotification, onRequest, log }) {
  let nextId = 1;
  const pending = new Map();
  let closed = false;
  let closeError = null;

  const rejectAll = (error) => {
    closeError = error;
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };

  const write = (payload) => {
    if (closed) throw closeError ?? failEngine('agent process is gone');
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const respondError = (id, message) => write({ jsonrpc: '2.0', id, error: { code: -32000, message } });

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      log(`acp engine: ignoring non-protocol stdout line (${line.length} bytes)`);
      return;
    }
    if (payload === null || typeof payload !== 'object') return;
    if (payload.id !== undefined && payload.method === undefined) {
      const entry = pending.get(payload.id);
      if (!entry) return;
      pending.delete(payload.id);
      if (payload.error) {
        entry.reject(new Error(`acp engine: agent error for ${entry.method}: ${payload.error.message ?? 'unknown'}`));
      } else {
        entry.resolve(payload.result);
      }
      return;
    }
    if (typeof payload.method !== 'string') return;
    if (payload.id === undefined) {
      onNotification(payload.method, payload.params ?? {});
      return;
    }
    Promise.resolve()
      .then(() => onRequest(payload.method, payload.params ?? {}))
      .then((result) => { if (!closed) respond(payload.id, result); })
      .catch((error) => { if (!closed) respondError(payload.id, error.message ?? 'request failed'); });
  });

  child.on('close', () => {
    closed = true;
    rejectAll(new Error('acp engine: agent process exited before the turn finished'));
  });
  child.on('error', (error) => {
    closed = true;
    rejectAll(new Error(`acp engine: failed to run agent process: ${error.message}`));
  });

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { method, resolve, reject });
        try {
          write({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method, params) {
      try {
        write({ jsonrpc: '2.0', method, params });
      } catch {
        // A notification to a dead child is moot; the close path reports.
      }
    },
    // Force-fail every pending request. The turn deadline and cancel paths
    // use this so a descendant that survives a kill attempt while holding the
    // inherited stdio pipes open can never hold the run open with it.
    abort(error) {
      closed = true;
      rejectAll(error);
    },
  };
}

// --- update shaping ---------------------------------------------------------

function withinBound(update) {
  return Buffer.byteLength(JSON.stringify(update), 'utf8') <= MAX_UPDATE_BYTES;
}

// Chunk text is truncated to fit the event bound; anything else either fits
// and validates or is skipped. Returns the update to emit, or null to skip.
export function boundAcpUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  const kind = update.sessionUpdate;
  if (!UPDATE_KINDS.includes(kind)) return null;
  let candidate = update;
  if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
    && typeof candidate?.content?.text === 'string' && !withinBound(candidate)) {
    const text = candidate.content.text;
    let keep = Math.max(0, MAX_UPDATE_BYTES - Buffer.byteLength(JSON.stringify({
      ...candidate,
      content: { ...candidate.content, text: '' },
    }), 'utf8') - 64);
    while (keep > 0 && !withinBound({
      ...candidate,
      content: { ...candidate.content, text: `${text.slice(0, keep)}…[truncated]` },
    })) {
      keep = Math.floor(keep / 2);
    }
    if (keep === 0) return null;
    candidate = { ...candidate, content: { ...candidate.content, text: `${text.slice(0, keep)}…[truncated]` } };
  }
  try {
    return validateUpdate(candidate);
  } catch {
    return null;
  }
}

// The policy speaks tool names; ACP permission requests speak tool calls. A
// harness-specific name from the call's metadata wins, the ACP kind is the
// generic fallback, and anything unusable becomes 'other' (which a policy can
// still target — and the contract denies malformed names regardless).
export function permissionToolName(toolCall) {
  const meta = toolCall?._meta ?? toolCall?.meta ?? {};
  for (const candidate of [meta.toolName, meta['claudecode/toolName'], toolCall?.kind]) {
    if (typeof candidate === 'string' && candidate.length > 0 && !/\s/.test(candidate)) {
      return candidate.slice(0, 200);
    }
  }
  return 'other';
}

function pickOption(options, allowed) {
  const rows = Array.isArray(options) ? options : [];
  const prefix = allowed ? 'allow' : 'reject';
  const preferred = rows.find((row) => row?.kind === `${prefix}_once`)
    ?? rows.find((row) => typeof row?.kind === 'string' && row.kind.startsWith(prefix));
  return preferred?.optionId ?? null;
}

// --- the executor -----------------------------------------------------------

// createAcpExecutor returns a contract executor whose run drives one ACP turn.
// `registry` defaults to the shipped spawn registry; tests and future planes
// substitute rows without touching engine code. `getHarnessSession` lets the
// daemon resume an existing harness session: it receives the invocation and
// returns { harnessSessionId } (or null for a fresh session).
export function createAcpExecutor({
  harness,
  identity,
  policy,
  registry = ACP_SPAWN_REGISTRY,
  cwd = process.cwd(),
  mcpServers = [],
  getHarnessSession = null,
  env: baseEnv = process.env,
  spawn = spawnChild,
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const row = resolveSpawn(registry, harness);
  if (!Array.isArray(mcpServers)) failEngine('mcpServers must be an array');
  if (getHarnessSession !== null && typeof getHarnessSession !== 'function') {
    failEngine('getHarnessSession must be a function when provided');
  }
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0) {
    failEngine('turnTimeoutMs must be a positive integer');
  }
  if (baseEnv === null || typeof baseEnv !== 'object' || Array.isArray(baseEnv)) {
    failEngine('env must be an object of environment variables');
  }
  if (typeof spawn !== 'function') failEngine('spawn must be a function');
  if (typeof log !== 'function') failEngine('log must be a function');

  const run = async ({
    invocation, message, attachments, signal,
    bindHarnessSession, emitUpdate, emitStop, requestPermission,
  }) => {
    if (Array.isArray(attachments) && attachments.length > 0) {
      failEngine('attachments are not driven over ACP yet; retry without attachments');
    }

    const env = { ...baseEnv };
    for (const name of row.stripEnv) delete env[name];

    // detached puts the agent in its own process group, so killTree can take
    // down the whole tree — spawn-runner rows like npx launch the actual
    // adapter as a descendant, and signaling only the direct child would leak
    // it (still holding the inherited stdio pipes) past the turn.
    const child = spawn(row.command, [...row.args], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    const killTree = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    };
    let stderrTail = '';
    child.stderr.on('data', (data) => {
      stderrTail = (stderrTail + data.toString()).slice(-STDERR_TAIL_BYTES);
    });

    let sessionId = null;
    let replaying = false;
    let skippedUpdates = 0;
    let streamError = null;

    const rpc = createRpcChannel(child, {
      log,
      onNotification: (method, params) => {
        if (method !== 'session/update' || replaying) return;
        if (sessionId === null || params.sessionId !== sessionId) return;
        const bounded = boundAcpUpdate(params.update);
        if (bounded === null) {
          skippedUpdates += 1;
          return;
        }
        try {
          emitUpdate(bounded);
        } catch (error) {
          // A contract refusal mid-stream fails the turn; remember the first.
          streamError = streamError ?? error;
        }
      },
      onRequest: async (method, params) => {
        if (method === 'session/request_permission') {
          if (signal.aborted) return { outcome: { outcome: 'cancelled' } };
          const toolCall = params.toolCall ?? {};
          const decision = await requestPermission({
            toolName: permissionToolName(toolCall),
            summary: typeof toolCall.title === 'string' ? toolCall.title : null,
          });
          const optionId = pickOption(params.options, decision.outcome === 'allow');
          if (optionId === null) return { outcome: { outcome: 'cancelled' } };
          return { outcome: { outcome: 'selected', optionId } };
        }
        // The daemon offers no filesystem or terminal to the agent process.
        throw new Error(`method not supported by this client: ${method}`);
      },
    });

    let cancelTimer = null;
    const onAbort = () => {
      if (sessionId !== null) rpc.notify('session/cancel', { sessionId });
      cancelTimer = setTimeout(() => {
        rpc.abort(new Error('acp engine: turn aborted'));
        killTree();
      }, CANCEL_GRACE_MS);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const turnTimer = setTimeout(() => {
      const deadline = new Error(`acp engine: turn exceeded ${turnTimeoutMs}ms`);
      streamError = streamError ?? deadline;
      rpc.abort(deadline);
      killTree();
    }, turnTimeoutMs);

    try {
      await rpc.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      const prior = getHarnessSession === null ? null : await getHarnessSession(invocation);
      if (prior && typeof prior.harnessSessionId === 'string') {
        sessionId = prior.harnessSessionId;
        replaying = true;
        try {
          await rpc.request('session/load', { sessionId, cwd, mcpServers: [...mcpServers] });
        } finally {
          replaying = false;
        }
        bindHarnessSession({ mode: 'resume', harnessSessionId: sessionId });
      } else {
        const created = await rpc.request('session/new', { cwd, mcpServers: [...mcpServers] });
        if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
          failEngine('agent returned no sessionId for session/new');
        }
        sessionId = created.sessionId;
        bindHarnessSession({ mode: 'new', harnessSessionId: sessionId });
      }

      const result = await rpc.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: message }],
      });
      if (streamError) throw streamError;
      if (signal.aborted) throw new Error('acp engine: turn aborted');
      if (skippedUpdates > 0) {
        log(`acp engine: skipped ${skippedUpdates} update(s) outside the contract vocabulary or bound`);
      }
      emitStop({ stopReason: result?.stopReason });
    } catch (error) {
      if (streamError && error !== streamError) throw streamError;
      if (stderrTail.length > 0) {
        throw new Error(`${error.message} [agent stderr tail: ${stderrTail.trim().slice(-512)}]`);
      }
      throw error;
    } finally {
      clearTimeout(turnTimer);
      if (cancelTimer !== null) clearTimeout(cancelTimer);
      signal.removeEventListener('abort', onAbort);
      killTree();
    }
  };

  return createContractExecutor({ harness, identity, policy, run });
}
