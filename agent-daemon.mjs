#!/usr/bin/env node

// Local loopback daemon v0: one machine trust boundary for soul registration,
// Agent Space ensure/path, and population listing, wrapping the same on-disk
// stores the CLI uses in-process. Binding is fail-closed to loopback — there
// is no LAN mode, and a request that somehow arrives from a non-loopback peer
// is refused before it is routed. A per-start bearer token in the 0600 state
// file keeps other local accounts on a shared machine from driving the daemon
// through the (necessarily shared) loopback interface.
//
//   agent-bot daemon run             — foreground server (supervised launch)
//   agent-bot daemon start           — detach a background `run`, wait healthy
//   agent-bot daemon status [--json] — probe the recorded daemon
//   agent-bot daemon stop            — terminate the recorded daemon
//
// v0 scope per #41: register soul, space ensure, space path, population list.
// No OAuth, no remote sync, no HTTPS — loopback is the boundary (#35).

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { initAgentSpace, spacePath } from './agent-space.mjs';
import { listSouls, upsertIdentitySoul } from './agent-population.mjs';
import { stateDirectory, validateAgentId } from './agent-identity.mjs';

const SCHEMA_VERSION = 1;
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HEALTH_TIMEOUT_MS = 1_500;

export function daemonStateFile({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_DAEMON_STATE_PATH) return path.resolve(env.AGENT_BOT_DAEMON_STATE_PATH);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'daemon.json');
}

// The daemon never negotiates its bind address. Anything that is not a
// loopback literal is refused before listen(), so a configuration mistake
// cannot quietly open the population and space stores to a network.
export function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`daemon host must be a loopback literal (127.0.0.1 or ::1), not ${JSON.stringify(host)}`);
  }
  return host;
}

export function isLoopbackPeer(remoteAddress) {
  return LOOPBACK_PEERS.has(remoteAddress);
}

function readStateFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('daemon state file could not be read');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON parser messages may quote file contents; never reflect them.
    throw new Error('daemon state file is not valid JSON');
  }
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0
    || !Number.isSafeInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65535
    || typeof parsed.token !== 'string' || parsed.token.length < 32
    || typeof parsed.startedAt !== 'string'
  ) {
    throw new Error('daemon state file has an unsupported shape');
  }
  return { schemaVersion: SCHEMA_VERSION, pid: parsed.pid, port: parsed.port, token: parsed.token, startedAt: parsed.startedAt };
}

function writeStateFile(file, state) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function tokensMatch(expected, presented) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented ?? '', 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop consuming but keep the socket writable so the 413 response can
        // actually reach the client before the connection closes.
        req.removeAllListeners('data');
        req.pause();
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(raw) {
  if (raw === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('request body must be a JSON object'), { statusCode: 400 });
  }
  return parsed;
}

function requireAgentId(value) {
  try {
    return validateAgentId(value);
  } catch {
    // validateAgentId messages can reflect their input; the daemon answers
    // with a stable, non-reflecting error instead.
    throw Object.assign(new Error('invalid Agent ID'), { statusCode: 400 });
  }
}

// The store modules already keep their error messages secret-free (they never
// quote file contents), so their messages are safe to return verbatim; only
// the status code is decided here.
function operationError(error) {
  if (Number.isSafeInteger(error.statusCode)) return error;
  return Object.assign(new Error(error.message), { statusCode: 409 });
}

