// The owner's presence through agent-bot-keyd (#416): Touch ID where the
// Mac has it, otherwise the login password, never an administrator account.
//
// keyd, the signed native helper GeniusBar ships (#397), asks the person at
// the Mac with its own LocalAuthentication prompt and, only on approval,
// signs an assertion of the exact action with its presence key:
//
//   p1.<base64url(payload)>.<base64url(Ed25519 signature of the payload segment)>
//   payload: { v: 1, aud: 'agent-bot-owner', kind: 'presence',
//              action: hex(sha256(action)), nonce, iat, exp }
//
// The nonce is ours, so an assertion answers this one request. The key comes
// from the code-signed keyd binary (`agent-bot-keyd presence-key`), never from
// the socket: a process in this account can stand up a socket that answers
// anything, but it cannot sign with keyd's key, whose seed only keyd's code
// reads from the Keychain. `keyd/presence.pub` caches that key, and a cache in
// this account is a file a soul can write, so every call re-derives the key
// from the binary and refuses rather than trusting a cache that disagrees
// (#753).
//
// `unavailable` (code 'presence-unavailable') means nobody could be asked
// through keyd: no keyd, no Developer ID signature, no GUI session, no login
// password. The owner gate then falls back to its administrator dialog.
// Every other failure is the owner's answer or a bad assertion, and the gate
// refuses without asking again.

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { appendAuditReceipt } from './agent-principals.mjs';
import { ANY_DEVELOPER_ID, DEFAULT_KEYD_IDENTIFIER, keydSigner } from './config.mjs';
import { keydPaths, keydRequest, readKeydRecord } from './keyd-client.mjs';
import { requireOwnerApproval } from './owner-approval.mjs';
import { ed25519KeyLine, parseSshPublicKey, sshFingerprint } from './owner-statement.mjs';

export const PRESENCE_AUDIENCE = 'agent-bot-owner';
export const PRESENCE_UNAVAILABLE_RPC = -32001;
// A person at the Mac may take a while; keyd itself gives up at 120 s.
const OWNER_TIMEOUT_MS = 150_000;
const MAX_LIFETIME_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 30;
// The code-signing requirement checked before agent-bot runs a keyd binary
// to learn its presence key: a Developer ID Application signature from the
// configured team, on the configured identifier (#594). `keydSigner` in
// config.mjs resolves both; ANY_DEVELOPER_ID drops that part of the check.
export function developerIdRequirement({ teamId, identifier = DEFAULT_KEYD_IDENTIFIER }) {
  let requirement = 'anchor apple generic';
  if (identifier !== ANY_DEVELOPER_ID) requirement += ` and identifier "${identifier}"`;
  requirement += ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
  if (teamId !== ANY_DEVELOPER_ID) requirement += ` and certificate leaf[subject.OU] = "${teamId}"`;
  return requirement;
}

function unavailable(message) {
  return Object.assign(new Error(message), { code: 'presence-unavailable' });
}

function rawKey(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(text)) return null;
  return Buffer.from(text, 'base64').length === 32 ? text : null;
}

// `home` follows the caller's env, so a gate given a scratch HOME stays in it.
export function presencePinPath({ env = process.env, home = env.HOME || homedir() } = {}) {
  return path.join(keydPaths({ env, home }).dir, 'presence.pub');
}

// The signer a pin was taken under, kept beside it so a later pin under
// another signer is seen (#594). Pins from before #594 have none.
export function presenceSignerPath({ env = process.env, home = env.HOME || homedir() } = {}) {
  return path.join(keydPaths({ env, home }).dir, 'presence.signer');
}

function readPinnedSigner(file) {
  try {
    const signer = JSON.parse(readFileSync(file, 'utf8'));
    return typeof signer?.teamId === 'string' && typeof signer?.identifier === 'string' ? signer : null;
  } catch { return null; }
}

function signerWords({ teamId, identifier }) {
  const team = teamId === ANY_DEVELOPER_ID ? 'any Developer ID team' : `Developer ID team ${teamId}`;
  return identifier === ANY_DEVELOPER_ID ? `${team}, any identifier` : `${team} as ${identifier}`;
}

// Loosening who may sign keyd is the owner's call (#594): any Developer ID,
// or another signer than the pin was taken under. keyd cannot vouch for
// itself here, since its key is what is being pinned, so the owner answers
// the administrator dialog.
function approveSigner(signer, { previous }) {
  const change = previous ? ` instead of ${signerWords(previous)}` : '';
  requireOwnerApproval({
    prompt: `agent-bot wants to trust a keyd signed by ${signerWords(signer)}${change} for owner approvals. Approve only if you asked for this.`,
    outcome: 'no keyd key was pinned',
  });
}

