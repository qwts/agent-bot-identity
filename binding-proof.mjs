// Binding proofs (#270, agent-comms ADR-0008 decision 3 as amended). A client
// never sends its binding secret over the wire: whoever holds the daemon's
// loopback port would learn it, and while the daemon is down any local uid
// can hold that port. Each request instead carries a one-time proof keyed by
// the secret's SHA-256, which the daemon already keeps in its registry.
//
//   x-agent-binding-proof: v1.<keyId>.<unix seconds>.<nonce>.<mac>
//
// The MAC covers the method, the path, and the daemon authority the client
// meant to reach, so a proof captured on a squatted port does nothing at the
// real daemon's port, and the daemon refuses a nonce it has already seen.
// agent-comms carries a byte-for-byte copy of the client half.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PROOF_HEADER = 'x-agent-binding-proof';
export const PROOF_WINDOW_MS = 60_000;

const PROOF_PATTERN = /^v1\.([A-Za-z0-9_-]{43})\.(\d{1,12})\.([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/;

// The key is the registry's own record of the binding: sha256(secret).
export function bindingKey(secret) {
  return createHash('sha256').update(secret).digest();
}

// Names the key without revealing it, so the daemon can find the binding.
export function bindingKeyId(key) {
  return createHash('sha256').update('agent-binding-id\0').update(key).digest('base64url');
}

function mac(key, { method, path, authority, ts, nonce }) {
  return createHmac('sha256', key)
    .update(['agent-binding-proof', 'v1', method.toUpperCase(), path, authority, ts, nonce].join('\n'))
    .digest('base64url');
}

// `authority` is the host:port of the binding's daemon URL (`new URL(daemon).host`).
export function signBindingProof({ secret, method, path, authority, now = Date.now(), nonce = randomBytes(18).toString('base64url') }) {
  const key = bindingKey(secret);
  const ts = String(Math.floor(now / 1000));
  return `v1.${bindingKeyId(key)}.${ts}.${nonce}.${mac(key, { method, path, authority, ts, nonce })}`;
}

export function parseBindingProof(header) {
  const match = typeof header === 'string' ? PROOF_PATTERN.exec(header) : null;
  return match ? { keyId: match[1], ts: match[2], nonce: match[3], mac: match[4] } : null;
}

// True when `proof` (parsed) was made with `key` for this request and is fresh.
// Replay is the caller's to refuse: it owns the nonce cache.
export function checkBindingProof(proof, key, { method, path, authority, now = Date.now() }) {
  if (Math.abs(now - Number(proof.ts) * 1000) > PROOF_WINDOW_MS) return false;
  const expected = Buffer.from(mac(key, { method, path, authority, ts: proof.ts, nonce: proof.nonce }));
  const presented = Buffer.from(proof.mac);
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}
