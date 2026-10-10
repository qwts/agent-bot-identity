#!/usr/bin/env node

// Sanctioned agent-bot MCP server (#94): the conversation-side half of the
// surrender-and-enforce binding flow, spoken over newline-delimited JSON-RPC
// on stdio so any MCP-capable harness can mount it with zero dependencies.
//
//   agent-bot mcp
//
// It AUGMENTS the worktree scripts, never replaces them: setup-worktree still
// configures identity, credentials, and hooks, and additionally mints the
// inert bind token this server surrenders. At conversation start the agent
// calls the `bind` tool with what only the conversation knows (transcript
// locator, parent agent); this server reads the token from the worktree it is
// running in, exchanges it at the daemon, and holds the returned binding
// secret from the private git dir. The secret is never logged or returned
// to the conversation; subsequent MCP processes reuse the shared binding.
//
// Git and gh remain the only sanctioned write paths to GitHub; nothing here
// touches commits or the credential boundary.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readBinding, readBindToken } from './agent-binding.mjs';
import { daemonClient } from './daemon-client.mjs';
import { detectAgentHarness } from './detect-harness.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';

const PROTOCOL_VERSION = '2025-06-18';

function serverVersion() {
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const TOOLS = [
  {
    name: 'bind',
    description:
      'Surrender this worktree\'s bind token and bind the current conversation '
      + 'to its execution identity. Call once at conversation start, before any '
      + 'other agent-bot tool. The transcript id is whatever identifies this '
      + 'conversation to its harness (session id, thread id).',
    inputSchema: {
      type: 'object',
      properties: {
        transcript_id: { type: 'string', description: 'conversation/session identifier from the harness' },
        transcript_provider: { type: 'string', description: 'harness name (claude, codex, cursor, custom)' },
        parent_agent_id: { type: 'string', description: 'spawning agent\'s Agent ID, when this conversation was spawned by a bound agent' },
      },
      required: ['transcript_id'],
    },
  },
  {
    name: 'whoami',
    description: 'Report the identity this connection is bound to, as enforced by the daemon.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'population',
    description: 'List the population census of agent souls in this account.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'filter by lifecycle status (active, finalized, retired)' },
        app: { type: 'string', description: 'filter by GitHub App slug' },
      },
    },
  },
  {
    name: 'space_path',
    description: 'Path of the bound identity\'s Agent Space (requires bind).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'credential',
    description:
      'Mint a short-lived GitHub App installation token for the identity this '
      + 'connection is bound to (requires bind). Tier 1 only: the token is the '
      + 'bot\'s own — export it as GH_TOKEN for gh. Configured worktrees already '
      + 'authenticate git through the credential helper, so git needs nothing. '
      + 'Treat it as a secret; never write it to a file or commit.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'take_inbox',
    description:
      'Take the next GitHub mention or review request for the App and '
      + 'repository this bound worktree is. The call returns the event and '
      + 'marks it pulled (the record stays until its push deliveries settle '
      + 'and the TTL expires). A returned event carries a `deliveries` array '
      + 'with the per-subscriber push status (`pending`, `delivered`, or '
      + '`dead`), so a consumer that also receives pushes can skip events '
      + 'already delivered and watch for dead ones. The repository and App '
      + 'come from the binding, not from the caller. Requires bind.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function createMcpState({
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  client = null,
} = {}) {
  return {
    env,
    home,
    cwd,
    client: client ?? daemonClient({ env, home, cwd }),
    // Held in memory for the life of this server process; never serialized.
    secret: null,
    agentId: null,
  };
}

// Stable take_inbox error codes (#299). The MCP tool surface returns only
// the message text to the agent, so the code is embedded as [code] as well
// as carried on error.code for programmatic use.
function inboxError(code, message, { cause = undefined } = {}) {
  return Object.assign(new Error(`${message} [${code}]`), { code, ...(cause === undefined ? {} : { cause }) });
}

// The bearer must never appear in an error, even when a lower layer echoes
// it. Strip it from any detail derived from the request or its failure.
function sanitizeInboxDetail(detail, token) {
  let out = String(detail ?? '');
  if (typeof token === 'string' && token !== '') out = out.split(token).join('[redacted]');
  return out;
}

