import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// Opt-in network probe of the gh-app-hook inbox for `doctor --probe-inbox`
// (#318). The default doctor run only reports configuration, so a dead DNS
// name, a TLS failure or a down broker still reads as ready; this answers
// whether the broker is actually there.
//
// Secret-free by construction: it takes the URL alone, never the bearer, and
// builds the request from scheme, host, port and the fixed /inbox path, so
// neither URL userinfo (which Node would turn into Basic auth) nor a query
// string ever leaves the machine. Results carry the host, never the URL.

export const INBOX_PROBE_TIMEOUT_MS = 5000;

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'EPROTO',
]);

export function classifyProbeError(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code === 'PROBE_TIMEOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code && (TLS_CODES.has(code) || /^ERR_(TLS|SSL)_/.test(code) || code.includes('CERT'))) return 'tls';
  return 'network';
}

function probeTarget(inboxUrl) {
  let parsed;
  try {
    parsed = new URL(inboxUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return null;
  return {
    https: parsed.protocol === 'https:',
    host: parsed.host,
    options: {
      method: 'HEAD',
      // URL hostnames keep IPv6 brackets; the socket layer wants them bare.
      hostname: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
      port: parsed.port || undefined,
      path: '/inbox',
      headers: { 'user-agent': 'agent-bot-doctor' },
      agent: false,
    },
  };
}

// Resolves, never rejects: { outcome, host, http_status?, error_code? }.
// outcome is 'http' | 'dns' | 'tls' | 'refused' | 'timeout' | 'network' |
// 'invalid-url'.
export function probeInboxReachability(inboxUrl, {
  timeoutMs = INBOX_PROBE_TIMEOUT_MS,
  httpsOptions = {},
} = {}) {
  const target = probeTarget(inboxUrl);
  if (!target) return Promise.resolve({ outcome: 'invalid-url', host: null });
  const send = target.https ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ host: target.host, ...result });
    };
    const req = send({ ...target.options, ...(target.https ? httpsOptions : {}) }, (res) => {
      res.resume();
      finish({ outcome: 'http', http_status: res.statusCode });
    });
    // One deadline over DNS, connect, TLS and the response head together.
    const timer = setTimeout(() => {
      finish({ outcome: 'timeout', error_code: 'PROBE_TIMEOUT' });
    }, timeoutMs);
    req.on('error', (error) => {
      finish({ outcome: classifyProbeError(error), error_code: typeof error?.code === 'string' ? error.code : null });
    });
    req.end();
  });
}
