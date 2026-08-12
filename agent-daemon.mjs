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
//
// v1 adds the transport-neutral interaction contract (#55): sessions,
// messages, invocation status, ordered events, cancellation, and artifact
// references, served by agent-interaction.mjs over the durable job store
// (agent-jobs.mjs) with deny-by-default principal authorization
// (agent-principals.mjs). /v0 semantics are unchanged. Requests carry the
// adapter-authenticated (transport, providerId) pair; the daemon resolves it
// to a locally enrolled principal and refuses everything else — nothing on
// this remote surface can enroll a principal or widen an authorization.
//
// /ui/... serves the private web client (#59) from agent-web.mjs: static PWA
// assets plus a cookie-authenticated JSON API over the same interaction
// service. /ui routes never see the bearer token — browser auth is a local
// pairing ceremony — and they change nothing about the loopback boundary:
// the same peer check runs before any /ui routing.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { initAgentSpace, spacePath } from './agent-space.mjs';
import { listSouls, upsertIdentitySoul } from './agent-population.mjs';
import { stateDirectory, validateAgentId } from './agent-identity.mjs';
import { createInteractionService } from './agent-interaction.mjs';
import { recoverInteractionStore } from './agent-jobs.mjs';
import { appendAuditReceipt, principalsFile, resolvePrincipal } from './agent-principals.mjs';
import { createWebLayer } from './agent-web.mjs';

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
  const host = parsed?.host ?? '127.0.0.1';
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0
    || !Number.isSafeInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65535
    || typeof parsed.token !== 'string' || parsed.token.length < 32
    || typeof parsed.startedAt !== 'string'
    || !LOOPBACK_HOSTS.has(host)
  ) {
    throw new Error('daemon state file has an unsupported shape');
  }
  return { schemaVersion: SCHEMA_VERSION, pid: parsed.pid, host, port: parsed.port, token: parsed.token, startedAt: parsed.startedAt };
}

