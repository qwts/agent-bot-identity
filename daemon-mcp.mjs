#!/usr/bin/env node

// Daemon reach-back MCP server (#146): the one channel a daemon-driven
// harness session has back to the adapter thread that woke it. Spoken over
// newline-delimited JSON-RPC on stdio so every MCP-capable harness mounts the
// same server, in either of two placements:
//
//   injected   — the drive engine stamps `reachMcpServerEntry(...)` into
//                `session/new` mcpServers[] for every daemon-driven session,
//                with the invocation id and identity in the entry's env.
//   registered — a live desktop harness config runs `agent-bot reach-mcp`
//                from a configured worktree; identity comes from the worktree
//                git config and tools address invocations explicitly. This is
//                the ONLY lane for Cursor and VS Code/Copilot, which have no
//                drive plane.
//
// The server writes to the interaction store directly (appendEvent takes a
// cross-process lock), so it works whether or not the daemon that spawned the
// session is still the same process. Trust boundary: the store is 0600 files
// under the same user — this server authenticates placement (env stamped by
// the engine, or a worktree the user configured), not the calling process.

import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path, { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  appendEvent,
  getInvocation,
  listInvocations,
  readEvents,
  readInvocationPayload,
  validateInvocationId,
} from './agent-jobs.mjs';
import { populationFile, showSoul } from './agent-population.mjs';
import { validateAgentId } from './agent-identity.mjs';
import { detectAgentHarness } from './detect-harness.mjs';
import { AGENT_ID_KEYS, readGitConfig } from './resolve-agent.mjs';

const PROTOCOL_VERSION = '2025-06-18';

// Environment contract for the injected placement. The engine's factory
// stamps these into the mcpServers[] entry; the registered placement has
// neither and falls back to worktree git config plus explicit arguments.
export const REACH_INVOCATION_ENV = 'AGENT_BOT_REACH_INVOCATION';
export const REACH_AGENT_ID_ENV = 'AGENT_BOT_REACH_AGENT_ID';

// Store-location variables forwarded into the injected entry so the spawned
// server resolves the same interaction store even under a harness that does
// not merge the parent environment.
const STORE_ENV_PASSTHROUGH = [
  'AGENT_BOT_INTERACTION_HOME',
  'AGENT_BOT_POPULATION_PATH',
  'XDG_STATE_HOME',
  'HOME',
];

// A reply event must fit the store's 8 KiB event-data bound with the
// identity stamp and JSON envelope; status notes stay chat-sized.
export const MAX_REPLY_TEXT_BYTES = 6 * 1024;
export const MAX_STATUS_NOTE_BYTES = 1024;

// fetch_context thread history bounds: enough to reconstruct a conversation,
// small enough that the result never balloons a session's context window.
const THREAD_HISTORY_LIMIT = 10;
const THREAD_TEXT_LIMIT = 2048;

function serverVersion() {
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

const TOOLS = [
  {
    name: 'fetch_context',
    description:
      'Fetch the context of the invocation this session was driven for: the '
      + 'inbound message, attachment references (space:// refs resolved to '
      + 'paths when possible), and the bounded thread history of the '
      + 'originating adapter session. Call this first.',
    inputSchema: {
      type: 'object',
      properties: {
        invocation_id: {
          type: 'string',
          description: 'invocation to fetch; defaults to the injected AGENT_BOT_REACH_INVOCATION',
        },
      },
    },
  },
  {
    name: 'post_reply',
    description:
      'Deliver this session\'s answer to the adapter thread that originated '
      + 'the invocation. The reply lands as a durable event the adapter '
      + 'relays to its surface; post exactly one final reply per invocation.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the answer, plain text, at most 6 KiB' },
        invocation_id: {
          type: 'string',
          description: 'invocation to reply to; defaults to the injected AGENT_BOT_REACH_INVOCATION',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'report_status',
    description:
      'Report interim progress to the originating adapter thread while the '
      + 'work is still running. Short note, not the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'short progress note, at most 1 KiB' },
        invocation_id: {
          type: 'string',
          description: 'invocation to report on; defaults to the injected AGENT_BOT_REACH_INVOCATION',
        },
      },
      required: ['note'],
    },
  },
  {
    name: 'clock_in',
    description:
      'Identity heartbeat: report which agent soul is at the keyboard. With '
      + 'an invocation in scope the clock-in is a durable event on its '
      + 'stream; without one (registered placement, idle session) it is an '
      + 'ephemeral identity report.',
    inputSchema: {
      type: 'object',
      properties: {
        invocation_id: {
          type: 'string',
          description: 'invocation to clock in on; optional in the registered placement',
        },
      },
    },
  },
];

export function createReachState({
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  now = () => new Date(),
} = {}) {
  return { env, home, cwd, now };
}

function storeOptions(state) {
  return { env: state.env, home: state.home };
}

