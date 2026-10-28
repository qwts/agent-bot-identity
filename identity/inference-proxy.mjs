// Loopback inference proxy (#1190): the pilot provider key never reaches a
// member process. A launched harness is given a short-lived proxy token in
// place of the key and a soul-declared baseUrl on this loopback proxy; the
// proxy checks the token, swaps in the key the daemon holds in memory, and
// forwards the request to the owner-configured upstream. Responses stream
// back unchanged. Nothing here writes the key or a token anywhere.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const PROXY_PATH = '/v0/inference/';
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const TOKEN = /^abp_[0-9a-f]{48}$/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const LOOPBACK = new Set(['localhost', '[::1]', '0.0.0.0']);
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Any 127.0.0.0/8 address is loopback, not only 127.0.0.1.
function isLoopbackHost(hostname) {
  return LOOPBACK.has(hostname)
    || (LOOPBACK_V4.test(hostname) && hostname.split('.').every((octet) => Number(octet) <= 255));
}

/** Origin and path prefix a soul's baseUrl uses for this proxy and provider. */
export function proxyBaseUrl(port, providerId) {
  return `http://127.0.0.1:${port}${PROXY_PATH}${providerId}`;
}

/** A fixed loopback port; 0 is refused, since a soul's baseUrl can't name a random port. */
export function validProxyPort(port) {
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Whether a soul's baseUrl points at the loopback inference proxy: an http
 * loopback URL on the configured port, or any loopback URL under the proxy
 * path. Such a launch is brokered or refused, never given the key.
 */
export function isProxyBaseUrl(baseUrl, port) {
  let url;
  try { url = new URL(baseUrl); } catch { return false; }
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) return false;
  return (validProxyPort(port) && Number(url.port || 80) === port) || url.pathname.startsWith(PROXY_PATH);
}

// One forwarded path segment: no traversal, no encoded separator.
function safeSegment(segment, index, all) {
  if (segment === '') return index === all.length - 1;
  let decoded;
  try { decoded = decodeURIComponent(segment); } catch { return false; }
  return decoded !== '.' && decoded !== '..' && !/[/\\]/.test(decoded);
}

/**
 * The proxy and its token registry. `upstreams` maps provider id to the
 * real base URL (https only); `keyFor(providerId)` returns the held key or
 * null; `now` is injectable for tests.
 */
export function createInferenceProxy({ upstreams = {}, keyFor, now = () => Date.now(), fetchImpl = fetch, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  const tokens = new Map(); // token -> { agentId, providerId, expiresAt }
  const bases = new Map(); // provider id -> { origin, path }
  for (const [id, url] of Object.entries(upstreams)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || !/^https:\/\/[^/?#@]+(\/[^?#]*)?$/.test(url)) {
      throw new Error(`inferenceProxy.upstreams.${id} must be an https URL with no credentials, query or fragment`);
    }
    const parsed = new URL(url);
    bases.set(id, { origin: parsed.origin, path: parsed.pathname.replace(/\/$/, '') });
  }

  // A token lives `ttlMs`, and never past `notAfter` (the held key's lease).
  const issue = ({ agentId, providerId, ttlMs = 6 * 60 * 60 * 1000, notAfter = Infinity }) => {
    if (!bases.has(providerId)) return null;
    for (const [t, e] of tokens) if (e.expiresAt <= now()) tokens.delete(t);
    const expiresAt = Math.min(now() + ttlMs, notAfter);
    if (!(expiresAt > now())) return null;
    const token = `abp_${randomBytes(24).toString('hex')}`;
    tokens.set(token, { agentId, providerId, expiresAt });
    return token;
  };
  const revokeAll = () => tokens.clear();

  const presented = (req) => {
    const auth = req.headers.authorization ?? '';
    const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    return bearer ?? req.headers['x-api-key'] ?? null;
  };
  const lookup = (value) => {
    if (typeof value !== 'string' || !TOKEN.test(value)) return null;
    for (const [t, e] of tokens) {
      if (t.length === value.length && timingSafeEqual(Buffer.from(t), Buffer.from(value))) return e.expiresAt > now() ? e : null;
    }
    return null;
  };

  const handle = async (req, res) => {
    const deny = (status, error, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify({ error })); };
    // The raw request target, never resolved against a base: `//host/x`
    // and encoded traversal are refused rather than normalised.
    const raw = req.url ?? '';
    if (!raw.startsWith(PROXY_PATH)) return deny(404, 'not found');
    const queryAt = raw.indexOf('?');
    const rawPath = queryAt === -1 ? raw : raw.slice(0, queryAt);
    const search = queryAt === -1 ? '' : raw.slice(queryAt);
    const [providerId, ...rest] = rawPath.slice(PROXY_PATH.length).split('/');
    const base = bases.get(providerId);
    if (!base) return deny(404, 'unknown provider');
    if (!rest.every(safeSegment)) return deny(400, 'invalid path');
    // Re-encoded segment by segment (":" kept, as in `model:generate`), so
    // nothing forwarded can change the upstream's origin or path prefix.
    const forwardPath = rest.map((segment) => encodeURIComponent(decodeURIComponent(segment)).replace(/%3A/gi, ':')).join('/');
    const query = [...new URLSearchParams(search)].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    let target;
    try { target = new URL(`${base.path}/${forwardPath}${query ? `?${query}` : ''}`, base.origin); } catch { return deny(400, 'invalid path'); }
    if (target.origin !== base.origin || !(target.pathname === base.path || target.pathname.startsWith(`${base.path}/`))) return deny(400, 'invalid path');
    const entry = lookup(presented(req));
    if (!entry) return deny(401, 'invalid or expired inference token');
    if (entry.providerId !== providerId) return deny(403, 'token is for another provider');
    const key = keyFor(providerId);
    if (!key) return deny(503, 'provider key not held; the daemon fetches it from the identity service');
    if (Number(req.headers['content-length'] ?? 0) > maxBodyBytes) return deny(413, 'request body too large', { connection: 'close' });
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name) && name !== 'authorization' && name !== 'x-api-key') headers[name] = value;
    // The real key, in the form the upstream API expects.
    if (req.headers['x-api-key'] !== undefined) headers['x-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBodyBytes) return deny(413, 'request body too large', { connection: 'close' });
      chunks.push(chunk);
    }
    let upstreamRes;
    try {
      upstreamRes = await fetchImpl(target, {
        method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'error',
      });
    } catch {
      return deny(502, 'upstream unreachable');
    }
    const out = {};
    upstreamRes.headers.forEach((value, name) => { if (!HOP.has(name) && name !== 'content-encoding' && name !== 'set-cookie') out[name] = value; });
    res.writeHead(upstreamRes.status, out);
    if (!upstreamRes.body) return res.end();
    try { for await (const chunk of upstreamRes.body) res.write(chunk); } finally { res.end(); }
  };

  const server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  return {
    server,
    issue,
    revokeAll,
    listen: (port) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
