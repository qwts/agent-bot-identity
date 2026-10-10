// Ed25519 soul tokens (ADR-0008 decision 3, #254).
//
// The daemon holds one per-account key, created once at
// <state-dir>/vouch-key.pem (PKCS#8, mode 0600). The default state dir is
// ~/.local/state/agent-bot, following XDG_STATE_HOME the same way the
// daemon's other account state does. A vouch signs a short-lived token the
// broker checks with the SPKI public key:
//
//   v1.<base64url(JSON payload)>.<base64url(Ed25519(payload segment bytes))>
//
// The signature covers the payload segment — the base64url text itself — not
// the decoded JSON and not the "v1." prefix. exp is iat + 300 seconds and
// aud is always "agent-comms". verifySoulToken is the check agent-comms
// mirrors: signature, version, audience, the 300-second cap, and expiry.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createWindowsAccountCustody } from './windows-account-custody.mjs';

export const SOUL_TOKEN_TTL_SECONDS = 300;
export const SOUL_TOKEN_AUDIENCE = 'agent-comms';
const VOUCH_KEY_FILE = 'vouch-key.pem';
const NONCE_BYTES = 16;
const MAX_TOKEN_CHARS = 4096;

export function vouchStateDir({ env = process.env, home = homedir() } = {}) {
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot');
}

export function vouchKeyPath(stateDir) {
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new Error('vouch state directory is required');
  }
  return path.join(path.resolve(stateDir), VOUCH_KEY_FILE);
}

function tightenKeyMode(file) {
  try {
    chmodSync(file, 0o600);
  } catch {
    throw new Error('vouch key permissions could not be restricted');
  }
}

// A key that is not Ed25519 PKCS#8 is refused and left in place. Replacing it
// would silently rotate the public key the broker has already approved.
function readVouchKey(file, { platform, custody, sid }) {
  if (platform === 'win32') {
    try {
      // `lstat` distinguishes a missing first-run key from an untrusted one;
      // the Windows seam then checks owner, file type and reparse status.
      lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('vouch key file could not be inspected');
    }
    let pem;
    try {
      custody.assertOwnedFile(file, sid);
      custody.restrictPrivateFile(file, sid);
      pem = readFileSync(file, 'utf8');
    } catch {
      throw new Error('vouch key file custody or private access could not be verified');
    }
    return parseVouchKey(pem);
  }

  // O_NOFOLLOW and an owner check, like the binding reader: a symlink or a
  // foreign file is refused rather than read and chmodded through.
  let pem;
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid()) throw new Error('untrusted');
    pem = readFileSync(fd, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('vouch key file is not a regular file owned by this account');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return parseVouchKey(pem);
}

function parseVouchKey(pem) {
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    return privateKey;
  } catch {
    throw new Error('vouch key file is not an Ed25519 PKCS#8 key');
  }
}

