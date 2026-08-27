// A scripted ACP agent for engine conformance tests: newline-delimited
// JSON-RPC 2.0 on stdio, speaking just enough of the protocol to exercise
// every engine path. The prompt text selects the scenario, so the test file
// reads as a list of turns and this fixture stays a dumb switchboard.
import { createInterface } from 'node:readline';

let nextId = 1;
const pending = new Map();
let sessionCounter = 0;
const sessions = new Map();

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function notifyUpdate(sessionId, update) {
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

function chunk(sessionId, text) {
  notifyUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
}

function request(method, params) {
  return new Promise((resolve) => {
    const id = `agent-${nextId}`;
    nextId += 1;
    pending.set(id, resolve);
    write({ jsonrpc: '2.0', id, method, params });
  });
}

async function handlePrompt({ sessionId, prompt }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`unknown session ${sessionId}`);
  const text = prompt?.[0]?.text ?? '';

  if (text === 'env-probe') {
    chunk(sessionId, JSON.stringify({
      CLAUDECODE: process.env.CLAUDECODE ?? null,
      FAKE_KEEP: process.env.FAKE_KEEP ?? null,
      cwd: session.cwd,
      mcpServers: session.mcpServers,
      loaded: session.loaded,
    }));
    return { stopReason: 'end_turn' };
  }

  if (text === 'need-permission') {
    const response = await request('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: 'call_perm',
        title: 'run the build',
        kind: 'execute',
        _meta: { toolName: 'Bash' },
      },
      options: [
        { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'opt-reject', name: 'Reject once', kind: 'reject_once' },
      ],
    });
    chunk(sessionId, `permission:${JSON.stringify(response.outcome ?? response)}`);
    return { stopReason: 'end_turn' };
  }

  if (text === 'oversize') {
    chunk(sessionId, 'x'.repeat(20_000));
    chunk(sessionId, 'after-oversize');
    return { stopReason: 'end_turn' };
  }

  if (text === 'weird-update') {
    notifyUpdate(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] });
    notifyUpdate(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } });
    notifyUpdate(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call_untitled' });
    chunk(sessionId, 'still-fine');
    return { stopReason: 'end_turn' };
  }

  if (text === 'bad-stop') {
    return { stopReason: 'flumox' };
  }

  if (text === 'hang') {
    return new Promise((resolve) => { session.onCancel = () => resolve({ stopReason: 'cancelled' }); });
  }

  chunk(sessionId, `pong: ${text}`);
  notifyUpdate(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'call_1',
    title: 'read a file',
    kind: 'read',
  });
  notifyUpdate(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
  return { stopReason: 'end_turn' };
}

async function handle(method, params) {
  if (method === 'initialize') {
    return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  }
  if (method === 'session/new') {
    sessionCounter += 1;
    const sessionId = `fake-ses-${sessionCounter}`;
    sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers, loaded: false });
    return { sessionId };
  }
  if (method === 'session/load') {
    sessions.set(params.sessionId, { cwd: params.cwd, mcpServers: params.mcpServers, loaded: true });
    // History replay: the engine must NOT re-record this as a fresh event.
    chunk(params.sessionId, 'replayed-history-line');
    return {};
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
  if (payload.id !== undefined && payload.method === undefined) {
    const resolve = pending.get(payload.id);
    if (resolve) {
      pending.delete(payload.id);
      resolve(payload.result ?? payload.error ?? null);
    }
    return;
  }
  if (payload.method === 'session/cancel') {
    const session = sessions.get(payload.params?.sessionId);
    if (session?.onCancel) session.onCancel();
    return;
  }
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
