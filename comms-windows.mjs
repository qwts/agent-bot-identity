// Windows local transport for the agent-comms v1 broker wire contract.
// Keep this bot-owned adapter independent of the agent-comms checkout.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { createWindowsAccountCustody, isWindowsSid } from './windows-account-custody.mjs';

export const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';
export const WINDOWS_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_LINE_BYTES = 128 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const windowsPipeName = (label, sid) => `${WINDOWS_PIPE_PREFIX}${label}.${sid}`;
export const windowsHandshakeMessage = (pipe, nonce) => Buffer.from(
  `agent-comms broker handshake v1\n${pipe}\n${nonce}\n`, 'utf8',
);

export const createWindowsTransportCustody = createWindowsAccountCustody;
export { isWindowsSid };

export function assertWindowsBrokerCustody({ brokerStateDir, brokerUid, mode, custody = createWindowsAccountCustody() } = {}) {
  if (mode !== 'single-account') throw Object.assign(new Error('group broker mode is not supported on Windows'), { code: 'platform-not-implemented' });
  let sid;
  try {
    sid = custody.currentSid();
    if (!isWindowsSid(sid) || brokerUid !== sid) throw new Error('sid');
    custody.assertOwnedDirectory(brokerStateDir, sid);
    custody.assertOwnedFile(path.join(brokerStateDir, 'identity.json'), sid);
  } catch {
    throw Object.assign(new Error('the Windows broker identity is not owned by this account'), { code: 'broker-untrusted' });
  }
  return sid;
}

