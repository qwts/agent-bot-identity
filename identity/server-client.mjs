#!/usr/bin/env node
// Client for an agent-bot server (true-line/agent-bot): a fleet control plane
// that holds the harness GitHub App keys centrally and hands this machine
// short-lived, repo-scoped installation tokens.
//
// Off unless AGENT_BOT_SERVER (env) or settings.agentBotServer (config) names
// the server. With it unset, nothing here runs and minting stays local.
//
// Protocol (docs/server-mode.md):
//   enroll  — RFC 8628 device grant (/oauth/device_authorization, poll
//             /oauth/token), or a one-shot enrollment token for cloud VMs
//             (/oauth/device_enroll). Either way the proof is signed by a
//             P-256 device key generated here and kept 0600 in the state dir.
//   access  — RFC 7523 jwt-bearer assertion signed by the device key, with
//             cnf.jwk = a fresh in-memory P-256 key; the 15-minute token is
//             DPoP-bound (RFC 9449) to that ephemeral key, which is never
//             written to disk. Refreshed before expiry and after a 401.
//   verify  — every /api/daemon/* response is Ed25519-signed; the server key
//             from /.well-known/agent-bot-server-key is pinned on first use.
// Zero-dependency.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform as osPlatform } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.mjs';
import { enforcementProfile } from './identity-format.mjs';
import { listActions, readAction, transition, writeAction } from './action-ledger.mjs';

export const GRANT_DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';
export const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const REFRESH_MARGIN_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const CREDENTIAL_CONTRACT = 'credential/v1';

// Stable daemon codes (governance/error-codes.json) for the identity
// service's answers (Soul Agent Platform 0.4 Appendix A names in brackets):
//   credential-unavailable [credential_unavailable]: unreachable, timed out,
//     an unsigned 5xx, or a signed 503; nothing was issued, local work goes on.
//   device-revoked [device_revoked]: the device was revoked; cached tokens are
//     dropped at once and nothing mints until `server enroll --force`.
//   outcome-unknown [outcome_unknown]: the mint may have happened upstream;
//     look the operation up, never retry it blindly.
//   operation-conflict [operation_conflict]: an operation_id reused for a
//     different request, or after its token expired.
export function serverError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const ID_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A fresh operation_id: one per credential request, never reused (0.4 §7). */
export function newOperationId() {
  return `op_${crypto.randomUUID()}`;
}
/**
 * The task a credential is minted for: AGENT_BOT_TASK_ID when the daemon set
 * one for a turn, else the soul's conversation (Agent ID plus a digest of its
 * transcript locator), else an ad hoc task named by the operation itself.
 */
export function taskIdFor({ env = process.env, agentId = null, transcript = null, operationId } = {}) {
  if (env.AGENT_BOT_TASK_ID && ID_PART.test(env.AGENT_BOT_TASK_ID)) return env.AGENT_BOT_TASK_ID;
  if (agentId && ID_PART.test(agentId)) {
    if (!transcript) return agentId;
    const locator = typeof transcript === 'string' ? transcript : JSON.stringify(transcript);
    return `${agentId}.${crypto.createHash('sha256').update(locator).digest('hex').slice(0, 16)}`;
  }
  return `adhoc.${operationId}`;
}

// Callbacks run when the device is found revoked, so in-memory credentials
// (session tokens, the pilot provider key) are dropped at once.
const revokedListeners = new Set();
export function onDeviceRevoked(listener) {
  revokedListeners.add(listener);
  return () => revokedListeners.delete(listener);
}

// ---- settings ----

