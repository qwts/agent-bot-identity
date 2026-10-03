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
// Beyond the adapter thread, the server is the soul's line to its teammates:
// `fleet` lists the souls it may message and `send_message` sends one, both
// through `agent-comms` run AS the soul — its own binding and worktree, never
// another's. A daemon-driven turn has nobody to approve a shell call, so
// without these tools a cold soul could answer people but never reach
// another agent. They are on for every soul unless its launch turned comms
// off (AGENT_BOT_REACH_COMMS=0, stamped by the engine from the census).
// `start_soul` (#377) asks the daemon to start a new teammate soul with this
// one as its parent; the daemon owns the limits and audits every attempt.
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
import { agentCommsAsSoul } from './comms-relay.mjs';
import { validateAgentId } from './agent-identity.mjs';
import { recordThreadMessage } from './soul-threads.mjs';
import { detectAgentHarness } from './detect-harness.mjs';
import { AGENT_ID_KEYS, readGitConfig } from './resolve-agent.mjs';
import { readBinding } from './agent-binding.mjs';
import { PROOF_HEADER, signBindingProof } from './binding-proof.mjs';

const PROTOCOL_VERSION = '2025-06-18';

// Environment contract for the injected placement. The engine's factory
// stamps these into the mcpServers[] entry; the registered placement has
// neither and falls back to worktree git config plus explicit arguments.
export const REACH_INVOCATION_ENV = 'AGENT_BOT_REACH_INVOCATION';
export const REACH_AGENT_ID_ENV = 'AGENT_BOT_REACH_AGENT_ID';
// The soul's worktree, where `agent-comms` runs as the soul; its binding file
// travels as AGENT_BOT_BINDING. `AGENT_BOT_REACH_COMMS=0` withholds the
// teammate tools for a soul launched with comms off.
export const REACH_WORKTREE_ENV = 'AGENT_BOT_REACH_WORKTREE';
export const REACH_COMMS_ENV = 'AGENT_BOT_REACH_COMMS';
// The thread a relayed turn belongs to (#392): the woken message's
// correlation, or its id. send_message and start_soul's brief carry it, so a
// teammate's answer finds its way back into this soul's thread.
export const REACH_CORRELATION_ENV = 'AGENT_BOT_REACH_CORRELATION';
const MAX_CORRELATION_LENGTH = 128;
export const BINDING_ENV = 'AGENT_BOT_BINDING';

// The server's name in mcpServers[], and the tool names a harness derives
// from it. Claude Code names an MCP tool `mcp__<server>__<tool>`; the ACP
// engine normalizes every adapter it can verify to that canonical name (see
// MCP_TOOL_NAMINGS in acp-registry.mjs), and the daemon's permission policy
// allows exactly these (see reachPolicyRules).
export const REACH_SERVER_NAME = 'agent-reach';
export const REACH_TOOL_NAMES = Object.freeze([
  'fetch_context', 'post_reply', 'report_status', 'clock_in', 'fleet', 'send_message', 'start_soul',
]);
const COMMS_TOOL_NAMES = new Set(['fleet', 'send_message', 'start_soul']);
// The tools that address an interaction-store invocation. A comms turn (a
// cold wake or a launch) has none, so its injected server leaves them out
// rather than offer a fetch_context that can only fail (#407).
const INVOCATION_TOOL_NAMES = new Set(['fetch_context', 'post_reply', 'report_status']);

// Store-location variables forwarded into the injected entry so the spawned
// server resolves the same interaction store even under a harness that does
// not merge the parent environment.
const STORE_ENV_PASSTHROUGH = [
  'AGENT_BOT_INTERACTION_HOME',
  'AGENT_BOT_POPULATION_PATH',
  'XDG_STATE_HOME',
  // The soul thread journal lives under the identity state directory.
  'AGENT_BOT_STATE_HOME',
  'QWTS_AGENT_STATE_HOME',
  'HOME',
  // agent-comms must resolve under a harness that does not merge env, and a
  // launchd daemon's PATH is the one that was widened to reach it.
  'PATH',
];