export function isWindowsBrokerKey(value) {
  if (typeof value !== 'string' || !BASE64.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value
      && createPublicKey({ key: bytes, format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function publicKeyFrom(identityFile) {
  let identity;
  try {
    identity = JSON.parse(readFileSync(identityFile, 'utf8'));
    if (identity?.v !== 1 || identity?.algorithm !== 'ed25519'
      || typeof identity.publicKey !== 'string' || !BASE64.test(identity.publicKey)) throw new Error('shape');
    const bytes = Buffer.from(identity.publicKey, 'base64');
    if (bytes.toString('base64') !== identity.publicKey) throw new Error('encoding');
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('algorithm');
    return identity.publicKey;
  } catch {
    throw Object.assign(new Error('the broker identity is invalid; pair again'), { code: 'broker-untrusted' });
  }
}

function frameLine(value) {
  return `${JSON.stringify(value)}\n`;
}

// Returns a socket-like Duplex that reports connect only after validating the
// broker's proof. Any writes made before proof are queued and never reach the
// pipe unless the pinned key proves the exact pipe and nonce.
export function createWindowsCommsTransport({
  label,
  brokerStateDir,
  brokerUid,
  brokerKey,
  custody = createWindowsAccountCustody(),
  createConnection = net.createConnection,
  randomNonce = () => randomBytes(32).toString('hex'),
  handshakeTimeoutMs = WINDOWS_HANDSHAKE_TIMEOUT_MS,
} = {}) {
  let sid;
  try {
    if (typeof label !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(label)) throw new Error('label');
    sid = assertWindowsBrokerCustody({ brokerStateDir, brokerUid, mode: 'single-account', custody });
    if (brokerKey !== undefined) {
      if (typeof brokerKey !== 'string' || !BASE64.test(brokerKey)) throw new Error('pin');
      const key = createPublicKey({ key: Buffer.from(brokerKey, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('pin');
    }
  } catch {
    throw Object.assign(new Error('the saved broker identity is not trusted; pair again'), { code: 'broker-untrusted' });
  }
  if (brokerKey === undefined) {
    throw Object.assign(new Error('no broker key is pinned for this client; pair again'), { code: 'broker-untrusted' });
  }

  const pipe = windowsPipeName(label, sid);
  const nonce = randomNonce();
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) {
    throw Object.assign(new Error('could not create a broker handshake nonce'), { code: 'broker-untrusted' });
  }
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(brokerKey, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw Object.assign(new Error('the pinned broker key is invalid; pair again'), { code: 'broker-untrusted' });
  }

  let raw;
  try {
    raw = createConnection(pipe);
  } catch (error) {
    throw Object.assign(new Error(`cannot reach the broker: ${error?.code ?? error?.message ?? 'pipe connection failed'}`), {
      code: 'broker-unreachable',
    });
  }
  let channel;
  let timer;
  let verified = false;
  let closed = false;
  let head = Buffer.alloc(0);
  const queued = [];
  channel = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      if (verified) raw.write(chunk, encoding, callback);
      else queued.push([chunk, encoding, callback]);
    },
    final(callback) {
      if (verified) raw.end(callback);
      else callback();
    },
    destroy(error, callback) {
      closed = true;
      clearTimeout(timer);
      raw.destroy();
      callback(error);
    },
  });
  const reject = (error) => {
    if (closed) return;
    channel.destroy(error);
  };
  const onProof = (chunk) => {
    if (closed) return;
    head = Buffer.concat([head, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (head.length > MAX_LINE_BYTES && head.indexOf(0x0a) === -1) {
      reject(Object.assign(new Error('the broker did not answer the handshake'), { code: 'bad-response' }));
      return;
    }
    const newline = head.indexOf(0x0a);
    if (newline === -1) return;
    const rawLine = head.subarray(0, newline);
    if (rawLine.length > MAX_LINE_BYTES) {
      reject(Object.assign(new Error('the broker handshake exceeds the protocol limit'), { code: 'bad-response' }));
      return;
    }
    let answer;
    let signature;
    try {
      answer = JSON.parse(rawLine.toString('utf8'));
      if (answer?.v !== 1 || typeof answer.proof !== 'string' || !BASE64.test(answer.proof)) throw new Error('frame');
      signature = Buffer.from(answer.proof, 'base64');
      if (!signature.length || signature.toString('base64') !== answer.proof) throw new Error('encoding');
    } catch {
      reject(Object.assign(new Error('the broker sent an invalid handshake proof'), { code: 'broker-untrusted' }));
      return;
    }
    if (!verify(null, windowsHandshakeMessage(pipe, nonce), key, signature)) {
      reject(Object.assign(new Error('the broker did not prove it holds the pinned key'), { code: 'broker-untrusted' }));
      return;
    }
    verified = true;
    clearTimeout(timer);
    raw.removeListener('data', onProof);
    raw.on('data', (data) => channel.push(data));
    const remainder = head.subarray(newline + 1);
    if (remainder.length) channel.push(remainder);
    for (const [queuedChunk, encoding, callback] of queued.splice(0)) raw.write(queuedChunk, encoding, callback);
    if (channel.writableEnded) raw.end();
    channel.emit('connect');
  };
  const ended = () => {
    if (closed) return;
    if (!verified) reject(Object.assign(new Error('the broker closed before proving its identity'), { code: 'broker-unreachable' }));
    else channel.push(null);
  };
  timer = setTimeout(() => reject(Object.assign(new Error('broker handshake timed out'), { code: 'broker-timeout' })), handshakeTimeoutMs);
  raw.on('connect', () => raw.write(frameLine({ v: 1, hello: nonce })));
  raw.on('data', onProof);
  raw.on('error', (error) => reject(Object.assign(new Error(`cannot reach the broker: ${error.code ?? error.message}`), { code: 'broker-unreachable' })));
  raw.on('end', ended);
  raw.on('close', ended);
  return channel;
}

export function readWindowsBrokerPin({ brokerStateDir, brokerUid, custody = createWindowsAccountCustody() } = {}) {
  let sid;
  try {
    sid = assertWindowsBrokerCustody({ brokerStateDir, brokerUid, mode: 'single-account', custody });
  } catch {
    throw Object.assign(new Error('the broker state directory is not owned by this account'), { code: 'broker-untrusted' });
  }
  const identityFile = path.join(brokerStateDir, 'identity.json');
  return publicKeyFrom(identityFile);
}
