// Disabled owner-decision action decoding and native p1 presence verification
// (agent-comms#77, C2). The grammar is agent-comms docs/owner-decisions.md
// and docs/owner-decision-wire.md (typed summary and native display) at
// 9edd21b; this is the daemon's own implementation, checked against the
// shared vectors (tests/fixtures/owner-decisions/v1.json), and imports no
// agent-comms code. Pure verification: no route, slot write or authority.
//
// The p1 is verified with agent-bot's existing keyd p1 semantics
// (presence-verifier.mjs: audience agent-bot-owner, kind presence, at most a
// 120-second lifetime, 30-second skew), unchanged, against the presence pin
// from the trust records: the future native agent-bot-owner signer, which
// readOwnerDecisionTrust already refuses to be keyd's legacy presence seed.
import { createHash, createPublicKey } from 'node:crypto';
import { verifyPresence } from './presence-verifier.mjs';
import { exactBytes } from './owner-decision-bytes.mjs';

const MAX_BYTES = 32 * 1024;
const MAX_DEPTH = 8;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const SOUL = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REVISION = /^sha256:[0-9a-f]{64}$/;
// `soul.computer-use.set` (agent-comms#250, first phase): proposed, not
// adopted. Its shapes follow the agent-comms candidate vectors (PR #263),
// vendored as tests/fixtures/owner-decisions/computer-use-candidate-v1.json
// and still a draft until that PR merges. Disabled: no route.
export const COMPUTER_USE_OPERATION = 'soul.computer-use.set';
const OPERATIONS = new Set(['revision.approve', 'revision.reject', 'revision.adopt', 'revision.edit', 'cold-wake.set', COMPUTER_USE_OPERATION]);
// The fixed native summaries for `soul.computer-use.set` (agent-comms PR
// #260): permission only, never a stop.
export const COMPUTER_USE_SUMMARIES = Object.freeze({
  false: 'enabled=false; deny future computer-use calls while off; current turn and authorized/running tool calls continue',
  true: 'enabled=true; current turn continues',
});
// Scalars the owner's display refuses: every Unicode 17.0.0 Cc, Cf, Zl and Zp
// code point (DerivedGeneralCategory.txt), as inclusive [first, last] ranges.
// A frozen literal table, never an ambient \p{} property, so a runtime's
// Unicode version can't change it; it equals agent-comms
// display-rejections-v1.json rejectedRanges exactly.
export const OWNER_DISPLAY_REJECTED_RANGES = Object.freeze([
  [0x0000, 0x001f, 'Cc'], [0x007f, 0x009f, 'Cc'], [0x00ad, 0x00ad, 'Cf'], [0x0600, 0x0605, 'Cf'],
  [0x061c, 0x061c, 'Cf'], [0x06dd, 0x06dd, 'Cf'], [0x070f, 0x070f, 'Cf'], [0x0890, 0x0891, 'Cf'],
  [0x08e2, 0x08e2, 'Cf'], [0x180e, 0x180e, 'Cf'], [0x200b, 0x200f, 'Cf'], [0x2028, 0x2028, 'Zl'],
  [0x2029, 0x2029, 'Zp'], [0x202a, 0x202e, 'Cf'], [0x2060, 0x2064, 'Cf'], [0x2066, 0x206f, 'Cf'],
  [0xfeff, 0xfeff, 'Cf'], [0xfff9, 0xfffb, 'Cf'], [0x110bd, 0x110bd, 'Cf'], [0x110cd, 0x110cd, 'Cf'],
  [0x13430, 0x1343f, 'Cf'], [0x1bca0, 0x1bca3, 'Cf'], [0x1d173, 0x1d17a, 'Cf'], [0xe0001, 0xe0001, 'Cf'],
  [0xe0020, 0xe007f, 'Cf'],
].map((range) => Object.freeze(range)));

// Whether any scalar of `text` falls in a refused range. The text is checked
// exactly as given: no trimming or normalization.
function hasRejectedScalar(text) {
  for (const scalar of text) {
    const code = scalar.codePointAt(0);
    for (const [first, last] of OWNER_DISPLAY_REJECTED_RANGES) {
      if (code < first) break;
      if (code <= last) return true;
    }
  }
  return false;
}
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function actionError(reason) {
  return Object.assign(new Error('owner decision action refused'), { code: 'invalid-owner-decision', reason });
}
const fail = (reason = 'owner-action-invalid') => { throw actionError(reason); };

