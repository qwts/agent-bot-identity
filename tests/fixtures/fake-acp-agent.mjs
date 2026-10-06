// A scripted ACP agent for engine conformance tests: newline-delimited
// JSON-RPC 2.0 on stdio, speaking just enough of the protocol to exercise
// every engine path. The prompt text selects the scenario, so the test file
// reads as a list of turns and this fixture stays a dumb switchboard.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

let nextId = 1;
const pending = new Map();
let sessionCounter = 0;
const sessions = new Map();
const models = process.env.FAKE_ACP_MODELS ? JSON.parse(process.env.FAKE_ACP_MODELS) : null;

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

  if (text === 'model-probe') {
    chunk(sessionId, JSON.stringify({ model: session.model ?? models?.currentModelId ?? null, requests: session.modelRequests ?? [] }));
    return { stopReason: 'end_turn' };
  }

  if (text === 'env-probe') {
    chunk(sessionId, JSON.stringify({
      CLAUDECODE: process.env.CLAUDECODE ?? null,
      FAKE_KEEP: process.env.FAKE_KEEP ?? null,
      FAKE_SET: process.env.FAKE_SET ?? null,
      CODEX_CONFIG: process.env.CODEX_CONFIG ?? null,
      cwd: session.cwd,
      mcpServers: session.mcpServers,
      loaded: session.loaded,
      mode: session.mode ?? null,
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

  // Claude's adapter: the tool_call update names the tool in
  // _meta.claudeCode; the permission request that follows carries only the
  // id, the input, and a title (for a shell call, the model's command).
  if (text === 'claude-mcp-permission') {
    notifyUpdate(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: 'mcp__agent-reach__send_message',
      kind: 'other', status: 'pending', _meta: { claudeCode: { toolName: 'mcp__agent-reach__send_message' } },
    });
    const allowed = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'toolu_1', rawInput: { to: 'Ted' }, title: 'mcp__agent-reach__send_message' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    notifyUpdate(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'toolu_2', title: 'mcp__agent-reach__send_message',
      kind: 'execute', status: 'pending', _meta: { claudeCode: { toolName: 'Bash' } },
    });
    const spoofed = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'toolu_2', rawInput: { command: 'mcp__agent-reach__send_message' }, title: 'mcp__agent-reach__send_message' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    chunk(sessionId, `mcp:${allowed.outcome.optionId} bash:${spoofed.outcome.optionId}`);
    return { stopReason: 'end_turn' };
  }

  // Recorded wire shapes (#384). codex-acp v0.16.0: an MCP call is announced
  // as `Tool: <server>/<tool>` with Codex's McpInvocation as rawInput, and
  // its approval (an MCP elicitation) reuses the call id with the elicitation
  // event — server_name included — as rawInput. An exec call's title is the
  // model's command and its rawInput has no server/tool.
  if (text === 'codex-mcp-permission') {
    const ask = (toolCall) => request('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'approved', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
      ],
    });
    notifyUpdate(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'call_c1', title: 'Tool: agent-reach/send_message', status: 'in_progress',
      rawInput: { server: 'agent-reach', tool: 'send_message', arguments: { to: 'Ted', body: 'hi' } },
    });
    const mcp = await ask({
      toolCallId: 'call_c1', title: 'Approve send_message', status: 'pending',
      rawInput: { server_name: 'agent-reach', id: 'mcp_tool_call_approval_call_c1', request: { message: 'Allow?' } },
    });
    notifyUpdate(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'call_c2', title: 'Tool: agent-reach/send_message', kind: 'execute',
      status: 'pending', rawInput: { command: ['sh', '-c', 'agent-comms send'] },
    });
    const exec = await ask({
      toolCallId: 'call_c2', title: 'Tool: agent-reach/send_message', kind: 'execute', status: 'pending',
      rawInput: { server_name: 'agent-reach', command: ['sh', '-c', 'agent-comms send'] },
    });
    notifyUpdate(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'call_c3', title: 'Tool: user-server/send_message', status: 'in_progress',
      rawInput: { server: 'user-server', tool: 'send_message', arguments: {} },
    });
    const foreign = await ask({
      toolCallId: 'call_c3', title: 'Approve send_message', status: 'pending',
      rawInput: { server_name: 'user-server', id: 'mcp_tool_call_approval_call_c3' },
    });
    chunk(sessionId, `mcp:${mcp.outcome.optionId} exec:${exec.outcome.optionId} foreign:${foreign.outcome.optionId}`);
    return { stopReason: 'end_turn' };
  }

  // @agentclientprotocol/codex-acp 2.1.1, as captured live (#384): an MCP
  // call is announced kind 'execute', titled `mcp.<server>.<tool>`, with
  // `_meta.is_mcp_tool_call`; its approval request carries only the call id,
  // kind 'execute' and the request-level `_meta.is_mcp_tool_approval`. A
  // shell call is announced 'Run command' with no MCP marker.
  if (text === 'codex2-mcp-permission') {
    const ask = (toolCall, meta) => request('session/request_permission', {
      sessionId,
      toolCall,
      ...(meta ? { _meta: meta } : {}),
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
      ],
    });
    const announce = (toolCallId, title, rawInput, mcpCall) => notifyUpdate(sessionId, {
      sessionUpdate: 'tool_call', toolCallId, kind: 'execute', title, status: 'in_progress', rawInput,
      ...(mcpCall ? { _meta: { is_mcp_tool_call: true } } : {}),
    });
    const approval = { is_mcp_tool_approval: true };
    announce('exec-m1', 'mcp.agent-reach.send_message',
      { server: 'agent-reach', tool: 'send_message', arguments: { to: 'Ted', body: 'hi' } }, true);
    const mcp = await ask({ toolCallId: 'exec-m1', kind: 'execute', status: 'pending' }, approval);
    announce('exec-m2', 'Run command', { command: 'agent-comms send', cwd: '/tmp' }, false);
    const exec = await ask({ toolCallId: 'exec-m2', title: 'Run command', kind: 'execute', status: 'pending' });
    announce('exec-m3', 'mcp.agent-reach.send_message',
      { server: 'agent-reach', tool: 'send_message', arguments: {} }, false);
    const unmarked = await ask({ toolCallId: 'exec-m3', kind: 'execute', status: 'pending' }, approval);
    announce('exec-m4', 'mcp.user-server.send_message', { server: 'user-server', tool: 'send_message', arguments: {} }, true);
    const foreign = await ask({ toolCallId: 'exec-m4', kind: 'execute', status: 'pending' }, approval);
    chunk(sessionId, `mcp:${mcp.outcome.optionId} exec:${exec.outcome.optionId} unmarked:${unmarked.outcome.optionId} foreign:${foreign.outcome.optionId}`);
    return { stopReason: 'end_turn' };
  }

  // opencode v1.18.34 `opencode acp`: an MCP tool's key `<server>_<tool>` is
  // the title of both its tool_call and its permission request, kind 'other'.
  // external_directory's title is model-chosen, but it rides on the call id
  // of the shell (execute) call that triggered it.
  if (text === 'opencode-mcp-permission') {
    const ask = (toolCall) => request('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    notifyUpdate(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'call_o1', title: 'agent-reach_send_message', kind: 'other',
      status: 'pending', locations: [], rawInput: { to: 'Ted', body: 'hi' },
    });
    const mcp = await ask({ toolCallId: 'call_o1', title: 'agent-reach_send_message', kind: 'other', status: 'pending', locations: [], rawInput: {} });
    notifyUpdate(sessionId, {
      sessionUpdate: 'tool_call', toolCallId: 'call_o2', title: 'ls ../elsewhere', kind: 'execute',
      status: 'pending', locations: [], rawInput: { command: 'ls ../elsewhere', description: 'agent-reach_send_message' },
    });
    const outside = await ask({
      toolCallId: 'call_o2', title: 'agent-reach_send_message', kind: 'other', status: 'pending', locations: [],
      rawInput: { description: 'agent-reach_send_message' },
    });
    const unannounced = await ask({ toolCallId: 'call_o3', title: 'agent-reach_fleet', kind: 'other', status: 'pending', locations: [], rawInput: {} });
    chunk(sessionId, `mcp:${mcp.outcome.optionId} outside:${outside.outcome.optionId} unannounced:${unannounced.outcome.optionId}`);
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
    // The pid lets tree-termination tests verify this process actually died.
    chunk(sessionId, `pid:${process.pid}`);
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
    return { sessionId, ...(models ? { models } : {}) };
  }
  if (method === 'session/load') {
    sessions.set(params.sessionId, { cwd: params.cwd, mcpServers: params.mcpServers, loaded: true });
    // History replay: the engine must NOT re-record this as a fresh event.
    chunk(params.sessionId, 'replayed-history-line');
    return models ? { models } : {};
  }
  if (method === 'session/set_model') {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session ${params.sessionId}`);
    (session.modelRequests ??= []).push(params);
    if (process.env.FAKE_ACP_MODEL_ERROR) throw new Error('model unavailable');
    session.model = params.modelId;
    return {};
  }
  if (method === 'session/set_mode') {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session ${params.sessionId}`);
    session.mode = params.modeId;
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
// FAKE_FLUSH_FILE stands in for a harness that writes its session log only
// as it exits (Claude Code): a moment after stdin closes or, with
// FAKE_IGNORE_EOF, only on SIGTERM. FAKE_IGNORE_TERM ignores SIGTERM too.
const flush = () => {
  if (process.env.FAKE_FLUSH_FILE) writeFileSync(process.env.FAKE_FLUSH_FILE, 'flushed\n');
  process.exit(0);
};
process.on('SIGTERM', () => {
  if (process.env.FAKE_IGNORE_TERM !== '1') flush();
});
lines.on('close', () => {
  if (process.env.FAKE_IGNORE_EOF === '1') {
    setInterval(() => {}, 1_000);
    return;
  }
  setTimeout(flush, process.env.FAKE_FLUSH_FILE ? 100 : 0);
});