// Identity resolution order is the placement order: the injected entry stamps
// the identity explicitly; a registered server inherits the identity of the
// worktree it was configured to run from. No identity means no writes.
export function resolveReachIdentity(state) {
  const stamped = state.env[REACH_AGENT_ID_ENV];
  if (typeof stamped === 'string' && stamped !== '') {
    return { agentId: validateAgentId(stamped), placement: 'injected' };
  }
  const pinned = readGitConfig(state.cwd, AGENT_ID_KEYS);
  if (pinned) return { agentId: validateAgentId(pinned), placement: 'registered' };
  return null;
}

// Every invocation-scoped tool runs the same gate: the invocation must exist
// and must belong to the identity this server speaks for. A mismatch fails
// closed — a registered server in the wrong worktree must not be able to
// write into another soul's thread.
function requireInvocation(state, args, { identity }) {
  const raw = typeof args.invocation_id === 'string' && args.invocation_id !== ''
    ? args.invocation_id
    : state.env[REACH_INVOCATION_ENV];
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(
      'no invocation in scope — pass invocation_id (registered placement) or '
      + `run with ${REACH_INVOCATION_ENV} set (injected placement)`,
    );
  }
  const invocation = getInvocation(validateInvocationId(raw), storeOptions(state));
  if (!invocation) throw new Error('unknown invocation');
  if (identity === null) {
    throw new Error(
      'no reach-back identity — set '
      + `${REACH_AGENT_ID_ENV} or run from a worktree with agentBot.agentId configured`,
    );
  }
  if (invocation.agentId !== identity.agentId) {
    throw new Error('invocation belongs to a different agent identity');
  }
  return invocation;
}

