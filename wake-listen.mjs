#!/usr/bin/env node

// The session's socket at the daemon's wake plane (#257, ADR-0008 decision 8).
//
// A session sits in the warm pool only while a listener holds a WebSocket open
// at `GET <daemon>/v0/wake`. This module is that listener. It prints one NDJSON
// line per frame, so any harness can run it under its own persistent watcher —
// Claude Code's Monitor — and read wakes without speaking WebSocket itself.
//
// The listener is cattle and the session is a pet. Nothing here acts on a wake:
// `agent-hooks/session-start/20-arm-wake` injects the standing instruction that
// tells the session to arm this command and what to do with each line.
//
// Node's global WebSocket cannot set request headers, and the binding secret
// travels in `x-agent-binding`, so the client half of RFC 6455 is written out
// here over node:http: handshake through the `upgrade` event, masked outgoing
// frames, pong answers to pings, and text-frame parsing. Zero npm
// dependencies, like the rest of this runtime.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { resolveAgentSlug } from './resolve-agent.mjs';

export const WAKE_PATH = '/v0/wake';
export const BINDING_FILE = 'agent-binding.json';
// A spawned soul's own binding, handed to it by its parent. When set it wins
// over the worktree's file: the child is the child, not the parent.
export const BINDING_ENV = 'AGENT_BOT_BINDING';
export const BINDING_HEADER = 'x-agent-binding';

const SCHEMA_VERSION = 1;
const HANDSHAKE_TIMEOUT_MS = 10_000;
// A wake is one coalesced line of JSON. Anything larger is a bug or an attack,
// and buffering it unbounded is how a loopback socket becomes a memory lever.
const MAX_FRAME_BYTES = 1 << 20;

export const BACKOFF = Object.freeze({ initialMs: 250, maxMs: 15_000, factor: 2 });

export const OPCODE = Object.freeze({
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
});

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function wakeHelpText() {
  return `Usage: agent-bot wake listen [options]
       agent-bot wake session-context [--harness <key>]

listen           Hold the session's socket at the daemon's wake plane and print
                 one NDJSON line per frame: connected, each wake, disconnected.
                 Run it under the harness's persistent watcher; the session is
                 warm only while it runs. Reconnects with capped backoff, and
                 exits nonzero when this worktree has no binding.
session-context  Print the SessionStart hook line that tells a session in bot
                 territory to arm the listener. Silent — exit 0 and no output —
                 outside bot territory or without a binding.

Options:
  --harness <key>  Harness key that words the injected instruction
                   (default: $AGENT_HOOK_HARNESS)
  -h, --help       Show this help
`;
}

