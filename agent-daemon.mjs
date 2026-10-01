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
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertPrivateGitDir, childBindingPath, consumeBindToken, createBindingRegistry, lookupBinding as lookupRegistryBinding, readBinding, readBindToken } from './agent-binding.mjs';
import { initAgentSpace, spacePath } from './agent-space.mjs';
import { listSouls, upsertIdentitySoul } from './agent-population.mjs';
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
import { recoverInteractionStore } from './agent-jobs.mjs';
import { appendAuditReceipt, principalsFile, resolvePrincipal } from './agent-principals.mjs';
import { runSpawnHooks } from './agent-hook.mjs';
import { createWebLayer } from './agent-web.mjs';
import { loadOrCreateVouchKey, signSoulToken, vouchStateDir } from './vouch.mjs';
import { PROOF_HEADER, parseBindingProof, signBindingProof } from './binding-proof.mjs';
import { createCommsSupervisor, pairDaemonComms, readCommsStatus } from './comms-client.mjs';
import { attachWakeEndpoint } from './agent-wake.mjs';
import { readColdWakeSettings } from './cold-wake-settings.mjs';
import { loadConfig } from './config.mjs';
import { acpExecutorFor, createWakePlane } from './wake-plane.mjs';

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
  mintImpl = mint,
  spawnHook = runSpawnHooks,
  now = () => new Date(),
  // #253 replaces this with its persistent lookup. The default reads the
  // in-memory registry and does not change how bindings are stored.
  lookupBinding: lookupBindingOverride = null,
  // Live comms watch state for GET /v0/comms/status. The supervisor is owned
  // by runDaemon; tests and embedding callers pass a stub with getState().
  comms = null,
} = {}) {
  // One interaction service per server so in-flight executions and their
  // cancellation controllers live exactly as long as the daemon.
  const interaction = createInteractionService({ env, home, config, executor, now });
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
      if (!['GET /v0/binding', 'DELETE /v0/binding', 'POST /v0/credential', 'POST /v0/spawn'].includes(`${req.method} ${url.pathname}`) && !tokensMatch(token, presented)) {
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
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, status: 'ok', pid: process.pid, warmPool: warmPool.list() });
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
          if ((body.parent && body.parent !== source.agentId)
            || (body.app && body.app !== parent.github.appSlug)) {
            throw Object.assign(new Error('spawn cannot override parent authority'), { statusCode: 403 });
          }
          const harness = body.harness ?? source.harness ?? parent.harness ?? 'unknown';
          const name = body.name ?? 'child';
          for (const value of [name, harness]) {
            if (typeof value !== 'string' || !value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
              throw Object.assign(new Error('invalid spawn name or harness'), { statusCode: 400 });
            }
          }
          const identity = mintAgentIdentity({
            appSlug: parent.github.appSlug, botUid: parent.github.botUid, harness,
            transcript: body.transcript, parentId: source.agentId,
            team: body.team ?? parent.team, squad: body.squad ?? parent.squad,
            type: body.type ?? 'agent', level: body.level, subjects: body.subjects ?? [], stateDir, now,
          });
          bindings.bind({ agentId: identity.id, parent: source.agentId, spawnedBy: source.bindingHash,
            worktree: source.worktree, gitDir: source.gitDir, app: parent.github.appSlug,
            harness, transcript: identity.transcript });
          const result = { agentId: identity.id, parent: source.agentId,
            binding: childBindingPath(source.gitDir, identity.id) };
          let warning;
          try { warning = await spawnHook({ ...result, name: body.name ?? identity.id, harness, cwd: source.worktree, env }); }
          catch { warning = 'spawn hook failed'; }
          sendJson(res, 200, { ...result, ...(warning ? { warning } : {}) });
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
            grant = await mintImpl({ slug: identity.github.appSlug, env });
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
          });
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
  const identity = ensureAgentIdentity({
    currentId: record.agentId,
    appSlug: pinned.github.appSlug,
    botUid: pinned.github.botUid,
    harness,
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
    app: bound.github.appSlug,
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
  // The ACP executor is off unless the user config turns it on (#259):
  // `"executor": { "enabled": true, "policy": { ... } }`. Without it /v1
  // keeps its unconfigured error and cold wake reports `waiting`.
  const setup = (config ?? loadConfig({ home, env })).executor;
  const identities = (agentId) => readAgentIdentity(validateAgentId(agentId), { stateDir: stateDirectory({ env, home }) });
  const executorFor = setup?.enabled === true
    ? acpExecutorFor({ identities, policy: setup.policy ?? { version: 1, rules: [], fallback: 'deny' }, baseEnv: env })
    : null;
  const executor = executorFor
    ? (input) => {
      const identity = identities(input.invocation.agentId);
      return executorFor({ agentId: identity.id, harness: identity.harness, cwd: input.invocation.cwd ?? setup.cwd ?? home, env: {} })(input);
    }
    : undefined;
  // The comms supervisor idles until a pairing credential exists, then keeps
  // the broker's account-watch stream open for this account's wakes (#255).
  // Each wake goes through the wake plane: a warm socket, else the opt-in
  // cold turn, else `waiting` (ADR-0008 decisions 7 to 9).
  let server;
  const onWake = (wake, ports) => server.wakePlane(wake, ports);
  const comms = createCommsSupervisor({ env, home, now, onWake });
  server = createDaemonServer({ env, home, config, now, comms, executor });
  server.wakePlane = createWakePlane({
    pool: server.warmPool,
    settings: () => readColdWakeSettings({ env, home }),
    lookupSoul: (agentId) => server.bindings.findAgent(agentId),
    identities,
    executorFor,
    // Receipts carry a soul and a decision, never message IDs or content.
    receipt: ({ event, agentId, decision, outcome }) => appendAuditReceipt({ event, agentId, decision: decision ?? outcome }, { env, home, now }),
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
      throw new Error('usage: agent-bot daemon <run|start|status|stop|disable|vouch-key|pair-comms> [--json]');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-daemon: ${error.message}\n`);
    process.exit(1);
  });
}
