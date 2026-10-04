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
//   agent-bot daemon vouch-key       — print the account Ed25519 public key (SPKI PEM)
//   agent-bot daemon pair-comms [--broker <account>]
//                                    — pair this account's daemon with the
//                                      agent-comms broker (prints the owner
//                                      approval code); status shows the
//                                      pairing and the account-watch link.
//   agent-bot daemon install [--json] — supervise this runtime's daemon (node
//                                      and entry as running now) under
//                                      AGENT_BOT_SERVICE_LABEL; rewritten and
//                                      reloaded only when that changed (#302)
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
//
// POST /v0/vouch (#254, ADR-0008 decision 3) sits behind that loopback gate
// but not the bearer. The caller presents a binding secret in
// x-agent-binding and receives a five-minute Ed25519 soul token. The signing
// key is created once per account; `daemon vouch-key` prints its SPKI form.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertPrivateGitDir, childBindingPath, consumeBindToken, createBindingRegistry, lookupBinding as lookupRegistryBinding, readBinding, readBindToken } from './agent-binding.mjs';
import { initAgentSpace, spacePath } from './agent-space.mjs';
import { archiveSoulDirs, backfillManagedSouls, listSouls, locateSoulDir, populationFile, recordSoulDisplayName, recordSoulLaunch, retireIdentityWithPopulation, setSoulComms, showSoul, soulDirectory, upsertIdentitySoul, withRoles } from './agent-population.mjs';
import { spawnSoulTemplate } from './soul-templates.mjs';
import {
  bindAgentLineage,
  ensureAgentIdentity,
  mintAgentIdentity,
  readAgentIdentity,
  stateDirectory,
  validateAgentId,
} from './agent-identity.mjs';
import { createInteractionService } from './agent-interaction.mjs';
import { mint } from './mint-token.mjs';
import { KEYD_TOOL_NAMES, grantTarget, keydRequest, mintViaKeyd, readKeydRecord, signKeydGrant } from './keyd-client.mjs';
import { recoverInteractionStore } from './agent-jobs.mjs';
import { appendAuditReceipt, principalsFile, resolvePrincipal } from './agent-principals.mjs';
import { runSpawnHooks } from './agent-hook.mjs';
import { createWebLayer } from './agent-web.mjs';
import { loadOrCreateVouchKey, signSoulToken, vouchStateDir } from './vouch.mjs';
import { PROOF_HEADER, parseBindingProof, signBindingProof } from './binding-proof.mjs';
import { createCommsSupervisor, pairDaemonComms, readCommsStatus } from './comms-client.mjs';
import { attachWakeEndpoint } from './agent-wake.mjs';
import { readColdWakeSettings, setColdWake } from './cold-wake-settings.mjs';
import { isGateEnabled, loadConfig } from './config.mjs';
import { createLaunchHandler, launchCommsSetting } from './daemon-launch.mjs';
import { createTeamStarter, defaultTeamTemplate, harnessLaunchProblem, teamLimits } from './team-start.mjs';
import { createSoulHomes, installHarnesses, soulBindingForLaunch, soulHarnessesPath } from './soul-home.mjs';
import { createWebhookWaker, readWebhook } from './wake-webhook.mjs';
import { defaultHarnessFor, onPath } from './acp-registry.mjs';
import { soulCredentialsDeclaration, validateSoulPackage, writeSoulComms } from './soul-package.mjs';
import { editSoulRevision, revisionHistory } from './soul-revisions.mjs';
import { acpExecutorFor, createWakePlane } from './wake-plane.mjs';
import { recordSoulSession } from './metrics.mjs';
import { createTaskReporter } from './task-turns.mjs';
import { createCommsRelay } from './comms-relay.mjs';
import { createResumeExecutor, createWakeSessions, resumePath, wakeSessionsFile } from './wake-resume.mjs';
import { migratePreGateConfig } from './config-migration.mjs';

/**
 * What a soul's harness inherits: the daemon's environment with the host's
 * tools (AGENT_BOT_TOOL_PATH, such as GeniusBar's agent-comms) first on
 * PATH, so a soul on a machine without them installed can still use them.
 * With `home`, the user's own tool directories follow (#418): a launchd
 * daemon gets a bare PATH, while harness CLIs such as `opencode` live where
 * the login shell (`loginPath`) or an installer put them.
 */
export function soulEnvironment(env = process.env, { home = null, loginPath = null } = {}) {
  const tools = env.AGENT_BOT_TOOL_PATH && path.isAbsolute(env.AGENT_BOT_TOOL_PATH) ? env.AGENT_BOT_TOOL_PATH : null;
  if (!home) return tools ? { ...env, PATH: [tools, env.PATH].filter(Boolean).join(path.delimiter) } : env;
  const dirs = [tools, ...(env.PATH ?? '').split(path.delimiter), ...(loginPath ?? '').split(path.delimiter),
    ...userToolDirs(home)].filter((dir) => dir && path.isAbsolute(dir));
  return { ...env, PATH: [...new Set(dirs)].join(path.delimiter) };
}

