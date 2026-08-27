#!/usr/bin/env node
// muse-acp (#145) — ACP agent adapter over the Muse CLI, so the drive engine
// (#144) covers Muse through the exact same code path as every other harness:
// the engine speaks newline-delimited JSON-RPC ACP to this process, and this
// process speaks `muse exec --json` per turn.
//
// Turn model (spawn-per-turn, the documented warmup cost of this lane):
//   session/new    → mint a uuid; nothing spawns until the first prompt.
//   session/prompt → `muse exec --json --session-id <uuid> --workspace <cwd>`
//                    with the prompt text; Muse's JSONL event stream is
//                    translated to ACP session/update notifications.
//   session/load   → replay the persisted session log from Muse's own store
//                    (~/.local/share/muse/sessions/<Y>/<M>/<D>/<uuid>/), then
//                    subsequent prompts exec against the same id.
//   session/cancel → terminate the in-flight exec; the prompt resolves with
//                    stopReason 'cancelled'.
//
// Verified CLI contract (probed 2026-08-27 against Muse Code 0.2.1, echoed in
// issue #145): `--session-id` continues the same persisted session stream, and
// resume is WORKSPACE-BOUND — reusing an id from a different cwd is refused
// unless `--workspace` matches, so every exec passes `--workspace <ACP cwd>`.
//
// Event translation:
//   run.output.delta                → agent_message_chunk
//   task.lifecycle.proposed         → (records task_kind for the title)
//   task.lifecycle.started          → tool_call   (skipping model.* tasks —
//                                     the model turn itself is not a tool)
//   task.lifecycle.completed/failed → tool_call_update
//   run.terminal completed          → stopReason end_turn
//   run.terminal cancelled          → stopReason cancelled
//   run.terminal anything else      → JSON-RPC error (the engine fails the
//                                     turn; a failed run is not a clean stop)
//
// Permissions: Muse has no interactive permission callback — policy is
// pre-declared on the exec invocation (workspace rooting, policy-gated
// tools). This adapter therefore NEVER issues session/request_permission and
// declares its capabilities honestly. The engine's policy still gates the
// daemon side; what Muse may touch is bounded by --workspace.
//
// Environment knobs (all optional):
//   MUSE_ACP_MUSE_BIN  — the muse executable (default 'muse'; tests point it
//                        at a scripted fake)
//   MUSE_ACP_STORE     — Muse's data dir (default ~/.local/share/muse)
//   MUSE_ACP_PROVIDER  — forwarded as --provider (echo|meta)
//   MUSE_ACP_MODEL     — forwarded as --model

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = 1;
const CANCEL_KILL_GRACE_MS = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sessions = new Map();

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function notifyUpdate(sessionId, update) {
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
}

function museStore() {
  return process.env.MUSE_ACP_STORE ?? path.join(homedir(), '.local', 'share', 'muse');
}

// Muse shards session directories by date (sessions/<Y>/<M>/<D>/<uuid>); the
// id alone addresses a session, so locating one is a bounded walk.
async function findSessionLog(sessionId) {
  const root = path.join(museStore(), 'sessions');
  let years;
  try {
    years = await readdir(root);
  } catch {
    return null;
  }
  for (const year of years) {
    let months;
    try {
      months = await readdir(path.join(root, year));
    } catch {
      continue;
    }
    for (const month of months) {
      let days;
      try {
        days = await readdir(path.join(root, year, month));
      } catch {
        continue;
      }
      for (const day of days) {
        const candidate = path.join(root, year, month, day, sessionId, 'session.jsonl');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function promptText(prompt) {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

// One live exec per session; the translation state (task titles) is per-turn.
function translateExecEvent(sessionId, record, taskKinds) {
  const type = record?.payload_type;
  const payload = record?.payload ?? {};
  if (type === 'run.output.delta' && typeof payload.text === 'string') {
    notifyUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: payload.text },
    });
    return null;
  }
  if (typeof type === 'string' && type.startsWith('task.lifecycle.')) {
    const event = payload.event ?? {};
    const taskId = typeof event.task_id === 'string' ? event.task_id : null;
    if (taskId === null) return null;
    if (event.kind === 'proposed' && typeof event.task_kind === 'string') {
      taskKinds.set(taskId, event.task_kind);
      return null;
    }
    const kind = taskKinds.get(taskId);
    if (typeof kind !== 'string' || kind.startsWith('model.')) return null;
    if (event.kind === 'started') {
      notifyUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: taskId,
        title: kind,
        kind: 'other',
      });
    } else if (event.kind === 'completed' || event.kind === 'failed') {
      notifyUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: taskId,
        status: event.kind,
      });
    }
    return null;
  }
  if (typeof type === 'string' && type.startsWith('run.terminal.')) {
    return {
      terminal: typeof payload.terminal === 'string' ? payload.terminal : 'unknown',
      reason: typeof payload.reason === 'string' ? payload.reason : null,
    };
  }
  return null;
}