function signerUnverified(error) {
  return Object.assign(new Error(`the keyd signer was not approved by the owner: ${error.message}`),
    { code: 'keyd-signer-unverified', cause: error });
}

// A presence key as `SHA256:` and unpadded base64, the form `ssh-keygen -l`
// prints and keyd's owner key prompt shows, so the owner can compare keys.
export function presenceKeyFingerprint(raw) {
  return sshFingerprint(parseSshPublicKey(ed25519KeyLine(raw)).blob);
}

// The cache and the binary disagree, or the cache is gone while a pin is on
// record, so something was replaced or removed. Neither value may answer for
// the owner on its own. The owner can settle it through the administrator
// dialog, which a soul cannot answer, and the dialog names both keys; without
// that answer nothing is re-pinned (#753).
function approveRepinnedKey({ cached, key }) {
  const was = cached ? `the pinned key ${presenceKeyFingerprint(cached)}` : 'a pinned key whose record is missing or damaged';
  requireOwnerApproval({
    prompt: `agent-bot's record of the keyd presence key does not match the code-signed keyd binary. Re-pin from ${was} to ${presenceKeyFingerprint(key)}, the key that binary reports now? Approve only if you asked for this — after updating the host app, or after removing keyd's presence key.`,
    outcome: 'the keyd presence key was not re-pinned',
  });
}

function pinMismatch(file, cause) {
  return Object.assign(new Error(
    `the keyd presence key in ${file} does not match the code-signed keyd binary and the owner did not re-pin it; run the owner command again from the Mac and approve the re-pin`),
  { code: 'presence-pin-mismatch', cause });
}

// What one record says about an earlier pin. Only a file that is not there
// at all (ENOENT) says "never"; one that cannot be checked, a symlink, a
// directory or any other non-regular file says "pinned before", so a record
// made unreadable fails closed rather than open (#753).
function recordState(file) {
  let info;
  try { info = lstatSync(file); } catch (error) { return error?.code === 'ENOENT' ? 'absent' : 'pinned'; }
  return info.isFile() && !info.isSymbolicLink() ? 'file' : 'pinned';
}

// keyd's own receipts (keyd/src/audit.rs). An `owner/presence` or
// `owner/pins-attest` call is made only under a pinned presence key, so one on
// record means a key was pinned here before. An audit that cannot be read
// counts as one that says so.
function keydUsedPresence(file) {
  const state = recordState(file);
  if (state !== 'file') return state === 'pinned';
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return true; }
  return /"operation":\s*"owner\/(?:presence|pins-attest)"/.test(text);
}

// Whether a presence key was pinned here before, when the cache is missing or
// does not parse. Removing `presence.pub` must not turn the next key the
// binary reports, possibly a planted seed, into a silent first pin (#753).
// A cache that is there but does not parse, a `presence.signer` (written with
// every pin since #594), or a presence call in keyd's audit each means the
// owner is asked; only all three absent means a first pin.
//
// All three sit in `<state>/keyd`, which confinement.mjs denies a soul's tool
// calls by path, not by any OS boundary. A process running as the owner can
// still remove every one of them and get a silent first pin: this makes a
// partial removal or a damaged record visible, it does not prevent a whole
// one. As with keyd's Keychain lock (store.rs), the durable answer is the
// data-protection keychain under the signed host app.
function pinnedBefore({ env, home, file, signerFile }) {
  if (recordState(file) !== 'absent') return true;
  if (recordState(signerFile) !== 'absent') return true;
  return keydUsedPresence(path.join(keydPaths({ env, home }).dir, 'audit.jsonl'));
}