export function parseWakeArgs(argv = []) {
  const [operation, ...rest] = argv;
  if (operation === undefined || operation === 'help' || operation === '--help' || operation === '-h') {
    return { kind: 'help' };
  }
  if (operation !== 'listen' && operation !== 'session-context') {
    throw new Error('usage: agent-bot wake <listen|session-context> [--harness <key>]');
  }
  const options = { harness: null };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--help' || token === '-h') return { kind: 'help' };
    if (token !== '--harness') throw new Error(`unknown option: ${token}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--harness requires a value');
    options.harness = value;
    index += 1;
  }
  return { kind: operation, ...options };
}

// --- the binding -----------------------------------------------------------------

function defaultGit(args, { cwd }) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// SEAM for #253, which owns the persisted binding file this reads. The shape and
// the checks here are ADR-0008 decision 1 and 2 as written; when #253 lands its
// `readBinding`, this function is deleted and its helper imported instead, and
// nothing else in this module changes — every caller goes through it.
export function bindingPath({ env = process.env, cwd = process.cwd(), git = defaultGit } = {}) {
  const stated = typeof env[BINDING_ENV] === 'string' ? env[BINDING_ENV].trim() : '';
  if (stated) return path.resolve(cwd, stated);
  try {
    const dir = (git(['rev-parse', '--absolute-git-dir'], { cwd }) ?? '').trim();
    return dir === '' ? null : path.join(dir, BINDING_FILE);
  } catch {
    // Not a worktree, or no git at all: that is an absent binding, not a fault.
    return null;
  }
}

// The binding file is a credential, so it is read the way a credential is read:
// regular file, owned by this user, no group or other bits. Anything else fails
// closed rather than presenting a secret nobody should have been able to read.
export function readBinding({
  env = process.env,
  cwd = process.cwd(),
  git = defaultGit,
  lstat = lstatSync,
  read = readFileSync,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const file = bindingPath({ env, cwd, git });
  if (!file) return null;
  let stat;
  try {
    stat = lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`the binding at ${file} could not be inspected: ${error.message}`);
  }
  if (!stat.isFile()) {
    // lstat, so this is a symlink or a directory: either way it is not the file
    // the daemon wrote, and following it would present someone else's secret.
    throw new Error(`the binding at ${file} is not a regular file`);
  }
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`the binding at ${file} is owned by uid ${stat.uid}, not this user (${uid})`);
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0 || (mode & 0o400) === 0) {
    throw new Error(
      `the binding at ${file} is mode 0${mode.toString(8)}; the daemon writes it 0600`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(read(file, 'utf8'));
  } catch (error) {
    // A JSON parse error can quote file contents, and the file holds a secret.
    throw new Error(`the binding at ${file} could not be read: ${error.code ?? 'not valid JSON'}`);
  }
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.v !== SCHEMA_VERSION
    || typeof parsed.agentId !== 'string' || parsed.agentId === ''
    || typeof parsed.daemon !== 'string' || parsed.daemon === ''
    || typeof parsed.secret !== 'string' || parsed.secret === ''
  ) {
    throw new Error(`the binding at ${file} has an unsupported shape`);
  }
  return {
    path: file,
    v: SCHEMA_VERSION,
    agentId: parsed.agentId,
    parent: typeof parsed.parent === 'string' && parsed.parent !== '' ? parsed.parent : null,
    account: typeof parsed.account === 'string' && parsed.account !== '' ? parsed.account : null,
    daemon: parsed.daemon,
    secret: parsed.secret,
  };
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]']);

export function isLoopbackHost(hostname) {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

// The daemon is loopback-only (ADR-0002), and the binding secret rides in a
// header. A binding file that names a remote host is therefore either corrupt
// or an attempt to walk the secret out of the account, and neither deserves a
// connection.
export function wakeUrl(daemon) {
  const url = new URL(WAKE_PATH, daemon);
  if (url.protocol !== 'http:') {
    throw new Error(`the daemon URL must be loopback http, not ${url.protocol}`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(`refusing to present the binding to a non-loopback host: ${url.hostname}`);
  }
  return url.toString();
}

// --- the client half of RFC 6455 -------------------------------------------------

export function websocketAccept(key) {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

// Every frame a client sends is masked (RFC 6455 5.1); a server must fail the
// connection on an unmasked one. The mask is a per-frame random key, not
// encryption, and nothing here treats it as such.
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  const maskKey = randomBytes(4);
  const wide = body.length >= 126;
  const huge = body.length > 0xffff;
  const header = Buffer.alloc(huge ? 10 : wide ? 4 : 2);
  header[0] = 0x80 | opcode; // FIN — this client never fragments on purpose
  header[1] = 0x80 | (huge ? 127 : wide ? 126 : body.length);
  if (wide && !huge) header.writeUInt16BE(body.length, 2);
  if (huge) header.writeBigUInt64BE(BigInt(body.length), 2);
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= maskKey[index & 3];
  return Buffer.concat([header, maskKey, masked]);
}

function closePayload(code, reason = '') {
  const bytes = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + bytes.length);
  payload.writeUInt16BE(code, 0);
  bytes.copy(payload, 2);
  return payload;
}

// Incremental: a socket delivers frames in whatever chunks the kernel felt like,
// so `push` parses what is complete and keeps the tail for the next chunk.
export function createFrameParser(onFrame) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      for (;;) {
        const frame = readFrame(pending);
        if (!frame) return;
        pending = pending.subarray(frame.total);
        onFrame(frame);
      }
    },
  };
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  if ((buffer[0] & 0x70) !== 0) throw new Error('a WebSocket frame set reserved bits');
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const declared = buffer.readBigUInt64BE(offset);
    offset += 8;
    if (declared > BigInt(MAX_FRAME_BYTES)) {
      throw new Error(`a WebSocket frame declared ${declared} bytes, over the ${MAX_FRAME_BYTES} cap`);
    }
    length = Number(declared);
  }
  if (length > MAX_FRAME_BYTES) {
    throw new Error(`a WebSocket frame declared ${length} bytes, over the ${MAX_FRAME_BYTES} cap`);
  }
  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  // A server must not mask what it sends; unmasking anyway costs nothing and
  // keeps the parser honest against a peer that got that half backwards.
  if (maskKey) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index & 3];
  }
  return { fin, opcode, payload, total: offset + length };
}

// Wire a live socket into the frame protocol. Returns a handle whose `closed`
// promise resolves exactly once, with the reason the stream ended — the loop
// above it reconnects on every resolution but a local stop.
function attachWakeSocket({ socket, head, onOpen = null, onText, onPing }) {
  let fragments = [];
  let fragmentOpcode = null;
  let finished = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const send = (opcode, payload) => {
    if (!socket.destroyed) socket.write(encodeFrame(opcode, payload));
  };
  const finish = (info) => {
    if (finished) return;
    finished = true;
    socket.destroy();
    resolveClosed(info);
  };
  const deliver = (opcode, payload) => {
    // The wake plane is text-only JSON. A binary frame is not an error worth
    // dropping the socket over, and not something to print as a wake either.
    if (opcode === OPCODE.text) onText(payload.toString('utf8'));
  };
  const parser = createFrameParser((frame) => {
    switch (frame.opcode) {
      case OPCODE.text:
      case OPCODE.binary:
        if (frame.fin) {
          deliver(frame.opcode, frame.payload);
          return;
        }
        fragments = [frame.payload];
        fragmentOpcode = frame.opcode;
        return;
      case OPCODE.continuation:
        fragments.push(frame.payload);
        if (!frame.fin) return;
        deliver(fragmentOpcode ?? OPCODE.text, Buffer.concat(fragments));
        fragments = [];
        fragmentOpcode = null;
        return;
      case OPCODE.ping:
        // Answering pings is what keeps a daemon that health-checks its wake
        // sockets from dropping an otherwise idle session out of the warm pool.
        send(OPCODE.pong, frame.payload);
        onPing?.(frame.payload);
        return;
      case OPCODE.pong:
        return;
      case OPCODE.close: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        send(OPCODE.close, closePayload(code));
        finish({ code, reason: reason || 'the daemon closed the wake socket' });
        return;
      }
      default:
        finish({ code: 1002, reason: `unknown WebSocket opcode 0x${frame.opcode.toString(16)}` });
    }
  });
  const feed = (chunk) => {
    try {
      parser.push(chunk);
    } catch (error) {
      finish({ code: 1002, reason: error.message });
    }
  };
  socket.on('data', feed);
  socket.once('end', () => finish({ code: 1006, reason: 'the daemon ended the wake stream' }));
  socket.once('error', (error) => finish({ code: 1006, reason: error.message }));
  socket.once('close', () => finish({ code: 1006, reason: 'the wake socket closed' }));
  // Announced before the handover bytes: the 101 response can already carry
  // frames, and a wake must never be printed ahead of the connection it rode.
  onOpen?.();
  if (head && head.length > 0) feed(head);
  return {
    socket,
    closed,
    sendText(text) {
      send(OPCODE.text, Buffer.from(text, 'utf8'));
    },
    sendClose(code = 1000, reason = '') {
      if (finished) return;
      send(OPCODE.close, closePayload(code, reason));
      finish({ code, reason: reason || 'the listener stopped', local: true });
    },
  };
}

export function connectWake({
  url,
  headers = {},
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  signal = null,
  onOpen = null,
  onText,
  onPing = null,
}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const key = randomBytes(16).toString('base64');
    let settled = false;
    const req = request({
      protocol: target.protocol,
      // url.hostname keeps the brackets around an IPv6 literal; net.connect
      // wants the bare address.
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port === '' ? 80 : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      // No keep-alive agent: this request is an upgrade, and pooling it would
      // leave a socket nothing can reuse.
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
        ...headers,
      },
    });
    const onAbort = () => {
      req.destroy(new Error('the listener stopped'));
    };
    const settle = (outcome) => {
      // The listener reconnects for the life of the session, so a handler left
      // on the signal every attempt would pile up until Node warned about it.
      signal?.removeEventListener('abort', onAbort);
      if (settled) return false;
      settled = true;
      outcome();
      return true;
    };
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('the wake handshake timed out'));
    });
    req.once('error', (error) => {
      settle(() => reject(error));
    });
    // A plain HTTP answer means the daemon refused the upgrade — an unknown
    // route, or a binding secret it does not recognize.
    req.once('response', (res) => {
      res.resume();
      settle(() => reject(new Error(`the daemon answered HTTP ${res.statusCode} instead of upgrading`)));
    });
    req.once('upgrade', (res, socket, headBuffer) => {
      // The accept value proves the peer is a WebSocket server that read our
      // key, not something that answers every upgrade with 101.
      const accepted = res.headers['sec-websocket-accept'] === websocketAccept(key);
      if (!accepted) {
        settle(() => reject(new Error('the daemon did not complete the WebSocket handshake')));
        socket.destroy();
        return;
      }
      // Already settled means the listener stopped mid-handshake: this socket
      // belongs to nobody, so it is closed and never handed over.
      if (!settle(() => resolve(attachWakeSocket({ socket, head: headBuffer, onOpen, onText, onPing })))) {
        socket.destroy();
      }
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

// --- the listener ----------------------------------------------------------------

export function backoffDelay(attempt, { initialMs, maxMs, factor } = BACKOFF) {
  if (attempt <= 0) return initialMs;
  return Math.min(maxMs, initialMs * factor ** attempt);
}

function writeLine(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

// One frame, one line, whatever the daemon put in it. A frame that is JSON
// arrives verbatim (re-encoded, so a pretty-printed frame cannot break NDJSON);
// a frame that is not is wrapped rather than printed raw, because a harness
// reading this stream line by line must never meet a half a line.
export function frameLine(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* not JSON — wrapped below */
  }
  return { event: 'frame', text };
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', resolve);
      resolve();
    }, ms);
    signal?.addEventListener('abort', resolve, { once: true });
  });
}

async function oneAttempt({ binding, url, connect, stdout, signal }) {
  // Announced from inside the handshake, not after it resolves: the 101
  // response can already carry frames, and a wake must never be printed ahead
  // of the connection it rode in on.
  let announced = false;
  const onOpen = () => {
    if (announced) return;
    announced = true;
    writeLine(stdout, { event: 'connected', agentId: binding.agentId });
  };
  let connection;
  try {
    connection = await connect({
      url,
      headers: { [BINDING_HEADER]: binding.secret },
      signal,
      onOpen,
      onText: (text) => writeLine(stdout, frameLine(text)),
    });
  } catch (error) {
    return { reason: error.message, connected: false };
  }
  // A connect that announces nothing — an injected fake, say — is still
  // announced here, before any frame it may already have delivered.
  onOpen();
  const stop = () => connection.sendClose(1000, 'listener stopping');
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  const info = await connection.closed;
  signal?.removeEventListener('abort', stop);
  return { reason: info.reason ?? `closed with code ${info.code}`, code: info.code, connected: true };
}

// Hold the socket for as long as the caller wants it held. Resolves with the
// process exit code: 0 when the listener was stopped, 1 when there was never a
// binding to present.
export async function listenWake({
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  readBinding: read = readBinding,
  connect = connectWake,
  sleep = defaultSleep,
  signal = null,
  backoff = BACKOFF,
} = {}) {
  let binding;
  try {
    binding = read({ env, cwd });
  } catch (error) {
    stderr.write(`wake: ${error.message}\n`);
    return 1;
  }
  if (!binding) {
    // Fail closed and say which of the two names to look for: an unbound
    // worktree is a setup state, not a runtime fault, and a harness watching
    // this stream needs the word rather than a stack.
    stderr.write(
      `wake: unbound — no ${BINDING_FILE} for this worktree and no ${BINDING_ENV}; `
        + 'bind the worktree before arming a listener\n',
    );
    return 1;
  }
  // Validated once, up front, and never re-derived from a refreshed binding
  // unless it validates too. A non-loopback daemon is not a transient
  // condition, so retrying it would spin forever printing disconnects while
  // the one property that makes the secret safe to present is missing.
  let url;
  try {
    url = wakeUrl(binding.daemon);
  } catch (error) {
    stderr.write(`wake: ${error.message}\n`);
    return 1;
  }
  let attempt = 0;
  while (!signal?.aborted) {
    const dropped = await oneAttempt({ binding, url, connect, stdout, signal });
    if (signal?.aborted) {
      writeLine(stdout, { event: 'stopped' });
      return 0;
    }
    const retryInMs = backoffDelay(attempt, backoff);
    // A connection that was up and dropped starts the backoff over, so a daemon
    // restart costs one short wait. One that never upgraded keeps growing the
    // delay toward the cap instead of hammering a daemon that is not there.
    attempt = dropped.connected ? 0 : attempt + 1;
    writeLine(stdout, { event: 'disconnected', reason: dropped.reason, retryInMs });
    // Re-read before retrying. The daemon rewrites `daemon` in every binding it
    // still knows when it starts, so a restart moves the port, and a listener
    // holding the old URL would reconnect to nothing forever.
    try {
      const refreshed = read({ env, cwd });
      if (refreshed) {
        // Throwing here keeps the last good loopback URL, which is the point:
        // a rewrite that would walk the secret somewhere else is reported and
        // then ignored, not connected to.
        url = wakeUrl(refreshed.daemon);
        binding = refreshed;
      }
    } catch (error) {
      stderr.write(`wake: ${error.message}\n`);
    }
    await sleep(retryInMs, signal);
  }
  writeLine(stdout, { event: 'stopped' });
  return 0;
}

// --- the SessionStart instruction ------------------------------------------------

// Named where the harness names its watcher, generic where it does not. The
// instruction has to be actionable by the model reading it, and "under Monitor"
// is actionable in Claude Code the way "a background task" is not.
const PERSISTENT_WATCHERS = {
  claude: 'the Monitor tool',
  codex: 'a background shell task',
  cursor: 'a background task',
  copilot: 'a background task',
  'devin-desktop': 'a background task',
};

export function wakeInstruction({ harness = null } = {}) {
  const watcher = PERSISTENT_WATCHERS[harness] ?? 'a persistent background task';
  return (
    `agent-bot wake: arm \`agent-bot wake listen\` under ${watcher} and leave it running for this `
    + "whole session — that socket is this session's place in the daemon's warm pool, and nothing "
    + 'else keeps it warm. On each `wake` line it prints, run `agent-comms inbox --full`, act on '
    + 'those messages, then ack them; a `disconnected` line is not fatal, the listener reconnects '
    + 'by itself. Arm it in the background — never run it in the foreground of a turn.'
  );
}

