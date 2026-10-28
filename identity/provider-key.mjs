// The pilot provider key (owner decision D2, 2026-10-27; the one named
// exception to short-lived credentials). The daemon fetches it from the
// identity service when it starts (`GET /api/daemon/provider-key`), holds it
// in this process's memory only, never writes it to disk, a log or a receipt,
// and drops it at once when the device is revoked. Every fetch and every use
// leaves a receipt naming the exception (`provider-key-exception`) and the
// issuance reference. Spend caps and rotation live on the provider side.

import { appendAuditReceipt, enforcementProfile } from './identity-format.mjs';
import { ServerSession, newOperationId, onDeviceRevoked, serverUrl } from './server-client.mjs';

export const PROVIDER_KEY_TASK = 'daemon-start';
const REFETCH_MARGIN_MS = 10 * 60_000;

let held = null; // { provider, key, keyId, issuanceId, operationId, expiresAt }
onDeviceRevoked(() => { held = null; });

/** Drops the held key (device revoked, shutdown, tests). */
export function dropProviderKey() {
  held = null;
  backoff = { failures: 0, nextAt: 0 };
}

/** Non-secret facts about the held key, or null. */
export function providerKeyStatus() {
  return held ? { provider: held.provider, keyId: held.keyId, issuanceId: held.issuanceId, expiresAt: held.expiresAt } : null;
}

/**
 * Fetches the pilot key for `provider` (one fresh operation per fetch) and
 * holds it in memory. Returns the non-secret status.
 */
export async function fetchProviderKey({ provider, env = process.env, home, session = null, now = () => new Date() } = {}) {
  const s = session ?? new ServerSession({ base: serverUrl({ env }), env, home });
  const operationId = newOperationId();
  const profile = enforcementProfile({ env, ...(home ? { home } : {}), now }).profile;
  const receipt = (fields) => appendAuditReceipt({
    event: 'provider-key-fetch', operation: provider, taskId: PROVIDER_KEY_TASK, operationId, ...fields,
  }, { env, ...(home ? { home } : {}), now });
  let out;
  try {
    out = await s.call('GET', `/api/daemon/provider-key?provider=${encodeURIComponent(provider)}&operation_id=${encodeURIComponent(operationId)}&profile=${encodeURIComponent(profile)}`);
  } catch (error) {
    receipt({ decision: 'failed', reason: error.code ?? 'error' });
    throw error;
  }
  if (out.operation_id !== operationId || out.provider !== provider || typeof out.key !== 'string' || !out.key || !out.issuance_id) {
    receipt({ decision: 'failed', reason: 'answer-mismatch' });
    throw new Error('the identity service provider-key answer does not match the request; refusing it');
  }
  held = { provider, key: out.key, keyId: out.key_id ?? null, issuanceId: out.issuance_id, operationId, expiresAt: out.expires_at ?? null };
  receipt({ decision: 'granted', reason: 'provider-key-exception', issuanceId: out.issuance_id });
  return providerKeyStatus();
}

/** Whether the held key should be fetched again (missing, or near its lease end). */
export function providerKeyStale({ now = () => new Date() } = {}) {
  if (!held) return true;
  return held.expiresAt !== null && Date.parse(held.expiresAt) - now().getTime() < REFETCH_MARGIN_MS;
}

// A key past its lease (`expires_at`, the "fetch again by" time) is never
// used: it is dropped, and the next ensure fetches it again.
function dropIfExpired(now) {
  if (held && held.expiresAt !== null && Date.parse(held.expiresAt) <= now().getTime()) held = null;
}

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
let backoff = { failures: 0, nextAt: 0 };

/**
 * Makes sure a usable key is held: fetches when none is held or the lease is
 * near its end, at most once per backoff window after a failure (a locked
 * vault, an outage). The service saying the key is not configured drops any
 * held key; a refetch with a new key_id replaces the old one. Never throws.
 */
export async function ensureProviderKey({ provider, env = process.env, home, session = null, now = () => new Date() } = {}) {
  dropIfExpired(now);
  if (held?.provider === provider && !providerKeyStale({ now })) return providerKeyStatus();
  if (now().getTime() < backoff.nextAt) return providerKeyStatus();
  try {
    await fetchProviderKey({ provider, env, home, session, now });
    backoff = { failures: 0, nextAt: 0 };
  } catch (error) {
    backoff = { failures: backoff.failures + 1, nextAt: now().getTime() + Math.min(BACKOFF_BASE_MS * 2 ** backoff.failures, BACKOFF_MAX_MS) };
    if (error.status === 404 || /provider_key_not_configured/.test(error.message ?? '')) held = null;
    dropIfExpired(now);
  }
  return providerKeyStatus();
}

/**
 * The env patch for one harness launch, in the shape soulProviderEnv returns
 * (`{ env, envKey, provider }`), when the held key is for `providerId`; else
 * null. The use is receipted with the exception named, never the key.
 */
export function heldProviderEnv({ providerId, envKey, agentId = null, harness = null, env = process.env, home, now = () => new Date() } = {}) {
  dropIfExpired(now);
  if (!held || held.provider !== providerId || !envKey) return null;
  appendAuditReceipt({
    event: 'provider-key-use', agentId, operation: harness ?? providerId, decision: 'injected', reason: 'provider-key-exception',
    issuanceId: held.issuanceId, taskId: PROVIDER_KEY_TASK, operationId: held.operationId,
  }, { env, ...(home ? { home } : {}), now });
  return { env: { [envKey]: held.key }, envKey, provider: { harness, id: providerId, envKey, credential: null, source: 'identity-service', keyId: held.keyId } };
}
