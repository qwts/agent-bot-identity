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
// secret in process memory only. The secret is never written down, logged, or
// returned to the conversation — identity stays a property of the connection.
//
// Git and gh remain the only sanctioned write paths to GitHub; nothing here
// touches commits or the credential boundary.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readBindToken } from './agent-binding.mjs';
import { daemonClient } from './agent-daemon.mjs';
import { detectAgentHarness } from './detect-harness.mjs';

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
    description: 'List the workstation population census of agent souls.',
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
    client: client ?? daemonClient({ env, home }),
    // Held in memory for the life of this server process; never serialized.
    secret: null,
    agentId: null,
  };
}

async function callTool(state, name, args = {}) {
  switch (name) {
    case 'bind': {
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
  try {
    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-bot', version: serverVersion() },
          instructions:
            'Call the bind tool once at conversation start, passing your session or '
            + 'thread identifier as transcript_id (and parent_agent_id when you were '
            + 'spawned by another agent). Binding joins this worktree\'s minted token '
            + 'with your conversation into one enforced identity; other tools require it.',
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        try {
          const result = await callTool(state, params.name, params.arguments ?? {});
          return rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          });
        } catch (error) {
          // Tool failures are results, not protocol errors (MCP contract):
          // the agent should read the message and adapt.
          return rpcResult(id, {
            content: [{ type: 'text', text: error.message }],
            isError: true,
          });
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
  lines.on('line', async (line) => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'parse error'))}\n`);
      return;
    }
    const response = await handleMcpMessage(state, message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  });
  return new Promise((resolve) => {
    lines.on('close', resolve);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpServer().catch((error) => {
    process.stderr.write(`agent-mcp: ${error.message}\n`);
    process.exit(1);
  });
}