export function validateServerUrl(raw, source = 'AGENT_BOT_SERVER') {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`invalid ${source}: expected an https URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`invalid ${source}: must be https (http only for localhost)`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`invalid ${source}: no credentials, query or fragment`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function agentBotServerSetting(config = {}) {
  const value = config?.settings?.agentBotServer;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('invalid settings.agentBotServer: expected a URL string');
  return validateServerUrl(value, 'settings.agentBotServer');
}

// The server URL, or null when server mode is off. Env wins over config.
export function serverUrl({ env = process.env, config } = {}) {
  if (env.AGENT_BOT_SERVER) return validateServerUrl(env.AGENT_BOT_SERVER);
  return agentBotServerSetting(config ?? loadConfig({ env }));
}

export function serverStateDir({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_SERVER_STATE) return path.resolve(env.AGENT_BOT_SERVER_STATE);
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(home, '.local', 'state');
  return path.join(base, 'agent-bot', 'server');
}

// Harness names as the server knows them (`claude`, `codex`, `grok`, …).
export function serverHarness(name) {
  if (!name) return null;
  return name === 'claude-code' ? 'claude' : name;
}

export function ambientHarness(env = process.env) {
  if (env.AGENT_BOT_SERVER_HARNESS) return serverHarness(env.AGENT_BOT_SERVER_HARNESS);
  if (env.GROK_AGENT === '1') return 'grok';
  return null;
}

// ---- JOSE helpers ----

const b64u = (b) => Buffer.from(b).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const newJti = () => b64u(crypto.randomBytes(16));

export function publicJwk(key) {
  const { kty, crv, x, y } = crypto.createPublicKey(key).export({ format: 'jwk' });
  return { kty, crv, x, y };
}

export function jwkThumbprint(jwk) {
  return b64u(crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

export function signJws(privateKey, header, payload) {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64u(sig)}`;
}

export function signatureMessage(status, body, requestJti) {
  return `agent-bot-sig-v1\n${status}\n${crypto.createHash('sha256').update(body).digest('hex')}\n${requestJti}`;
}

export function verifyServerResponse(serverJwk, { status, body, requestJti, headers }) {
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: serverJwk.x }, format: 'jwk' });
  const sig = headers.get('agent-bot-signature') || '';
  if (headers.get('agent-bot-request-jti') !== requestJti
    || !crypto.verify(null, Buffer.from(signatureMessage(status, body, requestJti)), key, Buffer.from(sig, 'base64url'))) {
    throw new Error('agent-bot server response signature is invalid (pinned key mismatch?)');
  }
}

// ---- local state (0600 files in a 0700 dir) ----

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* windows */ }
}

function writePrivate(file, text) {
  ensureDir(path.dirname(file));
  writeFileSync(file, text, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* windows */ }
}

export function statePaths(opts = {}) {
  const dir = serverStateDir(opts);
  return { dir, key: path.join(dir, 'device-key.pem'), device: path.join(dir, 'device.json'), serverKey: path.join(dir, 'server-key.json') };
}

export function loadDeviceKey(opts = {}, { create = false } = {}) {
  const { key } = statePaths(opts);
  if (existsSync(key)) return crypto.createPrivateKey(readFileSync(key));
  if (!create) return null;
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writePrivate(key, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  return privateKey;
}

export function loadDevice(opts = {}) {
  const { device } = statePaths(opts);
  return existsSync(device) ? JSON.parse(readFileSync(device, 'utf8')) : null;
}

function saveDevice(opts, record) {
  writePrivate(statePaths(opts).device, `${JSON.stringify(record, null, 2)}\n`);
}

export function loadPinnedServerKey(opts = {}) {
  const { serverKey } = statePaths(opts);
  return existsSync(serverKey) ? JSON.parse(readFileSync(serverKey, 'utf8')) : null;
}

// ---- HTTP ----

// Never follow redirects: a 3xx could forward device-key assertions or DPoP
// headers to another origin, or get a foreign key pinned on first use.
function noRedirect(fetchImpl) {
  return (url, init = {}) => fetchImpl(url, { ...init, redirect: 'error' });
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: `non-JSON response (${res.status})` }; }
}

function form(fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body };
}

function oauthError(prefix, body) {
  const e = new Error(`${prefix}: ${body.error ?? 'error'}${body.error_description ? ` (${body.error_description})` : ''}`);
  e.code = body.error;
  return e;
}