// What the SessionStart hook injects, and the two conditions under which it
// stays silent. Returns `{ context, note }`: `context` null means say nothing
// to the model, `note` non-null means say something on stderr.
export function sessionContext({
  env = process.env,
  cwd = process.cwd(),
  harness = null,
  readBinding: read = readBinding,
  resolveSlug = resolveAgentSlug,
  git = defaultGit,
} = {}) {
  // A stated --harness wins; the runner's env mirror is the fallback that makes
  // the hook shim need no arguments.
  const wordingHarness = harness ?? env.AGENT_HOOK_HARNESS ?? null;
  // Bot territory is a stated identity, never an inference — this runs on every
  // session start including a human's, so detection is off, the same rule the
  // gh shim and hook-driven worktree setup follow.
  let slug;
  try {
    slug = resolveSlug({ env, cwd, git, detect: false });
  } catch (error) {
    return { context: null, note: error.message };
  }
  if (!slug) return { context: null, note: null };
  let binding;
  try {
    binding = read({ env, cwd, git });
  } catch (error) {
    // An unusable binding is worth a line on stderr and nothing more: this is
    // an advisory event, and a session start must not fail over a wake plane.
    return { context: null, note: error.message };
  }
  if (!binding) return { context: null, note: null };
  return {
    context: wakeInstruction({ harness: wordingHarness }),
    note: null,
    slug,
    agentId: binding.agentId,
  };
}