// --- the strict canonical encoding owner-decision actions use ---

function scalarString(value) {
  for (const scalar of value) {
    const code = scalar.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) fail('owner-action-encoding');
  }
  return JSON.stringify(value);
}

// Sorted keys (ASCII only), no whitespace, safe integers only (no -0), and
// strings of Unicode scalar values.
export function ownerDecisionCanonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return scalarString(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('owner-action-encoding');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(ownerDecisionCanonical).join(',')}]`;
  if (typeof value !== 'object') fail('owner-action-encoding');
  const keys = Object.keys(value).sort();
  for (const key of keys) if (!/^[\x00-\x7f]*$/.test(key)) fail('owner-action-encoding');
  return `{${keys.map((key) => `${scalarString(key)}:${ownerDecisionCanonical(value[key])}`).join(',')}}`;
}

// Containers are counted before JSON.parse, so deep nesting never reaches the
// recursive encoder.
function boundedDepth(text) {
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') { if (++depth > MAX_DEPTH) fail('owner-action-encoding'); }
    else if (char === '}' || char === ']') { if (--depth < 0) fail('owner-action-encoding'); }
  }
  if (depth !== 0 || quoted) fail('owner-action-encoding');
}

// A private copy of the input's intrinsic bytes (owner-decision-bytes.mjs).
function snapshot(bytes) {
  return exactBytes(bytes, { max: MAX_BYTES }) ?? fail('owner-action-encoding');
}

function decodeCanonical(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    boundedDepth(text);
    const value = JSON.parse(text);
    if (ownerDecisionCanonical(value) !== text) throw new Error();
    return value;
  } catch { return fail('owner-action-encoding'); }
}

// --- the typed action and its native display text ---

function fields(value, names) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) fail();
}

function reason(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 500 || hasRejectedScalar(value)) fail();
}

// A canonical WHATWG HTTPS host: lowercase ASCII, at most 253 bytes, that
// round-trips through URL with only "/" as its path and no credentials.
function host(value) {
  if (typeof value !== 'string' || !/^[\x00-\x7f]+$/.test(value) || value.length > 253 || value !== value.toLowerCase()) fail();
  let parsed;
  try { parsed = new URL(`https://${value}/`); } catch { fail(); }
  if (parsed.host !== value || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) fail();
}

function summary(action) {
  const p = action.parameters;
  if (action.operation === 'revision.approve' || action.operation === 'revision.reject') {
    fields(p, ['proposalId', 'expectedRevision', 'reason']);
    if (!matches(UUID4, p.proposalId) || !matches(REVISION, p.expectedRevision)) fail();
    reason(p.reason);
    return `proposal=${JSON.stringify(p.proposalId)}; reason=${JSON.stringify(p.reason)}`;
  }
  if (action.operation === 'revision.adopt' || action.operation === 'revision.edit') {
    const editing = action.operation === 'revision.edit';
    fields(p, ['stagingId', 'packageDigest', 'expectedRevision', 'reason', ...(editing ? ['apply'] : [])]);
    if (!matches(UUID4, p.stagingId) || !matches(DIGEST, p.packageDigest)
      || (editing ? !matches(REVISION, p.expectedRevision) || typeof p.apply !== 'boolean' : p.expectedRevision !== null)) fail();
    reason(p.reason);
    return `package sha256:${p.packageDigest}; ${editing ? `apply=${p.apply}; ` : ''}reason=${JSON.stringify(p.reason)}`;
  }
  if (action.operation === COMPUTER_USE_OPERATION) {
    fields(p, ['enabled']);
    if (typeof p.enabled !== 'boolean') fail();
    return COMPUTER_USE_SUMMARIES[p.enabled];
  }
  // Every branch below is cold-wake's; any other operation refuses here,
  // never falling through to a mode it doesn't have.
  if (action.operation !== 'cold-wake.set') fail();
  if (p?.mode === 'on' || p?.mode === 'off') {
    fields(p, ['mode']);
    return `mode=${p.mode}`;
  }
  if (p?.mode === 'resume') {
    fields(p, ['mode', 'policy']);
    if (p.policy !== 'read-only' && p.policy !== 'workspace') fail();
    return `mode=resume; policy=${p.policy}`;
  }
  if (p?.mode === 'webhook') {
    fields(p, ['mode', 'stagingId', 'configurationDigest', 'host']);
    if (!matches(UUID4, p.stagingId) || !matches(DIGEST, p.configurationDigest)) fail();
    host(p.host);
    return `mode=webhook; host=${JSON.stringify(p.host)}; configuration sha256:${p.configurationDigest}`;
  }
  return fail();
}

