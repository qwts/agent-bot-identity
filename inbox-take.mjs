// The daemon's half of take_inbox (#229). The gh-app-hook inbox bearer is one
// fleet-wide value that can take any App's records, so no caller holds it:
// the daemon reads it from pass-cli for each take and presents it to the
// broker's existing `POST /inbox`, for the App and repository the caller's
// binding already is. An explicit GH_APP_HOOK_INBOX_TOKEN in the daemon's own
// environment wins over the audited pass-cli field: the owner's declaration is final.
//
// Secret-free by construction on the way out: every message is built from
// the host, the status and a cause scrubbed of the bearer, never from the
// URL's query or userinfo, and never the bearer itself.
import { execFileSync } from 'node:child_process';

import { credentialVault, inboxBearerItem, itemTitle } from './credential-names.mjs';
import { createProtonPassAdapter } from './secret-providers/proton-pass.mjs';
import { createSecretProviderRegistry, getSecret } from './secret-store.mjs';

export const INBOX_TIMEOUT_MS = 10_000;
export const INBOX_BEARER_TITLE = itemTitle(inboxBearerItem());
export const INBOX_BEARER_FIELD = 'password';
export const INBOX_BEARER_ACCESS_REASON = 'Read the shared gh-app-hook bearer for an authenticated inbox take';

// Stable take_inbox codes (#299), carried on error.code and in the daemon's
// JSON answer so the MCP surface can name them.
export function inboxError(code, message, { cause = undefined, statusCode = 502 } = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...(cause === undefined ? {} : { cause }) });
}

export function inboxHost(inboxUrl) {
  try {
    return new URL(inboxUrl).host || 'inbox';
  } catch {
    return 'inbox';
  }
}

// The bearer must never appear in an error, even when a lower layer echoes
// it. Strip it from any detail derived from the request or its failure.
export function sanitizeInboxDetail(detail, token) {
  let out = String(detail ?? '');
  if (typeof token === 'string' && token !== '') out = out.split(token).join('[redacted]');
  return out;
}

export function describeFetchCause(error) {
  const cause = error?.cause ?? error;
  const code = cause?.code ?? error?.code ?? null;
  const message = sanitizeInboxDetail(cause?.message ?? error?.message ?? 'network error');
  // AbortSignal.timeout rejects with a TimeoutError DOMException; undici
  // surfaces network failures as 'fetch failed' with the real reason in
  // error.cause. Name both so the operator can tell a hang from a refusal.
  if (error?.name === 'TimeoutError' || cause?.name === 'TimeoutError' || code === 'ABORT_ERR' || /timeout|aborted/i.test(message)) {
    return { kind: 'timeout', code: code ?? 'TimeoutError', message };
  }
  return { kind: 'network', code, message };
}

// Read the exact shared bearer from the configured host vault for every take.
// The provider receives an audited reason, and no caller or environment other
// than the daemon's configured vault selects the credential.
export function readInboxBearer({
  env = process.env,
  registry = createSecretProviderRegistry([createProtonPassAdapter({ env })]),
} = {}) {
  let value;
  try {
    value = getSecret({
      provider: 'proton-pass',
      collection: credentialVault(env),
      item: INBOX_BEARER_TITLE,
      field: INBOX_BEARER_FIELD,
      reason: INBOX_BEARER_ACCESS_REASON,
    }, { registry });
  } catch (error) {
    if (['COLLECTION_NOT_FOUND', 'ITEM_NOT_FOUND', 'FIELD_NOT_FOUND', 'EMPTY_FIELD'].includes(error?.code)) {
      throw inboxError(
        'inbox-credential-missing',
        `take_inbox failed: the inbox bearer password field is not stored; add an active password field to ${INBOX_BEARER_TITLE} in the configured ${credentialVault(env)} vault, then retry`,
        { statusCode: 503 },
      );
    }
    throw inboxError(
      'inbox-credential-unavailable',
      'take_inbox failed: the daemon could not read the inbox bearer; check the pass-cli session and configured vault, then retry',
      { statusCode: 503 },
    );
  }
  const token = typeof value === 'string' ? value.trim() : '';
  if (token === '') {
    throw inboxError(
      'inbox-credential-missing',
      `take_inbox failed: the password field on ${INBOX_BEARER_TITLE} is empty; store INBOX_TOKEN in the configured vault, then retry`,
      { statusCode: 503 },
    );
  }
  return token;
}

// The bearer and where it came from. An explicit GH_APP_HOOK_INBOX_TOKEN in
// the daemon's own environment wins; otherwise the audited pass-cli field. Only the
// source ('env' or 'pass-cli') is ever recorded, never the value.
export function resolveInboxBearer({ env = process.env, readSecret = () => readInboxBearer({ env }) } = {}) {
  const explicit = typeof env.GH_APP_HOOK_INBOX_TOKEN === 'string' ? env.GH_APP_HOOK_INBOX_TOKEN.trim() : '';
  if (explicit !== '') return { token: explicit, source: 'env' };
  // A failed secret read still names its source, so the refusal is receipted
  // with it.
  try {
    return { token: readSecret(), source: 'pass-cli' };
  } catch (error) {
    throw Object.assign(error, { bearerSource: 'pass-cli' });
  }
}

function bearerOf(value) {
  return typeof value === 'string' ? { token: value, source: 'pass-cli' } : value;
}

