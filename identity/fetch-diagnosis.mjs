// Why a server-mode fetch failed, in words an operator can act on (#1373).
//
// Node reports every connection-level failure as `TypeError: fetch failed`
// and keeps the reason in `cause`. This names the reason (DNS, TLS, timeout,
// refused, unreachable, reset) and, when standard proxy variables are set
// but this process is not using them, says so and names the switch. It reads
// the environment and the error only: it changes no request, no TLS setting
// and no proxy behaviour, and it never prints the credentials a proxy URL
// may carry.
import process from 'node:process';

const CAUSES = [
  [/^(ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_NONAME)$/, 'DNS lookup failed'],
  [/^(ECONNREFUSED)$/, 'connection refused'],
  [/^(EHOSTUNREACH|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL)$/, 'no route to the host'],
  [/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/, 'timed out'],
  [/^(ECONNRESET|EPIPE|UND_ERR_SOCKET)$/, 'connection reset'],
  [/^(CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|ERR_TLS_|ERR_SSL_|EPROTO$|HOSTNAME_MISMATCH$)/, 'TLS failed'],
];

// A failure where no connection was made, which is what an unused proxy
// looks like from the inside. A TLS failure or a reset is something else.
const NO_CONNECTION = /^(ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_NONAME|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/;

function causeCode(error) {
  // undici nests: TypeError -> cause, and an AggregateError of attempts.
  const cause = error?.cause;
  const code = cause?.code ?? cause?.errors?.find((e) => e?.code)?.code ?? error?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

// A short phrase for the failure: "DNS lookup failed (ENOTFOUND)".
export function fetchFailureCause(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timed out';
  const code = causeCode(error);
  if (!code) return 'network error';
  const known = CAUSES.find(([pattern]) => pattern.test(code));
  return known ? `${known[1]} (${code})` : code;
}

// A proxy URL as it may be shown: scheme, host and port, never userinfo,
// path or query.
export function redactProxyUrl(value) {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'a proxy';
  }
}

function proxyFor(target, env) {
  const https = target?.protocol !== 'http:';
  const names = https
    ? ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
    : ['HTTP_PROXY', 'http_proxy'];
  const name = names.find((key) => typeof env[key] === 'string' && env[key].trim() !== '');
  if (!name) return null;
  const host = target?.hostname?.toLowerCase();
  const exempt = String(env.NO_PROXY ?? env.no_proxy ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (host && exempt.some((entry) => entry === '*' || host === entry.replace(/^\*?\./, '') || host.endsWith(`.${entry.replace(/^\*?\./, '')}`))) return null;
  return { name, url: redactProxyUrl(env[name].trim()) };
}

// Node reads proxy variables only when asked: NODE_USE_ENV_PROXY=1 or
// --use-env-proxy, from Node 24.0 and from 22.21 on the 22 line.
export function nodeHonorsEnvProxy(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

function envProxyRequested(env, execArgv) {
  if (env.NODE_USE_ENV_PROXY === '1') return true;
  const flags = [...execArgv, ...String(env.NODE_OPTIONS ?? '').split(/\s+/)];
  return flags.includes('--use-env-proxy');
}

// A sentence to add to a connection failure, or null when a proxy is not
// the likely cause.
export function proxyHint({ url, error, env = process.env, version = process.versions.node, execArgv = process.execArgv } = {}) {
  let target = null;
  try { target = url ? new URL(String(url)) : null; } catch { /* no target: judge by the variables alone */ }
  const proxy = proxyFor(target, env);
  if (!proxy) return null;
  if (envProxyRequested(env, execArgv) && nodeHonorsEnvProxy(version)) return null;
  if (error) {
    const code = causeCode(error);
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    if (!timedOut && !(code && NO_CONNECTION.test(code))) return null;
  }
  return nodeHonorsEnvProxy(version)
    ? `${proxy.name} is set (${proxy.url}) but this process is not using it; set NODE_USE_ENV_PROXY=1 and retry`
    : `${proxy.name} is set (${proxy.url}) but Node ${version} cannot use it; run with Node 22.21 or later, or 24, and NODE_USE_ENV_PROXY=1`;
}

// The cause, with the proxy sentence when it applies.
export function describeFetchFailure(error, { url, env = process.env, version, execArgv } = {}) {
  const cause = fetchFailureCause(error);
  const hint = proxyHint({ url, error, env, ...(version ? { version } : {}), ...(execArgv ? { execArgv } : {}) });
  return hint ? `${cause}; ${hint}` : cause;
}