export function createDaemonServer({
  env = process.env,
  home = homedir(),
  config,
  token = randomBytes(32).toString('hex'),
} = {}) {
  const server = createServer(async (req, res) => {
    try {
      if (!isLoopbackPeer(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'loopback peers only' });
        return;
      }
      const authorization = req.headers.authorization ?? '';
      const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!tokensMatch(token, presented)) {
        sendJson(res, 401, { error: 'missing or invalid daemon token' });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /v0/health': {
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, status: 'ok', pid: process.pid });
          return;
        }
        case 'POST /v0/space/ensure': {
          const body = parseJsonBody(await readBody(req));
          const id = requireAgentId(body.agentId);
          const space = initAgentSpace(id, { env, home, config });
          sendJson(res, 200, { agentId: space.id, path: space.path, created: space.created });
          return;
        }
        case 'GET /v0/space/path': {
          const id = requireAgentId(url.searchParams.get('agentId'));
          sendJson(res, 200, { agentId: id, path: spacePath(id, { env, home, config }) });
          return;
        }
        case 'POST /v0/register': {
          const body = parseJsonBody(await readBody(req));
          const id = requireAgentId(body.agentId);
          if (typeof body.spacePath !== 'string' || !path.isAbsolute(body.spacePath)) {
            throw Object.assign(new Error('spacePath must be an absolute path'), { statusCode: 400 });
          }
          const soul = upsertIdentitySoul(id, body.spacePath, {
            file: populationOverride(env, home),
            stateDir: stateDirectory({ env, home }),
          });
          sendJson(res, 200, { soul });
          return;
        }
        case 'GET /v0/population': {
          const souls = listSouls({
            status: url.searchParams.get('status'),
            app: url.searchParams.get('app'),
            file: populationOverride(env, home),
          });
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, souls });
          return;
        }
        default:
          sendJson(res, 404, { error: 'unknown route' });
      }
    } catch (error) {
      const failure = operationError(error);
      sendJson(res, failure.statusCode, { error: failure.message });
    }
  });
  server.token = token;
  return server;
}

// listSouls/upsertIdentitySoul default populationFile() reads process.env; the
// daemon threads its own env/home through so tests and supervised launches see
// one consistent world, mirroring the space calls above.
function populationOverride(env, home) {
  if (env.AGENT_BOT_POPULATION_PATH) return path.resolve(env.AGENT_BOT_POPULATION_PATH);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'population.json');
}

async function probeHealth(state, { fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${state.port}/v0/health`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.status === 'ok' && body?.pid === state.pid;
  } catch {
    return false;
  }
}

export async function daemonStatus({
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const file = daemonStateFile({ env, home });
  let state;
  try {
    state = readStateFile(file);
  } catch (error) {
    return { running: false, reason: error.message };
  }
  if (!state) return { running: false, reason: 'no daemon state file' };
  if (await probeHealth(state, { fetchImpl, timeoutMs })) {
    return { running: true, pid: state.pid, port: state.port, startedAt: state.startedAt };
  }
  return { running: false, reason: 'daemon state file is stale (health probe failed)', stale: state };
}

// Thin client for callers that prefer the daemon over in-process stores (#43).
// Every method fails with a plain Error; the caller decides whether policy
// allows an in-process fallback.
export function daemonClient({
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  let state = null;
  async function request(method, pathname, body) {
    if (!state) {
      state = readStateFile(daemonStateFile({ env, home }));
      if (!state) throw new Error('daemon is not running (no state file)');
    }
    const res = await fetchImpl(`http://127.0.0.1:${state.port}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${state.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`daemon ${method} ${pathname} failed: ${payload.error ?? `HTTP ${res.status}`}`);
    return payload;
  }
  return {
    async available() {
      try {
        const status = await daemonStatus({ env, home, fetchImpl, timeoutMs });
        return status.running;
      } catch {
        return false;
      }
    },
    async ensureSpace(agentId) {
      return request('POST', '/v0/space/ensure', { agentId });
    },
    async registerSoul(agentId, spaceRoot) {
      const { soul } = await request('POST', '/v0/register', { agentId, spacePath: spaceRoot });
      return soul;
    },
    async spacePath(agentId) {
      return request('GET', `/v0/space/path?agentId=${encodeURIComponent(agentId)}`);
    },
    async population({ status = null, app = null } = {}) {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (app) params.set('app', app);
      const query = params.toString();
      const { souls } = await request('GET', `/v0/population${query ? `?${query}` : ''}`);
      return souls;
    },
  };
}