// One take against the broker. The App and repository come from the caller's
// binding, never from a request parameter.
function requireInboxUrl(inboxUrl) {
  if (typeof inboxUrl !== 'string' || inboxUrl === '') {
    throw inboxError(
      'inbox-not-configured',
      'take_inbox failed: the daemon has no inbox URL; set GH_APP_HOOK_INBOX_URL and rerun `agent-bot daemon install`, then retry',
      { statusCode: 503 },
    );
  }
  return inboxUrl;
}

export async function takeFromBroker({ inboxUrl, token, bearerSource = 'pass-cli', app, repo, fetchImpl = globalThis.fetch, timeoutMs = INBOX_TIMEOUT_MS }) {
  requireInboxUrl(inboxUrl);
  const host = inboxHost(inboxUrl);
  let url;
  try {
    url = new URL('/inbox', inboxUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error('not an http(s) URL');
  } catch (error) {
    throw inboxError(
      'inbox-not-configured',
      `take_inbox failed: the inbox URL is invalid (${sanitizeInboxDetail(error?.message ?? 'bad URL', token)}); check GH_APP_HOOK_INBOX_URL, then run \`agent-bot doctor\``,
      { cause: error, statusCode: 503 },
    );
  }
  url.searchParams.set('app', app);
  url.searchParams.set('repo', repo);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = describeFetchCause(error);
    const safeMessage = sanitizeInboxDetail(cause.message, token);
    const causeCode = cause.code ? `${cause.code}: ` : '';
    throw inboxError(
      'inbox-broker-unreachable',
      cause.kind === 'timeout'
        ? `take_inbox failed: broker ${host} timed out after ${timeoutMs}ms (${causeCode}${safeMessage}); check GH_APP_HOOK_INBOX_URL and the broker status, then retry`
        : `take_inbox failed: broker ${host} unreachable (${causeCode}${safeMessage}); check GH_APP_HOOK_INBOX_URL and network/DNS/TLS, then retry`,
      { cause: error },
    );
  }
  if (response.status === 204) return { event: null };
  if (response.status === 401) {
    throw inboxError(
      'inbox-auth-expired',
      bearerSource === 'env'
        ? `take_inbox failed: inbox at ${host} rejected the bearer (HTTP 401); update GH_APP_HOOK_INBOX_TOKEN in the daemon's environment to the current INBOX_TOKEN, or unset it to use the pass-cli password field ${INBOX_BEARER_TITLE}, then restart the daemon from that environment so it takes effect, and retry`
        : `take_inbox failed: inbox at ${host} rejected the bearer (HTTP 401); update the pass-cli password field ${INBOX_BEARER_TITLE} to the current INBOX_TOKEN, then retry`,
    );
  }
  if (response.status === 400) {
    throw inboxError(
      'inbox-bad-request',
      `take_inbox failed: inbox at ${host} rejected the request (HTTP 400 for app=${app} repo=${repo}); check the worktree binding with \`agent-bot doctor\``,
    );
  }
  if (!response.ok) {
    throw inboxError(
      'inbox-unavailable',
      `take_inbox failed: inbox at ${host} returned HTTP ${response.status}; the broker may be down — wait and retry, then check broker status`,
    );
  }
  try {
    return { event: await response.json() };
  } catch (error) {
    throw inboxError(
      'inbox-unavailable',
      `take_inbox failed: inbox at ${host} returned an unreadable response (${sanitizeInboxDetail(error?.message ?? 'bad body', token)}); wait and retry, then check broker status`,
      { cause: error },
    );
  }
}

// Takes for one App and repository run one at a time in this daemon, so two
// sessions on the same worktree can never be handed the same record even by
// a broker that does not serialize its own takes.
export function createInboxTaker({ env = process.env, readBearer = () => resolveInboxBearer({ env }), fetchImpl = globalThis.fetch } = {}) {
  const queues = new Map();
  return function take({ app, repo }) {
    const key = `${app}\n${repo}`;
    const previous = queues.get(key) ?? Promise.resolve();
    // An unconfigured URL is refused before the bearer is ever read.
    const run = previous.catch(() => {}).then(async () => {
      const inboxUrl = requireInboxUrl(env.GH_APP_HOOK_INBOX_URL);
      const { token, source } = bearerOf(readBearer());
      try {
        const result = await takeFromBroker({ inboxUrl, token, bearerSource: source, app, repo, fetchImpl });
        return { ...result, bearerSource: source };
      } catch (error) {
        throw Object.assign(error, { bearerSource: source });
      }
    });
    const settled = run.catch(() => {});
    queues.set(key, settled);
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return run;
  };
}

// The repository a bound worktree is, from its origin remote: the same rule
// take_inbox has always used (#299), now applied by the daemon to the
// worktree the binding names rather than to a path the caller chose.
export function boundRepository(worktree, { git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } = {}) {
  let remote;
  try {
    remote = git(['-C', worktree, 'remote', 'get-url', 'origin']);
  } catch {
    remote = '';
  }
  const match = String(remote).match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw inboxError(
      'inbox-bad-request',
      'take_inbox failed: the bound worktree has no GitHub origin remote; check the worktree with `agent-bot doctor`',
      { statusCode: 409 },
    );
  }
  return `${match[1]}/${match[2]}`;
}