// A reply event must fit the store's 8 KiB event-data bound with the
// identity stamp and JSON envelope; status notes stay chat-sized.
export const MAX_REPLY_TEXT_BYTES = 6 * 1024;
export const MAX_STATUS_NOTE_BYTES = 1024;
// A teammate message stays chat-sized, well inside the broker's 32 KiB body.
export const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_ADDRESS_LENGTH = 256;
// Starting a soul can provision its home and install its harness first.
const START_SOUL_TIMEOUT_MS = 15 * 60_000;

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
  {
    name: 'fleet',
    description:
      'List your teammates: the other agent souls you may message through '
      + 'agent-comms, with each one\'s name, address, and harness. Use it to '
      + 'find who to work with, then send_message to reach them.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_message',
    description:
      'Send an agent-comms message, as yourself, to a teammate (a name from '
      + 'fleet, an address, or an Agent ID) or to a person by principal name. '
      + 'Their answer arrives in your inbox later as a reply and wakes you; '
      + 'each message stands alone, so include the context they need.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'teammate name, account/agentId address, Agent ID, or principal name' },
        body: { type: 'string', description: 'the message, plain text, at most 16 KiB' },
        reply_to: { type: 'string', description: 'message id you are answering, if this is a reply' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'start_soul',
    description:
      'Start a new teammate: a full agent soul of its own (its own folder, '
      + 'identity, and inbox) with you as its parent, not a subagent in your '
      + 'session. Use it when asked to set up a team. It joins agent-comms '
      + 'and shows under you in fleet; pass brief to send it its first task '
      + 'from you. The host limits how many teammates you may start.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the new teammate\'s name, e.g. "Researcher"' },
        harness: { type: 'string', description: 'harness to run it on (claude, opencode, …); defaults to yours' },
        template: { type: 'string', description: 'absolute path of a soul template; defaults to the host\'s Starter' },
        brief: { type: 'string', description: 'first message to send it, from you, at most 16 KiB' },
      },
      required: ['name'],
    },
  },
];

// The daemon's permission rules for this server: an exact allow for each of
// its own tools under the canonical `mcp__<server>__<tool>` naming, prepended to whatever policy
// the owner configured. A cold turn has nobody to approve a call, so without
// them the default deny policy refuses the soul its own reach-back channel.
export function reachPolicyRules() {
  return REACH_TOOL_NAMES.map((tool) => ({ tool: `mcp__${REACH_SERVER_NAME}__${tool}`, outcome: 'allow' }));
}

function commsEnabled(state) {
  return state.env[REACH_COMMS_ENV] !== '0';
}

// An injected server stamped with a soul but no invocation serves a comms
// turn; a registered server has neither stamp and takes explicit ids.
function invocationScoped(state) {
  const injected = typeof state.env[REACH_AGENT_ID_ENV] === 'string' && state.env[REACH_AGENT_ID_ENV] !== '';
  const stamped = typeof state.env[REACH_INVOCATION_ENV] === 'string' && state.env[REACH_INVOCATION_ENV] !== '';
  return stamped || !injected;
}

function toolsFor(state) {
  return TOOLS.filter((tool) => (commsEnabled(state) || !COMMS_TOOL_NAMES.has(tool.name))
    && (invocationScoped(state) || !INVOCATION_TOOL_NAMES.has(tool.name)));
}

export function createReachState({
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  now = () => new Date(),
  run = undefined,
  fetch: fetchImpl = undefined,
} = {}) {
  return { env, home, cwd, now, run, fetch: fetchImpl };
}

// The soul agent-comms runs as: the identity this server speaks for, in the
// stamped worktree (injected) or the configured one (registered), with the
// stamped binding file when there is one. Nothing here can name another soul.
function commsSoul(state, identity) {
  if (identity === null) {
    throw new Error(
      'no reach-back identity — set '
      + `${REACH_AGENT_ID_ENV} or run from a worktree with agentBot.agentId configured`,
    );
  }
  if (!commsEnabled(state)) throw new Error('agent-comms is turned off for this soul');
  const stamped = state.env[REACH_WORKTREE_ENV];
  const worktree = typeof stamped === 'string' && path.isAbsolute(stamped) ? stamped : state.cwd;
  // Only an injected entry's binding is the soul's own; a registered server
  // inherits whatever its desktop harness had, so agent-comms resolves the
  // soul from the configured worktree instead.
  const file = identity.placement === 'injected' ? state.env[BINDING_ENV] : null;
  return {
    agentId: identity.agentId,
    binding: { worktree, file: typeof file === 'string' && file !== '' ? file : null },
  };
}

function asSoul(state) {
  return agentCommsAsSoul({ env: state.env, ...(state.run ? { run: state.run } : {}) });
}

