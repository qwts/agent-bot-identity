import { createHash } from 'node:crypto';

const MAX_FRAME = 64 * 1024;
// RFC 6455 5.5: control frames carry at most 125 bytes.
const MAX_CONTROL = 125;

export class WarmPool {
  #agents = new Map();

  add(agentId, socket) {
    let sockets = this.#agents.get(agentId);
    if (!sockets) this.#agents.set(agentId, sockets = new Set());
    sockets.add(socket);
  }

  remove(agentId, socket) {
    const sockets = this.#agents.get(agentId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.#agents.delete(agentId);
  }

  has(agentId) { return (this.#agents.get(agentId)?.size ?? 0) > 0; }

  send(agentId, frame) {
    let delivered = 0;
    const text = Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame));
    // Refused before any socket sees it: an oversized frame is a sender bug,
    // not a reason to desynchronize every listener.
    if (text.length > MAX_FRAME) throw new Error(`wake frame of ${text.length} bytes exceeds ${MAX_FRAME}`);
    for (const socket of this.#agents.get(agentId) ?? []) {
      if (socket.destroyed || !socket.writable) continue;
      try { writeFrame(socket, 0x1, text); delivered++; }
      catch { socket.destroy(); }
    }
    return delivered;
  }

  list() {
    return Object.fromEntries([...this.#agents].map(([id, sockets]) => [id, sockets.size]));
  }
}

function writeFrame(socket, opcode, data = '') {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (payload.length > 0xffff) throw new Error('frame too large for this encoder');
  const head = payload.length < 126
    ? Buffer.from([0x80 | opcode, payload.length])
    : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
  socket.write(Buffer.concat([head, payload]));
}

// Send a close frame, then destroy the socket if the peer has not closed
// it within a second, so a dead peer cannot linger in the warm pool.
function closeSocket(socket, code = 1000) {
  if (socket.destroyed) return;
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code);
  try { writeFrame(socket, 0x8, body); } catch { /* already broken */ }
  socket.end();
  setTimeout(() => socket.destroy(), 1000).unref?.();
}

function bindingProtocol(value) {
  return String(value ?? '').split(',').map((part) => part.trim())
    .find((part) => part.startsWith('agent-binding.')) ?? null;
}

export function attachWakeEndpoint(server, { lookupBinding, pingIntervalMs = 30_000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const warmPool = new WarmPool();
  server.on('upgrade', (req, socket, head) => {
    // Node hands the upgrade socket over with no error listener. A peer that
    // resets while a refusal is being written must not crash the daemon.
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/v0/wake') { socket.destroy(); return; }
    if (req.method !== 'GET') { socket.end('HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    let binding;
    // A browser cannot set headers, so the secret may ride as the subprotocol
    // `agent-binding.<secret>`; a compliant client then needs it echoed.
    const protocol = req.headers['x-agent-binding'] ? null : bindingProtocol(req.headers['sec-websocket-protocol']);
    try { binding = lookupBinding(req.headers['x-agent-binding'] || protocol?.slice('agent-binding.'.length) || ''); }
    catch { binding = null; }
    if (!binding) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const echoed = protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '';
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${echoed}\r\n`);
    const agentId = binding.agentId;
    warmPool.add(agentId, socket);
    let buffered = Buffer.alloc(0);
    let missedPongs = 0;
    let awaitingPong = false;
    // A frame this endpoint refuses ends the read side for good: nothing more
    // is buffered from a peer that broke the protocol.
    const refuse = (code) => {
      socket.off('data', onData);
      buffered = Buffer.alloc(0);
      closeSocket(socket, code);
    };
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      // One frame plus its largest header is the most worth holding.
      if (buffered.length > MAX_FRAME + 14) { refuse(1009); return; }
      while (buffered.length >= 2) {
        const first = buffered[0], second = buffered[1];
        const fin = !!(first & 0x80), opcode = first & 0x0f, masked = !!(second & 0x80);
        let length = second & 0x7f, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        else if (length === 127) { refuse(1009); return; }
        if (length > MAX_FRAME) { refuse(1009); return; }
        // RFC 6455 5.1: a server must fail the connection on an unmasked frame.
        if (!masked) { refuse(1002); return; }
        if (buffered.length < offset + 4 + length) return;
        if (opcode >= 0x8 && length > MAX_CONTROL) { refuse(1002); return; }
        if (!fin || opcode === 0x2 || ![0x1, 0x8, 0x9, 0xa].includes(opcode)) { refuse(1003); return; }
        const mask = buffered.subarray(offset, offset + 4); offset += 4;
        const payload = Buffer.from(buffered.subarray(offset, offset + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buffered = buffered.subarray(offset + length);
        if (opcode === 0x8) { closeSocket(socket); return; }
        if (opcode === 0x9) writeFrame(socket, 0xa, payload);
        if (opcode === 0xa) { awaitingPong = false; missedPongs = 0; }
      }
    };
    socket.on('data', onData);
    // A client may pipeline its first frame with the upgrade request.
    if (head?.length) onData(Buffer.from(head));
    const timer = setIntervalImpl(() => {
      if (awaitingPong && ++missedPongs >= 2) { closeSocket(socket, 1001); return; }
      awaitingPong = true;
      try { writeFrame(socket, 0x9); } catch { socket.destroy(); }
    }, pingIntervalMs);
    timer.unref?.();
    const remove = () => { clearIntervalImpl(timer); warmPool.remove(agentId, socket); };
    // `on`, not `once`: a second error event with no listener would crash the daemon.
    socket.once('close', remove);
    // The HTTP server allows half-open sockets; a client that hangs up must
    // not leave the daemon holding its side open.
    socket.once('end', () => { remove(); socket.destroy(); });
    socket.on('error', () => { remove(); socket.destroy(); });
    warmPool.send(agentId, { event: 'ready', agentId });
  });
  return warmPool;
}
