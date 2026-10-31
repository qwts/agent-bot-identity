// agent-machine client (#1254): the local control-plane client to
// managed-machine's daemon. One signed JSON line out, one signed JSON line
// back over a unix socket (Windows: a named pipe). The wire protocol is
// managed-machine's internal/daemon/protocol.go: requests sign the
// newline-joined verb..nonce fields, responses sign ok..request_nonce.
// The agent-daemon Ed25519 key lives under the identity vouch custody
// (0600 / Windows owned ACL); the agent-machine response key is pinned at
// pair time so a swapped daemon.pub is refused.
import { createHash, createPrivateKey as createPrivateKeySync, randomBytes, sign as edSign, verify as edVerify, createPublicKey } from 'node:crypto';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { loadOrCreateVouchKey, loadVouchKey, vouchKeyPath, vouchStateDir } from './identity-host.mjs';

// Same 12-byte Ed25519 SPKI DER prefix as identity/keyd-client.mjs
// ED25519_SPKI_PREFIX — keyd-client is identity module and host may not
// import it directly, so the constant is duplicated here by design.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const REQUEST_FIELDS = ['verb', 'name', 'option', 'target', 'plan_id', 'soul', 'harness', 'session_id'];
const VERBS = new Set(['status', 'receipts', 'plan', 'apply', 'update', 'catalog']);
const SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;
const SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

export const AGENT_MACHINE_DIR = (home = homedir()) => path.join(home, '.config', 'agent-machine');
export const machineSocketPath = ({ home = homedir(), platform = process.platform } = {}) =>
  platform === 'win32' ? '\\\\.\\pipe\\agent-machine' : path.join(AGENT_MACHINE_DIR(home), 'daemon.sock');

function mcError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

export function machineStateDir({ env = process.env, home = homedir() } = {}) {
  return path.join(vouchStateDir({ env, home }), 'agent-machine');
}

export function loadOrCreateMachineKey({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  // loadOrCreateVouchKey owns directory custody itself: a pre-created
  // directory here would keep an inherited ACL on Windows.
  const key = loadOrCreateVouchKey(machineStateDir({ env, home }), { platform });
  const der = key.publicKey.export({ type: 'spki', format: 'der' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) {
    throw mcError('machine-reply-invalid', 'the machine client key is not a raw Ed25519 SPKI export');
  }
  const publicKeyRaw = Buffer.from(der.subarray(12));
  return { publicKeyRaw, sign: (bytes) => edSign(null, bytes, key.privateKey) };
}

// Load-only signer for read surfaces: uses the key when it exists, never
// creates it. Windows reports presence only (custody ACL owns the file).
export function loadMachineSigner({ env = process.env, home = homedir(), platform = process.platform, custody = null } = {}) {
  const file = vouchKeyPath(machineStateDir({ env, home }));
  if (!existsSync(file)) return null;
  // The file exists, so the custody read never creates state — vouch's own
  // checks (O_NOFOLLOW / owner / regular file; ACL custody on win32).
  const key = loadVouchKey(machineStateDir({ env, home }), { platform, custody });
  if (key === null) return null;
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) return null;
  return { publicKeyRaw: Buffer.from(der.subarray(12)), sign: (bytes) => edSign(null, bytes, key) };
}

// Read-only probe for `agent-bot machine status`: reports the key's public
// half without ever creating one. On Windows the custody ACL keeps the key
// unreadable without the vouch plumbing, so only presence is reported.
export function loadMachinePublicKey({ env = process.env, home = homedir(), platform = process.platform, custody = null } = {}) {
  const file = vouchKeyPath(machineStateDir({ env, home }));
  if (!existsSync(file)) return null;
  const key = loadVouchKey(machineStateDir({ env, home }), { platform, custody });
  if (key === null) return null;
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) return null;
  return Buffer.from(der.subarray(12));
}

