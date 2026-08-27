// A scripted ACP agent that proves the reach-back loop (#146): on
// session/prompt it spawns the FIRST injected mcpServers[] entry exactly as a
// real harness would — command, args, and the entry's env pairs — then speaks
// MCP over the child's stdio: initialize, fetch_context, post_reply. The
// reply text embeds what fetch_context returned, so a passing test proves the
// message travelled adapter → store → injected server → session → store.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

let sessionCounter = 0;
const sessions = new Map();

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function chunk(sessionId, text) {
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });
}

// Minimal MCP client over one spawned server: sequential request/response.
function mcpClient(entry) {
  const env = { ...process.env };
  for (const pair of entry.env ?? []) env[pair.name] = pair.value;
  const child = spawn(entry.command, entry.args ?? [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const queue = [];
  lines.on('line', (line) => {
    const waiter = queue.shift();
    if (waiter) waiter(JSON.parse(line));
  });
  let nextId = 0;
  return {
    request(method, params) {
      nextId += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`);
      return new Promise((resolve) => queue.push(resolve));
    },
    close() {
      child.stdin.end();
    },
  };
}

async function callReachTool(client, name, args) {
  const response = await client.request('tools/call', { name, arguments: args });
  const text = response.result?.content?.[0]?.text ?? '';
  if (response.result?.isError) throw new Error(`tool ${name} failed: ${text}`);
  return JSON.parse(text);
}

async function handlePrompt({ sessionId }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);
  const entry = session.mcpServers?.[0];
  if (!entry) {
    chunk(sessionId, 'no mcp server was injected');
    return { stopReason: 'refusal' };
  }
  const client = mcpClient(entry);
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18' });
    const clockIn = await callReachTool(client, 'clock_in', {});
    const context = await callReachTool(client, 'fetch_context', {});
    await callReachTool(client, 'report_status', { note: 'working on it' });
    const posted = await callReachTool(client, 'post_reply', {
      text: `reach-echo:${context.message} as:${clockIn.agentId}`,
    });
    chunk(sessionId, `posted seq ${posted.seq}`);
  } finally {
    client.close();
  }
  return { stopReason: 'end_turn' };
}

async function handle(method, params) {
  if (method === 'initialize') {
    return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
  }
  if (method === 'session/new') {
    sessionCounter += 1;
    const sessionId = `reach-ses-${sessionCounter}`;
    sessions.set(sessionId, { mcpServers: params.mcpServers });
    return { sessionId };
  }
  if (method === 'session/prompt') {
    return handlePrompt(params);
  }
  throw new Error(`unsupported method ${method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }
  if (payload.method === undefined) return;
  Promise.resolve()
    .then(() => handle(payload.method, payload.params ?? {}))
    .then((result) => {
      if (payload.id !== undefined) write({ jsonrpc: '2.0', id: payload.id, result });
    })
    .catch((error) => {
      if (payload.id !== undefined) {
        write({ jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: error.message } });
      }
    });
});
lines.on('close', () => process.exit(0));