export async function runDaemon({
  env = process.env,
  home = homedir(),
  config,
  host = env.AGENT_BOT_DAEMON_HOST ?? '127.0.0.1',
  port = env.AGENT_BOT_DAEMON_PORT ?? '0',
  onListening = null,
  now = () => new Date(),
} = {}) {
  assertLoopbackHost(host);
  const requestedPort = Number(port);
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error('daemon port must be an integer between 0 and 65535');
  }
  const existing = await daemonStatus({ env, home });
  if (existing.running) {
    throw new Error(`daemon already running (pid ${existing.pid}, port ${existing.port})`);
  }
  const server = createDaemonServer({ env, home, config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, resolve);
  });
  const file = daemonStateFile({ env, home });
  const state = {
    schemaVersion: SCHEMA_VERSION,
    pid: process.pid,
    port: server.address().port,
    token: server.token,
    startedAt: now().toISOString(),
  };
  writeStateFile(file, state);
  const shutdown = () => {
    try {
      const recorded = readStateFile(file);
      // Another daemon may have replaced a stale record; only remove our own.
      if (recorded && recorded.pid === process.pid) rmSync(file, { force: true });
    } catch {
      /* an unreadable state file is not ours to preserve */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  onListening?.(state, server);
  return { server, state };
}

const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function startDaemon({ env = process.env, home = homedir(), moduleUrl = import.meta.url } = {}) {
  const existing = await daemonStatus({ env, home });
  if (existing.running) return { ...existing, alreadyRunning: true };
  const child = spawn(process.execPath, [new URL(moduleUrl).pathname, 'run'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await daemonStatus({ env, home });
    if (status.running) return { ...status, alreadyRunning: false };
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('daemon did not become healthy within the startup deadline');
}

export async function stopDaemon({ env = process.env, home = homedir() } = {}) {
  const file = daemonStateFile({ env, home });
  const state = readStateFile(file);
  if (!state) return { stopped: false, reason: 'no daemon state file' };
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') {
      rmSync(file, { force: true });
      return { stopped: false, reason: 'recorded daemon was not running; removed stale state' };
    }
    throw error;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(state.pid, 0);
    } catch {
      rmSync(file, { force: true });
      return { stopped: true, pid: state.pid };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`daemon pid ${state.pid} did not exit within the shutdown deadline`);
}

async function main() {
  const [command = 'status', ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  switch (command) {
    case 'run': {
      await runDaemon({
        onListening: (state) => {
          process.stderr.write(`agent-bot daemon listening on 127.0.0.1:${state.port} (pid ${state.pid})\n`);
        },
      });
      break;
    }
    case 'start': {
      const status = await startDaemon();
      process.stdout.write(
        status.alreadyRunning
          ? `daemon already running (pid ${status.pid}, port ${status.port})\n`
          : `daemon started (pid ${status.pid}, port ${status.port})\n`,
      );
      break;
    }
    case 'status': {
      const status = await daemonStatus();
      if (json) {
        process.stdout.write(`${JSON.stringify(status, (key, value) => (key === 'stale' ? undefined : value), 2)}\n`);
      } else if (status.running) {
        process.stdout.write(`running (pid ${status.pid}, port ${status.port}, since ${status.startedAt})\n`);
      } else {
        process.stdout.write(`not running: ${status.reason}\n`);
      }
      if (!status.running) process.exitCode = 1;
      break;
    }
    case 'stop': {
      const result = await stopDaemon();
      process.stdout.write(result.stopped ? `daemon stopped (pid ${result.pid})\n` : `${result.reason}\n`);
      break;
    }
    default:
      throw new Error('usage: agent-bot daemon <run|start|status|stop> [--json]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-daemon: ${error.message}\n`);
    process.exit(1);
  });
}
