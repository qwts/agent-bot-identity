#!/usr/bin/env node

// Private web client plane for the loopback daemon (#59). The daemon serves a
// small installable PWA from the in-repo `web/` directory at /ui/... and a
// cookie-authenticated JSON API at /ui/api/... — a projection of the same
// interaction service every other adapter uses, never a second authority.
//
// Browser trust model:
//   - The daemon's per-start bearer token never reaches JavaScript-accessible
//     storage. Instead, `agent-bot web open` (a local owner ceremony, like
//     principal enrollment) asks the daemon to mint a one-time pairing code
//     bound to an enrolled principal and prints a 127.0.0.1 URL carrying it
//     in the fragment. The page exchanges the code (single use, ~2 minute
//     expiry) for a short-lived HttpOnly SameSite=Strict cookie session held
//     daemon-side in memory (~12 hours), so nothing durable or secret lives
//     in the browser.
//   - State-changing requests require the custom X-Agent-Bot-UI header and a
//     same-origin Origin check on top of the SameSite cookie.
//   - Every operation is authorized per principal by the interaction service
//     (deny-by-default, #57); the browser is untrusted relative to it.
//   - The daemon stays loopback-only. Remote access is an explicit operator
//     deployment (Tailscale / reverse proxy) documented in the README, never
//     a wider listener here.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertAuthorized, assertMachineAuthorized, fetchCatalog, getPrincipal, listPrincipals, loadDevice, principalsFile, serverUrl, listSessions } from './identity-host.mjs';
import { stateDirectory } from './state-paths.mjs';
import { operationDigest } from './agent-jobs.mjs';
import { populationFile } from './agent-population.mjs';
import { listSoulProposals, revisionCommand } from './soul-revisions.mjs';
import { setColdWake } from './cold-wake-settings.mjs';
import { removalPlan, soulRemoveCommand } from './soul-remove.mjs';
import { appendAuditReceipt } from './identity-format.mjs';
import { configPath, FEATURE_GATES, loadConfig, SKILL_SEARCH_ADAPTERS, validateConfig } from './config.mjs';
import { serverStatusReport, doctorReportAsync } from './server-status.mjs';
import {
  AGENT_MACHINE_DIR, buildRequest, daemonFingerprint, loadMachinePublicKey,
  loadMachineSigner, loadOrCreateMachineKey, machineCall, machineSocketPath,
  pairedPublicKey, pinDaemonPub, pinPath, unpairAgentDaemon, verifyResponse,
  writeAgentDaemonPeer,
} from './machine-client.mjs';
import { daemonStateFile, daemonStatus, wrongAccountWarning } from './agent-daemon.mjs';

export const UI_CSRF_HEADER = 'x-agent-bot-ui';
export const PAIRING_CODE_TTL_MS = 2 * 60_000;
export const WEB_SESSION_TTL_MS = 12 * 60 * 60_000;
export const MAX_ARTIFACT_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const COOKIE_NAME = 'agent_bot_ui';
const MAX_BODY_BYTES = 64 * 1024;
const WEB_TRANSPORT = 'web';

// Self-contained client only: no CDN scripts, no external styles or fonts, no
// inline <script> (all JS lives in app.js), no cross-origin connects.
const STATIC_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': STATIC_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
]);

// Flat, boring asset names only. Anything else — traversal, separators,
// dotfiles, encodings — is an unknown asset, checked again canonically below.
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Enroll stdout is newline-delimited JSON; a record may split across chunks,
// so the parser carries the partial tail. Non-JSON lines are ignored.
export function parseEnrollLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}
// The flow's complete URI is the approve link; build one only when absent.
export function enrollPromptReport(prompt, report, now = () => new Date()) {
  const verification_uri = prompt.verification_uri_complete
    ?? (prompt.verification_uri && prompt.user_code
      ? `${prompt.verification_uri}?user_code=${encodeURIComponent(prompt.user_code)}`
      : prompt.verification_uri);
  report({ status: 'pending-approval', user_code: prompt.user_code, verification_uri,
    expires_at: new Date(now().getTime() + (prompt.expires_in ?? 900) * 1000).toISOString(),
    thumbprint: prompt.jkt });
}

export function enrollStdoutChunk(tail, chunk, onLine) {
  const lines = (tail + chunk).split('\n');
  const rest = lines.pop();
  for (const line of lines) if (line.trim()) onLine(line);
  return rest;
}
// Only the non-secret reconcile fields the UI needs ever leave the server.
function reconcileRow(row) {
  return { operation_id: row?.operation_id ?? null, state: row?.state ?? null, reason: row?.reason ?? null };
}

// The web-proposal owner gate (#1295), built inside an approved proposal's
// execute. It accepts only the exact action string the implementation will
// pass for this operation and returns the consent-shaped authorization
// naming the proposal as the owner decision — every other caller and the
// default gates are untouched.
export function proposalOwnerGate({ expected, proposalId, principalId, digest, env, home, now }) {
  return async (action) => {
    if (action !== expected) throw Object.assign(new Error('owner-gate action mismatch'), { code: 'ui-proposal-gate-mismatch' });
    appendAuditReceipt({ event: 'ui-proposal-decision', proposalId, principal: principalId,
      operationDigest: digest, action, decision: 'approved' }, { env, home, now });
    return { method: 'consent', via: `ui-proposal:${proposalId}` };
  };
}

// The removal-plan compact summary — the digest-covered shape the proposal
// summary names and the executor re-checks before removing anything.
async function soulRemovePlan(agentId, { env, home, stateDir }) {
  const plan = await removalPlan(agentId, {
    scope: 'soul', file: populationFile({ env, home }), env, home, stateDir,
    running: async () => null,
  });
  return { archived: plan.archived.map((e) => e.agentId).sort(),
    independent: plan.independent.map((e) => e.agentId).sort(), unchanged: plan.unchanged.length };
}

export function webRootDirectory() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
}