export async function pinServerKey(base, opts = {}, { fetchImpl: rawFetch = fetch } = {}) {
  const fetchImpl = noRedirect(rawFetch);
  const pinned = loadPinnedServerKey(opts);
  if (pinned) return pinned;
  const res = await fetchImpl(`${base}/.well-known/agent-bot-server-key`);
  const body = await readJson(res);
  const jwk = body?.keys?.[0];
  if (!res.ok || jwk?.kty !== 'OKP' || jwk?.crv !== 'Ed25519' || !jwk?.x) {
    throw new Error(`agent-bot server key unavailable: ${body?.error ?? res.status}`);
  }
  const record = { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: jwk.kid, server: base, pinned_at: new Date().toISOString() };
  writePrivate(statePaths(opts).serverKey, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function enrollProof(deviceKey, aud) {
  return signJws(deviceKey, { alg: 'ES256', typ: 'ab-enroll+jwt', jwk: publicJwk(deviceKey) }, { aud, iat: now(), jti: newJti() });
}

export function defaultPlatform(env = process.env) {
  if (env.AGENT_BOT_ENROLL_TOKEN) return 'cloud-vm';
  return { darwin: 'macos', linux: 'linux', win32: 'windows', android: 'android' }[osPlatform()] ?? 'other';
}

// Enroll this machine. Returns the stored device record.
export async function enroll({
  base, env = process.env, home, harnesses = [], deviceName = hostname(), platform = defaultPlatform(env),
  tags = [], enrollToken = env.AGENT_BOT_ENROLL_TOKEN, force = false,
  fetchImpl: rawFetch = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onPrompt = () => {},
} = {}) {
  const fetchImpl = noRedirect(rawFetch);
  const opts = { env, home };
  if (!force && loadDevice(opts)) throw new Error('already enrolled; run `agent-bot server logout` first (or pass --force)');
  if (force) logout(opts);
  const serverKey = await pinServerKey(base, opts, { fetchImpl });
  const deviceKey = loadDeviceKey(opts, { create: true });
  const jkt = jwkThumbprint(publicJwk(deviceKey));
  const meta = { device_name: deviceName, platform, key_storage: 'software', tags: tags.join(' ') };
  let result; let method;
  if (enrollToken) {
    method = 'enrollment_token';
    const aud = `${base}/oauth/device_enroll`;
    const res = await fetchImpl(aud, form({ ...meta, enrollment_token: enrollToken, proof: enrollProof(deviceKey, aud) }));
    result = await readJson(res);
    if (!res.ok || !result.device_id) throw oauthError('enrollment failed', result);
  } else {
    method = 'device_code';
    if (harnesses.length === 0) throw new Error('enroll needs at least one --harness');
    const aud = `${base}/oauth/device_authorization`;
    const res = await fetchImpl(aud, form({ ...meta, harnesses: harnesses.join(' '), proof: enrollProof(deviceKey, aud) }));
    const auth = await readJson(res);
    if (!res.ok || !auth.user_code) throw oauthError('device authorization failed', auth);
    onPrompt({ ...auth, jkt });
    let interval = Number(auth.interval) || 5;
    const deadline = Date.now() + (Number(auth.expires_in) || 900) * 1000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('device code expired before approval');
      await sleep(interval * 1000);
      const p = await fetchImpl(`${base}/oauth/token`, form({ grant_type: GRANT_DEVICE_CODE, device_code: auth.device_code }));
      const body = await readJson(p);
      if (body.device_id) { result = body; break; }
      if (body.error === 'slow_down') interval += 5;
      else if (body.error !== 'authorization_pending') throw oauthError('enrollment failed', body);
    }
  }
  const record = {
    server: base, device_id: result.device_id, jkt, method, platform, device_name: deviceName,
    harnesses: result.harnesses ?? harnesses, read_only: Boolean(result.read_only),
    ephemeral: Boolean(result.ephemeral), expires_at: result.expires_at ?? null,
    management: 'managed', server_key_id: serverKey.kid ?? null, enrolled_at: new Date().toISOString(),
  };
  saveDevice(opts, record);
  // Prove the enrollment works end to end and learn what the server reports.
  // The enrollment is already real on the server, so a failed check is a
  // warning on the saved record, not an error that strands a retry.
  try {
    const who = await new ServerSession({ base, env, home, fetchImpl: rawFetch }).whoami();
    saveDevice(opts, { ...record, management: who?.device?.management ?? record.management, verified: true });
  } catch (e) {
    saveDevice(opts, { ...record, verified: false, verify_error: e.message });
  }
  return loadDevice(opts);
}

export function logout(opts = {}) {
  const { dir } = statePaths(opts);
  rmSync(dir, { recursive: true, force: true });
}

// A long-lived authenticated session: re-mints its 15-minute DPoP token on
// demand, so a daemon can hold one forever across sleep/wake.
export class ServerSession {
  constructor({ base, env = process.env, home, fetchImpl = fetch } = {}) {
    this.opts = { env, home };
    this.base = base ?? serverUrl({ env });
    this.fetch = noRedirect(fetchImpl);
    this.token = null;
  }

  device() {
    const d = loadDevice(this.opts);
    if (!d) throw new Error('this machine is not enrolled with the agent-bot server; run `agent-bot server enroll`');
    if (d.server !== this.base) throw new Error(`enrolled with ${d.server}, not ${this.base}; run \`agent-bot server enroll --force\``);
    if (d.revoked_at) throw serverError('device-revoked', `this device was revoked at the identity service (${d.revoked_at}); re-enroll with \`agent-bot server enroll --force\``);
    return d;
  }

  // The identity service said this device is revoked: drop the session token
  // and everything listeners hold, and record it so no later process tries.
  revoked(detail = 'device_revoked') {
    this.token = null;
    const d = loadDevice(this.opts);
    if (d && !d.revoked_at) saveDevice(this.opts, { ...d, revoked_at: new Date().toISOString() });
    for (const listener of revokedListeners) { try { listener(); } catch { /* a listener never blocks revocation */ } }
    return serverError('device-revoked', `the identity service revoked this device (${detail}); cached credentials were dropped; re-enroll with \`agent-bot server enroll --force\``);
  }

  // One request to the identity service: transport failures and timeouts are
  // credential-unavailable, never an authority decision.
  async send(url, init) {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      // No connection was made (refused, no route, no DNS): nothing can have
      // reached the service. A timeout or reset after connecting might have.
      const code = error?.cause?.code ?? error?.code;
      const neverSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
      throw serverError('credential-unavailable', `the identity service is unreachable (${error?.name === 'TimeoutError' ? 'timed out' : code ?? 'network error'})`, { neverSent });
    }
  }

  async accessToken({ force = false } = {}) {
    if (!force && this.token && Date.now() < this.token.refreshAt) return this.token;
    const dev = this.device();
    const deviceKey = loadDeviceKey(this.opts);
    if (!deviceKey) throw new Error('device key missing; re-enroll with `agent-bot server enroll --force`');
    const { privateKey: ek } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const t = now();
    const assertion = signJws(deviceKey, { alg: 'ES256', typ: 'JWT' }, {
      iss: dev.device_id, sub: dev.device_id, aud: `${this.base}/oauth/token`, iat: t, exp: t + 120, jti: newJti(),
      cnf: { jwk: publicJwk(ek) },
    });
    const res = await this.send(`${this.base}/oauth/token`, form({ grant_type: GRANT_JWT_BEARER, assertion }));
    if (res.status >= 500) throw serverError('credential-unavailable', `the identity service token endpoint answered ${res.status}; nothing was issued`);
    const body = await readJson(res);
    if (body.error === 'device_revoked' || (body.error === 'invalid_grant' && /device_revoked/.test(body.error_description ?? ''))) throw this.revoked();
    if (!res.ok || !body.access_token) {
      const e = oauthError('agent-bot server token', body);
      if (body.error === 'invalid_grant') e.message += ' — the device may be revoked or expired; re-enroll';
      throw e;
    }
    const life = (Number(body.expires_in) || 900) * 1000;
    this.token = { value: body.access_token, ek, refreshAt: Date.now() + Math.max(life - REFRESH_MARGIN_MS, life / 2), management: body.management };
    return this.token;
  }

  async call(method, route, payload) {
    this.device();
    const serverKey = loadPinnedServerKey(this.opts);
    if (!serverKey) throw new Error('no pinned server key; re-enroll');
    for (let attempt = 0; ; attempt += 1) {
      const tok = await this.accessToken({ force: attempt > 0 });
      const url = `${this.base}${route}`;
      const jti = newJti();
      const dpop = signJws(tok.ek, { alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk(tok.ek) }, {
        htm: method, htu: url, iat: now(), jti, ath: b64u(crypto.createHash('sha256').update(tok.value).digest()),
      });
      // A failed write (POST) may still have reached the service: such an
      // outcome is `ambiguous`, and a credential caller looks the operation
      // up before anything is retried (T06). A GET changes nothing.
      const ambiguous = method !== 'GET';
      let res;
      try {
        res = await this.send(url, {
          method,
          headers: { authorization: `DPoP ${tok.value}`, dpop, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
          body: payload ? JSON.stringify(payload) : undefined,
        });
      } catch (error) { throw Object.assign(error, { ambiguous: ambiguous && !error.neverSent }); }
      let buf;
      try { buf = Buffer.from(await res.arrayBuffer()); } catch {
        throw serverError('credential-unavailable', `the identity service connection dropped while answering ${route}`, { ambiguous });
      }
      // An unsigned 5xx (a proxy, the platform) grants nothing: unavailable.
      // A 503 means the request was not served; a 502 or 504 after a write
      // may have been, so that write's outcome is ambiguous.
      if (res.status >= 500 && !res.headers.get('agent-bot-signature')) {
        throw serverError('credential-unavailable', `the identity service answered ${res.status} for ${route}`, { ambiguous: ambiguous && res.status !== 503 });
      }
      verifyServerResponse(serverKey, { status: res.status, body: buf, requestJti: jti, headers: res.headers });
      let json;
      try { json = JSON.parse(buf.toString('utf8')); } catch { json = {}; }
      if (json.error === 'device_revoked') throw this.revoked();
      if (res.status === 401 && attempt === 0) continue; // token expired early (sleep, clock): re-mint once
      if (!res.ok) {
        const known = { credential_unavailable: 'credential-unavailable', outcome_unknown: 'outcome-unknown', operation_conflict: 'operation-conflict' }[json.error];
        const e = known
          ? serverError(known, `the identity service answered ${route}: ${json.error}${json.error_description ? ` (${json.error_description})` : ''}`, { body: json })
          : new Error(`agent-bot server ${route}: ${res.status} ${json.error ?? ''}${typeof json.error_description === 'string' ? ` (${json.error_description.slice(0, 200)})` : ''}`.trim());
        e.status = res.status;
        throw e;
      }
      return json;
    }
  }

  whoami() { return this.call('GET', '/api/daemon/whoami'); }

  installationToken({ harness, repo }) {
    return this.call('POST', '/api/daemon/installation-token', { harness: serverHarness(harness), repo });
  }

  // credential/v1: one credential for exactly one (task, operation). The
  // answer must echo both, or it is refused.
  async credential({ harness, repo, taskId, operationId, profile }) {
    const out = await this.call('POST', '/api/daemon/credentials', {
      task_id: taskId, operation_id: operationId, kind: 'github_installation_token', harness: serverHarness(harness), repo, profile,
    });
    if (out.task_id !== taskId || out.operation_id !== operationId || typeof out.token !== 'string' || !out.token || !out.issuance_id) {
      throw new Error('the identity service answer does not match the requested task and operation; refusing it');
    }
    return out;
  }

  /** `{ state: issued|unknown|none, ... }` for one operation; never a token. */
  issuance(operationId) {
    return this.call('GET', `/api/daemon/issuances/${encodeURIComponent(operationId)}`);
  }
}

// owner/name of the checkout's origin remote, for server-side minting.
export function repoFromCheckout(cwd = process.cwd(), env = process.env) {
  if (env.AGENT_BOT_SERVER_REPO) return env.AGENT_BOT_SERVER_REPO;
  let remote;
  try {
    remote = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  const m = remote.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Mint through the server: same shape as the local mint() result.
// The credential request as an action-ledger entry (0.4 §7, T06): recorded
// before it is sent; an ambiguous failure is looked up, never re-sent blind.
async function mintRecorded(session, { harness, repo, taskId, operationId, profile, stateDir }) {
  const request = { kind: 'github_installation_token', harness: serverHarness(harness), repo };
  // An operation already in the ledger is never overwritten: an unknown one
  // is reconciled by lookup; any other is a reused operation_id.
  const existing = readAction(stateDir, operationId);
  if (existing?.state === 'unknown') return reconcileCredential(session, { stateDir, operationId, profile });
  if (existing) throw serverError('operation-conflict', `credential operation ${operationId} was already used (${existing.state}); use a new operation`, { operationId });
  // No blind retry under a new name either (T06): an earlier operation for
  // the same task, harness and repo whose outcome is unknown is settled by
  // lookup first. Issued or none lets this one go ahead; still unknown
  // refuses it, so a lost credential is never followed by a second mint.
  for (const pending of listActions(stateDir, { state: 'unknown' })) {
    if (pending.task_id !== taskId || pending.harness !== request.harness || pending.repo !== repo) continue;
    try {
      await reconcileCredential(session, { stateDir, operationId: pending.operation_id, profile });
    } catch (error) {
      if (readAction(stateDir, pending.operation_id)?.state === 'rejected') continue;
      throw error;
    }
  }
  writeAction(stateDir, { operation_id: operationId, task_id: taskId, ...request, state: 'prepared', created_at: new Date().toISOString() });
  transition(stateDir, operationId, 'submitted');
  try {
    const out = await session.credential({ harness, repo, taskId, operationId, profile });
    transition(stateDir, operationId, 'succeeded', { issuance_id: out.issuance_id, replayed: Boolean(out.replayed) });
    return out;
  } catch (error) {
    const unknown = error.code === 'outcome-unknown' || (error.code === 'credential-unavailable' && error.ambiguous);
    if (!unknown) {
      transition(stateDir, operationId, 'rejected', { reason: error.code ?? 'error' });
      throw error;
    }
    transition(stateDir, operationId, 'unknown', { reason: error.code });
    return reconcileCredential(session, { stateDir, operationId, profile, cause: error });
  }
}

/**
 * Settles one `unknown` credential action by lookup: `issued` replays the
 * same operation (the service returns the same issuance; nothing new is
 * minted), `none` records `rejected`, and anything else stays `unknown` and
 * throws `outcome-unknown`. Never sends a fresh request for the operation.
 */
export async function reconcileCredential(session, { stateDir, operationId, profile = enforcementProfile().profile, cause = null }) {
  const action = readAction(stateDir, operationId);
  if (!action) throw new Error(`no action recorded for ${operationId}`);
  if (action.state !== 'unknown') return action;
  let found;
  try {
    found = await session.issuance(operationId);
  } catch (error) {
    if (error.code === 'device-revoked') throw error;
    throw serverError('outcome-unknown', `the outcome of credential operation ${operationId} is unknown and could not be looked up (${error.code ?? 'error'}); it was not retried`, { operationId, cause });
  }
  // Issued, but its credential has expired: it can never be replayed (the
  // service answers operation_conflict), so the action settles as rejected
  // instead of staying unknown for ever.
  const expired = (reason) => {
    transition(stateDir, operationId, 'rejected', { reason, issuance_id: found.issuance_id ?? null, reconciled: true });
    return serverError('credential-unavailable', `credential operation ${operationId} was issued but its credential has expired (reconciled by lookup); it was not re-sent`, { operationId });
  };
  if (found?.state === 'issued' && found.expires_at && Date.parse(found.expires_at) <= Date.now()) throw expired('reconciled-expired');
  if (found?.state === 'issued') {
    let out;
    try {
      out = await session.credential({ harness: action.harness, repo: action.repo, taskId: action.task_id, operationId, profile });
    } catch (error) {
      if (error.code === 'operation-conflict') throw expired('reconciled-conflict');
      throw error;
    }
    if (out.issuance_id !== found.issuance_id) throw new Error(`the identity service replayed a different issuance for ${operationId}; refusing it`);
    transition(stateDir, operationId, 'succeeded', { issuance_id: out.issuance_id, replayed: true, reconciled: true });
    return out;
  }
  if (found?.state === 'none') {
    transition(stateDir, operationId, 'rejected', { reason: 'reconciled-none', reconciled: true });
    throw serverError('credential-unavailable', `credential operation ${operationId} was not issued (reconciled by lookup); nothing was minted`, { operationId });
  }
  throw serverError('outcome-unknown', `the identity service still reports credential operation ${operationId} as unknown until ${found?.expires_at ?? 'later'}; it was not retried`, { operationId, resolvesAt: found?.expires_at ?? null });
}

/** Reconciles every `unknown` credential action (daemon start, `agent-bot server reconcile`). */
export async function reconcilePendingCredentials({ base, env = process.env, home, fetchImpl = fetch, session = null } = {}) {
  const stateDir = serverStateDir({ env, ...(home ? { home } : {}) });
  const s = session ?? new ServerSession({ base: base ?? serverUrl({ env }), env, home, fetchImpl });
  const results = [];
  for (const action of listActions(stateDir, { state: 'unknown' })) {
    try {
      await reconcileCredential(s, { stateDir, operationId: action.operation_id });
      results.push({ operation_id: action.operation_id, state: readAction(stateDir, action.operation_id).state });
    } catch (error) {
      results.push({ operation_id: action.operation_id, state: readAction(stateDir, action.operation_id)?.state ?? 'unknown', code: error.code ?? 'error' });
      if (error.code === 'device-revoked') break;
    }
  }
  return results;
}

// One credential per task and operation (credential/v1). The token goes to
// the caller for this one operation and is never cached or reused; receipts
// carry the issuance reference instead.
export async function mintViaServer({ base, harness, repo, env = process.env, home, fetchImpl = fetch, taskId = null, operationId = null, session = null } = {}) {
  if (!harness) throw new Error('server mode needs a harness: pass --app, set AGENT_BOT_SERVER_HARNESS, or run inside a detected harness');
  if (!repo) throw new Error('server mode mints per repository: run inside a checkout with an origin remote, or set AGENT_BOT_SERVER_REPO=owner/name');
  const op = operationId ?? newOperationId();
  const task = taskId ?? taskIdFor({ env, operationId: op });
  if (!ID_PART.test(op) || !ID_PART.test(task)) throw new Error('task and operation IDs are 1-128 characters of [A-Za-z0-9._:-]');
  const profile = enforcementProfile({ env, ...(home ? { home } : {}) }).profile;
  const s = session ?? new ServerSession({ base, env, home, fetchImpl });
  const out = await mintRecorded(s, { harness, repo, taskId: task, operationId: op, profile, stateDir: serverStateDir({ env, ...(home ? { home } : {}) }) });
  return {
    token: out.token, expires_at: out.expires_at, installation_id: null, repo: out.repo ?? repo, git_author: out.git_author,
    source: 'agent-bot-server', issuance_id: out.issuance_id, task_id: out.task_id, operation_id: out.operation_id,
    profile: out.profile ?? profile, replayed: Boolean(out.replayed),
  };
}

// ---- CLI ----

export const SERVER_USAGE = `usage: agent-bot server enroll [--harness NAME]... [--name DEVICE] [--platform P] [--tag T]... [--force] [--json]
       agent-bot server status [--json]
       agent-bot server logout
       agent-bot server reconcile [--json]

Server mode is on when AGENT_BOT_SERVER (or settings.agentBotServer) is set.
enroll uses the device grant (approve in the browser), or AGENT_BOT_ENROLL_TOKEN
when set (cloud VMs). logout deletes this machine's device key and pins; revoke
the device on <server>/devices as well.
`;

export function parseServerArgs(argv) {
  const [sub, ...rest] = argv;
  const out = { sub, harnesses: [], tags: [], json: false, force: false };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const val = () => { const v = rest[++i]; if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`); return v; };
    if (a === '--json') out.json = true;
    else if (a === '--force') out.force = true;
    else if (a === '--harness') out.harnesses.push(serverHarness(val()));
    else if (a === '--tag') out.tags.push(val());
    else if (a === '--name') out.name = val();
    else if (a === '--platform') out.platform = val();
    else throw new Error(`unknown option: ${a}\n${SERVER_USAGE}`);
  }
  if (!['enroll', 'status', 'logout', 'reconcile', undefined, 'help', '--help', '-h'].includes(sub)) throw new Error(`unknown server command: ${sub}\n${SERVER_USAGE}`);
  return out;
}

export async function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, err = process.stderr, fetchImpl = fetch, sleep } = {}) {
  try {
    const a = parseServerArgs(argv);
    if (!a.sub || ['help', '--help', '-h'].includes(a.sub)) { out.write(SERVER_USAGE); return 0; }
    if (a.sub === 'reconcile') {
      // Settle credential actions whose outcome went missing, by lookup only (T06).
      const results = await reconcilePendingCredentials({ env, fetchImpl });
      const lines = results.map((r) => `${r.operation_id}: ${r.state}${r.code ? ` (${r.code})` : ''}\n`).join('');
      out.write(a.json ? `${JSON.stringify({ reconciled: results })}\n` : (lines || 'no pending credential actions\n'));
      return results.some((r) => r.state === 'unknown') ? 1 : 0;
    }
    if (a.sub === 'logout') {
      logout({ env });
      out.write('removed local server enrollment; also revoke this device on the server\'s /devices page\n');
      return 0;
    }
    const base = serverUrl({ env });
    if (!base) throw new Error('server mode is off: set AGENT_BOT_SERVER=https://… (or settings.agentBotServer)');
    if (a.sub === 'status') {
      const dev = loadDevice({ env });
      const status = { server: base, enrolled: Boolean(dev), device: dev, pinned_key: loadPinnedServerKey({ env })?.kid ?? null };
      if (dev) {
        try { status.remote = (await new ServerSession({ base, env, fetchImpl }).whoami()).device; status.ok = true; }
        catch (e) { status.ok = false; status.error = e.message; }
      }
      out.write(a.json ? `${JSON.stringify(status)}\n` : formatStatus(status));
      return status.enrolled && status.ok === false ? 1 : 0;
    }
    const harnesses = a.harnesses.length ? a.harnesses : [ambientHarness(env)].filter(Boolean);
    const record = await enroll({
      base, env, harnesses, tags: a.tags, force: a.force, fetchImpl, ...(sleep ? { sleep } : {}),
      ...(a.name ? { deviceName: a.name } : {}), ...(a.platform ? { platform: a.platform } : {}),
      onPrompt: (p) => err.write(`Approve this device at ${p.verification_uri_complete}\n  code: ${p.user_code}\n  key:  ${p.jkt}\nWaiting for approval…\n`),
    });
    if (record.verified === false) err.write(`warning: enrolled, but the first signed check failed: ${record.verify_error}; run \`agent-bot server status\`\n`);
    out.write(a.json ? `${JSON.stringify(record)}\n` : `enrolled ${record.device_id} (${record.management}, harnesses: ${record.harnesses.join(', ')})\n`);
    return 0;
  } catch (e) {
    err.write(`agent-bot server: ${e.message}\n`);
    return 1;
  }
}

function formatStatus(s) {
  if (!s.enrolled) return `server: ${s.server}\nnot enrolled — run \`agent-bot server enroll --harness <name>\`\n`;
  const d = s.device;
  const revoked = d.revoked_at ? `revoked: ${d.revoked_at} — re-enroll with \`agent-bot server enroll --force\`\n` : '';
  return `server: ${s.server}\ndevice: ${d.device_id} (${d.management}${d.ephemeral ? ', ephemeral' : ''})\nharnesses: ${d.harnesses.join(', ')}${d.read_only ? ' (read-only)' : ''}\npinned key: ${s.pinned_key}\n${revoked}${s.ok ? 'auth: ok' : `auth: FAILED — ${s.error}`}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