// Addresses are single-line; a message body may span lines.
function boundedString(value, label, { max, bytes = false }) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  if (!bytes && /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be a single line of text`);
  if ((bytes ? Buffer.byteLength(value, 'utf8') : value.length) > max) {
    throw new Error(`${label} must be at most ${max} ${bytes ? 'bytes' : 'characters'}`);
  }
  return value;
}

// A teammate is addressed by what the agent knows: an address or Agent ID
// goes as is; a bare name resolves against the peers the broker lets this
// soul see. A name no peer has may be a person (principal), so it goes as is
// and the broker decides; a name several peers share is refused, not guessed.
async function resolveRecipient(run, soul, to) {
  if (to.includes('/') || to.startsWith('agent_')) return to;
  const { peers = [] } = await run(soul, ['peers']);
  const wanted = to.trim().toLowerCase();
  const matches = peers.filter((peer) => typeof peer?.name === 'string' && peer.name.trim().toLowerCase() === wanted);
  if (matches.length === 1) return matches[0].address;
  if (matches.length > 1) {
    throw new Error(`${matches.length} teammates are named ${to}; use an address: ${matches.map((peer) => peer.address).join(', ')}`);
  }
  return to;
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
// write into another soul's thread. An injected server is pinned harder
// still: its env stamp IS the addressed thread, and an explicit
// invocation_id naming any other invocation is refused even for the same
// soul — fetch_context exposes sibling invocation ids, and a confused
// session must not be able to post into a sibling thread through them.
function requireInvocation(state, args, { identity }) {
  const stamped = state.env[REACH_INVOCATION_ENV];
  const explicit = typeof args.invocation_id === 'string' && args.invocation_id !== ''
    ? args.invocation_id
    : null;
  if (typeof stamped === 'string' && stamped !== '' && explicit !== null && explicit !== stamped) {
    throw new Error(
      'this injected reach server is pinned to its own invocation; '
      + 'invocation_id may not address another thread',
    );
  }
  const raw = explicit ?? stamped;
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
  if (INVOCATION_TOOL_NAMES.has(name) && !invocationScoped(state)) {
    throw new Error(`${name} is not available in this turn: the message and its thread are already in your prompt, and your final answer is the reply`);
  }
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
    case 'fleet': {
      const soul = commsSoul(state, identity);
      const { peers = [] } = await asSoul(state)(soul, ['peers']);
      return {
        you: soul.agentId,
        teammates: peers.map(({ name: peerName = null, address, account, agentId, harness = null, parent = null, verification = null }) => ({
          name: peerName, address, account, agentId, harness, parent, verification,
        })),
      };
    }
    case 'send_message': {
      const soul = commsSoul(state, identity);
      const to = boundedString(args.to, 'to', { max: MAX_ADDRESS_LENGTH }).trim();
      const body = boundedString(args.body, 'body', { max: MAX_MESSAGE_BYTES, bytes: true });
      const replyTo = args.reply_to === undefined || args.reply_to === null || args.reply_to === ''
        ? null
        : boundedString(args.reply_to, 'reply_to', { max: 128 });
      const run = asSoul(state);
      const address = await resolveRecipient(run, soul, to);
      const correlation = turnCorrelation(state);
      const sent = await run(soul, [
        'send', address, '--body', body,
        ...(replyTo ? ['--reply-to', replyTo] : []),
        ...(correlation ? ['--correlation', correlation] : []),
      ]);
      recordSent(state, soul, { id: sent.messageId, to: address, replyTo, correlation, body });
      return { sent: true, to: address, messageId: sent.messageId ?? null, wake: sent.wake ?? null };
    }
    case 'start_soul': {
      const soul = commsSoul(state, identity);
      const request = { name: boundedString(args.name, 'name', { max: 128 }).trim() };
      if (args.harness !== undefined && args.harness !== null && args.harness !== '') {
        request.harness = boundedString(args.harness, 'harness', { max: 32 });
      }
      if (args.template !== undefined && args.template !== null && args.template !== '') {
        request.template = boundedString(args.template, 'template', { max: 4096 });
      }
      const brief = args.brief === undefined || args.brief === null || args.brief === ''
        ? null
        : boundedString(args.brief, 'brief', { max: MAX_MESSAGE_BYTES, bytes: true });
      const started = await startSoul(state, soul, request);
      const result = { started: true, agentId: started.agentId, name: started.name, harness: started.harness, parent: soul.agentId };
      if (brief !== null) {
        try {
          const correlation = turnCorrelation(state);
          const sent = await asSoul(state)(soul, ['send', started.agentId, '--body', brief, ...(correlation ? ['--correlation', correlation] : [])]);
          recordSent(state, soul, { id: sent.messageId, to: started.agentId, replyTo: null, correlation, body: brief });
          result.brief = { sent: true, messageId: sent.messageId ?? null };
        } catch (error) {
          result.brief = { sent: false, error: error.message };
        }
      }
      return result;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// The injected turn's thread key, when the daemon stamped one.
function turnCorrelation(state) {
  const value = state.env[REACH_CORRELATION_ENV];
  return typeof value === 'string' && value !== '' && value.length <= MAX_CORRELATION_LENGTH ? value : null;
}

// Journals a send so a later cold wake can show it (#392). Best effort.
function recordSent(state, soul, entry) {
  recordThreadMessage(soul.agentId, { dir: 'out', ...entry }, { env: state.env, home: state.home, now: state.now });
}

// The daemon starts the teammate; this server only proves which soul asks.
// The binding is the soul's own (the injected entry's file, or the
// registered worktree's), and its secret signs a one-request proof (#270)
// rather than travelling. A binding for any other soul is refused here.
async function startSoul(state, soul, request) {
  const binding = soul.binding.file
    ? readBinding({ env: { AGENT_BOT_BINDING: soul.binding.file } })
    : readBinding({ env: {}, cwd: soul.binding.worktree });
  if (!binding) throw new Error('starting a teammate needs this soul\'s daemon binding, and none was found');
  if (binding.agentId !== soul.agentId) throw new Error('the binding here belongs to a different soul');
  const target = new URL('/v0/team/start', binding.daemon);
  const fetchImpl = state.fetch ?? fetch;
  const res = await fetchImpl(target.href, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PROOF_HEADER]: signBindingProof({ secret: binding.secret, method: 'POST', path: target.pathname, authority: target.host }),
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(START_SOUL_TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error ?? `the daemon refused to start the soul (HTTP ${res.status})`);
  return payload;
}

// The injected placement's mcpServers[] entry, ACP-shaped ({name, value} env
// pairs). The engine's per-invocation factory calls this with the invocation
// and bound identity; store-location variables travel along so the spawned
// server reads the same store even when the harness does not merge env.
//
// A comms turn (a cold wake or a launch) has no interaction-store invocation,
// so `invocationId` is optional; the soul's worktree and binding make the
// teammate tools speak as it, and `comms: false` withholds them.
export function reachMcpServerEntry({
  invocationId = null, agentId, env = process.env, worktree = null, binding = null, comms = true, correlation = null,
} = {}) {
  const vars = [{ name: REACH_AGENT_ID_ENV, value: validateAgentId(agentId) }];
  if (invocationId !== null && invocationId !== undefined) {
    vars.unshift({ name: REACH_INVOCATION_ENV, value: validateInvocationId(invocationId) });
  }
  if (worktree !== null) {
    if (typeof worktree !== 'string' || !path.isAbsolute(worktree)) throw new Error('reach worktree must be an absolute path');
    vars.push({ name: REACH_WORKTREE_ENV, value: worktree });
  }
  if (binding !== null) {
    if (typeof binding !== 'string' || !path.isAbsolute(binding)) throw new Error('reach binding must be an absolute path');
    vars.push({ name: BINDING_ENV, value: binding });
  }
  if (comms === false) vars.push({ name: REACH_COMMS_ENV, value: '0' });
  if (typeof correlation === 'string' && correlation !== '' && correlation.length <= MAX_CORRELATION_LENGTH) {
    vars.push({ name: REACH_CORRELATION_ENV, value: correlation });
  }
  for (const name of STORE_ENV_PASSTHROUGH) {
    if (typeof env[name] === 'string' && env[name] !== '') {
      vars.push({ name, value: env[name] });
    }
  }
  return {
    name: REACH_SERVER_NAME,
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
            (invocationScoped(state)
              ? 'Reach-back channel to the adapter thread that started this session. '
                + 'Call fetch_context first to receive the inbound message and thread '
                + 'history, report_status for interim progress, and post_reply exactly '
                + 'once with the final answer.'
              : 'Your prompt already holds the message you are answering and its thread.')
            + (commsEnabled(state)
              ? ' To work with other agents, call fleet to see your teammates and '
                + 'send_message to reach one; their replies arrive in your inbox. '
                + 'When asked to set up a team, start_soul starts new teammate '
                + 'souls under you.'
              : ''),
        }));
      case 'ping':
        return reply(rpcResult(id, {}));
      case 'tools/list':
        return reply(rpcResult(id, { tools: toolsFor(state) }));
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
