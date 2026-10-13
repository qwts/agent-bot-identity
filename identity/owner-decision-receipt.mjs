// Disabled daemon-side d1 receipt verification (agent-comms#77, C2), against
// agent-comms docs/owner-decisions.md and the issuer vectors at c7f7ea0
// (#213). Verification only: no slot write, route, release or authority. A
// receipt that verifies is the broker's signed statement about one prepared
// challenge; applying still needs the live check, current trust and the
// final locked rechecks.
//
// Not here: the p1 signature and action-text check (the native presence
// verifier, which needs shared action vectors). This binds the receipt to the
// exact p1 bytes (presenceDigest) and bounds its expiry by the p1's stated
// expiry, read structurally.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from '../canonical-json.mjs';
import { exactBytes } from './owner-decision-bytes.mjs';
import { DAEMON_JOURNAL_SLOTS } from './owner-decision-journal-frame.mjs';

const CHALLENGE_CAP = DAEMON_JOURNAL_SLOTS.find(({ slot }) => slot === 'prepared-challenge').cap;

export const RECEIPT_AUDIENCE = 'agent-comms-owner-decision';
const MAX_TOKEN = 4096;
const LIFETIME = 60;
const SKEW = 30;
const RECEIPT_FIELDS = ['v', 'aud', 'brokerKey', 'requestId', 'principal', 'account', 'soul', 'operation',
  'payloadDigest', 'nonce', 'presenceKey', 'presenceDigest', 'iat', 'exp'];
const CHALLENGE_BINDINGS = ['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'nonce'];
const DIGEST = /^[a-f0-9]{64}$/;
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PRINCIPAL = /^principal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SOUL = /^agent_[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACCOUNT = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
// `soul.computer-use.set` (agent-comms#250, proposed): the d1 payload itself is
// unchanged; its nonce binds the challenge, which carries the plan digest.
const OPERATIONS = ['revision.approve', 'revision.reject', 'revision.adopt', 'revision.edit', 'cold-wake.set', 'soul.computer-use.set'];
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const seconds = (value) => Number.isSafeInteger(value) && value >= 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function receiptError(reason) {
  return Object.assign(new Error('owner decision receipt refused'), { code: 'receipt-invalid', reason });
}
const fail = (reason = 'owner-receipt-invalid') => { throw receiptError(reason); };

// Canonical unpadded base64url only: decoding and re-encoding must reproduce
// the segment exactly, including zero unused trailing bits.
function base64url(segment, length) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) fail();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment || (length !== undefined && bytes.length !== length)) fail();
  return bytes;
}

function canonicalObject(bytes) {
  let value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
    if (!plain(value) || canonicalJson(value) !== text) throw new Error();
  } catch { fail(); }
  return value;
}

const asciiToken = (token, prefix) => {
  if (typeof token !== 'string' || token.length > MAX_TOKEN || !/^[\x21-\x7e]+$/.test(token)) fail();
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) fail();
  return parts;
};

// The receipt clock rule: 0 < exp - iat <= 60, iat <= now + 30, now < exp.
export function receiptClockValid({ iat, exp, now }) {
  return seconds(iat) && seconds(exp) && seconds(now) && exp > iat && exp - iat <= LIFETIME
    && Number.isSafeInteger(now + SKEW) && iat <= now + SKEW && now < exp;
}

function publicKeyOf(pin) {
  try { return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pin.publicKey }, format: 'jwk' }); } catch { return fail(); }
}

// Verifies one complete d1 token against:
// - `trust`: the active receipt and presence pins from readOwnerDecisionTrust;
// - `daemonKey`: this daemon's own key ID;
// - `challengeBytes`: the exact saved prepared challenge (daemon slot 3);
// - `presenceToken`: the complete ASCII p1 delivered with it;
// - `nowMilliseconds`.
// Returns the payload and the receiptDigest (SHA-256 of the whole token).
export function verifyOwnerDecisionReceipt(receiptToken, { trust, daemonKey, challengeBytes, presenceToken, nowMilliseconds } = {}) {
  const parts = asciiToken(receiptToken, 'd1');
  const receiptPin = trust?.receiptKey, presencePin = trust?.presenceKey;
  if (!plain(receiptPin) || !plain(presencePin) || !matches(DIGEST, receiptPin.keyId) || !matches(DIGEST, presencePin.keyId)
    || !matches(DIGEST, daemonKey)) fail('owner-receipt-trust');
  // Four distinct roles: no receipt, presence or vouch key alias.
  if (new Set([receiptPin.keyId, presencePin.keyId, daemonKey]).size !== 3) fail('owner-receipt-alias');
  const receiptKey = publicKeyOf(receiptPin);
  if (sha256(receiptKey.export({ type: 'spki', format: 'der' })) !== receiptPin.keyId) fail('owner-receipt-trust');

  const payload = canonicalObject(base64url(parts[1]));
  if (Object.keys(payload).length !== RECEIPT_FIELDS.length || !RECEIPT_FIELDS.every((key) => Object.hasOwn(payload, key))
    || payload.v !== 1 || payload.aud !== RECEIPT_AUDIENCE || !matches(UUID4, payload.requestId)
    || !matches(PRINCIPAL, payload.principal) || !matches(ACCOUNT, payload.account) || !matches(SOUL, payload.soul)
    || !OPERATIONS.includes(payload.operation)
    || !['brokerKey', 'payloadDigest', 'presenceKey', 'presenceDigest'].every((key) => matches(DIGEST, payload[key]))) fail();
  base64url(payload.nonce, 32);
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) fail();
  if (!receiptClockValid({ iat: payload.iat, exp: payload.exp, now: Math.floor(nowMilliseconds / 1000) })) fail('owner-receipt-clock');
  if (payload.brokerKey !== receiptPin.keyId || payload.presenceKey !== presencePin.keyId) fail('owner-receipt-trust');
  if (!verify(null, Buffer.from(parts[1], 'ascii'), receiptKey, base64url(parts[2], 64))) fail('owner-receipt-signature');

  // Bound to the exact saved challenge, and never outliving it.
  // A private copy of the challenge's intrinsic bytes, within slot 3's cap.
  const challenge = canonicalObject(exactBytes(challengeBytes, { max: CHALLENGE_CAP }) ?? fail('owner-receipt-binding'));
  if (!CHALLENGE_BINDINGS.every((key) => payload[key] === challenge[key]) || !seconds(challenge.exp) || payload.exp > challenge.exp
    || challenge.daemonKey !== daemonKey) fail('owner-receipt-binding');
  // Bound to the exact p1 bytes, and never outliving its stated expiry.
  const presenceParts = asciiToken(presenceToken, 'p1');
  const presence = presencePayload(base64url(presenceParts[1]));
  if (!seconds(presence.exp) || payload.exp > presence.exp || payload.presenceDigest !== sha256(Buffer.from(presenceToken, 'ascii'))) {
    fail('owner-receipt-binding');
  }
  return { payload, receiptDigest: sha256(Buffer.from(receiptToken, 'ascii')) };
}

// The p1 payload is keyd's own encoding, not necessarily canonical: read it
// as plain JSON for its expiry only; its signature is the presence verifier's.
function presencePayload(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(); }
  if (!plain(value)) fail();
  return value;
}