// The daemon may legitimately bind ::1; probes and clients must dial whatever
// the state file records instead of assuming IPv4.
function baseUrl(state) {
  const host = state.host === '::1' ? '[::1]' : state.host;
  return `http://${host}:${state.port}`;
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
  executor,
  now = () => new Date(),
} = {}) {
  // One interaction service per server so in-flight executions and their
  // cancellation controllers live exactly as long as the daemon.
  const interaction = createInteractionService({ env, home, config, executor, now });
  // The private web client (#59) rides the same server and the same loopback
  // peer check; it authenticates browsers with its own pairing-code cookie
  // sessions instead of the bearer token, which never reaches page script.
  const web = createWebLayer({ env, home, config, interaction, daemonToken: token, now });
  const server = createServer(async (req, res) => {
    try {
      if (!isLoopbackPeer(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'loopback peers only' });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/ui' || url.pathname.startsWith('/ui/')) {
        await web.handle(req, res, url);
        return;
      }
      const authorization = req.headers.authorization ?? '';
      const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!tokensMatch(token, presented)) {
        sendJson(res, 401, { error: 'missing or invalid daemon token' });
        return;
      }
      if (url.pathname.startsWith('/v1/')) {
        await handleInteractionRequest({ req, res, url, interaction, env, home });
        return;
      }
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

// Versioned /v1 interaction routes (#55). The transport adapter authenticates
// the provider identity and forwards only the normalized (transport,
// providerId) pair — in the body for POSTs, in the query for GETs. The daemon
// resolves that pair to a locally enrolled principal, deny-by-default; the
// interaction service then authorizes each operation before any soul lookup
// or job mutation. Errors are stable and never reflect request contents.
async function handleInteractionRequest({ req, res, url, interaction, env, home }) {
  const body = req.method === 'POST' ? parseJsonBody(await readBody(req)) : null;
  const transport = body ? body.transport : url.searchParams.get('transport');
  const providerId = body ? body.providerId : url.searchParams.get('providerId');
  let principal;
  try {
    principal = resolvePrincipal({ transport, providerId }, { file: principalsFile({ env, home }) });
  } catch {
    throw Object.assign(new Error('invalid transport principal'), { statusCode: 400 });
  }
  if (!principal) {
    // No principal, no route: the refusal is recorded but indistinguishable
    // from any other authorization failure to the caller.
    appendAuditReceipt({ event: 'denied-request', transport, decision: 'denied' }, { env, home });
    sendJson(res, 403, { error: 'principal is not authorized for this operation' });
    return;
  }
  let match;
  if (req.method === 'POST' && url.pathname === '/v1/sessions') {
    sendJson(res, 200, interaction.createOrContinueSession({
      principal,
      transport,
      agentId: body.agentId,
      sessionId: body.sessionId ?? null,
    }));
    return;
  }
  if (req.method === 'POST' && (match = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/))) {
    sendJson(res, 200, interaction.submitMessage({
      principal,
      transport,
      sessionId: match[1],
      message: body.message,
      idempotencyKey: body.idempotencyKey,
      attachments: body.attachments,
    }));
    return;
  }
  if (req.method === 'GET' && (match = url.pathname.match(/^\/v1\/invocations\/([^/]+)$/))) {
    sendJson(res, 200, interaction.getInvocation({ principal, transport, invocationId: match[1] }));
    return;
  }
  if (req.method === 'GET' && (match = url.pathname.match(/^\/v1\/invocations\/([^/]+)\/events$/))) {
    const after = url.searchParams.get('after');
    sendJson(res, 200, interaction.readEvents({
      principal,
      transport,
      invocationId: match[1],
      afterSeq: after === null ? 0 : Number(after),
    }));
    return;
  }
  if (req.method === 'POST' && (match = url.pathname.match(/^\/v1\/invocations\/([^/]+)\/cancel$/))) {
    sendJson(res, 200, await interaction.cancelInvocation({ principal, transport, invocationId: match[1] }));
    return;
  }
  if (req.method === 'GET' && (match = url.pathname.match(/^\/v1\/invocations\/([^/]+)\/artifacts$/))) {
    sendJson(res, 200, interaction.listArtifacts({ principal, transport, invocationId: match[1] }));
    return;
  }
  sendJson(res, 404, { error: 'unknown route' });
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
    const res = await fetchImpl(`${baseUrl(state)}/v0/health`, {
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
  async function request(method, pathname, body) {
    // Re-read the state file on every request: a long-running adapter must
    // follow a daemon restart to its new port and per-start token instead of
    // failing forever against a cached endpoint.
    const state = readStateFile(daemonStateFile({ env, home }));
    if (!state) throw new Error('daemon is not running (no state file)');
    const res = await fetchImpl(`${baseUrl(state)}${pathname}`, {
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
    // v1 interaction contract (#55). Adapters authenticate their provider
    // identity and pass the normalized pair on every call; the daemon owns
    // principal resolution and authorization.
    async createSession({ transport, providerId, agentId, sessionId = null }) {
      return request('POST', '/v1/sessions', { transport, providerId, agentId, sessionId });
    },
    async submitMessage(sessionId, { transport, providerId, message, idempotencyKey, attachments }) {
      return request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        transport, providerId, message, idempotencyKey, attachments,
      });
    },
    async invocation(invocationId, { transport, providerId }) {
      return request('GET', `/v1/invocations/${encodeURIComponent(invocationId)}?${new URLSearchParams({ transport, providerId })}`);
    },
    async events(invocationId, { transport, providerId, afterSeq = 0 }) {
      const params = new URLSearchParams({ transport, providerId, after: String(afterSeq) });
      return request('GET', `/v1/invocations/${encodeURIComponent(invocationId)}/events?${params}`);
    },
    async cancel(invocationId, { transport, providerId }) {
      return request('POST', `/v1/invocations/${encodeURIComponent(invocationId)}/cancel`, { transport, providerId });
    },
    async artifacts(invocationId, { transport, providerId }) {
      return request('GET', `/v1/invocations/${encodeURIComponent(invocationId)}/artifacts?${new URLSearchParams({ transport, providerId })}`);
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
  // Reconcile jobs orphaned by a previous daemon before accepting new work
  // (#56 req 8): executing work becomes failed, never-dispatched queued work
  // becomes failed with its own stable reason, and pending cancellations
  // become cancelled — nothing is silently stranded.
  recoverInteractionStore({ env, home, now });
  const server = createDaemonServer({ env, home, config, now });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, resolve);
  });
  const file = daemonStateFile({ env, home });
  const state = {
    schemaVersion: SCHEMA_VERSION,
    pid: process.pid,
    host,
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
  // fileURLToPath, not URL.pathname: a checkout path with spaces stays
  // percent-encoded in the pathname and the child exits module-not-found
  // (and drive letters break on Windows).
  const child = spawn(process.execPath, [fileURLToPath(moduleUrl), 'run'], {
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

export async function stopDaemon({ env = process.env, home = homedir(), fetchImpl = fetch } = {}) {
  const file = daemonStateFile({ env, home });
  const state = readStateFile(file);
  if (!state) return { stopped: false, reason: 'no daemon state file' };
  // A recorded PID can be reused by an unrelated process after a crash or
  // reboot. Only the token-authenticated health probe proves the record still
  // names our daemon, so a failed probe removes the stale record and signals
  // nothing.
  if (!(await probeHealth(state, { fetchImpl }))) {
    rmSync(file, { force: true });
    return {
      stopped: false,
      reason: 'recorded daemon did not answer the authenticated health probe; removed stale state',
    };
  }
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