function describeFetchCause(error) {
  const cause = error?.cause ?? error;
  const code = cause?.code ?? error?.code ?? null;
  const message = sanitizeInboxDetail(cause?.message ?? error?.message ?? 'network error');
  // AbortSignal.timeout rejects with a TimeoutError DOMException; undici
  // surfaces network failures as 'fetch failed' with the real reason in
  // error.cause. Name both so the operator can tell a hang from a refusal.
  if (error?.name === 'TimeoutError' || cause?.name === 'TimeoutError' || code === 'ABORT_ERR' || /timeout|aborted/i.test(message)) {
    return { kind: 'timeout', code: code ?? 'TimeoutError', message };
  }
  return { kind: 'network', code, message };
}

// A daemon failure as text: the MCP surface returns only error.message, so
// an undici cause (ECONNREFUSED behind 'fetch failed') must be in it.
function daemonDetail(error) {
  const cause = describeFetchCause(error);
  return `${cause.code ? `${cause.code}: ` : ''}${cause.message}`;
}

// Restore the in-memory secret from the worktree's binding file after an MCP
// restart (#299). The file is the durable binding; the token was single-use
// and is gone. Throws inbox-not-bound when there is nothing to restore, and
// inbox-daemon-unreachable when the daemon cannot validate it.
async function ensureTakeBinding(state) {
  if (state.secret) {
    try {
      return await state.client.binding(state.secret);
    } catch (error) {
      throw inboxError(
        'inbox-daemon-unreachable',
        `take_inbox failed: the daemon rejected the held binding (${daemonDetail(error)}); run \`agent-bot daemon status\`, then \`agent-bot doctor\`, and re-bind with the bind tool`,
        { cause: error },
      );
    }
  }
  let existing = null;
  try {
    existing = readBinding({ env: state.env, cwd: state.cwd });
  } catch (error) {
    throw inboxError(
      'inbox-daemon-unreachable',
      `take_inbox failed: the worktree binding could not be read (${sanitizeInboxDetail(error?.message ?? 'unknown error')}); run \`agent-bot doctor\`, then \`agent-bot setup-worktree\` if the binding is corrupt`,
      { cause: error },
    );
  }
  if (!existing) {
    throw inboxError(
      'inbox-not-bound',
      'take_inbox failed: not bound — call the bind tool first (a restarted MCP server re-binds automatically when the worktree binding file exists)',
    );
  }
  try {
    const binding = await state.client.binding(existing.secret);
    state.secret = existing.secret;
    state.agentId = binding.agentId;
    return binding;
  } catch (error) {
    throw inboxError(
      'inbox-daemon-unreachable',
      `take_inbox failed: the daemon rejected the worktree binding (${daemonDetail(error)}); run \`agent-bot daemon status\`, then re-bind with the bind tool or \`agent-bot setup-worktree\` for a fresh token`,
      { cause: error },
    );
  }
}

async function takeInbox(state) {
  const binding = await ensureTakeBinding(state);
  if (resolve(binding.worktree) !== resolve(state.cwd)) {
    throw inboxError(
      'inbox-wrong-worktree',
      'take_inbox failed: this server only serves its bound worktree; run the MCP server from the bound worktree',
    );
  }
  // The daemon holds the inbox bearer and names the App and repository from
  // the binding (#229); this process never sees the bearer.
  let result;
  try {
    result = await state.client.takeInbox(state.secret);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('inbox-') && error.detail) {
      throw inboxError(error.code, error.detail, { cause: error });
    }
    throw inboxError(
      'inbox-daemon-unreachable',
      `take_inbox failed: the daemon could not take from the inbox (${daemonDetail(error)}); run \`agent-bot daemon status\`, then \`agent-bot doctor\`, and retry`,
      { cause: error },
    );
  }
  return { event: result?.event ?? null };
}

// The App this session was explicitly run as (GH_AGENT_APP, else the
// checkout's pin), sent with a first bind so the daemon can reconcile the
// soul's record with it (#107). A claim the resolver rejects is not sent.
function claimedApp(state) {
  try { return resolveAgentSlug({ env: state.env, cwd: state.cwd, detect: false }); } catch { return null; }
}