export function requestCanonical(r) {
  const base = REQUEST_FIELDS.map((f) => r[f] ?? '').join('\n') + '\n' + String(r.timestamp) + '\n' + r.nonce;
  // The catalog verb's eleventh part (catalogCanonical, protocol.go): only
  // when any catalog field is present, joined key\nfloor\nenvelope.
  if (r.catalog_key || r.floor || r.envelope) {
    const key = r.catalog_key ? `${r.catalog_key.public_key}\n${r.catalog_key.key_id}` : '';
    const floor = r.floor ? `${r.floor.key_id}\n${r.floor.min_version}` : '';
    const env = r.envelope ? [r.envelope.format, r.envelope.key_id, String(r.envelope.version), String(r.envelope.issued_at), r.envelope.catalog, r.envelope.sig].join('\n') : '';
    return Buffer.from(`${base}\n${[key, floor, env].join('\n')}`);
  }
  return Buffer.from(base);
}

// The catalog verb relays a signed agent-bot catalog: it carries only
// catalog_key, floor and envelope — no soul/harness/session or op fields —
// and its canonical signature gains one more line-joined part
// (catalogCanonical in managed-machine internal/daemon/protocol.go).
export function buildRequest({ verb, name, option, target, plan_id, soul, harness, session_id, catalog_key = null, floor = null, envelope = null }, signer, { now = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('base64url') } = {}) {
  if (!VERBS.has(verb)) throw mcError('machine-verb-unknown', `verb is not one of ${[...VERBS].join(', ')}`);
  const catalogFields = { catalog_key, floor, envelope };
  const hasCatalog = catalog_key !== null || floor !== null || envelope !== null;
  if (verb === 'catalog' && [name, option, target, plan_id, soul, harness, session_id].some((v) => v !== undefined)) {
    throw mcError('machine-field-invalid', 'catalog carries only catalog_key, floor and envelope');
  }
  if (verb !== 'catalog' && hasCatalog) {
    throw mcError('machine-field-invalid', 'catalog fields belong only to the catalog verb');
  }
  for (const [field, value] of Object.entries({ name, option, target, plan_id })) {
    if (value !== undefined && (typeof value !== 'string' || !SHAPE.test(value))) {
      throw mcError('machine-field-invalid', `${field} fails the wire shape`);
    }
  }
  const request = { verb };
  for (const f of REQUEST_FIELDS.slice(1)) {
    const v = { name, option, target, plan_id, soul, harness, session_id }[f];
    if (v) request[f] = v;
  }
  if (hasCatalog) {
    // Never send raw nulls: a null catalog field is refused on any verb.
    if (catalog_key !== null) request.catalog_key = catalog_key;
    if (floor !== null) request.floor = floor;
    if (envelope !== null) request.envelope = envelope;
  }
  request.timestamp = now;
  request.nonce = nonce;
  request.public_key = signer.publicKeyRaw.toString('base64');
  request.signature = signer.sign(requestCanonical(request)).toString('base64');
  return request;
}

// The response signature covers the raw bytes of the body value exactly as
// they appear on the line. Walk the top-level object — never regex-search —
// so a "body" string inside another value cannot be mistaken for the key:
// for each member, skip whitespace, read the key string honouring escapes,
// skip its value with the depth/string scanner, and return the span only
// when the unescaped key is exactly `body`.
export function bodySpan(line) {
  const text = typeof line === 'string' ? line : line.toString('utf8');
  const skipWs = (i) => { while (i < text.length && /\s/.test(text[i])) i += 1; return i; };
  const readString = (i) => { // i at opening quote → { key, end } past closing quote
    let value = '', j = i + 1;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { value += c + (text[j + 1] ?? ''); j += 2; continue; }
      if (c === '"') return { value: unescapeJson(value), end: j + 1 };
      value += c; j += 1;
    }
    return { value, end: j };
  };
  const skipValue = (i) => {
    let depth = 0, inString = false, escaped = false;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\' && inString) { escaped = true; continue; }
      if (c === '"') inString = !inString;
      if (inString) continue;
      if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') {
        if (depth === 0) return i;
        depth -= 1;
        if (depth === 0) return i + 1;
      } else if (depth === 0 && c === ',') return i;
    }
    return i;
  };
  let i = skipWs(text.indexOf('{') >= 0 ? text.indexOf('{') + 1 : 0);
  while (i < text.length && text[i] !== '}') {
    if (text[i] !== '"') break;
    const { value: key, end } = readString(i);
    i = skipWs(skipWs(end) + 1); // past the colon
    const vEnd = skipValue(i);
    if (key === 'body') return Buffer.from(text.slice(i, vEnd), 'utf8');
    i = skipWs(vEnd);
    if (text[i] === ',') i = skipWs(i + 1);
  }
  return null;
}

