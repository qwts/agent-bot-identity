// Loopback inference proxy (#1190): the pilot provider key never reaches a
// member process. A launched harness is given a short-lived proxy token in
// place of the key and a soul-declared baseUrl on this loopback proxy; the
// proxy checks the token, swaps in the key the daemon holds in memory, and
// forwards the request to the owner-configured upstream. Responses stream
// back unchanged. Nothing here writes the key or a token anywhere.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const PROXY_PATH = '/v0/inference/';
const TOKEN = /^abp_[0-9a-f]{48}$/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

/** Origin and path prefix a soul's baseUrl uses for this proxy and provider. */
export function proxyBaseUrl(port, providerId) {
  return `http://127.0.0.1:${port}${PROXY_PATH}${providerId}`;
}

/**
 * The proxy and its token registry. `upstreams` maps provider id to the
 * real base URL (https only); `keyFor(providerId)` returns the held key or
 * null; `now` is injectable for tests.
 */
export function createInferenceProxy({ upstreams = {}, keyFor, now = () => Date.now(), fetchImpl = fetch } = {}) {
  const tokens = new Map(); // token -> { agentId, providerId, expiresAt }
  for (const [id, url] of Object.entries(upstreams)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || !/^https:\/\/[^/?#@]+(\/[^?#]*)?$/.test(url)) {
      throw new Error(`inferenceProxy.upstreams.${id} must be an https URL with no credentials, query or fragment`);
    }
  }

  const issue = ({ agentId, providerId, ttlMs = 6 * 60 * 60 * 1000 }) => {
    if (!upstreams[providerId]) return null;
    for (const [t, e] of tokens) if (e.expiresAt <= now()) tokens.delete(t);
    const token = `abp_${randomBytes(24).toString('hex')}`;
    tokens.set(token, { agentId, providerId, expiresAt: now() + ttlMs });
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
    const deny = (status, error) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error })); };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith(PROXY_PATH)) return deny(404, 'not found');
    const [providerId, ...rest] = url.pathname.slice(PROXY_PATH.length).split('/');
    const upstream = upstreams[providerId];
    if (!upstream) return deny(404, 'unknown provider');
    const entry = lookup(presented(req));
    if (!entry) return deny(401, 'invalid or expired inference token');
    if (entry.providerId !== providerId) return deny(403, 'token is for another provider');
    const key = keyFor(providerId);
    if (!key) return deny(503, 'provider key not held; the daemon fetches it from the identity service');
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name) && name !== 'authorization' && name !== 'x-api-key') headers[name] = value;
    // The real key, in the form the upstream API expects.
    if (req.headers['x-api-key'] !== undefined) headers['x-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let upstreamRes;
    try {
      upstreamRes = await fetchImpl(`${upstream.replace(/\/$/, '')}/${rest.join('/')}${url.search}`, {
        method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'error',
      });
    } catch {
      return deny(502, 'upstream unreachable');
    }
    const out = {};
    upstreamRes.headers.forEach((value, name) => { if (!HOP.has(name) && name !== 'content-encoding') out[name] = value; });
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