// The exact canonical action bytes, decoded and validated, with the payload
// digest and the one-line text the owner's native presence signs. The text
// is refused (never truncated) past 400 Unicode scalars, 500 UTF-8 bytes, or
// with any control character.
export function decodeOwnerDecisionAction(bytes) {
  const copy = snapshot(bytes);
  const action = decodeCanonical(copy);
  fields(action, ['v', 'requestId', 'principal', 'account', 'soul', 'operation', 'parameters']);
  if (action.v !== 1 || !matches(UUID4, action.requestId) || !matches(PRINCIPAL, action.principal)
    || !matches(ACCOUNT, action.account) || !matches(SOUL, action.soul) || !OPERATIONS.has(action.operation)) fail();
  const typedSummary = summary(action);
  const payloadDigest = sha256(copy);
  const actionText = `Owner decision ${action.operation} for ${action.account}/${action.soul}: ${typedSummary}; request ${action.requestId}; payload sha256:${payloadDigest}`;
  if ([...actionText].length > 400 || Buffer.byteLength(actionText) > 500 || hasRejectedScalar(actionText)) fail('owner-action-display');
  return { action, payloadDigest, summary: typedSummary, actionText, actionDigest: sha256(Buffer.from(actionText, 'utf8')) };
}

// Verifies one complete p1 for exactly this action and challenge nonce,
// against the active presence pin from readOwnerDecisionTrust. Returns the
// p1 payload, the decoded action and presenceDigest (SHA-256 of the token).
export function verifyOwnerDecisionPresence(presenceToken, { actionBytes, nonce, trust, nowMilliseconds } = {}) {
  const decoded = decodeOwnerDecisionAction(actionBytes);
  const pin = trust?.presenceKey;
  if (pin === null || typeof pin !== 'object' || pin.alg !== 'ed25519' || !matches(/^[A-Za-z0-9_-]{43}$/, pin.publicKey)
    || !matches(DIGEST, pin.keyId)) fail('owner-presence-trust');
  let raw;
  try {
    raw = Buffer.from(pin.publicKey, 'base64url');
    const spki = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pin.publicKey }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
    if (raw.length !== 32 || raw.toString('base64url') !== pin.publicKey || sha256(spki) !== pin.keyId) throw new Error();
  } catch { fail('owner-presence-trust'); }
  if (typeof presenceToken !== 'string' || presenceToken.length > 4096 || !/^[\x21-\x7e]+$/.test(presenceToken)
    || !Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) fail('owner-presence-invalid');
  // The challenge nonce: exactly 32 bytes as canonical unpadded base64url. The
  // p1's nonce must equal it, so a missing nonce on both sides never matches.
  if (!matches(/^[A-Za-z0-9_-]{43}$/, nonce) || Buffer.from(nonce, 'base64url').length !== 32
    || Buffer.from(nonce, 'base64url').toString('base64url') !== nonce) fail('owner-presence-nonce');
  let payload;
  try {
    payload = verifyPresence(presenceToken, { key: raw.toString('base64'), action: decoded.actionText, nonce, now: nowMilliseconds });
  } catch { fail('owner-presence-invalid'); }
  return { payload, action: decoded.action, payloadDigest: decoded.payloadDigest, actionText: decoded.actionText,
    presenceDigest: sha256(Buffer.from(presenceToken, 'ascii')) };
}