function failure(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
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
        req.removeAllListeners('data');
        req.pause();
        reject(failure(413, 'request body too large'));
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
    throw failure(400, 'request body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw failure(400, 'request body must be a JSON object');
  }
  return parsed;
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

function tokensMatch(expected, presented) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented ?? '', 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicPrincipal(principal) {
  return {
    principalId: principal.principalId,
    label: principal.label,
    operations: principal.authorizations.operations,
    souls: principal.authorizations.souls,
    defaultSoul: principal.defaultSoul,
  };
}

const execFileAsync = promisify(execFile);

const webRootDirectoryRoot = path.dirname(fileURLToPath(import.meta.url));

export function createWebLayer({
  env = process.env,
  home = homedir(),
  config,
  interaction,
  daemonToken,
  confirmDecision = null,
  now = () => new Date(),
  reconcileInFlight = { current: null },
  catalogFetch = { inFlight: null, result: null, at: 0 },
  lastDelivery = { current: null },
  fetchCatalogImpl = fetchCatalog,
  digestUploadStatus = () => ({ at: null, outcome: null }),
  notifyMachineWrite = () => {},
  soulBindings = () => [],
  // Server actions (#1295): CLI spawns, injected for tests.
  spawnServerCli = null,
  webRoot = webRootDirectory(),
  // Injectable for tests: the shared server/doctor probes (#1295).
  serverStatus = serverStatusReport,
  doctor = doctorReportAsync,
} = {}) {
  void config; // reserved; the web layer holds no policy of its own
  const root = path.resolve(webRoot);
  // Pairing codes and cookie sessions are held daemon-side in memory only:
  // they die with the daemon, are never written to disk, and are therefore
  // never available to another local account or a later process.
  let doctorInFlight = null;
  const machineInFlight = new Map();
let enrollInFlight = false;
const enrollChildren = new Set();

  // Machine-level views are only for a principal the owner allowed to
  // observe every soul — exactly ['*'], not a subset with '*' adjacent
  // to other entries (#1295).
  function requireMachineView(principal) {
    const auth = principal.authorizations ?? {};
    if (!Array.isArray(auth.operations) || !auth.operations.includes('observe')
      || !Array.isArray(auth.souls) || auth.souls.length !== 1 || auth.souls[0] !== '*') {
      throw failure(403, 'principal is not authorized for this operation');
    }
  }

  // A signed verb round trip; an agent-machine failure is data, never a
  // thrown route error — the Server section keeps working when it is down.
  async function machineVerb(verb, fields = {}) {
    const pinned = pairedPublicKey({ env, home });
    const signer = loadMachineSigner({ env, home });
    if (!signer) throw Object.assign(new Error('client key absent'), { code: 'machine-not-paired' });
    const request = buildRequest({ verb, ...fields }, signer);
    const line = await machineCall({ socketPath: machineSocketPath({ home }), request });
    const res = verifyResponse(line, pinned, { expectedNonce: request.nonce });
    return { ok: res.ok, state: res.state, diagnostic: res.diagnostic, message: res.message, records: res.body };
  }
  const pairingCodes = new Map(); // code -> { principalId, expiresAt }
  const sessions = new Map(); // cookie token -> { principalId, expiresAt }

  function mintPairingCode(principalId) {
    const principal = getPrincipal(principalId, { file: principalsFile({ env, home }) });
    if (principal.status !== 'active') throw failure(403, 'principal is revoked');
    const code = randomBytes(32).toString('hex');
    const expiresAt = now().getTime() + PAIRING_CODE_TTL_MS;
    pairingCodes.set(code, { principalId: principal.principalId, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  function redeemPairingCode(code) {
    if (typeof code !== 'string' || code.length === 0) {
      throw failure(401, 'invalid or expired pairing code');
    }
    const record = pairingCodes.get(code);
    // Single use: the code is consumed on first sight, valid or expired.
    pairingCodes.delete(code);
    if (!record || now().getTime() > record.expiresAt) {
      throw failure(401, 'invalid or expired pairing code');
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = now().getTime() + WEB_SESSION_TTL_MS;
    sessions.set(token, { principalId: record.principalId, expiresAt });
    return { token, principalId: record.principalId };
  }

  // Cookie sessions resolve to a *fresh* principal read on every request, so
  // revocation and ACL changes apply immediately, not at next login.
  function requirePrincipal(req) {
    const token = parseCookies(req.headers.cookie).get(COOKIE_NAME);
    if (!token) throw failure(401, 'no active web session');
    const record = sessions.get(token);
    if (!record || now().getTime() > record.expiresAt) {
      sessions.delete(token);
      throw failure(401, 'no active web session');
    }
    let principal;
    try {
      principal = getPrincipal(record.principalId, { file: principalsFile({ env, home }) });
    } catch {
      sessions.delete(token);
      throw failure(401, 'no active web session');
    }
    if (principal.status !== 'active') {
      sessions.delete(token);
      throw failure(403, 'principal is not authorized for this operation');
    }
    return { principal, token };
  }

  // CSRF defence in depth for state-changing requests: the custom header
  // cannot be attached cross-origin without a CORS preflight (which the
  // daemon never grants), and the Origin must be same-origin — either this
  // loopback origin directly, or, behind a reviewed reverse proxy (the
  // documented Tailscale pattern), an Origin naming exactly the host the
  // browser addressed. A cross-site page can never satisfy that: its Origin
  // names the attacking site, not this one. Sessions stay useless to DNS
  // rebinding because the HttpOnly cookie is scoped to the paired host.
  function assertBrowserRequest(req) {
    if (req.headers[UI_CSRF_HEADER] !== '1') {
      throw failure(403, 'missing UI request header');
    }
    const origin = req.headers.origin;
    if (typeof origin !== 'string') throw failure(403, 'cross-origin request refused');
    const port = req.socket?.localPort;
    const loopback = new Set([
      `http://127.0.0.1:${port}`,
      `http://[::1]:${port}`,
      `http://localhost:${port}`,
    ]);
    if (loopback.has(origin)) return;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw failure(403, 'cross-origin request refused');
    }
    const host = req.headers.host;
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && typeof host === 'string' && host !== '' && parsed.host === host
    ) {
      return;
    }
    throw failure(403, 'cross-origin request refused');
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw failure(405, 'method not allowed');
    }
    let name;
    if (pathname === '/ui' || pathname === '/ui/') {
      name = 'index.html';
    } else {
      try {
        name = decodeURIComponent(pathname.slice('/ui/'.length));
      } catch {
        throw failure(404, 'unknown asset');
      }
    }
    if (!ASSET_NAME_PATTERN.test(name)) throw failure(404, 'unknown asset');
    // Canonical-path backstop: even a name that slipped the pattern must
    // resolve inside the whitelisted web root.
    const resolved = path.resolve(root, name);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw failure(404, 'unknown asset');
    }
    let bytes;
    try {
      bytes = readFileSync(resolved);
    } catch {
      throw failure(404, 'unknown asset');
    }
    const extension = path.extname(resolved);
    const contentType = CONTENT_TYPES.get(extension);
    if (!contentType) throw failure(404, 'unknown asset');
    // The shell and service worker always revalidate so a daemon upgrade is
    // picked up immediately; fingerprint-free assets get a short lifetime.
    const cacheControl = name === 'index.html' || name === 'sw.js'
      ? 'no-cache'
      : 'max-age=300';
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': bytes.length,
      'cache-control': cacheControl,
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  // Serve an artifact only if the on-disk bytes still match the recorded
  // metadata end to end: size cap first (from metadata, before any read),
  // then exact size, then the sha256 digest over the very buffer that is
  // sent — a corrupted or substituted file is refused, never served as
  // authentic, and there is no window between hashing and streaming.
  function sendArtifact(res, resolved) {
    const { artifact, path: filePath } = resolved;
    if (artifact.bytes > MAX_ARTIFACT_DOWNLOAD_BYTES) {
      throw failure(413, 'artifact exceeds the download size cap');
    }
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      throw failure(404, 'artifact is not available');
    }
    if (!stats.isFile() || stats.size !== artifact.bytes || stats.size > MAX_ARTIFACT_DOWNLOAD_BYTES) {
      throw failure(409, 'artifact does not match its recorded metadata');
    }
    let bytes;
    try {
      bytes = readFileSync(filePath);
    } catch {
      throw failure(404, 'artifact is not available');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== artifact.bytes || !tokensMatch(artifact.sha256, digest)) {
      throw failure(409, 'artifact does not match its recorded metadata');
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': bytes.length,
      // Artifact names are validated to a safe ASCII filename alphabet.
      'content-disposition': `attachment; filename="${artifact.name}"`,
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(bytes);
  }

  async function handleApi(req, res, url) {
    const { principal, token } = requirePrincipal(req);
    if (req.method === 'POST') assertBrowserRequest(req);
    const body = req.method === 'POST' ? parseJsonBody(await readBody(req)) : null;
    const caller = { principal, transport: WEB_TRANSPORT };
    const pathname = url.pathname;
    let match;
    if (req.method === 'GET' && pathname === '/ui/api/me') {
      sendJson(res, 200, { principal: publicPrincipal(principal) });
      return;
    }
    if (req.method === 'POST' && pathname === '/ui/api/logout') {
      sessions.delete(token);
      sendJson(res, 200, { loggedOut: true }, {
        'set-cookie': `${COOKIE_NAME}=; Path=/ui; HttpOnly; SameSite=Strict; Max-Age=0`,
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/ui/api/machine/server') {
      // Machine-level views are only for a principal the owner allowed to
      // observe every soul — exactly ['*'], not a subset with '*' adjacent
      // to other entries (#1295).
      requireMachineView(principal);
      // One doctor run at a time: a burst of viewers awaits the same
      // subprocess instead of spawning a stampede, and awaiting it keeps
      // the event loop free for the daemon's other routes.
      doctorInFlight ??= Promise.resolve()
        .then(() => doctor({ env, home }))
        .finally(() => { doctorInFlight = null; });
      let readiness = null;
      try { readiness = await doctorInFlight; }
      catch (error) {
        if (error?.code !== 'doctor-unavailable') throw error;
        readiness = { error: 'doctor-unavailable' };
      }
      const status = serverStatus({ env, home });
      sendJson(res, 200, { ...status, readiness });
      return;
    }
    if (req.method === 'GET' && pathname === '/ui/api/machine/agent-machine') {
      requireMachineView(principal);
      // Pairing is a file view only: the client key is probed load-only,
      // peers/agent-daemon.* is enumerated by name, terminal files are
      // never opened, and nothing here creates state.
      const machineDir = AGENT_MACHINE_DIR(home);
      const peers = path.join(machineDir, 'peers');
      const suffixes = existsSync(peers)
        ? ['.pub', '.next', '.confirm', '.revoked'].filter((sfx) => existsSync(path.join(peers, `agent-daemon${sfx}`)))
        : [];
      // A corrupt or symlinked key or pin is reported inside the section,
      // never a 500: the probe stays a 200 view.
      const pairing = {};
      try {
        pairing.client_key = loadMachinePublicKey({ env, home }) !== null;
      } catch { pairing.client_key = 'invalid'; pairing.client_key_error = 'key-unreadable'; }
      let pin = null;
      try {
        pin = existsSync(pinPath({ env, home })) ? readFileSync(pinPath({ env, home })) : null;
      } catch { pairing.pin = 'invalid'; pairing.pin_error = 'pin-unreadable'; }
      Object.assign(pairing, {
        pin_fingerprint: pin ? daemonFingerprint(pin) : null,
        agent_daemon_peer: suffixes,
        terminal_paired: existsSync(path.join(peers, 'terminal.pub')),
        pair_command: 'agent-bot machine pair',
      });
      const verb = async (v) => {
        let inFlight = machineInFlight.get(v);
        inFlight ??= Promise.resolve().then(() => machineVerb(v))
          .catch((error) => /^machine-[a-z-]+$/.test(error?.code ?? '')
            ? { error: error.code, message: error.message }
            : { error: 'machine-unreachable', message: error?.message ?? 'agent-machine call failed' })
          .finally(() => { if (machineInFlight.get(v) === inFlight) machineInFlight.delete(v); });
        machineInFlight.set(v, inFlight);
        return inFlight;
      };
      const [status, receipts] = await Promise.all([verb('status'), verb('receipts')]);
      sendJson(res, 200, { pairing, status, receipts, last_digest_upload: digestUploadStatus() });
      return;
    }
    if (req.method === 'POST' && pathname === '/ui/api/machine/agent-machine/plan') {
      try { assertMachineAuthorized({ principal, operation: 'approve' }); }
      catch { throw failure(403, 'principal is not authorized for this operation'); }
      const allowed = ['name', 'option', 'target'];
      for (const key of Object.keys(body)) if (!allowed.includes(key)) throw failure(400, 'unknown field');
      // buildRequest caps each field at 128 chars and only carries strings —
      // a non-string or oversized field fails before anything else.
      for (const f of allowed) {
        if (body[f] !== undefined && (typeof body[f] !== 'string' || body[f].length > 128)) throw failure(400, `${f} must be a string of at most 128 characters`);
      }
      if (typeof body.name !== 'string' || body.name === '') throw failure(400, 'name is required');
      const fields = { name: body.name };
      for (const f of ['option', 'target']) if (body[f] !== undefined) fields[f] = body[f];
      let res2;
      try { res2 = await machineVerb('plan', fields); }
      catch (error) {
        throw failure(/^machine-[a-z-]+$/.test(error?.code ?? '') ? 409 : 502, error?.message ?? 'plan failed');
      }
      sendJson(res, 200, { ok: res2.ok, state: res2.state, plan_id: res2.message, diagnostic: res2.diagnostic, message: res2.message });
      return;
    }
    if (req.method === 'POST' && pathname === '/ui/api/machine/agent-machine/proposals') {
      try { assertMachineAuthorized({ principal, operation: 'approve' }); }
      catch { throw failure(403, 'principal is not authorized for this operation'); }
      const allowed = ['verb', 'name', 'option', 'target', 'plan_id', 'repin'];
      for (const key of Object.keys(body)) if (!allowed.includes(key)) throw failure(400, 'unknown field');
      if (body.verb === 'pair' || body.verb === 'unpair') {
        const extra = Object.keys(body).filter((k) => k !== 'verb' && !(body.verb === 'pair' && k === 'repin'));
        if (extra.length > 0) throw failure(400, 'unknown field');
        if (body.verb === 'pair' && body.repin !== undefined && typeof body.repin !== 'boolean') {
          throw failure(400, 'repin must be a boolean');
        }
        const repin = body.verb === 'pair' && body.repin === true;
        const operation = body.verb === 'pair'
          ? { verb: 'pair', ...(repin ? { repin: true } : {}) }
          : { verb: 'unpair' };
        const actionName = body.verb === 'pair' ? 'machine-pair' : 'machine-unpair';
        const summary = body.verb === 'pair'
          ? `agent-machine pair${repin ? ' --repin' : ''}`
          : 'agent-machine unpair';
        const { proposal } = interaction.requestMachineApproval({
          principal: caller.principal,
          transport: WEB_TRANSPORT,
          operation,
          summary,
          execute: async (report) => {
            const gate = proposalOwnerGate({
              expected: actionName,
              proposalId: report.proposalId,
              principalId: caller.principal.principalId,
              digest: operationDigest(operation),
              env,
              home,
              now,
            });
            await gate(actionName, {});
            if (body.verb === 'unpair') {
              unpairAgentDaemon({ env, home });
              return { unpaired: true };
            }
            if (!existsSync(AGENT_MACHINE_DIR(home))) {
              throw Object.assign(new Error(`${AGENT_MACHINE_DIR(home)} does not exist — install and start agent-machine first (managed-machine daemon install) [machine-not-running]`), { code: 'machine-not-running' });
            }
            const key = loadOrCreateMachineKey({ env, home });
            writeAgentDaemonPeer({ home, publicKeyRaw: key.publicKeyRaw });
            const pin = pinDaemonPub({ env, home, repin });
            const request = buildRequest({ verb: 'status' }, key);
            const line = await machineCall({ socketPath: machineSocketPath({ home }), request });
            const reply = verifyResponse(line, pin.publicKeyRaw, { expectedNonce: request.nonce });
            if (!reply.ok) {
              throw new Error(`pairing staged but agent-machine refused the status check: ${reply.diagnostic ?? ''} ${reply.message ?? ''}`.trim());
            }
            return {
              paired: true,
              pin_fingerprint: pin.fingerprint,
              replaced_fingerprint: pin.replaced,
              state: reply.state ?? reply.message ?? 'ok',
            };
          },
        });
        sendJson(res, 200, { proposal });
        return;
      }
      if (body.repin !== undefined) throw failure(400, 'unknown field');
      for (const f of ['name', 'option', 'target', 'plan_id']) {
        if (body[f] !== undefined && (typeof body[f] !== 'string' || body[f].length > 128)) throw failure(400, `${f} must be a string of at most 128 characters`);
      }
      if (body.verb !== 'apply' && body.verb !== 'update') throw failure(400, 'verb must be apply, update, pair, or unpair');
      if (body.verb === 'apply' && (typeof body.plan_id !== 'string' || body.plan_id === '')) {
        throw failure(400, 'apply requires plan_id');
      }
      const operation = { verb: body.verb, harness: 'web-ui' };
      for (const f of ['name', 'option', 'target', 'plan_id']) if (body[f] !== undefined) operation[f] = body[f];
      const { proposal } = interaction.requestMachineApproval({
        principal: caller.principal,
        transport: WEB_TRANSPORT,
        operation,
        summary: `agent-machine ${operation.verb}${operation.plan_id ? ` ${operation.plan_id}` : operation.name ? ` ${operation.name}` : ''}`,
        execute: async () => {
          const result = await machineVerb(operation.verb, operation);
          if (result?.ok === true) notifyMachineWrite();
          return result;
        },
      });
      sendJson(res, 200, { proposal });
      return;
    }
    if (req.method === 'GET' && (match = pathname.match(/^\/ui\/api\/(?:machine\/)?(?:agent-machine\/)?proposals\/([^/]+)$/))) {
      // Authorization is per proposal scope inside ownerOutcome: machine.*
      // needs the machine gate, soul.* needs observe on that soul, anything
      // else is a 404 that never mutates the store.
      try { sendJson(res, 200, interaction.ownerOutcome({ principal: caller.principal, transport: WEB_TRANSPORT, proposalId: match[1] })); }
      catch (error) { throw failure(error?.statusCode ?? 404, error?.message ?? 'unknown proposal'); }
      return;
    }
    if (req.method === 'GET' && pathname === '/ui/api/souls') {
      const { souls } = interaction.listAuthorizedSouls(caller);
      const sessionsDir = stateDirectory({ env, home });
      const view = souls.map((soul) => ({
        id: soul.id,
        appSlug: soul.appSlug ?? null,
        parentId: soul.parentId ?? null,
        status: soul.status ?? null,
        lastSeen: soul.lastSeen ?? null,
        role: soul.parentId ? 'specialist' : 'lead',
        // Transcript locators and every path/token/proof-shaped field stay
        // server-side; only the public record fields cross the wire.
        sessions: listSessions(soul.id, { stateDir: sessionsDir }).map((s) => ({
          session_id: s.session_id,
          harness: s.harness ?? null,
          status: s.status ?? null,
          started_at: s.started_at ?? null,
          last_seen: s.last_seen ?? null,
          ended_at: s.ended_at ?? null,
        })),
        bindings: soulBindings(soul.id).map((b) => ({
          agentId: b.agentId,
          harness: b.harness ?? null,
          sessionId: b.sessionId ?? null,
          worktree: b.worktree ? path.basename(b.worktree) : null,
          boundAt: b.boundAt ?? null,
          lastUsedAt: b.lastUsedAt ?? null,
        })),
      }));
      sendJson(res, 200, { souls: view });
      return;
    }
    if (req.method === 'GET' && pathname === '/ui/api/machine/settings') {
      try { assertMachineAuthorized({ principal, operation: 'observe' }); }
      catch { throw failure(403, 'principal is not authorized for this operation'); }
      const file = configPath({ home, env });
      let parsed = null; let error = null;
      try {
        parsed = loadConfig({ home, env });
      } catch (loadError) {
        error = loadError.message;
      }
      const cfg = parsed ?? {};
      // Only settings keys config.mjs validates are echoed (each with its
      // editable flag); anything else under settings is counted, never read.
      const KNOWN_SETTINGS = [
        'agentBotServer', 'daemonPreference', 'diagnosticsOtlpEndpoint', 'keydIdentifier',
        'keydTeamId', 'ownerKeys', 'skillSearchAdapter', 'soulCoauthorDomain', 'soulsRoot',
        'spacesRoot', 'unmanagedAuthors',
      ];
      const EDITABLE_SETTINGS = new Set(['daemonPreference', 'skillSearchAdapter']);
      const settings = {};
      let settingsExtra = 0;
      for (const [key, value] of Object.entries(cfg.settings ?? {})) {
        if (KNOWN_SETTINGS.includes(key)) settings[key] = { value, editable: EDITABLE_SETTINGS.has(key) };
        else settingsExtra += 1;
      }
      const features = {};
      for (const gate of FEATURE_GATES) {
        features[gate] = { value: cfg.features?.[gate] ?? false, editable: true };
      }
      sendJson(res, 200, {
        path: file, exists: existsSync(file), valid: error === null, error,
        config: {
          prefix: cfg.prefix ?? null, owner: cfg.owner ?? null,
          // apps projects harness → slug strings only — nothing else a
          // config could smuggle into the object.
          apps: Object.fromEntries(Object.entries(cfg.apps ?? {}).filter(([, v]) => typeof v === 'string')),
          scope: cfg.scope ?? null, features, settings, settingsExtra,
        },
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/ui/api/machine/settings/proposals') {
      try { assertMachineAuthorized({ principal, operation: 'approve' }); }
      catch { throw failure(403, 'principal is not authorized for this operation'); }
      for (const key of Object.keys(body)) if (key !== 'changes') throw failure(400, 'unknown field');
      const changes = body.changes;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw failure(400, 'changes must be an object');
      const keys = Object.keys(changes);
      if (keys.length < 1 || keys.length > 8) throw failure(400, 'changes must hold 1..8 keys');
      const editable = Object.assign(Object.create(null), {
        'settings.daemonPreference': true, 'settings.skillSearchAdapter': true,
      });
      for (const gate of FEATURE_GATES) editable[`features.${gate}`] = true;
      for (const key of keys) if (!Object.hasOwn(editable, key)) throw failure(400, `key is not editable: ${key}`);
      // null unsets daemonPreference/skillSearchAdapter (restores the default);
      // feature gates only take booleans.
      const UNSETTABLE = new Set(['settings.daemonPreference', 'settings.skillSearchAdapter']);
      for (const key of keys) {
        if (changes[key] === null && !UNSETTABLE.has(key)) throw failure(400, `invalid ${key}: null is not allowed`);
      }
      if ('settings.daemonPreference' in changes && changes['settings.daemonPreference'] !== null && !['off', 'prefer', 'required'].includes(changes['settings.daemonPreference'])) {
        throw failure(400, 'invalid settings.daemonPreference');
      }
      if ('settings.skillSearchAdapter' in changes && changes['settings.skillSearchAdapter'] !== null && !SKILL_SEARCH_ADAPTERS.includes(changes['settings.skillSearchAdapter'])) {
        throw failure(400, 'invalid settings.skillSearchAdapter');
      }
      for (const key of keys) if (key.startsWith('features.') && typeof changes[key] !== 'boolean') {
        throw failure(400, `invalid ${key}: expected boolean`);
      }
      const file = configPath({ home, env });
      let baseBytes = '';
      try { baseBytes = readFileSync(file, 'utf8'); } catch { /* absent */ }
      const base = createHash('sha256').update(baseBytes).digest('hex');
      const operation = { verb: 'settings', changes, base };
      const { proposal } = interaction.requestMachineApproval({
        principal: caller.principal,
        transport: WEB_TRANSPORT,
        operation,
        summary: `settings change: ${(() => {
            const loaded = loadConfig({ home, env });
            return keys.map((k) => {
              const [sec, nm] = k.split('.');
              const cur = sec === 'features' ? (loaded?.features?.[nm] ?? false) : (loaded?.settings?.[nm] ?? null);
              return `${k}: ${cur === null ? 'unset' : cur} → ${changes[k] === null ? 'unset' : changes[k]}`;
            }).join(', ');
          })()}`,
        execute: () => {
          let current = '';
          try { current = readFileSync(file, 'utf8'); } catch { /* absent */ }
          if (createHash('sha256').update(current).digest('hex') !== base) {
            throw Object.assign(new Error('config changed since the proposal was created'), { code: 'settings-drifted' });
          }
          const candidate = current === '' ? {} : JSON.parse(current);
          for (const [key, value] of Object.entries(changes)) {
            const [section, name] = key.split('.');
            if (!Object.hasOwn(editable, key)) continue;
            const next = { ...(candidate[section] ?? {}) };
            if (value === null) delete next[name]; else next[name] = value;
            candidate[section] = next;
          }
          validateConfig(candidate);
          // A symlinked config path would write through to a foreign file —
          // refuse it, and fail if a same-named temp file already exists.
          let previousMode = null;
          try {
            const st = lstatSync(file);
            if (st.isSymbolicLink()) throw Object.assign(new Error('config path is a symlink; refusing to write'), { code: 'settings-unsafe-path' });
            previousMode = statSync(file).mode;
          } catch (error) {
            if (error?.code === 'settings-unsafe-path') throw error;
          }
          mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          // A crashed earlier write can leave a *.tmp-* sibling — sweep
          // stale ones so the atomic dir stays clean, and give this write a
          // unique name so 'wx' never collides with one.
          for (const entry of readdirSync(path.dirname(file))) {
            if (!entry.startsWith(`${path.basename(file)}.tmp-`)) continue;
            try { unlinkSync(path.join(path.dirname(file), entry)); } catch { /* racing writer */ }
          }
          const tmp = `${file}.tmp-${process.pid}-${createHash('sha256').update(`${Date.now()}`).digest('hex').slice(0, 8)}`;
          try {
            writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}
`, { mode: previousMode ?? 0o600, flag: 'wx' });
          } catch (error) {
            try { unlinkSync(tmp); } catch {}
            throw error;
          }
          renameSync(tmp, file);
          return { written: true, changed: keys };
        },
      });
      sendJson(res, 200, { proposal });
      return;
    }
    if (req.method === 'POST' && pathname === '/ui/api/machine/server/reconcile') {
      try { assertMachineAuthorized({ principal, operation: 'approve' }); }
      catch { throw failure(403, 'principal is not authorized for this operation'); }
      reconcileInFlight.current ??= (async () => {
        const file = path.join(webRootDirectoryRoot, 'identity', 'server-client.mjs');
        const run = spawnServerCli ?? ((args) => execFileAsync(process.execPath, [file, ...args], { env: { ...process.env, ...env }, timeout: 60000 }));
        try {
          const { stdout } = await run(['reconcile', '--json']);
          const { reconciled = [] } = JSON.parse(stdout);
          return { reconciled: reconciled.length, results: reconciled.map(reconcileRow) };
        } catch (error) {
          if (error?.stdout) {
            try {
              const { reconciled = [] } = JSON.parse(error.stdout);
              return { reconciled: reconciled.length, results: reconciled.map(reconcileRow) };
            } catch { /* fall through */ }
          }
          throw failure(502, error?.message ?? 'reconcile failed');
        } finally {
          setTimeout(() => { reconcileInFlight.current = null; }, 0);
        }
      })();
      sendJson(res, 200, await reconcileInFlight.current);
      return;
    }
    if (req.method === 'POST' && pathname === '/ui/api/machine/server/enroll') {
      try { assertMachineAuthorized({ principal, operation: 'approve' }); }
      catch { throw failure(403, 'principal is not authorized for this operation'); }
      for (const key of Object.keys(body)) throw failure(400, 'unknown field');
      const device = loadDevice({ env, home });
      const harnesses = device?.harnesses ?? [];
      if (harnesses.length === 0) throw failure(409, 'no enrolled harnesses to re-enroll');
      // One enrollment at a time across the whole grant lifecycle: a second
      // forced run recreates enroll-staging and could promote a mismatched
      // key+record pair.
      const open = interaction.listProposalsForOwner().proposals
        .some((p) => p.tool === 'machine.enroll' && p.status === 'open' && new Date(p.expiresAt) > now());
      if (open || enrollInFlight) throw Object.assign(failure(409, 'enroll-in-flight: an enrollment grant is already open or running'), { code: 'enroll-in-flight' });
      const operation = { verb: 'enroll', harnesses, base: serverUrl({ env, home }) };
      const { proposal } = interaction.requestMachineApproval({
        principal: caller.principal,
        transport: WEB_TRANSPORT,
        operation,
        summary: `re-enroll device (${harnesses.join(', ')})`,
        execute: async (report) => {
          const file = path.join(webRootDirectoryRoot, 'identity', 'server-client.mjs');
          const args = [file, 'enroll', '--force', '--json', ...harnesses.flatMap((h) => ['--harness', h])];
          if (spawnServerCli) {
            // Test seam: a fake CLI that yields captured output — still
            // parsed line-by-line like the real path.
            const { stdout } = await spawnServerCli(args.slice(1), report);
            let last = null;
            for (const line of stdout.split('\n')) {
              const msg = parseEnrollLine(line);
              if (msg?.prompt) enrollPromptReport(msg.prompt, report, now);
              else if (msg) last = msg;
            }
            return { device_id: last?.record?.device_id ?? null, harnesses: last?.record?.harnesses ?? harnesses };
          }
          return await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
            enrollChildren.add(child);
            // The grant flow can outlive a poll window; bound the child
            // anyway and kill it rather than leave a stale staging dir.
            const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 10 * 60_000);
            let out = ''; let errTail = ''; let last = null;
            child.stdout.on('data', (chunk) => {
              out = enrollStdoutChunk(out, chunk, (line) => {
                const msg = parseEnrollLine(line); if (!msg) return;
                if (msg.prompt) enrollPromptReport(msg.prompt, report, now);
                else last = msg;
              });
            });
            child.stderr.on('data', (chunk) => { errTail = (errTail + chunk).slice(-2000); });
            child.on('error', (error) => { clearTimeout(timer); enrollChildren.delete(child); enrollInFlight = false; reject(error); });
            child.on('close', (code) => {
              clearTimeout(timer);
              enrollChildren.delete(child);
              enrollInFlight = false;
              if (code === 0) {
                resolve({ device_id: last?.record?.device_id ?? null, harnesses: last?.record?.harnesses ?? harnesses });
              } else {
                reject(new Error(errTail.trim().split('\n').at(-1) || `enroll exited ${code}`));
              }
            });
            enrollInFlight = true;
          });
        },
      });
      sendJson(res, 200, { proposal });
      return;
    }
    if (req.method === 'GET' && pathname === '/ui/api/machine/catalog') {
      try { assertMachineAuthorized({ principal, operation: 'observe' }); }
      catch { throw failure(403, 'principal is not authorized for this operation'); }
      catalogFetch.inFlight ??= (async () => {
        try {
          if (catalogFetch.result && now().getTime() - catalogFetch.at < 5 * 60 * 1000) {
            return catalogFetch.result;
          }
          const fetched = await fetchCatalogImpl({ env, home });
          const catalog = fetched.catalog ?? {};
          const rawItems = Array.isArray(catalog) ? catalog : (catalog.items ?? []);
          // Installed state joins from agent-machine status records when paired.
          let installed = {};
          try {
            const st = await machineVerb('status');
            for (const rec of st.records ?? []) if (rec?.name) installed[rec.name] = rec.state ?? rec.version ?? 'installed';
          } catch { installed = null; }
          const items = rawItems.map((it) => ({
            name: it?.name ?? null,
            provider: it?.provider ?? it?.formula ?? it?.package ?? it?.cask ?? null,
            version: it?.version ?? it?.sha256 ?? null,
            installed: installed === null ? 'unknown' : (installed[it?.name] ?? null),
          }));
          const publisher = fetched.publisher && typeof fetched.publisher === 'object'
            ? {
              login: typeof fetched.publisher.login === 'string' ? fetched.publisher.login : null,
              id: Number.isInteger(fetched.publisher.id) ? fetched.publisher.id : null,
            }
            : null;
          const drafts = Array.isArray(fetched.drafts)
            ? fetched.drafts.map((d) => ({
              id: typeof d?.id === 'string' ? d.id : null,
              name: typeof d?.name === 'string' ? d.name : null,
              updated_at: typeof d?.updated_at === 'string' ? d.updated_at : null,
              sha256: typeof d?.sha256 === 'string' ? d.sha256 : null,
              size: Number.isInteger(d?.size) ? d.size : null,
              based_on_version: Number.isInteger(d?.based_on_version) ? d.based_on_version : 0,
              revision: Number.isInteger(d?.revision) ? d.revision : null,
            }))
            : [];
          const result = {
            key_id: fetched.catalog_key.key_id,
            version: fetched.envelope?.version ?? null,
            issued_at: fetched.envelope?.issued_at ?? null,
            publisher,
            floor_min_version: fetched.floor.min_version,
            items,
            drafts,
            delivered: lastDelivery.current,
            drafts_note: 'Edit and publish drafts in the agents.true-line.ai admin console.',
          };
          catalogFetch.result = result; catalogFetch.at = now().getTime();
          return result;
        } catch (error) {
          return { error: error?.code ?? 'error', message: error?.message ?? String(error) };
        } finally {
          setTimeout(() => { catalogFetch.inFlight = null; }, 0);
        }
      })();
      const result = await catalogFetch.inFlight;
      sendJson(res, 200, { ...result, delivered: result?.error ? result.delivered : lastDelivery.current });
      return;
    }
    if (req.method === 'POST' && pathname === '/ui/api/machine/catalog/deliver') {
      try { assertMachineAuthorized({ principal, operation: 'approve' }); }
      catch { throw failure(403, 'principal is not authorized for this operation'); }
      for (const key of Object.keys(body)) throw failure(400, 'unknown field');
      try {
        // Fresh fetch + verify: agent-machine pins the key on first delivery
        // and enforces the floor itself, so no proposal gates this relay.
        const fetched = await fetchCatalogImpl({ env, home });
        const res2 = await machineVerb('catalog', {
          catalog_key: fetched.catalog_key, floor: fetched.floor, envelope: fetched.envelope,
        });
        lastDelivery.current = { at: now().toISOString(), outcome: res2.ok ? res2.state : res2.diagnostic };
        sendJson(res, 200, res2);
      } catch (error) {
        lastDelivery.current = { at: now().toISOString(), outcome: error?.code ?? 'error' };
        throw failure(/^machine-[a-z-]+$|^catalog-[a-z-]+$/.test(error?.code ?? '') ? 409 : 502, error?.message ?? 'deliver failed');
      }
      return;
    }
    if (req.method === 'GET' && (match = pathname.match(/^\/ui\/api\/souls\/([^/]+)\/revisions$/))) {
      const agentId = decodeURIComponent(match[1]);
      try { assertAuthorized({ principal, agentId, operation: 'observe' }); }
      catch { throw failure(403, 'principal is not authorized for this operation'); }
      const proposals = listSoulProposals(agentId, { stateDir: stateDirectory({ env, home }) })
        .filter((p) => p.status === 'pending')
        .map(({ proposalId, revision, parentRevision, author, reason, diff, requiresUser, status, at }) =>
          ({ proposalId, revision, parentRevision, author, reason, diff, requiresUser, status, at }));
      sendJson(res, 200, { proposals });
      return;
    }
    if (req.method === 'POST' && (match = pathname.match(/^\/ui\/api\/souls\/([^/]+)\/proposals$/))) {
      const agentId = decodeURIComponent(match[1]);
      const EXTRA = { 'revision.approve': ['revision_id'], 'revision.reject': ['revision_id'], 'cold-wake': ['enabled'], 'remove': [] };
      const verb = body.verb;
      if (!(verb in EXTRA)) throw failure(400, 'unknown verb');
      const allowedKeys = ['verb', ...EXTRA[verb]];
      for (const key of Object.keys(body)) if (!allowedKeys.includes(key)) throw failure(400, 'unknown field');
      const stateDir = stateDirectory({ env, home });
      const gateFor = (expected, report) => proposalOwnerGate({ expected, proposalId: report.proposalId,
        principalId: caller.principal.principalId, digest: operationDigest(operation), env, home, now });
      let operation; let summary; let execute;
      if (verb === 'revision.approve' || verb === 'revision.reject') {
        const command = verb === 'revision.approve' ? 'approve' : 'reject';
        const revisionId = body.revision_id;
        if (typeof revisionId !== 'string' || revisionId === '') throw failure(400, 'revision_id is required');
        const pending = listSoulProposals(agentId, { stateDir }).filter((p) => p.status === 'pending');
        if (!pending.some((p) => p.proposalId === revisionId)) throw failure(400, 'unknown or decided revision');
        operation = { verb, revision_id: revisionId };
        summary = `soul revision ${command} ${revisionId} on ${agentId}`;
        execute = async (report) => revisionCommand([command, agentId, revisionId, `ui-proposal:${report.proposalId}`],
          { env, home, now, stateDir, assertUser: gateFor(`soul revision ${command} ${agentId}`, report) });
      } else if (verb === 'cold-wake') {
        if (typeof body.enabled !== 'boolean') throw failure(400, 'enabled must be a boolean');
        const change = body.enabled ? 'on' : 'off';
        operation = { verb, enabled: body.enabled };
        summary = `cold-wake ${change} for ${agentId}`;
        execute = async (report) => {
          // setColdWake takes no gate param — the proposal IS the owner
          // decision, so the stub fires here (same audit receipt) and the
          // real setter applies the approved change.
          await gateFor(`soul cold-wake ${agentId} ${change}`, report)(`soul cold-wake ${agentId} ${change}`, {});
          return setColdWake(agentId, body.enabled, { env, home, now });
        };
      } else {
        const plan = await soulRemovePlan(agentId, { env, home, stateDir });
        operation = { verb, scope: 'soul', plan };
        summary = `remove ${agentId}: archives ${plan.archived.length} (${plan.archived.join(', ') || 'none'}), ` +
          `independent ${plan.independent.join(', ') || 'none'}, unchanged ${plan.unchanged}`;
        execute = async (report) => {
          const again = await soulRemovePlan(agentId, { env, home, stateDir });
          if (JSON.stringify(again) !== JSON.stringify(plan)) {
            throw Object.assign(new Error('soul removal plan changed between proposal and approval'), { code: 'soul-remove-plan-changed' });
          }
          return soulRemoveCommand([agentId], { env, home, now, gate: gateFor(`soul remove ${agentId}`, report) });
        };
      }
      const { proposal } = interaction.requestOwnerApproval({ principal: caller.principal, transport: WEB_TRANSPORT,
        agentId, operation, summary, execute });
      sendJson(res, 200, { proposal });
      return;
    }
    if (req.method === 'GET' && pathname === '/ui/api/population') {
      sendJson(res, 200, interaction.listAuthorizedSouls(caller));
      return;
    }
    if (req.method === 'GET' && pathname === '/ui/api/sessions') {
      sendJson(res, 200, interaction.listSessions({
        ...caller,
        agentId: url.searchParams.get('agentId'),
      }));
      return;
    }
    if (req.method === 'POST' && pathname === '/ui/api/sessions') {
      sendJson(res, 200, interaction.createOrContinueSession({
        ...caller,
        agentId: body.agentId,
        sessionId: body.sessionId ?? null,
      }));
      return;
    }
    if (req.method === 'POST' && (match = pathname.match(/^\/ui\/api\/sessions\/([^/]+)\/messages$/))) {
      sendJson(res, 200, interaction.submitMessage({
        ...caller,
        sessionId: match[1],
        message: body.message,
        idempotencyKey: body.idempotencyKey,
        attachments: body.attachments,
      }));
      return;
    }
    if (req.method === 'GET' && pathname === '/ui/api/invocations') {
      sendJson(res, 200, interaction.listInvocations({
        ...caller,
        sessionId: url.searchParams.get('sessionId'),
      }));
      return;
    }
    if (req.method === 'GET' && (match = pathname.match(/^\/ui\/api\/invocations\/([^/]+)$/))) {
      sendJson(res, 200, interaction.getInvocation({ ...caller, invocationId: match[1] }));
      return;
    }
    if (req.method === 'GET' && (match = pathname.match(/^\/ui\/api\/invocations\/([^/]+)\/events$/))) {
      const after = url.searchParams.get('after');
      sendJson(res, 200, interaction.readEvents({
        ...caller,
        invocationId: match[1],
        afterSeq: after === null ? 0 : Number(after),
      }));
      return;
    }
    if (req.method === 'POST' && (match = pathname.match(/^\/ui\/api\/invocations\/([^/]+)\/cancel$/))) {
      sendJson(res, 200, await interaction.cancelInvocation({ ...caller, invocationId: match[1] }));
      return;
    }
    if (req.method === 'GET' && (match = pathname.match(/^\/ui\/api\/invocations\/([^/]+)\/artifacts$/))) {
      sendJson(res, 200, interaction.listArtifacts({ ...caller, invocationId: match[1] }));
      return;
    }
    if (req.method === 'GET' && (match = pathname.match(/^\/ui\/api\/invocations\/([^/]+)\/artifacts\/([^/]+)$/))) {
      let name;
      try {
        name = decodeURIComponent(match[2]);
      } catch {
        throw failure(400, 'invalid artifact name');
      }
      sendArtifact(res, interaction.resolveArtifact({
        ...caller,
        invocationId: match[1],
        name,
      }));
      return;
    }
    if (req.method === 'GET' && pathname === '/ui/api/approvals') {
      sendJson(res, 200, interaction.listProposals(caller));
      return;
    }
    if (req.method === 'POST' && (match = pathname.match(/^\/ui\/api\/approvals\/([^/]+)\/decision$/))) {
      // A decision lets a soul's tool run, so the owner is asked for this one
      // (#1060), exactly as on /v1: a web session was paired with the daemon
      // bearer, which any process in this account can read, so it proves a
      // principal, never the owner. No owner gate wired means no decision.
      if (typeof confirmDecision !== 'function') {
        throw failure(403, 'the owner did not confirm this decision');
      }
      const authorization = await confirmDecision({
        proposalId: match[1],
        decision: body.decision,
        principal,
        transport: WEB_TRANSPORT,
      });
      sendJson(res, 200, interaction.decideProposal({
        ...caller,
        proposalId: match[1],
        decision: body.decision,
        digest: body.digest,
        authorization,
      }));
      return;
    }
    throw failure(404, 'unknown route');
  }

  async function handle(req, res, url) {
    try {
      const pathname = url.pathname;
      // Owner ceremony: minting a pairing code requires the daemon bearer
      // token from the 0600 state file, which only the local CLI can read.
      if (pathname === '/ui/pair') {
        if (req.method !== 'POST') throw failure(405, 'method not allowed');
        const authorization = req.headers.authorization ?? '';
        const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!tokensMatch(daemonToken, presented)) {
          throw failure(401, 'missing or invalid daemon token');
        }
        const body = parseJsonBody(await readBody(req));
        let minted;
        try {
          minted = mintPairingCode(body.principalId);
        } catch (error) {
          if (Number.isSafeInteger(error.statusCode)) throw error;
          throw failure(404, 'unknown principal');
        }
        sendJson(res, 200, minted);
        return;
      }
      if (pathname === '/ui/session') {
        if (req.method !== 'POST') throw failure(405, 'method not allowed');
        assertBrowserRequest(req);
        const body = parseJsonBody(await readBody(req));
        const { token, principalId } = redeemPairingCode(body.code);
        const principal = getPrincipal(principalId, { file: principalsFile({ env, home }) });
        sendJson(res, 200, { principal: publicPrincipal(principal) }, {
          'set-cookie': `${COOKIE_NAME}=${token}; Path=/ui; HttpOnly; SameSite=Strict; `
            + `Max-Age=${Math.floor(WEB_SESSION_TTL_MS / 1000)}`,
        });
        return;
      }
      if (pathname === '/ui/api' || pathname.startsWith('/ui/api/')) {
        await handleApi(req, res, url);
        return;
      }
      serveStatic(req, res, pathname);
    } catch (error) {
      const status = Number.isSafeInteger(error.statusCode) ? error.statusCode : 500;
      const message = status === 500 ? 'internal error' : error.message;
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.destroy();
    }
  }

  return { handle, mintPairingCode,
    close() {
      for (const child of enrollChildren) { try { child.kill('SIGTERM'); } catch {} }
      enrollChildren.clear();
      enrollInFlight = false;
    } };
}

// ---------------------------------------------------------------------------
// CLI: `agent-bot web open` — the local pairing ceremony. Reads the daemon
// state file (0600, same trust anchor as every daemon client), asks the
// daemon to mint a one-time code for a chosen principal, and prints (and
// optionally opens) the 127.0.0.1 URL carrying the code in the fragment.

function readDaemonState({ env = process.env, home = homedir() } = {}) {
  const file = daemonStateFile({ env, home });
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed || typeof parsed !== 'object'
    || !Number.isSafeInteger(parsed.port) || typeof parsed.token !== 'string'
  ) {
    return null;
  }
  return parsed;
}

function selectPrincipal({ env, home, requested }) {
  const records = listPrincipals({ file: principalsFile({ env, home }) });
  if (requested) {
    const principal = records.find((record) => record.principalId === requested);
    if (!principal) throw new Error('unknown principal');
    if (principal.status !== 'active') throw new Error('principal is revoked');
    return principal;
  }
  const active = records.filter((record) => record.status === 'active');
  if (active.length === 1) return active[0];
  if (active.length === 0) {
    throw new Error('no active principals; enroll one with `agent-bot principal enroll --label <label>` and authorize it with `agent-bot principal allow --principal <principal-id> --souls \'*\' --operations observe,message,approve,cancel`');
  }
  throw new Error('multiple active principals; pick one with --principal <principal-id>');
}

function openInBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', url]
    : process.platform === 'win32'
      ? ['cmd', '/c', 'start', '', url]
      : ['xdg-open', url];
  try {
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* best effort; the URL is already printed */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function webOpen({
  env = process.env,
  home = homedir(),
  requestedPrincipal = null,
  fetchImpl = fetch,
  warn = (line) => process.stderr.write(`${line}\n`),
  accountWarning = wrongAccountWarning,
} = {}) {
  const notice = accountWarning({ env, command: 'web open' });
  if (notice) warn(notice);
  const status = await daemonStatus({ env, home });
  if (!status.running) {
    throw new Error(`daemon is not running; start it with \`agent-bot daemon start\`${notice ? ` (${notice})` : ''}`);
  }
  const state = readDaemonState({ env, home });
  if (!state) throw new Error('daemon state file could not be read');
  const principal = selectPrincipal({ env, home, requested: requestedPrincipal });
  const response = await fetchImpl(`http://127.0.0.1:${state.port}/ui/pair`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${state.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ principalId: principal.principalId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`pairing failed: ${payload.error ?? `HTTP ${response.status}`}`);
  }
  return {
    url: `http://127.0.0.1:${state.port}/ui/#${payload.code}`,
    expiresAt: payload.expiresAt,
    principalId: principal.principalId,
    port: state.port,
  };
}

const USAGE = 'usage: agent-bot web open [--principal <principal-id>] [--no-browser] [--json]\n';

// Wording from README.md, browser access and remote access.
const HELP = `${USAGE}
Pair a browser with the daemon's private web client.

web open asks the running daemon (authenticated with the bearer token from
the 0600 state file) to mint a one-time pairing code and prints/opens
http://127.0.0.1:<port>/ui/#<code>. The page exchanges the code — single
use, ~2 minute expiry — for a short-lived (~12 h) HttpOnly /
SameSite=Strict cookie session held daemon-side in memory.

Run agent-bot web open --no-browser on the daemon machine and open the
printed link from the remote device, substituting the proxy host for
127.0.0.1. Authorization stays with the local principal model.

See README.md, “Remote access (explicit operator choice)”.
`;

async function main() {
  const [command, ...tokens] = process.argv.slice(2);
  if (command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command !== 'open') throw new Error(USAGE);
  let requestedPrincipal = null;
  let noBrowser = false;
  let json = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--no-browser') { noBrowser = true; continue; }
    if (token === '--json') { json = true; continue; }
    if (token === '--principal') {
      requestedPrincipal = tokens[++index];
      if (!requestedPrincipal) throw new Error('--principal requires a value');
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }
  const opened = await webOpen({ requestedPrincipal });
  if (json) {
    process.stdout.write(`${JSON.stringify(opened, null, 2)}\n`);
  } else {
    process.stdout.write(`one-time pairing link (expires ${opened.expiresAt}, single use):\n`);
    process.stdout.write(`  ${opened.url}\n`);
  }
  if (!noBrowser) openInBrowser(opened.url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-web: ${error.message}\n`);
    process.exit(1);
  });
}