/** Where harness installers put their CLIs, after the login shell's PATH. */
export function userToolDirs(home) {
  return [path.join(home, '.local', 'bin'), path.join(home, '.opencode', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

const LOGIN_PATH_MARK = '__agent_bot_login_path__';

/**
 * The PATH the user's login shell builds (its .zshenv and .zprofile), read
 * once when the daemon starts, or null when it cannot be read within the
 * timeout. AGENT_BOT_LOGIN_PATH=0 skips it.
 */
export function loginShellPath({ env = process.env, home = homedir(), run = execFileSync, timeoutMs = 3000 } = {}) {
  if (env.AGENT_BOT_LOGIN_PATH === '0') return null;
  const shell = env.SHELL && path.isAbsolute(env.SHELL) && ['zsh', 'bash', 'sh'].includes(path.basename(env.SHELL))
    ? env.SHELL : '/bin/zsh';
  try {
    const out = String(run(shell, ['-lc', `printf '%s%s' '${LOGIN_PATH_MARK}' "$PATH"`], {
      env: { HOME: home, USER: env.USER ?? '', LOGNAME: env.LOGNAME ?? env.USER ?? '', SHELL: shell,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...(env.ZDOTDIR ? { ZDOTDIR: env.ZDOTDIR } : {}), TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, encoding: 'utf8',
    }));
    const at = out.lastIndexOf(LOGIN_PATH_MARK);
    if (at < 0) return null;
    const found = out.slice(at + LOGIN_PATH_MARK.length).trim().split(path.delimiter).filter((dir) => path.isAbsolute(dir));
    return found.length ? found.join(path.delimiter) : null;
  } catch { return null; }
}

/**
 * Joins a launched soul to agent-comms as itself, with the soul's binding and
 * the environment its harness gets, before its first turn (R4). Resolves to
 * the soul's address; a failed join fails the launch with agent-comms' own
 * message.
 */
export function joinLaunchedSoul({ agentId, harness, name, binding, parent = null }, { env = process.env, run = execFile } = {}) {
  const args = ['join', '--harness', harness, ...(name ? ['--name', name] : []), ...(parent ? ['--parent', parent] : [])];
  const soulEnv = { ...soulEnvironment(env), AGENT_BOT_BINDING: binding.file, AGENT_BOT_ID: agentId, QWTS_AGENT_ID: agentId };
  return new Promise((resolve, reject) => {
    run('agent-comms', args, { cwd: binding.worktree, env: soulEnv, timeout: 30_000 }, (error, stdout = '', stderr = '') => {
      let result = null;
      try { result = JSON.parse(String(stdout)); } catch {}
      if (!error && result?.ok === true) return resolve(result.address ?? null);
      const detail = result?.error?.message ?? (String(stderr).trim().split('\n').pop() || error?.message || 'no result');
      reject(new Error(`joining agent-comms failed: ${detail}`));
    });
  });
}

/**
 * Takes a soul out of agent-comms as itself (#419), the reverse of
 * joinLaunchedSoul. With the daemon's binding the request is vouched; without
 * one (`soul remove` from the CLI) it names the soul by ID, as an unbound
 * session would. A soul the hub never joined, or one that already left,
 * counts as left. Resolves to true, or rejects with agent-comms' message.
 */
export function leaveLaunchedSoul({ agentId, binding = null }, { env = process.env, run = execFile, cwd = tmpdir() } = {}) {
  const { AGENT_BOT_BINDING: _binding, ...rest } = soulEnvironment(env);
  const soulEnv = { ...rest, ...(binding?.file ? { AGENT_BOT_BINDING: binding.file } : {}), AGENT_BOT_ID: agentId, QWTS_AGENT_ID: agentId };
  const where = binding?.worktree && existsSync(binding.worktree) ? binding.worktree : cwd;
  return new Promise((resolve, reject) => {
    run('agent-comms', ['leave'], { cwd: where, env: soulEnv, timeout: 30_000 }, (error, stdout = '', stderr = '') => {
      let result = null;
      try { result = JSON.parse(String(stdout)); } catch {}
      if (!error && result?.ok === true) return resolve(true);
      if (result?.error?.code === 'not-joined') return resolve(true);
      const detail = result?.error?.message ?? (String(stderr).trim().split('\n').pop() || error?.message || 'no result');
      reject(new Error(`leaving agent-comms failed: ${detail}`));
    });
  });
}

/**
 * Rolls back a soul a launch spawned when its first start fails (#419): the
 * agent-comms membership while the soul can still vouch, then the identity
 * and census row, then its folder, archived so a retry can reuse the name.
 * `rollback` is how far the launch got: `{ binding, joined }`. Returns what
 * it did; a leave that fails is reported, not thrown, so the rest still runs.
 */
export async function discardFailedLaunch(agentId, { binding = null, joined = false } = {}, {
  env = process.env, home = homedir(), config, now = () => new Date(), leave = (soul) => leaveLaunchedSoul(soul, { env }),
} = {}) {
  let left = !joined;
  if (joined) { try { left = await leave({ agentId, binding }); } catch { /* reported as left: false; the soul is still retired */ } }
  const file = populationFile({ env, home });
  retireIdentityWithPopulation(agentId, { file, stateDir: stateDirectory({ env, home }), now });
  const archived = archiveSoulDirs(agentId, { env, home, ...(config === undefined ? {} : { config }), now, file });
  return { left, archived };
}

/**
 * A soul an interactive session set up with `setup-worktree` or `agent-bot
 * join` has no daemon binding: its worktree's git config pins the identity
 * instead. The population still records that worktree, so a resume or
 * webhook wake (#323, #334) can run there. A soul with no usable recorded
 * worktree — one made by `soul spawn` and never joined from a checkout —
 * falls back to its own soul directory, which its `.soul-state/agent-id`
 * marker proves is this soul's (#382). Resolves { agentId, worktree,
 * file: null }, or null when the soul is not active or neither place is
 * provably this soul's.
 */
export function recordedWorktree(agentId, { env = process.env, home = homedir() } = {}) {
  let soul;
  const file = populationFile({ env, home });
  try { soul = listSouls({ status: 'active', file }).find((record) => record.id === agentId); }
  catch { return null; }
  if (!soul) return null;
  const worktree = typeof soul.worktree === 'string' && path.isAbsolute(soul.worktree) ? soul.worktree : null;
  if (worktree && pinnedTo(worktree, agentId)) return { agentId, worktree, file: null };
  let directory = null;
  try { directory = soulDirectory(agentId, { env, home, file }); } catch { return null; }
  try {
    if (statSync(directory).isDirectory()
        && readFileSync(path.join(directory, '.soul-state', 'agent-id'), 'utf8').trim() === agentId) {
      return { agentId, worktree: directory, file: null };
    }
  } catch { /* no soul directory, or not this soul's */ }
  return null;
}

// A stale record or a repinned checkout must not run a wake as the wrong
// soul: the worktree's own pin has to name this soul.
function pinnedTo(worktree, agentId) {
  try { if (!statSync(worktree).isDirectory()) return false; } catch { return false; }
  try {
    return execFileSync('git', ['-C', worktree, 'config', '--get', 'agentBot.agentId'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() === agentId;
  } catch { return false; }
}

const SCHEMA_VERSION = 1;
const MAX_BODY_BYTES = 64 * 1024;
const VOUCH_LIMIT = 60;
const VOUCH_WINDOW_MS = 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HEALTH_TIMEOUT_MS = 1_500;
// Credential minting reaches GitHub (installation lookup + token creation),
// so it needs a network-scale budget — the health-probe timeout would abort
// legitimate mints on any slow round trip.
const CREDENTIAL_TIMEOUT_MS = 30_000;

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
  taskReporter = null,
  mintImpl = mint,
  // agent-bot-keyd's socket call (#397); tests pass a fake keyd.
  keydCall = keydRequest,
  spawnHook = runSpawnHooks,
  now = () => new Date(),
  // #253 replaces this with its persistent lookup. The default reads the
  // in-memory registry and does not change how bindings are stored.
  lookupBinding: lookupBindingOverride = null,
  // Live comms watch state for GET /v0/comms/status. The supervisor is owned
  // by runDaemon; tests and embedding callers pass a stub with getState().
  comms = null,
  // POST /v0/team/start (#377): (callerAgentId, body) => { agentId, ... }.
  // runDaemon wires it to the launch handler; null refuses the route.
  teamStarter = null,
} = {}) {
  // One interaction service per server so in-flight executions and their
  // cancellation controllers live exactly as long as the daemon.
  const interaction = createInteractionService({ env, home, config, executor, taskReporter, now });
  const bindings = createBindingRegistry({ now, file: path.join(vouchStateDir({ env, home }), 'bindings.json'), account: env.USER ?? process.env.USER ?? 'unknown' });
  const findBinding = lookupBindingOverride
    ?? ((secret) => lookupRegistryBinding(bindings, secret, { now }));
  // Per-binding vouch window. The map stores sha256(secret), never the secret.
  const vouchHits = new Map();
  let vouchKey = null;
  function signingKey() {
    if (!vouchKey) vouchKey = loadOrCreateVouchKey(vouchStateDir({ env, home }));
    return vouchKey.privateKey;
  }
  // Keyed per binding: the proof's key ID, or sha256 of an older client's
  // bare secret. Neither is the secret.
  function allowVouch(presented) {
    const key = typeof presented === 'string'
      ? createHash('sha256').update(presented, 'utf8').digest('hex')
      : parseBindingProof(presented.proof).keyId;
    const atMs = now().getTime();
    const recent = (vouchHits.get(key) ?? []).filter((stamp) => atMs - stamp < VOUCH_WINDOW_MS);
    if (recent.length >= VOUCH_LIMIT) {
      vouchHits.set(key, recent);
      return false;
    }
    recent.push(atMs);
    vouchHits.set(key, recent);
    return true;
  }
  // The private web client (#59) rides the same server and the same loopback
  // peer check; it authenticates browsers with its own pairing-code cookie
  // sessions instead of the bearer token, which never reaches page script.
  const web = createWebLayer({ env, home, config, interaction, daemonToken: token, now });
  let warmPool;
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
      // Binding-authenticated and bearer-free (#254). Every other route still
      // requires the per-start bearer below.
      if (req.method === 'POST' && url.pathname === '/v0/vouch') {
        await handleVouchRequest({
          req, res, findBinding, allowVouch, signingKey, env, home, now,
        });
        return;
      }
      const authorization = req.headers.authorization ?? '';
      const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!['GET /v0/binding', 'DELETE /v0/binding', 'POST /v0/credential', 'POST /v0/keyd/grant', 'POST /v0/spawn', 'POST /v0/team/start'].includes(`${req.method} ${url.pathname}`) && !tokensMatch(token, presented)) {
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
          // `busy`: souls with a daemon turn in flight (cold wake), beside
          // the warm pool's connected harnesses.
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, status: 'ok', pid: process.pid, warmPool: warmPool.list(),
            busy: server.wakePlane?.busy?.() ?? [] });
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
          let worktree;
          if (body.worktree !== undefined && body.worktree !== null) {
            if (typeof body.worktree !== 'string' || !path.isAbsolute(body.worktree)) {
              throw Object.assign(new Error('worktree must be an absolute path'), { statusCode: 400 });
            }
            worktree = body.worktree;
          }
          const soul = upsertIdentitySoul(id, body.spacePath, {
            file: populationOverride(env, home),
            stateDir: stateDirectory({ env, home }),
            worktree,
          });
          sendJson(res, 200, { soul });
          return;
        }
        case 'POST /v0/bind': {
          const body = parseJsonBody(await readBody(req));
          sendJson(res, 200, bindWorktreeConversation({ body, bindings, env, home, config, now, presented: presentedCredential(req) }));
          return;
        }
        case 'POST /v0/spawn': {
          const source = requireBinding(req, bindings);
          const body = parseJsonBody(await readBody(req));
          const stateDir = stateDirectory({ env, home });
          const parent = readAgentIdentity(source.agentId, { stateDir });
          const parentApp = parent.github?.appSlug ?? null;
          if ((body.parent && body.parent !== source.agentId)
            || (body.app && body.app !== parentApp)) {
            throw Object.assign(new Error('spawn cannot override parent authority'), { statusCode: 403 });
          }
          const harness = body.harness ?? source.harness ?? parent.harness ?? 'unknown';
          const name = body.name ?? 'child';
          for (const value of [name, harness]) {
            if (typeof value !== 'string' || !value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
              throw Object.assign(new Error('invalid spawn name or harness'), { statusCode: 400 });
            }
          }
          // A parent with no github field stays without one even when the
          // gate is on. The gate off omits github on the child either way.
          const useGithub = isGateEnabled('github-identity', { env, home, config }) && parent.github != null;
          const identity = mintAgentIdentity({
            appSlug: parentApp, botUid: parent.github?.botUid ?? null, harness,
            transcript: body.transcript, parentId: source.agentId,
            packagePath: body.packagePath ?? null,
            team: body.team ?? parent.team, squad: body.squad ?? parent.squad,
            type: body.type ?? 'agent', level: body.level, subjects: body.subjects ?? [], stateDir, now,
            useGithub,
          });
          bindings.bind({ agentId: identity.id, parent: source.agentId, spawnedBy: source.bindingHash,
            worktree: source.worktree, gitDir: source.gitDir, app: identity.github?.appSlug ?? null,
            harness, transcript: identity.transcript });
          const result = { agentId: identity.id, parent: source.agentId,
            binding: childBindingPath(source.gitDir, identity.id) };
          let warning;
          try { warning = await spawnHook({ ...result, name: body.name ?? identity.id, harness, cwd: source.worktree, env }); }
          catch { warning = 'spawn hook failed'; }
          sendJson(res, 200, { ...result, ...(warning ? { warning } : {}) });
          return;
        }
        // A soul starts a teammate as itself (#377): the binding is the
        // caller, and the starter enforces the team limits and audits.
        case 'POST /v0/team/start': {
          let source;
          try {
            source = requireBinding(req, bindings);
          } catch (error) {
            appendAuditReceipt({ event: 'team-start', operation: 'start_soul', decision: 'denied' }, { env, home, now });
            throw error;
          }
          if (!teamStarter) throw Object.assign(new Error('this daemon cannot start souls'), { statusCode: 503 });
          const body = parseJsonBody(await readBody(req));
          sendJson(res, 200, await teamStarter(source.agentId, body));
          return;
        }
        case 'GET /v0/binding': {
          const binding = requireBinding(req, bindings);
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, binding });
          return;
        }
        // Explicit revocation invalidates the secret and removes its file.
        case 'DELETE /v0/binding': {
          const presented = presentedCredential(req);
          const released = typeof presented === 'string'
            ? bindings.release(presented)
            : bindings.releaseProof(presented.proof, presented.request);
          if (!released) {
            throw Object.assign(new Error('missing or invalid agent binding'), { statusCode: 401 });
          }
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, released: true });
          return;
        }
        // Tier-1 credential brokering (#90): an App installation token for
        // the bot the caller already IS. Authorization is the live binding —
        // "a bound agent on an enforced connection" — never a request
        // parameter, and never a key-file read in the caller's process. The
        // request names no App and no Agent ID: both derive from the binding.
        // Delegated human authority (tier 2) is deliberately NOT this route —
        // it must never return a credential at all.
        case 'POST /v0/credential': {
          // Drain the (unused) request body so keep-alive connections are left
          // clean; readBody enforces MAX_BODY_BYTES like every other route.
          await readBody(req);
          let binding;
          try {
            binding = requireBinding(req, bindings);
          } catch (error) {
            appendAuditReceipt(
              { event: 'credential-mint', operation: 'tier1-app-token', decision: 'denied' },
              { env, home, now },
            );
            throw error;
          }
          let grant;
          let identity;
          try {
            identity = readAgentIdentity(binding.agentId, {
              stateDir: stateDirectory({ env, home }),
            });
          } catch (error) {
            appendAuditReceipt({
              event: 'credential-mint',
              agentId: binding.agentId,
              operation: 'tier1-app-token',
              decision: 'failed',
            }, { env, home, now });
            throw error;
          }
          // The add-on gate decides, not the record: a soul that carries a
          // github field gets no App token while github-identity is off.
          const githubOn = isGateEnabled('github-identity', { env, home, config });
          if (!githubOn || !identity.github?.appSlug) {
            appendAuditReceipt({
              event: 'credential-mint',
              agentId: binding.agentId,
              operation: 'tier1-app-token',
              decision: 'denied',
            }, { env, home, now });
            throw Object.assign(new Error(githubOn ? 'this soul has no GitHub App' : 'the github-identity add-on is off'), { statusCode: 409 });
          }
          try {
            grant = await mintImpl({
              slug: identity.github.appSlug, env, agentId: binding.agentId,
              viaKeyd: (soul) => mintViaKeyd({ ...soul, env, home, now, request: keydCall }),
            });
          } catch (error) {
            // A verified binding whose mint fails must still leave a receipt —
            // the audit stream has to account for every attempt, not only the
            // ones that reached a decision.
            appendAuditReceipt({
              event: 'credential-mint',
              agentId: binding.agentId,
              operation: 'tier1-app-token',
              decision: 'failed',
            }, { env, home, now });
            throw error;
          }
          appendAuditReceipt({
            event: 'credential-mint',
            agentId: binding.agentId,
            operation: 'tier1-app-token',
            decision: 'granted',
          }, { env, home, now });
          sendJson(res, 200, {
            schemaVersion: SCHEMA_VERSION,
            agentId: binding.agentId,
            appSlug: identity.github.appSlug,
            token: grant.token,
            expires_at: grant.expires_at,
            installation_id: Number.isSafeInteger(grant.installation_id) ? grant.installation_id : null,
          });
          return;
        }
        // agent-bot-keyd grants (#397): a soul's `agent-bot-keyd mcp` relay
        // asks here, on the soul's binding, before each keyd tool call. The
        // daemon keeps the policy — binding, add-on gate, the soul's own App,
        // a keyd-held key — and answers with a one-call grant signed by its
        // account key, which keyd pinned. keyd checks the grant and mints;
        // the key never leaves keyd and the grant is useless after 60s.
        case 'POST /v0/keyd/grant': {
          const body = parseJsonBody(await readBody(req));
          const tool = body?.tool;
          const receipt = (decision, agentId = null) => appendAuditReceipt({
            event: 'credential-grant', ...(agentId ? { agentId } : {}),
            operation: `keyd ${KEYD_TOOL_NAMES.includes(tool) ? tool : 'unknown'}`, decision,
          }, { env, home, now });
          if (!KEYD_TOOL_NAMES.includes(tool)) {
            receipt('denied');
            throw Object.assign(new Error('unknown keyd tool'), { statusCode: 400 });
          }
          let binding;
          try { binding = requireBinding(req, bindings); }
          catch (error) { receipt('denied'); throw error; }
          let identity;
          let declaration;
          try {
            identity = readAgentIdentity(binding.agentId, { stateDir: stateDirectory({ env, home }) });
            declaration = soulCredentialsDeclaration(soulDirectory(binding.agentId, { file: populationFile({ env, home }), env, home }));
          } catch (error) {
            receipt('failed', binding.agentId);
            throw error;
          }
          const githubOn = isGateEnabled('github-identity', { env, home, config });
          const app = identity.github?.appSlug;
          const refusal = !githubOn ? 'the github-identity add-on is off'
            : !app ? 'this soul has no GitHub App'
              : declaration?.app !== app || declaration?.store !== 'keyd' ? "agent-bot-keyd does not hold this soul's key"
                : null;
          if (refusal) {
            receipt('denied', binding.agentId);
            throw Object.assign(new Error(refusal), { statusCode: 409 });
          }
          const signed = signKeydGrant({ agentId: binding.agentId, app, tool, ...(await grantTarget({ env, config })) }, signingKey(), now);
          receipt('granted', binding.agentId);
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, grant: signed });
          return;
        }
        // Comms pairing state (#255): who this daemon is paired as, and whether
        // its account-watch stream to the agent-comms broker is connected.
        case 'GET /v0/comms/status': {
          sendJson(res, 200, {
            schemaVersion: SCHEMA_VERSION,
            comms: readCommsStatus({ env, home, live: comms?.getState() ?? null }),
          });
          return;
        }
        case 'GET /v0/population': {
          const souls = listSouls({
            status: url.searchParams.get('status'),
            app: url.searchParams.get('app'),
            file: populationOverride(env, home),
          });
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, souls: withRoles(souls, { file: populationOverride(env, home), env, home }) });
          return;
        }
        // The owner's approvals (#85). The CLI reaches these only after its
        // owner gate; a soul's own calls never come here.
        case 'GET /v0/approvals': {
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, ...interaction.listProposalsForOwner() });
          return;
        }
        case 'POST /v0/approvals/decide': {
          const body = parseJsonBody(await readBody(req));
          sendJson(res, 200, interaction.decideProposalAsOwner({
            proposalId: body.proposalId,
            decision: body.decision,
            digest: body.digest,
          }));
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
  server.on('listening', () => {
    const address = server.address();
    bindings.rewrite(`http://${address.address === '::1' ? '[::1]' : '127.0.0.1'}:${address.port}`);
  });
  warmPool = attachWakeEndpoint(server, {
    lookupBinding: (secret) => bindings.resolve(secret),
    lookupProof: (req) => {
      const presented = presentedCredential(req);
      return typeof presented === 'string' ? null : bindings.resolveProof(presented.proof, presented.request);
    },
  });
  server.token = token;
  server.warmPool = warmPool;
  server.bindings = bindings;
  server.interaction = interaction;
  return server;
}