async function callTool(state, name, args = {}) {
  switch (name) {
    case 'bind': {
      let existing = null;
      try {
        existing = readBinding({ env: state.env, cwd: state.cwd });
      } catch (error) {
        throw inboxError(
          'inbox-daemon-unreachable',
          `bind failed: the worktree binding could not be read (${sanitizeInboxDetail(error?.message ?? 'unknown error')}); run \`agent-bot doctor\`, then \`agent-bot setup-worktree\` if the binding is corrupt`,
          { cause: error },
        );
      }
      if (existing) {
        try {
          const binding = await state.client.binding(existing.secret);
          state.secret = existing.secret;
          state.agentId = binding.agentId;
          return binding;
        } catch (error) {
          const cause = describeFetchCause(error);
          const safeMessage = sanitizeInboxDetail(cause.message ?? error?.message ?? 'unknown error');
          const causeCode = cause.code ? `${cause.code}: ` : '';
          throw inboxError(
            'inbox-daemon-unreachable',
            `bind failed: the daemon is unreachable to re-bind this worktree (${causeCode}${safeMessage}); run \`agent-bot daemon status\` and \`agent-bot doctor\`, then retry`,
            { cause: error },
          );
        }
      }
      if (typeof args.transcript_id !== 'string' || args.transcript_id === '') {
        throw new Error('bind requires transcript_id');
      }
      const gitDir = git(state.cwd, 'rev-parse', '--absolute-git-dir');
      const record = readBindToken(gitDir);
      if (!record) {
        throw new Error('no bind token is minted for this worktree — run `agent-bot setup-worktree` first');
      }
      const result = await state.client.bind({
        gitDir,
        token: record.token,
        transcript: {
          provider: args.transcript_provider ?? detectAgentHarness(state.env) ?? 'custom',
          id: args.transcript_id,
        },
        parentId: args.parent_agent_id ?? null,
        app: claimedApp(state),
      });
      state.secret = result.secret;
      state.agentId = result.agentId;
      // The reuse policy may have resolved a different identity than the
      // token's original pin (a later conversation reusing the worktree);
      // repinning here keeps commits and binding attributing identically.
      if (result.repinRequired) {
        git(state.cwd, 'config', 'extensions.worktreeConfig', 'true');
        git(state.cwd, 'config', '--worktree', 'agentBot.agentId', result.agentId);
      }
      // The daemon reconciled the soul's App with the one this session was
      // run as (#107): the pin follows, so the credential helper and commit
      // attribution can be refreshed by setup-worktree in this checkout.
      if (result.app?.status === 'reconciled') {
        git(state.cwd, 'config', 'extensions.worktreeConfig', 'true');
        git(state.cwd, 'config', '--worktree', 'agentBot.app', result.app.claimed);
        result.app.next = 'run agent-bot setup-worktree in this checkout to commit as the reconciled App';
      }
      const { secret, ...safe } = result;
      return safe;
    }
    case 'whoami': {
      if (!state.secret) throw new Error('not bound — call the bind tool first');
      return state.client.binding(state.secret);
    }
    case 'population': {
      const souls = await state.client.population({
        status: typeof args.status === 'string' ? args.status : null,
        app: typeof args.app === 'string' ? args.app : null,
      });
      return { souls };
    }
    case 'space_path': {
      if (!state.secret) throw new Error('not bound — call the bind tool first');
      const binding = await state.client.binding(state.secret);
      return state.client.spacePath(binding.agentId);
    }
    case 'credential': {
      if (!state.secret) throw new Error('not bound — call the bind tool first');
      return state.client.credential(state.secret);
    }
    case 'take_inbox':
      return takeInbox(state, args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
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
          serverInfo: { name: 'agent-bot', version: serverVersion() },
          instructions:
            'Call the bind tool once at conversation start, passing your session or '
            + 'thread identifier as transcript_id (and parent_agent_id when you were '
            + 'spawned by another agent). Binding joins this worktree\'s minted token '
            + 'with your conversation into one enforced identity; other tools require it.',
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

export function runMcpServer({ state = createMcpState(), input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  // readline fires 'line' without awaiting the async handler, so 'close' can
  // arrive while the final message — possibly the bind itself — is still in
  // flight. Track every handler and drain the set before releasing, or a bind
  // that completes after EOF would install a secret nobody ever surrenders.
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
  runMcpServer().catch((error) => {
    process.stderr.write(`agent-mcp: ${error.message}\n`);
    process.exit(1);
  });
}