function runExec(session, sessionId, text) {
  return new Promise((resolve, reject) => {
    const bin = process.env.MUSE_ACP_MUSE_BIN ?? 'muse';
    const args = ['exec', '--json', '--session-id', sessionId, '--workspace', session.cwd];
    if (process.env.MUSE_ACP_PROVIDER) args.push('--provider', process.env.MUSE_ACP_PROVIDER);
    if (process.env.MUSE_ACP_MODEL) args.push('--model', process.env.MUSE_ACP_MODEL);
    args.push(text);

    const child = spawn(bin, args, { cwd: session.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    session.child = child;
    session.cancelled = false;
    // A session/cancel that raced ahead of the spawn (notifications and
    // requests share one pipe and can land in the same read) still applies
    // to this turn.
    if (session.pendingCancel) {
      session.pendingCancel = false;
      cancelChild(session);
    }

    const taskKinds = new Map();
    let terminal = null;
    let stderrTail = '';
    child.stderr.on('data', (data) => {
      stderrTail = (stderrTail + data.toString()).slice(-2_048);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      terminal = translateExecEvent(sessionId, record, taskKinds) ?? terminal;
    });

    child.on('error', (error) => {
      session.child = null;
      reject(new Error(`failed to run muse: ${error.message}`));
    });
    child.on('close', () => {
      session.child = null;
      if (session.cancelled) {
        resolve({ stopReason: 'cancelled' });
        return;
      }
      if (terminal === null) {
        reject(new Error(`muse exec ended without a terminal event${stderrTail ? `: ${stderrTail.trim().slice(-512)}` : ''}`));
        return;
      }
      if (terminal.terminal === 'completed') {
        resolve({ stopReason: 'end_turn' });
      } else if (terminal.terminal === 'cancelled') {
        resolve({ stopReason: 'cancelled' });
      } else {
        reject(new Error(`muse run ${terminal.terminal}${terminal.reason ? `: ${terminal.reason}` : ''}`));
      }
    });
  });
}

// Replay for session/load: the persisted log wraps run events as
// payload {kind:'run', event:{...}} — committed assistant messages are the
// conversation history worth re-streaming.
async function replaySessionLog(sessionId, logPath) {
  const lines = createInterface({ input: createReadStream(logPath) });
  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (payload?.kind !== 'run') continue;
    const event = payload.event ?? {};
    if (event.kind === 'assistant_message_committed' && typeof event.text === 'string') {
      notifyUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: event.text },
      });
    }
  }
}

async function handle(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        // Honest: text only, and no interactive permission callback exists —
        // Muse policy is pre-declared on the exec invocation.
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
    };
  }
  if (method === 'session/new') {
    if (typeof params.cwd !== 'string' || params.cwd.length === 0) {
      throw new Error('session/new requires a cwd');
    }
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: params.cwd, child: null, cancelled: false, pendingCancel: false });
    if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
      process.stderr.write('muse-acp: mcpServers are not supported by muse exec; ignoring\n');
    }
    return { sessionId };
  }
  if (method === 'session/load') {
    const { sessionId } = params;
    if (typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId)) {
      throw new Error('session/load requires a muse session uuid');
    }
    if (typeof params.cwd !== 'string' || params.cwd.length === 0) {
      throw new Error('session/load requires a cwd');
    }
    const logPath = await findSessionLog(sessionId);
    if (logPath === null) {
      throw new Error(`no persisted muse session ${sessionId}`);
    }
    sessions.set(sessionId, { cwd: params.cwd, child: null, cancelled: false, pendingCancel: false });
    await replaySessionLog(sessionId, logPath);
    return {};
  }
  if (method === 'session/prompt') {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session ${params.sessionId}`);
    if (session.child !== null) throw new Error('a prompt is already running for this session');
    const text = promptText(params.prompt);
    if (text.length === 0) throw new Error('session/prompt requires text content');
    return runExec(session, params.sessionId, text);
  }
  throw new Error(`method not supported: ${method}`);
}

function cancelChild(session) {
  session.cancelled = true;
  const child = session.child;
  child.kill('SIGTERM');
  const hardKill = setTimeout(() => child.kill('SIGKILL'), CANCEL_KILL_GRACE_MS);
  child.once('close', () => clearTimeout(hardKill));
}

function handleCancel(params) {
  const session = sessions.get(params?.sessionId);
  if (!session) return;
  if (session.child === null) {
    // No exec in flight yet: remember the cancel so the turn it was aimed at
    // is cancelled the moment it spawns instead of silently surviving.
    session.pendingCancel = true;
    return;
  }
  cancelChild(session);
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof payload?.method !== 'string') return;
  if (payload.method === 'session/cancel') {
    handleCancel(payload.params);
    return;
  }
  if (payload.id === undefined) return;
  Promise.resolve()
    .then(() => handle(payload.method, payload.params ?? {}))
    .then((result) => write({ jsonrpc: '2.0', id: payload.id, result }))
    .catch((error) => write({
      jsonrpc: '2.0',
      id: payload.id,
      error: { code: -32000, message: error.message },
    }));
});
input.on('close', () => process.exit(0));