// Surrender-and-enforce (#94): the caller presents the bind token that
// setup-worktree minted into the worktree's private git dir, together with
// what only the conversation knows — transcript locator, harness, parent.
// The daemon verifies the token against the file on disk, consumes it, and
// joins the two halves into one identity. The body carries NO Agent ID: who
// is binding is derived entirely from the consumed token record, so no caller
// can bind as a worktree it cannot read.
function bindWorktreeConversation({ body, bindings, env, home, config, now, presented = '' }) {
  // Validate the conversation half BEFORE consuming: a bind rejected for a
  // malformed request must leave the single-use token in place so the caller
  // can retry, while a wrong or replayed token still fails without consuming.
  if (typeof body.gitDir !== 'string' || !path.isAbsolute(body.gitDir)) throw new Error('gitDir must be an absolute path');
  const existing = readBinding({ env: {}, gitDir: body.gitDir });
  if (existing) {
    const binding = bindings.resolve(existing.secret);
    if (binding && binding.gitDir === body.gitDir) {
      // Reuse hands back a live secret, so the caller must prove it can read
      // this git dir, exactly as a first bind does: present the binding it
      // read, or a bind token minted there. A path and the daemon bearer
      // alone must never yield another worktree's secret.
      const pending = readBindToken(body.gitDir);
      const holdsBinding = typeof presented === 'string'
        ? presented !== '' && tokensMatch(existing.secret, presented)
        : bindings.resolveProof(presented.proof, presented.request)?.bindingHash
          === createHash('sha256').update(existing.secret).digest('hex');
      // A matching token proves place without being spent, so a redundant
      // token survives reuse.
      const holdsToken = pending !== null && typeof body.token === 'string' && tokensMatch(pending.token, body.token);
      if (!holdsBinding && !holdsToken) throw Object.assign(new Error('this worktree is already bound; present its binding'), { statusCode: 403 });
      if (!holdsBinding) assertPrivateGitDir(body.gitDir, pending.worktree);
      if (body.parentId && body.parentId !== binding.parent) throw Object.assign(new Error('identity already records a different parent'), { statusCode: 409 });
      return { schemaVersion: SCHEMA_VERSION, ...binding, secret: existing.secret, repinRequired: false };
    }
  }
  const transcript = body.transcript;
  if (!transcript || typeof transcript !== 'object' || Array.isArray(transcript)
    || typeof transcript.id !== 'string' || transcript.id === '') {
    throw Object.assign(
      new Error('bind requires a transcript locator ({provider, id})'),
      { statusCode: 400 },
    );
  }
  const locator = { provider: typeof transcript.provider === 'string' && transcript.provider !== '' ? transcript.provider : 'custom', id: transcript.id };
  const parentId = body.parentId === undefined || body.parentId === null
    ? null
    : requireAgentId(body.parentId);
  const stateDir = stateDirectory({ env, home });
  // A syntactically valid parentId can still be a typo or a stale ID from
  // another machine; lineage must only ever point at an identity this
  // workstation can produce. Checked before consuming so a rejected bind
  // leaves the single-use token in place.
  if (parentId !== null) {
    try {
      readAgentIdentity(parentId, { stateDir });
    } catch {
      throw Object.assign(new Error('parent Agent ID is unknown'), { statusCode: 409 });
    }
  }
  const pending = readBindToken(body.gitDir);
  if (pending) assertPrivateGitDir(body.gitDir, pending.worktree);
  const record = consumeBindToken({ gitDir: body.gitDir, token: body.token });
  let pinned;
  try {
    pinned = readAgentIdentity(record.agentId, { stateDir });
  } catch {
    throw Object.assign(new Error('bind token names an unknown Agent ID'), { statusCode: 409 });
  }
  const harness = typeof body.harness === 'string' && body.harness !== '' ? body.harness : pinned.harness;
  // The existing reuse policy decides whether the pinned identity binds this
  // transcript, an earlier identity already owns it, or a fresh one is minted
  // (a later conversation reusing the worktree). parentId only applies on a
  // mint; a reused identity's missing lineage is repaired below.
  // Reuse the pinned soul. GitHub metadata is copied only when the add-on
  // is on AND this soul already has it; a soul without `github` stays that
  // way when the gate is later turned on.
  const useGithub = isGateEnabled('github-identity', { env, home, config }) && pinned.github != null;
  const identity = ensureAgentIdentity({
    currentId: record.agentId,
    appSlug: useGithub ? pinned.github.appSlug : null,
    botUid: useGithub ? pinned.github.botUid : null,
    harness,
    useGithub,
    transcript: locator,
    fields: {
      team: pinned.team,
      squad: pinned.squad,
      type: pinned.type,
      level: pinned.level,
      parentId,
    },
    stateDir,
    now,
  });
  let bound = identity;
  if (parentId && !identity.parentId) {
    bound = bindAgentLineage(identity.id, parentId, { stateDir, now });
  } else if (parentId && identity.parentId !== parentId) {
    throw Object.assign(
      new Error('identity already records a different parent'),
      { statusCode: 409 },
    );
  }
  // Binding is the one moment place and conversation are both in view; the
  // census row picks up the provenance (#91) through the refreshed identity.
  const space = initAgentSpace(bound.id, { env, home, config });
  const soul = upsertIdentitySoul(bound.id, space.path, {
    file: populationOverride(env, home),
    stateDir,
    worktree: record.worktree,
  });
  const secret = bindings.bind({
    agentId: bound.id,
    gitDir: body.gitDir,
    parent: bound.parentId ?? null,
    app: bound.github?.appSlug ?? null,
    worktree: record.worktree,
    transcript: locator,
    harness: bound.harness,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    secret,
    agentId: bound.id,
    worktree: record.worktree,
    boundAt: soul.lastSeen,
    // The worktree pin still names the token's original identity when the
    // reuse policy resolved elsewhere; the caller owns repinning because the
    // daemon never reaches into worktrees.
    repinRequired: bound.id !== record.agentId,
    soul,
  };
}

// The daemon address a binding proof must name, normalized exactly as a
// client's `new URL(daemon).host` is (port 80 is omitted, IPv6 bracketed).
function daemonAuthority(req) {
  const address = String(req.socket.localAddress ?? '').replace(/^::ffff:/, '');
  return new URL(`http://${address.includes(':') ? `[${address}]` : address}:${req.socket.localPort}`).host;
}

// What the caller presented for its binding (#270): a proof, which never
// carries the secret, as { proof, request }; otherwise an older client's bare
// secret from `x-agent-binding` (empty when absent).
function presentedCredential(req) {
  const proof = req.headers[PROOF_HEADER];
  if (typeof proof === 'string') {
    const request = { method: req.method, path: new URL(req.url, 'http://127.0.0.1').pathname, authority: daemonAuthority(req) };
    return { proof, request };
  }
  return typeof req.headers['x-agent-binding'] === 'string' ? req.headers['x-agent-binding'] : '';
}

function requireBinding(req, bindings) {
  const presented = presentedCredential(req);
  const binding = typeof presented === 'string'
    ? bindings.resolve(presented)
    : bindings.resolveProof(presented.proof, presented.request);
  if (!binding) {
    throw Object.assign(new Error('missing or invalid agent binding'), { statusCode: 401 });
  }
  return binding;
}

// Until #253 stores parent on the binding, a lookup that does not know the
// field is filled from the identity recorded at bind time. A lookup that
// returns a parent (including an explicit null) wins, so the store can
// disagree with the identity file without this route second-guessing it.
function parentForVouch(binding, { env, home }) {
  if (typeof binding.parent === 'string' && binding.parent.length > 0) return binding.parent;
  if (binding.parentIsSet) return binding.parent ?? null;
  try {
    const record = readAgentIdentity(binding.agentId, { stateDir: stateDirectory({ env, home }) });
    return record.parentId ?? null;
  } catch {
    return null;
  }
}


async function handleVouchRequest({
  req,
  res,
  findBinding,
  allowVouch,
  signingKey,
  env,
  home,
  now,
}) {
  const body = parseJsonBody(await readBody(req));
  if (body.aud !== 'agent-comms') {
    throw Object.assign(new Error('aud must be agent-comms'), { statusCode: 400 });
  }
  const presented = presentedCredential(req);
  const binding = findBinding(presented);
  if (!binding) {
    appendAuditReceipt(
      { event: 'vouch', operation: 'soul-token', decision: 'denied' },
      { env, home, now },
    );
    throw Object.assign(new Error('unbound'), { statusCode: 401 });
  }
  if (!allowVouch(presented)) {
    appendAuditReceipt({
      event: 'vouch',
      agentId: binding.agentId,
      operation: 'soul-token',
      decision: 'rate-limited',
    }, { env, home, now });
    throw Object.assign(new Error('rate limited'), { statusCode: 429 });
  }
  let account;
  try {
    account = userInfo().username;
  } catch {
    account = '';
  }
  if (typeof account !== 'string' || account.length === 0) {
    throw Object.assign(new Error('could not determine the account name'), { statusCode: 500 });
  }
  const parent = parentForVouch(binding, { env, home });
  let token;
  let payload;
  try {
    token = signSoulToken({ account, agentId: binding.agentId, parent }, signingKey(), now);
    payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('could not sign soul token'), { statusCode: 500 });
  }
  appendAuditReceipt({
    event: 'vouch',
    agentId: binding.agentId,
    operation: 'soul-token',
    decision: 'granted',
  }, { env, home, now });
  sendJson(res, 200, {
    token,
    agentId: payload.agentId,
    parent: payload.parent,
    exp: payload.exp,
  });
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
      taskId: body.taskId,
    }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/proposals') {
    sendJson(res, 200, interaction.listProposals({ principal, transport }));
    return;
  }
  if (req.method === 'POST' && (match = url.pathname.match(/^\/v1\/proposals\/([^/]+)\/decision$/))) {
    sendJson(res, 200, interaction.decideProposal({
      principal,
      transport,
      proposalId: match[1],
      decision: body.decision,
      digest: body.digest,
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
    return body?.status === 'ok' && body?.pid === state.pid ? body : false;
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
    return { running: false, reason: error.message, comms: readCommsStatus({ env, home }) };
  }
  if (!state) return { running: false, reason: 'no daemon state file', comms: readCommsStatus({ env, home }) };
  const health = await probeHealth(state, { fetchImpl, timeoutMs });
  if (health) {
    return {
      running: true,
      pid: state.pid,
      port: state.port,
      startedAt: state.startedAt,
      warmPool: health.warmPool ?? {},
      busy: Array.isArray(health.busy) ? health.busy : [],
      comms: await probeComms(state, { env, home, fetchImpl, timeoutMs }),
    };
  }
  return {
    running: false,
    reason: 'daemon state file is stale (health probe failed)',
    stale: state,
    comms: readCommsStatus({ env, home }),
  };
}

async function probeComms(state, { env, home, fetchImpl, timeoutMs }) {
  try {
    const res = await fetchImpl(`${baseUrl(state)}/v0/comms/status`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return readCommsStatus({ env, home });
    const body = await res.json().catch(() => ({}));
    if (!body || typeof body.comms !== 'object') return readCommsStatus({ env, home });
    return body.comms;
  } catch {
    return readCommsStatus({ env, home });
  }
}

// Thin client for callers that prefer the daemon over in-process stores (#43).
// Every method fails with a plain Error; the caller decides whether policy
// allows an in-process fallback.
export function daemonClient({
  env = process.env,
  home = homedir(),
  fetchImpl = fetch,
  timeoutMs = HEALTH_TIMEOUT_MS,
  cwd = process.cwd(),
} = {}) {
  async function request(method, pathname, body, headers = {}, requestTimeoutMs = timeoutMs) {
    // Re-read the state file on every request: a long-running adapter must
    // follow a daemon restart to its new port and per-start token instead of
    // failing forever against a cached endpoint.
    const { 'x-agent-binding': secret, ...rest } = headers;
    const shared = secret ? readBinding({ env, cwd }) : null;
    const state = shared ? null : readStateFile(daemonStateFile({ env, home }));
    if (!state && !shared) throw new Error('daemon is not running (no state file)');
    const target = new URL(pathname, shared?.daemon ?? baseUrl(state));
    // A binding is presented as a proof for this one request (#270); the
    // secret itself never leaves this process.
    const proof = shared
      ? { [PROOF_HEADER]: signBindingProof({ secret, method, path: target.pathname, authority: target.host }) }
      : {};
    const res = await fetchImpl(`${target.origin}${pathname}`, {
      method,
      headers: {
        ...(state ? { authorization: `Bearer ${state.token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...rest,
        ...proof,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(requestTimeoutMs),
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
    async registerSoul(agentId, spaceRoot, { worktree = null } = {}) {
      const { soul } = await request('POST', '/v0/register', {
        agentId,
        spacePath: spaceRoot,
        ...(worktree ? { worktree } : {}),
      });
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
    // The daemon writes the shared secret in the private git dir. Callers
    // must never log it or return it to the conversation.
    async bind({ gitDir, token, transcript, parentId = null, harness = null }) {
      return request('POST', '/v0/bind', { gitDir, token, transcript, parentId, harness });
    },
    async binding(secret) {
      const { binding } = await request('GET', '/v0/binding', undefined, {
        'x-agent-binding': secret,
      });
      return binding;
    },
    async releaseBinding(secret) {
      return request('DELETE', '/v0/binding', undefined, { 'x-agent-binding': secret });
    },
    // Tier-1 (#90): the bound identity's own App installation token. The
    // caller is that identity — nothing is being borrowed.
    async credential(secret) {
      return request('POST', '/v0/credential', {}, { 'x-agent-binding': secret }, CREDENTIAL_TIMEOUT_MS);
    },
    // v1 interaction contract (#55). Adapters authenticate their provider
    // identity and pass the normalized pair on every call; the daemon owns
    // principal resolution and authorization.
    async createSession({ transport, providerId, agentId, sessionId = null }) {
      return request('POST', '/v1/sessions', { transport, providerId, agentId, sessionId });
    },
    async submitMessage(sessionId, { transport, providerId, message, idempotencyKey, attachments, taskId }) {
      return request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        transport, providerId, message, idempotencyKey, attachments, taskId,
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
    async approvals() {
      return request('GET', '/v0/approvals');
    },
    async decideApproval({ proposalId, decision, digest }) {
      return request('POST', '/v0/approvals/decide', { proposalId, decision, digest });
    },
    async artifacts(invocationId, { transport, providerId }) {
      return request('GET', `/v1/invocations/${encodeURIComponent(invocationId)}/artifacts?${new URLSearchParams({ transport, providerId })}`);
    },
  };
}

// Records a launch in the census before the first turn (#380). The principal
// may have chosen comms before start (#381): it becomes the soul's own
// setting, recorded as an edit when the soul has a revision chain. The
// revision history cannot be unwritten, so it is appended last; an earlier
// failure restores soul.json and the census comms.
export async function recordLaunchComms({ agentId, package: packagePath, comms, principal = null }, {
  env, home, config, revisions = { history: revisionHistory, edit: editSoulRevision },
} = {}) {
  const file = populationFile({ env, home });
  let directory = null;
  try { directory = soulDirectory(agentId, { env, home, config, file }); } catch { /* no census row yet */ }
  let census = null;
  try { census = showSoul(agentId, { file }).comms !== false; } catch { /* no census row yet */ }
  const previous = typeof comms === 'boolean' && directory ? writeSoulComms(directory, comms) : null;
  try {
    const recorded = recordSoulLaunch(agentId, { comms: typeof comms === 'boolean' ? comms
      : launchCommsSetting({ soulDir: directory, packagePath }) }, { file });
    const stateDir = stateDirectory({ env, home });
    if (previous !== null && revisions.history(agentId, { stateDir }).length) {
      await revisions.edit(agentId, directory, { reason: `comms ${comms ? 'on' : 'off'} at launch`, stateDir,
        ...(principal ? { authorization: { method: 'principal', principal } } : {}) });
    }
    return recorded;
  } catch (error) {
    if (previous !== null) {
      writeFileSync(path.join(directory, 'soul.json'), previous);
      if (census !== null) { try { setSoulComms(agentId, census, { file }); } catch { /* the launch fails either way */ } }
    }
    throw error;
  }
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
  // Harness CLIs resolve the same way for every soul turn, launch check and
  // relay (#418).
  const harnessEnv = soulEnvironment(env, { home, loginPath: loginShellPath({ env, home }) });
  // The ACP executor is off unless the user config turns it on (#259):
  // `"executor": { "enabled": true, "policy": { ... } }`. Without it /v1
  // keeps its unconfigured error and cold wake reports `waiting`.
  const setup = (config ?? loadConfig({ home, env })).executor;
  const identities = (agentId) => readAgentIdentity(validateAgentId(agentId), { stateDir: stateDirectory({ env, home }) });
  // An embedded host turns the executor on for its own daemon (ADR-0276).
  const executorFor = setup?.enabled === true || env.AGENT_BOT_EXECUTOR === '1'
    ? acpExecutorFor({
      identities,
      policy: setup?.policy ?? { version: 1, rules: [], fallback: 'deny' },
      baseEnv: harnessEnv,
      // A daemon-run soul's home is not a git worktree, so the session-start
      // hook cannot place its Claude session; the turn's binding does.
      onHarnessSession: ({ agentId, harness, harnessSessionId }) => recordSoulSession({ agentId, provider: harness, sessionId: harnessSessionId, env, home, now }),
      // Every turn gets the soul's agent-comms tools unless its launch
      // recorded comms off; the reach server runs agent-comms, which a
      // launchd PATH does not reach.
      commsFor: (agentId) => showSoul(agentId, { file: populationFile({ env, home }) }).comms,
      reachEnv: { PATH: resumePath(harnessEnv, home) },
      harnessDirsFor: (agentId) => [soulHarnessesPath(agentId, { env, home, config, file: populationFile({ env, home }) })],
      // A soul whose soul.json says its key is in agent-bot-keyd gets keyd's
      // relay, when this host installed keyd.
      keydFor: (agentId) => {
        const record = readKeydRecord({ env, home });
        if (!record) return null;
        const declaration = soulCredentialsDeclaration(soulDirectory(agentId, { file: populationFile({ env, home }), env, home }));
        return declaration?.store === 'keyd' ? record.bin : null;
      },
    })
    : null;
  const executor = executorFor
    ? (input) => {
      const identity = identities(input.invocation.agentId);
      return executorFor({ agentId: identity.id, harness: identity.harness, cwd: input.invocation.cwd ?? setup?.cwd ?? home, env: {} })(input);
    }
    : undefined;
  // The comms supervisor idles until a pairing credential exists, then keeps
  // the broker's account-watch stream open for this account's wakes (#255).
  // Each wake goes through the wake plane: a warm socket, else the opt-in
  // cold turn, else `waiting` (ADR-0008 decisions 7 to 9).
  let server;
  const onWake = (wake, ports) => server.wakePlane(wake, ports);
  // One provisioner for the daemon's life, so concurrent launches of a new
  // soul share its creation; it installs with this daemon's environment.
  let homes;
  const provisionHome = (soul) => {
    const file = populationFile({ env, home });
    // Older package launches could have an identity and home without a
    // census row. Register that provenance before resolving its directory.
    if (!listSouls({ file }).some((record) => record.id === soul.agentId)) {
      const space = initAgentSpace(soul.agentId, { env, home, config });
      upsertIdentitySoul(soul.agentId, space.path, { file, stateDir: stateDirectory({ env, home }), now });
    }
    homes ??= createSoulHomes({ env, home, config, stateDir: stateDirectory({ env, home }), bindings: server.bindings,
      install: (dir) => installHarnesses(dir, { env }) });
    return homes(soul);
  };
  const onLaunch = createLaunchHandler({
    file: path.join(path.dirname(daemonStateFile({ env, home })), 'launch-requests.json'),
    identities,
    // A package spawn is a new root soul with no GitHub App (#297). The
    // package is validated before minting, so a bad path mints nothing.
    // A team member (#377) is the same spawn with its parent recorded.
    spawnPackage: async ({ package: packagePath, harness, name, parent = null }) => {
      if (name !== undefined) return spawnSoulTemplate(packagePath, { name, harness, parentId: parent, env, home, config, now,
        stateDir: stateDirectory({ env, home }) });
      validateSoulPackage(packagePath);
      return mintAgentIdentity({ appSlug: null, harness, packagePath, useGithub: false, parentId: parent,
        stateDir: stateDirectory({ env, home }), now });
    },
    lookupBinding: (agentId) => soulBindingForLaunch(agentId, {
      stateDir: stateDirectory({ env, home }), bindings: server.bindings,
      provision: provisionHome, harness: identities(agentId).harness ?? null,
    }),
    provisionHome: (soul) => provisionHome(soul),
    locatePackage: (packagePath) => locateSoulDir(packagePath, { env, home, config, file: populationFile({ env, home }) }),
    // ADR-0276: an existing soul's own harness, else a package's preference,
    // else a registry harness on PATH.
    defaultHarness: async ({ soul, package: packagePath }) => {
      if (soul) return identities(soul).harness ?? defaultHarnessFor([], { available: (cmd) => onPath(cmd, env) });
      let preferred = [];
      try { preferred = JSON.parse(readFileSync(path.join(packagePath, 'soul.json'), 'utf8')).preferredHarnesses ?? []; } catch {}
      return defaultHarnessFor(Array.isArray(preferred) ? preferred : [], { available: (cmd) => onPath(cmd, env) });
    },
    // A principal launched this soul to talk to it, so later messages wake it.
    onLaunched: (agentId) => setColdWake(agentId, true, { env, home, now }),
    discard: (agentId, rollback) => discardFailedLaunch(agentId, rollback, { env, home, config, now }),
    joinSoul: async (soul) => {
      const address = await joinLaunchedSoul(soul, { env });
      // The census shows the launch name; every command shows it too (#429).
      if (soul.name) {
        try { recordSoulDisplayName(soul.agentId, soul.name, { file: populationFile({ env, home }) }); } catch { /* shown by soul.json name */ }
      }
      return address;
    },
    // The comms setting is read here, at launch only; turns read the census.
    recordLaunch: (launch) => recordLaunchComms(launch, { env, home, config }),
    executorFor,
  });
  // Souls launched before 0.10.9 read as unmanaged until marked from the
  // journal (#409). A census that cannot be rewritten leaves them as they are.
  try { backfillManagedSouls(onLaunch.launched(), { file: populationFile({ env, home }) }); } catch { /* shown as unmanaged */ }
  const comms = createCommsSupervisor({ env, home, now, onWake, onLaunch });
  const relay = createCommsRelay({ env: { ...harnessEnv, PATH: resumePath(harnessEnv, home) } });
  const taskReporter = createTaskReporter({
    file: path.join(path.dirname(daemonStateFile({ env, home })), 'task-turns.jsonl'),
    now,
    report: async (invocation) => {
      const binding = server.bindings.findAgent(invocation.agentId) ?? recordedWorktree(invocation.agentId, { env, home });
      if (!binding?.worktree) throw new Error('soul binding is unavailable');
      return relay.report({ agentId: invocation.agentId, binding }, invocation);
    },
  });
  // A soul's teammates go through the same launch handler as a principal's
  // launch; only the parent differs, and only the daemon can set it.
  const userConfig = config ?? loadConfig({ home, env });
  const account = env.USER ?? process.env.USER ?? 'unknown';
  const teamStarter = createTeamStarter({
    souls: () => listSouls({ status: 'active', file: populationFile({ env, home }) }),
    identities: (agentId) => { try { return identities(agentId); } catch { return null; } },
    launch: (event) => new Promise((resolve, reject) => {
      const { parent, ...request } = event;
      onLaunch(request, { account, parent, report: async (row) => resolve(row) }).catch(reject);
    }),
    receipt: ({ agentId, decision }) => appendAuditReceipt({ event: 'team-start', agentId, operation: 'start_soul', decision }, { env, home, now }),
    limits: teamLimits(userConfig),
    launchable: (harness) => harnessLaunchProblem(harness, { env: harnessEnv }) ?? true,
    template: () => defaultTeamTemplate({ config: userConfig, env }),
    account,
  });
  server = createDaemonServer({ env, home, config, now, comms, executor, taskReporter, teamStarter });
  await taskReporter.recover({ log: (line) => process.stderr.write(`agent-daemon: ${line}\n`) });
  server.wakePlane = createWakePlane({
    pool: server.warmPool,
    settings: () => readColdWakeSettings({ env, home }),
    lookupSoul: (agentId) => server.bindings.findAgent(agentId) ?? recordedWorktree(agentId, { env, home }),
    identities,
    executorFor,
    // Resume wake (#323) needs no executor config: it runs only for a soul
    // the owner set to `resume <policy>`.
    resumeExecutor: createResumeExecutor({
      sessions: createWakeSessions({ file: wakeSessionsFile({ env, home }) }),
      baseEnv: harnessEnv,
      home,
    }),
    // Webhook wake (#334) runs only for a soul the owner set to `webhook`.
    webhookWaker: createWebhookWaker({ read: (agentId) => readWebhook(agentId, { env, home }) }),
    // The relay runs agent-comms, which a launchd PATH does not reach.
    relay,
    taskReporter,
    // Receipts carry a soul and a decision, never message IDs or content.
    receipt: ({ event, agentId, decision, outcome, detail = null }) => appendAuditReceipt({ event, agentId, decision: decision ?? outcome, detail }, { env, home, now }),
    // A policy `approval` outcome in a cold turn waits on a proposal the
    // owner can decide (#85: `agent-bot approvals`, GeniusBar's panel).
    approvals: (request) => server.interaction.requestTurnApproval(request),
  });
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
  comms.start();
  const shutdown = () => {
    try {
      comms.stop();
    } catch {
      /* the watch loop is already down */
    }
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
  return { server, state, comms };
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

function brokerFlag(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--broker' || args[index].startsWith('--broker=')) {
      const value = args[index] === '--broker' ? args[index + 1] : args[index].slice('--broker='.length);
      if (!value || value.startsWith('--')) throw new Error('--broker requires an account name');
      return value;
    }
  }
  return null;
}

function formatCommsStatus(comms) {
  if (!comms?.paired) return 'comms: not paired (run `agent-bot daemon pair-comms [--broker <account>]`)';
  return `comms: paired as ${comms.account}, account-watch ${comms.connected ? 'connected' : 'disconnected'}`;
}

// A config from before the feature gates keeps the add-ons it was running
// with (#361). Never fatal: the daemon starts either way.
function reportPreGateMigration() {
  try {
    const result = migratePreGateConfig();
    if (result.migrated) {
      process.stderr.write(`agent-bot: ${result.path} predates feature gates and its souls use GitHub Apps; turned on ${Object.keys(result.features).join(' and ')} to keep that behavior\n`);
    }
  } catch (error) {
    process.stderr.write(`agent-bot: could not check the config for pre-gate add-ons: ${error.message}\n`);
  }
}

async function main() {
  const [command = 'status', ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  switch (command) {
    case 'run': {
      reportPreGateMigration();
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
        process.stdout.write(`${formatCommsStatus(status.comms)}\n`);
        const warm = Object.entries(status.warmPool ?? {});
        process.stdout.write(warm.length
          ? `warm pool: ${warm.map(([id, count]) => `${id} (${count})`).join(', ')}\n`
          : 'warm pool: empty\n');
      } else {
        process.stdout.write(`not running: ${status.reason}\n`);
        process.stdout.write(`${formatCommsStatus(status.comms)}\n`);
      }
      if (!status.running) process.exitCode = 1;
      break;
    }
    case 'pair-comms': {
      const broker = brokerFlag(rest);
      const pairing = await pairDaemonComms({ brokerAccount: broker });
      if (json) {
        process.stdout.write(`${JSON.stringify(pairing, null, 2)}\n`);
      } else {
        process.stdout.write(`daemon pairing requested for account '${pairing.account}' (state: ${pairing.state})\n`);
        process.stdout.write(`owner approval code: ${pairing.code}\n`);
        process.stdout.write('the owner approves this code on the broker admin socket, exactly like an account pairing\n');
      }
      break;
    }
    case 'stop': {
      const result = await stopDaemon();
      process.stdout.write(result.stopped ? `daemon stopped (pid ${result.pid})\n` : `${result.reason}\n`);
      break;
    }
    case 'install': {
      const unexpected = rest.filter((arg) => arg !== '--json');
      if (unexpected.length > 0) throw new Error('usage: agent-bot daemon install [--json]');
      reportPreGateMigration();
      const { ensureDaemonSupervisor } = await import('./daemon-supervisor.mjs');
      // This runtime exactly: the node running now and its agent-bot entry.
      const entry = fileURLToPath(new URL('./agent-bot.mjs', import.meta.url));
      const result = await ensureDaemonSupervisor({
        programArguments: [process.execPath, entry, 'daemon', 'run'],
        reloadUnchanged: false,
      });
      if (!result.applied) throw new Error(`no user-level supervisor on ${result.platform}`);
      const summary = { label: result.label, unitPath: result.unitPath, changed: result.refreshed, loaded: result.loaded };
      process.stdout.write(json
        ? `${JSON.stringify(summary, null, 2)}\n`
        : `daemon supervisor ${summary.changed ? 'installed' : 'unchanged'}: ${summary.label} (${summary.unitPath})\n`);
      break;
    }
    case 'disable': {
      const { disableDaemonSupervisor } = await import('./daemon-supervisor.mjs');
      const result = await disableDaemonSupervisor();
      if (json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.unloaded) {
        process.stdout.write('daemon supervisor unloaded\n');
      } else {
        process.stdout.write(`${result.reason}\n`);
      }
      break;
    }
    case 'vouch-key': {
      const unexpected = rest.filter((arg) => arg !== '--json');
      if (unexpected.length > 0) throw new Error('usage: agent-bot daemon vouch-key');
      const { publicKeyPem } = loadOrCreateVouchKey(vouchStateDir());
      process.stdout.write(publicKeyPem.endsWith('\n') ? publicKeyPem : `${publicKeyPem}\n`);
      break;
    }
    default:
      throw new Error('usage: agent-bot daemon <run|start|status|stop|install|disable|vouch-key|pair-comms> [--json]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-daemon: ${error.message}\n`);
    process.exit(1);
  });
}