function truncate(text, limit) {
  if (typeof text !== 'string') return null;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function lastReplyText(invocationId, options) {
  const replies = readEvents(invocationId, {}, options)
    .filter((event) => event.type === 'reply');
  if (replies.length === 0) return null;
  return truncate(replies[replies.length - 1].data.text, THREAD_TEXT_LIMIT);
}

// Best-effort resolution of #143's opaque `space://` attachment references
// against the soul's Agent Space, with the same containment discipline as
// the interaction service's resolveArtifact. Anything else stays opaque, and
// resolution failure never fails fetch_context — the ref is still returned.
function resolveAttachment(reference, soul) {
  const resolved = { ref: reference, path: null };
  if (!soul || !reference.startsWith('space://')) return resolved;
  const relative = reference.slice('space://'.length);
  if (
    relative === '' || path.isAbsolute(relative) || relative.includes('\\')
    || relative.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return resolved;
  }
  try {
    const root = realpathSync(path.resolve(soul.spacePath));
    const candidate = realpathSync(path.resolve(root, relative));
    if (candidate === root || candidate.startsWith(root + path.sep)) {
      resolved.path = candidate;
    }
  } catch {
    /* missing file or space — the ref stays opaque */
  }
  return resolved;
}

async function callTool(state, name, args = {}) {
  const identity = resolveReachIdentity(state);
  const options = storeOptions(state);
  switch (name) {
    case 'fetch_context': {
      const invocation = requireInvocation(state, args, { identity });
      const payload = readInvocationPayload(invocation.invocationId, options);
      let soul = null;
      try {
        soul = showSoul(invocation.agentId, { file: populationFile(options) });
      } catch {
        /* no census record — attachments stay opaque */
      }
      const thread = listInvocations({ sessionId: invocation.sessionId }, options)
        .filter((entry) => entry.invocationId !== invocation.invocationId)
        .slice(-THREAD_HISTORY_LIMIT)
        .map((entry) => ({
          invocationId: entry.invocationId,
          status: entry.status,
          createdAt: entry.createdAt,
          message: truncate(
            readInvocationPayload(entry.invocationId, options)?.message ?? null,
            THREAD_TEXT_LIMIT,
          ),
          reply: lastReplyText(entry.invocationId, options),
        }));
      return {
        invocation: {
          invocationId: invocation.invocationId,
          sessionId: invocation.sessionId,
          agentId: invocation.agentId,
          status: invocation.status,
          createdAt: invocation.createdAt,
        },
        message: payload?.message ?? null,
        attachments: (payload?.attachments ?? []).map((ref) => resolveAttachment(ref, soul)),
        thread,
      };
    }
    case 'post_reply': {
      const invocation = requireInvocation(state, args, { identity });
      if (
        typeof args.text !== 'string' || args.text.length === 0
        || Buffer.byteLength(args.text, 'utf8') > MAX_REPLY_TEXT_BYTES
      ) {
        throw new Error(`reply text must be a non-empty string of at most ${MAX_REPLY_TEXT_BYTES} bytes`);
      }
      const event = appendEvent(invocation.invocationId, 'reply', {
        agentId: identity.agentId,
        text: args.text,
      }, { ...options, now: state.now });
      return { delivered: true, invocationId: invocation.invocationId, seq: event.seq, at: event.at };
    }
    case 'report_status': {
      const invocation = requireInvocation(state, args, { identity });
      if (
        typeof args.note !== 'string' || args.note.length === 0
        || Buffer.byteLength(args.note, 'utf8') > MAX_STATUS_NOTE_BYTES
      ) {
        throw new Error(`status note must be a non-empty string of at most ${MAX_STATUS_NOTE_BYTES} bytes`);
      }
      const event = appendEvent(invocation.invocationId, 'agent-status', {
        agentId: identity.agentId,
        note: args.note,
      }, { ...options, now: state.now });
      return { recorded: true, invocationId: invocation.invocationId, seq: event.seq, at: event.at };
    }
    case 'clock_in': {
      if (identity === null) {
        throw new Error(
          'no reach-back identity — set '
          + `${REACH_AGENT_ID_ENV} or run from a worktree with agentBot.agentId configured`,
        );
      }
      const harness = detectAgentHarness(state.env) ?? null;
      const scoped = typeof args.invocation_id === 'string' && args.invocation_id !== ''
        ? args.invocation_id
        : state.env[REACH_INVOCATION_ENV];
      if (typeof scoped === 'string' && scoped !== '') {
        const invocation = requireInvocation(state, args, { identity });
        const event = appendEvent(invocation.invocationId, 'clock-in', {
          agentId: identity.agentId,
          placement: identity.placement,
          harness,
        }, { ...options, now: state.now });
        return {
          agentId: identity.agentId,
          placement: identity.placement,
          harness,
          durable: true,
          invocationId: invocation.invocationId,
          seq: event.seq,
          at: event.at,
        };
      }
      return {
        agentId: identity.agentId,
        placement: identity.placement,
        harness,
        durable: false,
        at: state.now().toISOString(),
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// The injected placement's mcpServers[] entry, ACP-shaped ({name, value} env
// pairs). The engine's per-invocation factory calls this with the invocation
// and bound identity; store-location variables travel along so the spawned
// server reads the same store even when the harness does not merge env.
export function reachMcpServerEntry({ invocationId, agentId, env = process.env } = {}) {
  const vars = [
    { name: REACH_INVOCATION_ENV, value: validateInvocationId(invocationId) },
    { name: REACH_AGENT_ID_ENV, value: validateAgentId(agentId) },
  ];
  for (const name of STORE_ENV_PASSTHROUGH) {
    if (typeof env[name] === 'string' && env[name] !== '') {
      vars.push({ name, value: env[name] });
    }
  }
  return {
    name: 'agent-reach',
    command: process.execPath,
    args: [fileURLToPath(import.meta.url)],
    env: vars,
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// One message in, at most one message out. Notifications (no id) return null.
export async function handleMcpMessage(state, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
    return rpcError(null, -32600, 'invalid request');
  }
  const { id = null, method, params = {} } = message;
  const isNotification = !('id' in message);
  // JSON-RPC: a notification executes but never gets a response — including
  // for known methods, so a ping without an id must not produce an id:null
  // reply the client would treat as an unmatched response.
  const reply = (payload) => (isNotification ? null : payload);
  try {
    switch (method) {
      case 'initialize':
        return reply(rpcResult(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-reach', version: serverVersion() },
          instructions:
            'Reach-back channel to the adapter thread that started this session. '
            + 'Call fetch_context first to receive the inbound message and thread '
            + 'history, report_status for interim progress, and post_reply exactly '
            + 'once with the final answer.',
        }));
      case 'ping':
        return reply(rpcResult(id, {}));
      case 'tools/list':
        return reply(rpcResult(id, { tools: TOOLS }));
      case 'tools/call': {
        try {
          const result = await callTool(state, params.name, params.arguments ?? {});
          return reply(rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }));
        } catch (error) {
          // Tool failures are results, not protocol errors (MCP contract):
          // the agent should read the message and adapt.
          return reply(rpcResult(id, {
            content: [{ type: 'text', text: error.message }],
            isError: true,
          }));
        }
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  } catch (error) {
    if (isNotification) return null;
    return rpcError(id, -32603, error.message);
  }
}

export function runReachServer({ state = createReachState(), input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  // readline fires 'line' without awaiting the async handler, so 'close' can
  // arrive while a final message — possibly the post_reply itself — is still
  // in flight. Drain the set before resolving so the reply is durable before
  // the server exits.
  const inFlight = new Set();
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    const task = (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(rpcError(null, -32700, 'parse error'))}\n`);
        return;
      }
      const response = await handleMcpMessage(state, message);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    })();
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  });
  return new Promise((resolve) => {
    lines.on('close', async () => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReachServer().catch((error) => {
    process.stderr.write(`daemon-mcp: ${error.message}\n`);
    process.exit(1);
  });
}