function unescapeJson(value) {
  try { return JSON.parse(`"${value}"`); } catch { return value; }
}

export function responseCanonical(res, bodyRaw) {
  return Buffer.from([
    String(res.ok), res.diagnostic ?? '', res.message ?? '', res.state ?? '',
    bodyRaw ? bodyRaw.toString('utf8') : '',
    String(res.timestamp), res.nonce ?? '', res.request_nonce ?? '',
  ].join('\n'));
}

export function verifyResponse(line, pinnedPublicKeyRaw, { expectedNonce, now = Date.now() } = {}) {
  const raw = typeof line === 'string' ? line : line.toString('utf8');
  const res = JSON.parse(raw.trimEnd());
  if (typeof res.signature !== 'string' || typeof res.timestamp !== 'number') {
    throw mcError('machine-reply-invalid', 'the agent-machine reply is unsigned');
  }
  const bodyRaw = bodySpan(raw);
  let ok;
  try {
    const pub = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pinnedPublicKeyRaw]), format: 'der', type: 'spki' });
    ok = edVerify(null, responseCanonical(res, bodyRaw), pub, Buffer.from(res.signature, 'base64'));
  } catch { ok = false; }
  if (!ok) throw mcError('machine-reply-tampered', 'the agent-machine reply signature does not match the pinned key');
  const skew = Math.abs(now - res.timestamp * 1000);
  if (skew > SKEW_MS) throw mcError('machine-reply-stale', 'the agent-machine reply timestamp is outside the allowed window');
  // A captured old reply verifies cryptographically but is not this
  // request's answer (#410): the signed request_nonce must echo ours,
  // and a caller that cannot name its nonce gets no reply at all.
  if (res.request_nonce !== expectedNonce) {
    throw mcError('machine-reply-unbound', 'the agent-machine reply is not bound to this request');
  }
  return { ok: res.ok, state: res.state ?? null, diagnostic: res.diagnostic ?? null, message: res.message ?? null, body: res.body ?? null };
}

export function machineCall({ socketPath, request, timeoutMs = DEFAULT_TIMEOUT_MS, connectImpl = connect } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connectImpl(socketPath);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(mcError('machine-timeout', 'agent-machine did not answer in time')); }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      // 0x0a never appears inside a UTF-8 multibyte sequence, so the raw-byte
      // scan is safe and the line decodes whole — a chunk boundary inside a
      // character must not split it. agent-machine's own maxMessage caps a
      // message at 64 KiB; anything larger is refused rather than buffered.
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 64 * 1024) {
        clearTimeout(timer);
        socket.destroy();
        reject(mcError('machine-reply-invalid', 'the agent-machine reply exceeds the 64 KiB message cap'));
        return;
      }
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(buf.subarray(0, nl).toString('utf8'));
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(mcError('machine-unreachable', `agent-machine socket failed: ${error.code ?? error.message}`)); });
  });
}

export async function machineRoundTrip({ verb, fields = {}, signer, socketPath, timeoutMs, now } = {}) {
  const request = buildRequest({ verb, ...fields }, signer, now ? { now } : {});
  const line = await machineCall({ socketPath, request, timeoutMs });
  return { request, reply: line };
}

// --- Pairing files (owner-only; see cli machine pair) ---

const PAIRING_CLIENTS = ['terminal', 'agent-daemon'];
const PAIRING_SUFFIXES = ['.pub', '.next', '.confirm', '.revoked'];
const LEGACY_PEER = ['peer.pub', 'peer.next', 'peer.confirm', 'peer.revoked'];

export function pinPath({ env = process.env, home = homedir() } = {}) {
  return path.join(machineStateDir({ env, home }), 'daemon.pub.pin');
}

