// Existing keyd token verification, isolated from custody, prompts and filesystem.
// p1 decoding and time semantics remain owned by agent-bot; do not tighten them
// to another protocol's canonical JSON or expiry policy here.
import { createHash, createPublicKey, verify } from 'node:crypto';

export const PRESENCE_AUDIENCE = 'agent-bot-owner';
const MAX_LIFETIME_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 30;

export function actionDigest(action) {
  return createHash('sha256').update(action, 'utf8').digest('hex');
}

// The payload of a `<prefix>.<payload>.<signature>` token keyd signed with
// `key`, fresh at `now`; throws `invalid()` otherwise.
export function openSigned(token, { prefix, kind, key, nonce, now, invalid }) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts[0] !== prefix) throw invalid();
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key, 'base64').toString('base64url') }, format: 'jwk' });
  if (!verify(null, Buffer.from(parts[1]), publicKey, Buffer.from(parts[2], 'base64url'))) throw invalid();
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw invalid(); }
  const seconds = Math.floor(now / 1000);
  if (payload?.v !== 1 || payload.aud !== PRESENCE_AUDIENCE || payload.kind !== kind || payload.nonce !== nonce
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
    || payload.exp <= payload.iat || payload.exp - payload.iat > MAX_LIFETIME_SECONDS
    || seconds + CLOCK_SKEW_SECONDS < payload.iat || seconds > payload.exp + CLOCK_SKEW_SECONDS) throw invalid();
  return payload;
}

// Throws unless `token` is keyd's signature of this action and nonce, fresh.
export function verifyPresence(token, { key, action, nonce, now = Date.now() }) {
  const invalid = () => Object.assign(new Error('agent-bot-keyd answered with an assertion that does not verify'), { code: 'presence-invalid' });
  const payload = openSigned(token, { prefix: 'p1', kind: 'presence', key, nonce, now, invalid });
  if (payload.action !== actionDigest(action)) throw invalid();
  return payload;
}
