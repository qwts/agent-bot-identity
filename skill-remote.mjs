// Data-only HTTPS instruction acquisition. No ambient credentials, proxy,
// cookies or executable content. DNS answers are validated before connecting.
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { isIP } from 'node:net';
import { inlineMarkdownLinks } from './skill-references.mjs';

export const REMOTE_SKILL_LIMITS = Object.freeze({ milliseconds: 30_000, redirects: 5, files: 100, bytes: 8 * 1024 * 1024, fileBytes: 1024 * 1024, depth: 8, references: 1000 });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const unavailable = () => fail('skill-fetch-unavailable', 'remote instruction source could not be acquired');
export function skillSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('skill-source-unsupported', 'select a public HTTPS document without credentials or query parameters'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.href.includes('?') || (url.port && url.port !== '443')
    || url.hostname.length > 253 || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname.replace(/\.$/, '')) || url.href.length > 4096) {
    fail('skill-source-unsupported', 'select a public HTTPS document without credentials or query parameters');
  }
  url.hash = ''; url.hostname = url.hostname.replace(/\.$/, '');
  return url.href;
}
export function publicSkillAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  const [a, b] = address.toLowerCase().split(':').map(value => parseInt(value || '0', 16));
  // Only global unicast, excluding transition, special-use and documentation
  // prefixes. IPv4-mapped, NAT64, loopback, local and multicast are outside /3.
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && !(a === 0x3fff && b < 0x1000);
}
function bounded(overrides = {}) {
  for (const [key, value] of Object.entries(overrides)) if (!Object.hasOwn(REMOTE_SKILL_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > REMOTE_SKILL_LIMITS[key]) fail('skill-limit-invalid', 'remote limits may only lower the documented positive bounds');
  return { ...REMOTE_SKILL_LIMITS, ...overrides };
}
async function abortable(promise, signal) {
  let reject, onAbort;
  const interrupted = new Promise((_, fail) => { reject = fail; });
  onAbort = () => reject(new Error('acquisition deadline'));
  if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
async function document(input, context) {
  const { resolve = lookup, requestImpl = request, signal, limits } = context;
  let url = skillSourceUrl(input);
  for (let redirects = 0; ; redirects++) {
    if (signal.aborted) unavailable();
    const parsed = new URL(url);
    let addresses;
    try { addresses = await abortable(resolve(parsed.hostname, { all: true, verbatim: true }), signal); } catch { unavailable(); }
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(row => !publicSkillAddress(row.address) || row.family !== isIP(row.address))) {
      fail('skill-fetch-address-refused', 'remote instruction source resolved to a non-public address');
    }
    const selected = addresses[0];
    let response;
    try {
      response = await abortable(new Promise((done, reject) => {
        context.hosts.add(parsed.hostname);
        const req = requestImpl(parsed, { method: 'GET', agent: context.agent, signal, servername: parsed.hostname, rejectUnauthorized: true,
          headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'agent-bot-skill-import' },
          lookup: (_host, options, callback) => options.all
            ? callback(null, [{ address: selected.address, family: selected.family }])
            : callback(null, selected.address, selected.family),
        }, done);
        req.on('error', reject); req.end();
      }), signal);
    } catch { unavailable(); }
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location; response.destroy();
      if (redirects >= limits.redirects || typeof location !== 'string') fail('skill-fetch-redirect-limit', 'remote instruction redirect limit or missing location');
      try { url = skillSourceUrl(new URL(location, url).href); } catch { fail('skill-fetch-redirect-refused', 'remote instruction redirect target is not allowed'); }
      continue;
    }
    if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) { response.destroy(); unavailable(); }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (signal.aborted) unavailable();
        if (size > limits.fileBytes || context.total + size > limits.bytes) fail('skill-limit', 'remote skill byte limit exceeded');
        chunks.push(bytes);
      }
    } catch (error) { response.destroy(); if (error.code === 'skill-limit') throw error; unavailable(); }
    context.total += size;
    return { url: input, resolvedUrl: url, bytes: Buffer.concat(chunks), mode: '100644' };
  }
}
const digest = value => createHash('sha256').update(value).digest('hex');
export async function acquireRemoteSkill(input, id, { remoteLimits, resolve, requestImpl } = {}) {
  input = skillSourceUrl(input);
  const limits = bounded(remoteLimits), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.milliseconds);
  const agent = new Agent({ keepAlive: false, proxyEnv: {} });
  const context = { limits, signal: controller.signal, total: 0, resolve, requestImpl, agent, hosts: new Set() };
  const entries = [], edges = [], locations = [], known = new Map(), names = new Set();
  let base;
  const storedPath = url => {
    const source = new URL(url), root = new URL(base);
    let file;
    try { file = source.origin === root.origin && source.pathname.startsWith(root.pathname)
      ? decodeURIComponent(source.pathname.slice(root.pathname.length)) : `remote/${digest(url)}/document.md`; }
    catch { fail('skill-path-unsafe', 'remote source path has an invalid escape'); }
    if (!file || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..'
      || ['.git', '.hg', '.svn', 'node_modules', '.ds_store'].includes(part.toLowerCase())
      || /[\\:*?"<>|\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('skill-path-unsafe', 'remote source maps to an unsafe local path');
    if (file.length > 1024 || file.split('/').length > 16) fail('skill-limit', 'remote source path exceeds the local payload bound');
    return file;
  };
  async function visit(url, depth) {
    if (known.has(url)) return known.get(url);
    if (depth > limits.depth || entries.length >= limits.files) fail('skill-limit', 'remote skill depth or file limit exceeded');
    const fetched = await document(url, context);
    if (known.has(fetched.resolvedUrl)) {
      const file = known.get(fetched.resolvedUrl), previous = entries.find(entry => entry.path === file);
      if (!previous.bytes.equals(fetched.bytes)) fail('skill-source-changed', 'remote source changed during acquisition');
      known.set(url, file);
      locations.push({ path: file, url, resolvedUrl: fetched.resolvedUrl });
      return file;
    }
    if (depth === 0) base = new URL('.', fetched.resolvedUrl).href;
    const file = depth === 0 ? 'SKILL.md' : storedPath(fetched.resolvedUrl);
    const normalized = file.normalize('NFC').toLowerCase();
    if (names.has(normalized)) fail('skill-path-unsafe', 'remote sources collide at a portable local path');
    names.add(normalized); known.set(url, file); known.set(fetched.resolvedUrl, file);
    entries.push({ path: file, bytes: fetched.bytes, mode: fetched.mode });
    locations.push({ path: file, url, resolvedUrl: fetched.resolvedUrl });
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes); } catch { fail('skill-entry-invalid', 'remote instruction document must be UTF-8'); }
    for (const link of inlineMarkdownLinks(text)) {
      if (edges.length >= limits.references) fail('skill-limit', 'remote instruction reference limit exceeded');
      const item = { owner: id, from: file, line: link.line }; edges.push(item);
      if (link.url.startsWith('#')) { Object.assign(item, { status: 'external', reason: 'document-anchor' }); continue; }
      let target;
      try { target = skillSourceUrl(new URL(link.url, fetched.resolvedUrl).href); }
      catch { Object.assign(item, { status: 'unresolved', reason: 'unsafe-or-sensitive-locator-withheld' }); continue; }
      const pathname = new URL(target).pathname;
      if (!/\.(?:md|markdown|txt)$/i.test(pathname)) { Object.assign(item, { source: target, status: 'external', reason: 'noninstruction-reference-outside-capture' }); continue; }
      Object.assign(item, { source: target, status: 'captured' });
      item.target = await visit(target, depth + 1);
    }
    return file;
  }
  try {
    await visit(input, 0);
    const graph = new Map();
    for (const edge of edges.filter(edge => edge.status === 'captured')) graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.target]);
    const reaches = (from, target, seen = new Set()) => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (graph.get(from) ?? []).some(next => reaches(next, target, seen));
    };
    for (const edge of edges.filter(edge => edge.status === 'captured')) if (reaches(edge.target, edge.from)) edge.cycle = true;
    return { entries, source: { kind: 'https', url: input }, dependencies: edges, locations, hosts: [...context.hosts].sort(), excluded: [], materialized: [],
      coverage: { boundary: 'markdown-inline-https-instructions-v1', unresolved: edges.filter(edge => edge.status === 'unresolved').length,
        external: edges.filter(edge => edge.status === 'external').length, universalRetrieval: false } };
  } finally { clearTimeout(timer); agent.destroy(); }
}