export function daemonFingerprint(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

export function assertPairingLayout(dir) {
  for (const name of LEGACY_PEER) {
    if (existsSync(path.join(dir, name))) {
      throw mcError('machine-legacy-peers', `${name} exists beside peers/: agent-machine has not run since the pairing layout moved — start it (managed-machine daemon install / restart) before pairing`);
    }
  }
  const peers = path.join(dir, 'peers');
  if (!existsSync(peers)) return;
  const allowed = new Set(PAIRING_CLIENTS.flatMap((c) => PAIRING_SUFFIXES.map((s) => c + s)));
  for (const entry of readdirSync(peers, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isDirectory()) {
      throw mcError('machine-peers-invalid', `peers/${entry.name} is not a client key file — agent-machine would refuse to start`);
    }
  }
}
// Atomic 0600 write: temp file lives in `dir`'s parent area, not inside a
// directory agent-machine refuses unknown names in (peers/).
export function atomicWrite0600(file, content, { tempDir = path.dirname(file) } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(tempDir, `.tmp-${randomBytes(8).toString('hex')}`);
  writeFileSync(temp, content, { mode: 0o600 });
  try { renameSync(temp, file); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

export function pinDaemonPub({ env = process.env, home = homedir(), repin = false, now } = {}) {
  const dir = AGENT_MACHINE_DIR(home);
  const pubFile = path.join(dir, 'daemon.pub');
  if (!existsSync(pubFile)) throw mcError('machine-not-running', `${pubFile} does not exist — start agent-machine first (managed-machine daemon install)`);
  const pub = readFileSync(pubFile);
  if (pub.length !== 32) throw mcError('machine-reply-invalid', `${pubFile} is not a raw 32-byte Ed25519 key`);
  const pin = pinPath({ env, home });
  const old = existsSync(pin) ? readFileSync(pin) : null;
  if (old && !old.equals(pub) && !repin) {
    throw mcError('machine-pin-mismatch', `agent-machine's key changed (old ${daemonFingerprint(old)}, new ${daemonFingerprint(pub)}) — re-pair with --repin to accept`);
  }
  const oldFp = old && !old.equals(pub) ? daemonFingerprint(old) : null;
  mkdirSync(path.dirname(pin), { recursive: true, mode: 0o700 });
  atomicWrite0600(pin, pub);
  return { publicKeyRaw: pub, fingerprint: daemonFingerprint(pub), replaced: oldFp };
}

export function writeAgentDaemonPeer({ home = homedir(), publicKeyRaw }) {
  const dir = AGENT_MACHINE_DIR(home);
  assertPairingLayout(dir);
  const peers = path.join(dir, 'peers');
  mkdirSync(peers, { recursive: true, mode: 0o700 });
  atomicWrite0600(path.join(peers, 'agent-daemon.next'), publicKeyRaw, { tempDir: dir });
  atomicWrite0600(path.join(peers, 'agent-daemon.confirm'), createHash('sha256').update(publicKeyRaw).digest('hex'), { tempDir: dir });
}

export function unpairAgentDaemon({ env = process.env, home = homedir() } = {}) {
  const dir = AGENT_MACHINE_DIR(home);
  assertPairingLayout(dir);
  const peers = path.join(dir, 'peers');
  mkdirSync(peers, { recursive: true, mode: 0o700 });
  atomicWrite0600(path.join(peers, 'agent-daemon.revoked'), Buffer.alloc(0), { tempDir: dir });
  rmSync(pinPath({ env, home }), { force: true });
}

export function pairedPublicKey({ env = process.env, home = homedir() } = {}) {
  const pin = pinPath({ env, home });
  if (!existsSync(pin)) throw mcError('machine-not-paired', 'agent-machine is not paired — run agent-bot machine pair');
  const pub = readFileSync(pin);
  const live = path.join(AGENT_MACHINE_DIR(home), 'daemon.pub');
  if (existsSync(live) && !readFileSync(live).equals(pub)) {
    throw mcError('machine-pin-mismatch', 'agent-machine daemon.pub differs from the pinned key — re-pair with --repin');
  }
  return pub;
}
