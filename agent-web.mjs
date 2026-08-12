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

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getPrincipal, listPrincipals, principalsFile } from './agent-principals.mjs';
import { daemonStateFile, daemonStatus } from './agent-daemon.mjs';

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

export function createWebLayer({
  env = process.env,
  home = homedir(),
  config,
  interaction,
  daemonToken,
  now = () => new Date(),
  webRoot = webRootDirectory(),
} = {}) {
  void config; // reserved; the web layer holds no policy of its own
  const root = path.resolve(webRoot);
  // Pairing codes and cookie sessions are held daemon-side in memory only:
  // they die with the daemon, are never written to disk, and are therefore
  // never available to another local account or a later process.
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

  function streamArtifact(res, resolved) {
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
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': stats.size,
      // Artifact names are validated to a safe ASCII filename alphabet.
      'content-disposition': `attachment; filename="${artifact.name}"`,
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    const stream = createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
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
      streamArtifact(res, interaction.resolveArtifact({
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
      sendJson(res, 200, interaction.decideProposal({
        ...caller,
        proposalId: match[1],
        decision: body.decision,
        digest: body.digest,
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

  return { handle, mintPairingCode };
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
    throw new Error('no active principals; enroll one with `agent-bot principal enroll --label <label>`');
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
} = {}) {
  const status = await daemonStatus({ env, home });
  if (!status.running) {
    throw new Error('daemon is not running; start it with `agent-bot daemon start`');
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

async function main() {
  const [command, ...tokens] = process.argv.slice(2);
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
