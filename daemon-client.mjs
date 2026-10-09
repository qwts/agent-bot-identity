// Client side of the local daemon (#645 step 3): where the daemon's state file
// lives, how it is read and probed, and the thin request client callers use.
// It lives in identity, apart from the process host in agent-daemon.mjs, so
// soul and identity modules can talk to the daemon without importing the
// host. agent-daemon.mjs re-exports daemonClient and daemonStateFile for
// existing importers.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { readBinding } from './agent-binding.mjs';
import { PROOF_HEADER, signBindingProof } from './binding-proof.mjs';

export const SCHEMA_VERSION = 1;
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
export const HEALTH_TIMEOUT_MS = 1_500;
// Credential minting reaches GitHub (installation lookup + token creation),
// so it needs a network-scale budget — the health-probe timeout would abort
// legitimate mints on any slow round trip.
const CREDENTIAL_TIMEOUT_MS = 30_000;
// Longer than keyd's presence prompt, so the owner has time to answer.
const OWNER_DECISION_TIMEOUT_MS = 180_000;

export function daemonStateFile({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_DAEMON_STATE_PATH) return path.resolve(env.AGENT_BOT_DAEMON_STATE_PATH);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'daemon.json');
}

export function readDaemonState(file) {
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
export function daemonBaseUrl(state) {
  const host = state.host === '::1' ? '[::1]' : state.host;
  return `http://${host}:${state.port}`;
}

export async function probeDaemonHealth(state, { fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(`${daemonBaseUrl(state)}/v0/health`, {
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
    const state = shared ? null : readDaemonState(daemonStateFile({ env, home }));
    if (!state && !shared) throw new Error('daemon is not running (no state file)');
    const target = new URL(pathname, shared?.daemon ?? daemonBaseUrl(state));
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
    if (!res.ok) throw Object.assign(new Error(`daemon ${method} ${pathname} failed: ${payload.error ?? `HTTP ${res.status}`}`),
      payload.code === 'soul-paused' ? { code: payload.code } : {});
    return payload;
  }
  return {
    async available() {
      try {
        const state = readDaemonState(daemonStateFile({ env, home }));
        return Boolean(state && await probeDaemonHealth(state, { fetchImpl, timeoutMs }));
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
    async soulProfile(agentId) {
      return request('GET', `/v0/soul/profile?agentId=${encodeURIComponent(agentId)}`);
    },
    async soulEnvironment(agentId) {
      return request('GET', `/v0/soul/env?agentId=${encodeURIComponent(agentId)}`);
    },
    async sandboxStatus() {
      return request('GET', '/v0/sandbox');
    },
    async setSandbox({ enabled, account, principal = null }) {
      return request('POST', '/v0/sandbox', { ...(enabled === undefined ? {} : { enabled }), ...(account === undefined ? {} : { account }), principal });
    },
    async setSandboxOverride({ agentId, override, principal = null }) {
      return request('POST', '/v0/sandbox/override', { agentId, override, principal });
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
    async submitMessage(sessionId, { transport, providerId, message, idempotencyKey, attachments, taskId }) {
      return request('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        transport, providerId, message, idempotencyKey, attachments, taskId,
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
    async approvals() {
      return request('GET', '/v0/approvals');
    },
    async setComputerUse(agentId, enabled, { principal = null } = {}) {
      return request('POST', '/v0/soul/computer-use', { agentId, enabled, ...(principal ? { principal } : {}) }, {}, OWNER_DECISION_TIMEOUT_MS);
    },
    async pauseSoul(agentId, requester = {}) {
      return request('POST', '/v0/soul/pause', { ...requester, agentId });
    },
    async resumeSoul(agentId, requester = {}) {
      return request('POST', '/v0/soul/resume', { ...requester, agentId });
    },
    async stopSoul(agentId, requester = {}) {
      return request('POST', '/v0/soul/stop', { ...requester, agentId });
    },
    // Waits while the daemon asks the owner (#438): Touch ID or a password.
    async decideApproval({ proposalId, decision, digest, scope = 'once', principal = null }) {
      return request('POST', '/v0/approvals/decide', {
        proposalId, decision, digest, scope, ...(principal ? { principal } : {}),
      }, {}, OWNER_DECISION_TIMEOUT_MS);
    },
    async artifacts(invocationId, { transport, providerId }) {
      return request('GET', `/v1/invocations/${encodeURIComponent(invocationId)}/artifacts?${new URLSearchParams({ transport, providerId })}`);
    },
  };
}