function codesignVerify(bin, requirement) {
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement}`, bin],
    { stdio: ['ignore', 'ignore', 'pipe'] });
}

function runPresenceKey(bin) {
  return execFileSync(bin, ['presence-key'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
}

// keyd's presence key, base64 of the raw Ed25519 public key, or null when
// no signed keyd is installed or no keyd Team ID is configured. Derived from
// the binary on every call: `presence.pub` is a cache of the last pin, never
// the pin, because a file in this account is one a soul can write (#753). A
// binary that disagrees with the cache, or a cache missing while a pin is on
// record, is put to the owner through the administrator dialog; refused, or with nobody to ask, this throws
// `presence-pin-mismatch`, and approved it re-pins. A pin under a loosened
// signer needs the owner's approval too and leaves a receipt; without it this
// throws `keyd-signer-unverified` and pins nothing.
export function pinnedPresenceKey({
  env = process.env,
  home = env.HOME || homedir(),
  record = readKeydRecord({ env, home }),
  verifyBinary = codesignVerify,
  run = runPresenceKey,
  signer = keydSigner,
  approve = approveSigner,
  approveRepin = approveRepinnedKey,
  receipt = appendAuditReceipt,
} = {}) {
  const file = presencePinPath({ env, home });
  let cached = null;
  try { cached = rawKey(readFileSync(file, 'utf8').trim()); } catch { /* not pinned yet */ }
  if (!record?.bin) return null;
  // A malformed signer setting pins nothing, like an unsigned binary, and so
  // does a missing Team ID.
  let wanted;
  try { wanted = signer({ env, home }); } catch { return null; }
  if (!wanted.teamId) return null;
  try { verifyBinary(record.bin, developerIdRequirement(wanted)); } catch { return null; }
  const signerFile = presenceSignerPath({ env, home });
  const previous = readPinnedSigner(signerFile);
  const changed = previous && (previous.teamId !== wanted.teamId || previous.identifier !== wanted.identifier);
  const loosened = wanted.teamId === ANY_DEVELOPER_ID || wanted.identifier === ANY_DEVELOPER_ID;
  // `presence.signer` sits in a directory a soul can write, so it is never
  // proof of approval on its own: it only spares the question when a pin is
  // also cached, and then a key the binary reports differently still goes to
  // the owner below. With no cache, a loosened signer is asked again.
  const alreadyApproved = previous && !changed && cached !== null;
  // Loosening who may sign keyd is put to the owner when it first pins and
  // whenever the signer moves. Re-deriving under a signer already recorded as
  // approved is not a new decision, and an owner action is not the place to
  // ask one again.
  if (changed || (loosened && !alreadyApproved)) {
    const detail = `${signerWords(wanted)}${changed ? ` (was ${signerWords(previous)})` : ''}`;
    const record_ = (decision) => receipt({ event: 'keyd-signer', operation: 'pin-presence-key', decision, detail }, { env, home });
    try {
      approve(wanted, { previous: changed ? previous : null });
    } catch (error) {
      try { record_('refused'); } catch { /* the refusal stands without its receipt */ }
      throw signerUnverified(error);
    }
    record_('approved');
  }
  let key;
  try { key = rawKey(String(run(record.bin)).trim()); } catch { return null; }
  if (!key) return null;
  // keyd's key moved, or its cache went missing after a pin: a rotation the
  // owner asked for, or somebody else's doing. Only the owner can say which,
  // and the answer is receipted either way. Approved, the write below re-pins
  // to what the binary reports.
  const moved = cached ? cached !== key : pinnedBefore({ env, home, file, signerFile });
  if (moved) {
    const detail = cached ? 'the pinned presence key does not match the code-signed keyd binary'
      : 'the presence key cache is missing or damaged although a key was pinned before';
    const record_ = (decision) => receipt({ event: 'keyd-signer', operation: 'repin-presence-key', decision, detail }, { env, home });
    try {
      approveRepin({ cached, key });
    } catch (error) {
      try { record_('refused'); } catch { /* the refusal stands without its receipt */ }
      throw pinMismatch(file, error);
    }
    record_('approved');
  }
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; a corrupt pin being
  // replaced keeps whatever mode it had, so set it explicitly.
  chmodSync(file, 0o600);
  writeFileSync(signerFile, `${JSON.stringify({ teamId: wanted.teamId, identifier: wanted.identifier })}\n`, { mode: 0o600 });
  chmodSync(signerFile, 0o600);
  return key;
}

export function actionDigest(action) {
  return createHash('sha256').update(action, 'utf8').digest('hex');
}

// The payload of a `<prefix>.<payload>.<signature>` token keyd signed with
// `key`, fresh at `now`; throws `invalid()` otherwise.
function openSigned(token, { prefix, kind, key, nonce, now, invalid }) {
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

// The digest keyd records for the owner's statement keys (#753): sha256 of
// one line per pin, in order, as keyd/src/pins.rs writes it. The fingerprint
// stands for the key; owner-statement.mjs refuses a pin whose fingerprint
// does not match its key.
export function pinSetDigest(pins) {
  const lines = pins.map((pin) => `${pin.store} ${pin.alg} ${pin.fingerprint} ${pin.verifyRequired ? 1 : 0} ${pin.softwareKey ? 1 : 0} ${pin.name}\n`);
  return createHash('sha256').update(`agent-bot owner pins v1\n${lines.join('')}`, 'utf8').digest('hex');
}

// Throws unless `token` is keyd's signed record of the owner's keys for this
// nonce, fresh: `owner/pins-attest` or `owner/pins-status`. Returns
// { digest, generation }; digest is null, at generation 0, before the owner
// has approved any key set through keyd.
export function verifyPinsAttestation(token, { key, nonce, now = Date.now() }) {
  const invalid = () => Object.assign(new Error('agent-bot-keyd answered with an owner key record that does not verify'), { code: 'pins-invalid' });
  const payload = openSigned(token, { prefix: 'k1', kind: 'pins', key, nonce, now, invalid });
  const { digest, generation } = payload;
  if (!Number.isSafeInteger(generation) || generation < 0) throw invalid();
  if (digest === null ? generation !== 0 : (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || generation === 0)) throw invalid();
  return { digest, generation };
}

// Asks the owner through keyd to approve `action`, one line naming the soul
// and the change. Returns the authorization to record.
export async function keydPresence(action, {
  env = process.env,
  home = env.HOME || homedir(),
  pinned = pinnedPresenceKey,
  request = keydRequest,
  now = () => Date.now(),
  nonce = () => randomBytes(18).toString('base64url'),
} = {}) {
  const key = pinned({ env, home });
  if (!key) throw unavailable('agent-bot-keyd is not set up for owner approval here');
  const sent = nonce();
  let result;
  try {
    result = await request(keydPaths({ env, home }).ownerSocket, 'owner/presence', { action, nonce: sent }, { timeoutMs: OWNER_TIMEOUT_MS });
  } catch (error) {
    if (error.code === 'keyd-unavailable' || error.rpcCode === PRESENCE_UNAVAILABLE_RPC) throw unavailable(error.message);
    throw Object.assign(new Error(`the owner did not approve (${error.message})`), { code: 'owner-declined' });
  }
  verifyPresence(result?.assertion, { key, action, nonce: sent, now: now() });
  return { method: 'presence', via: 'agent-bot-keyd' };
}

// For a caller with nobody at a dialog to answer — the daemon, or a command a
// soul runs (#753): keyd's own prompt only. A pin that would need the owner's
// administrator dialog, a loosened signer or a key to re-pin, is refused here
// instead of raising it, and the owner gate refuses the action with that code.
function noAdministratorDialog() {
  throw new Error('this caller cannot raise the administrator dialog, so the owner was not asked');
}

export function pinnedPresenceKeyWithoutDialog(options = {}) {
  return pinnedPresenceKey({ ...options, approve: noAdministratorDialog, approveRepin: noAdministratorDialog });
}

export function keydPresenceWithoutDialog(action, options = {}) {
  return keydPresence(action, { ...options, pinned: pinnedPresenceKeyWithoutDialog });
}

// Asks the owner through keyd to trust exactly `pins` as their statement keys
// (#753): keyd shows every key and, only on approval, records the set. Returns
// keyd's { digest, generation } for this set. The owner key store is written
// only through this, so with no keyd to ask, `presence-unavailable` refuses
// the change rather than falling back.
export async function keydAttestPins(pins, {
  env = process.env,
  home = env.HOME || homedir(),
  pinned = pinnedPresenceKey,
  request = keydRequest,
  now = () => Date.now(),
  nonce = () => randomBytes(18).toString('base64url'),
} = {}) {
  const key = pinned({ env, home });
  if (!key) throw unavailable('agent-bot-keyd is not set up to record owner keys here');
  const sent = nonce();
  let result;
  try {
    result = await request(keydPaths({ env, home }).ownerSocket, 'owner/pins-attest', { pins, nonce: sent }, { timeoutMs: OWNER_TIMEOUT_MS });
  } catch (error) {
    if (error.rpcCode === -32601) throw unavailable('this agent-bot-keyd cannot record owner keys; update it');
    if (error.code === 'keyd-unavailable' || error.rpcCode === PRESENCE_UNAVAILABLE_RPC) throw unavailable(error.message);
    throw Object.assign(new Error(`the owner did not approve (${error.message})`), { code: 'owner-declined' });
  }
  const record = verifyPinsAttestation(result?.attestation, { key, nonce: sent, now: now() });
  if (record.digest !== pinSetDigest(pins)) {
    throw Object.assign(new Error('agent-bot-keyd recorded other owner keys than were asked'), { code: 'pins-invalid' });
  }
  return record;
}