function describeKey(file, privateKey, created) {
  const publicKey = createPublicKey(privateKey);
  return {
    file,
    created,
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

export function loadOrCreateVouchKey(stateDir, {
  platform = process.platform, custody = null, openKeyFile = openSync, writeKeyFile = writeFileSync,
} = {}) {
  const file = vouchKeyPath(stateDir);
  if (platform === 'win32') {
    custody ??= createWindowsAccountCustody();
    const sid = custody.currentSid();
    mkdirSync(path.dirname(file), { recursive: true });
    custody.assertOwnedDirectory(path.dirname(file), sid);
    const existing = readVouchKey(file, { platform, custody, sid });
    if (existing) return describeKey(file, existing, false);

    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    let fd;
    try {
      fd = openKeyFile(file, 'wx');
      // Restrict the new empty file before writing private key bytes.
      custody.assertOwnedFile(file, sid);
      custody.restrictPrivateFile(file, sid);
      writeFileSync(fd, pem, { encoding: 'utf8' });
      custody.assertOwnedFile(file, sid);
      return describeKey(file, privateKey, true);
    } catch (error) {
      if (error.code === 'EEXIST') {
        const raced = readVouchKey(file, { platform, custody, sid });
        if (!raced) throw new Error('vouch key could not be read');
        return describeKey(file, raced, false);
      }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  const existing = readVouchKey(file, { platform });
  if (existing) {
    tightenKeyMode(file);
    return describeKey(file, existing, false);
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeKeyFile(file, pem, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('vouch key could not be created');
    const raced = readVouchKey(file, { platform });
    if (!raced) throw new Error('vouch key could not be read');
    tightenKeyMode(file);
    return describeKey(file, raced, false);
  }
  tightenKeyMode(file);
  return describeKey(file, privateKey, true);
}

function unixSeconds(now) {
  const instant = typeof now === 'function' ? now() : now;
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new TypeError('now must be a Date or a function that returns one');
  }
  return Math.floor(instant.getTime() / 1000);
}

function signingKeyOf(key) {
  const privateKey = key && typeof key === 'object' && key.privateKey ? key.privateKey : key;
  if (typeof privateKey === 'string') return createPrivateKey(privateKey);
  return privateKey;
}

function requireClaimString(name, value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

// key is a private KeyObject, a PKCS#8 PEM string, or the object
// loadOrCreateVouchKey returns. now is a Date or () => Date, matching the
// daemon's clock injection.
export function signSoulToken({ account, agentId, parent }, key, now = () => new Date()) {
  const iat = unixSeconds(now);
  const payload = {
    v: 1,
    aud: SOUL_TOKEN_AUDIENCE,
    account: requireClaimString('account', account),
    agentId: requireClaimString('agentId', agentId),
    parent: parent === null || parent === undefined ? null : requireClaimString('parent', parent),
    iat,
    exp: iat + SOUL_TOKEN_TTL_SECONDS,
    nonce: randomBytes(NONCE_BYTES).toString('base64url'),
  };
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(payloadSegment), signingKeyOf(key));
  return `v1.${payloadSegment}.${Buffer.from(signature).toString('base64url')}`;
}

function publicKeyOf(publicKey) {
  if (typeof publicKey === 'string') return createPublicKey(publicKey);
  if (publicKey && typeof publicKey === 'object' && publicKey.publicKey) return publicKey.publicKey;
  return publicKey;
}

function canonicalNonce(nonce) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) return false;
  const bytes = Buffer.from(nonce, 'base64url');
  return bytes.length === NONCE_BYTES && bytes.toString('base64url') === nonce;
}

// Returns the payload when the signature, version, audience, lifetime, and
// expiry all hold. Returns null for anything else, including a token signed
// over different bytes. Throws only when `now` itself is unusable.
export function verifySoulToken(token, publicKey, now = () => new Date()) {
  const nowSeconds = unixSeconds(now);
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || parts[1].length === 0 || parts[2].length === 0) {
    return null;
  }
  const [payloadSegment, signatureSegment] = [parts[1], parts[2]];
  if (!/^[A-Za-z0-9_-]+$/.test(payloadSegment) || !/^[A-Za-z0-9_-]+$/.test(signatureSegment)) {
    return null;
  }
  let key;
  try {
    key = publicKeyOf(publicKey);
  } catch {
    return null;
  }
  const signature = Buffer.from(signatureSegment, 'base64url');
  let signed;
  try {
    signed = verify(null, Buffer.from(payloadSegment), key, signature);
  } catch {
    return null;
  }
  if (!signed) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.v !== 1 || payload.aud !== SOUL_TOKEN_AUDIENCE) return null;
  if (typeof payload.account !== 'string' || payload.account.length === 0 || payload.account.length > 256) {
    return null;
  }
  if (typeof payload.agentId !== 'string' || payload.agentId.length === 0 || payload.agentId.length > 256) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'parent')) return null;
  if (payload.parent !== null && (typeof payload.parent !== 'string' || payload.parent.length === 0 || payload.parent.length > 256)) {
    return null;
  }
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return null;
  if (payload.exp - payload.iat <= 0 || payload.exp - payload.iat > SOUL_TOKEN_TTL_SECONDS) return null;
  if (!canonicalNonce(payload.nonce)) return null;
  if (nowSeconds < payload.iat || nowSeconds >= payload.exp) return null;
  return payload;
}