function sessionContextCommand({
  stdout,
  stderr,
  env,
  cwd,
  harness,
  readBinding: read = readBinding,
  resolveSlug = resolveAgentSlug,
}) {
  const result = sessionContext({ env, cwd, harness, readBinding: read, resolveSlug });
  if (result.note) stderr.write(`wake: ${result.note}\n`);
  if (!result.context) return 0;
  // The runner's own protocol, one line: the hook is a shim, and which dialect
  // carries the text to the model is agent-hook's decision, not this one's.
  stdout.write(`agent-hook: ${JSON.stringify({ decision: 'allow', context: result.context })}\n`);
  return 0;
}

export async function main(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    cwd = process.cwd(),
    signal = null,
    readBinding: read = readBinding,
    resolveSlug = resolveAgentSlug,
    connect = connectWake,
    sleep = defaultSleep,
  } = {},
) {
  const parsed = parseWakeArgs(argv);
  if (parsed.kind === 'help') {
    stdout.write(wakeHelpText());
    return 0;
  }
  if (parsed.kind === 'session-context') {
    return sessionContextCommand({
      stdout, stderr, env, cwd, harness: parsed.harness, readBinding: read, resolveSlug,
    });
  }
  return listenWake({ env, cwd, stdout, stderr, signal, readBinding: read, connect, sleep });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  // A watcher stops this by signal. Closing the socket politely on the way out
  // is what lets the daemon see the session leave the warm pool immediately
  // instead of at TCP timeout.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => controller.abort());
  }
  main(process.argv.slice(2), { signal: controller.signal })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`wake: ${error.message}\n`);
      process.exitCode = 1;
    });
}
