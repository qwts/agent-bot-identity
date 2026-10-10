import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CommsClient } from '../comms-client.mjs';
import { readWindowsBrokerPin } from '../comms-windows.mjs';
import { createWindowsAccountCustody } from '../windows-account-custody.mjs';
import { loadOrCreateVouchKey } from '../vouch.mjs';

test('Windows native custody and named-pipe preflight uses disposable state', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-bot-windows-native-'));
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let handshaken = false;
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        const message = JSON.parse(line);
        if (!handshaken) {
          handshaken = true;
          assert.equal(message.v, 1);
          assert.match(message.hello, /^[0-9a-f]{64}$/);
          // Intentionally spell out the wire contract here rather than call
          // the client's helper: drift in either side must fail this smoke test.
          const transcript = Buffer.from(
            `agent-comms broker handshake v1\n${pipe}\n${message.hello}\n`,
            'utf8',
          );
          const proof = sign(null, transcript, brokerPrivateKey).toString('base64');
          socket.write(`${JSON.stringify({ v: 1, proof })}\n`);
          continue;
        }

        assert.equal(message.v, 1);
        assert.equal(message.op, 'preflight');
        socket.write(`${JSON.stringify({ v: 1, id: message.id, ok: true, accepted: 'preflight' })}\n`);
      }
    });
  });

  let pipe;
  let brokerPrivateKey;
  let listening = false;
  try {
    const custody = createWindowsAccountCustody();
    const sid = custody.currentSid();
    assert.match(sid, /^S-1-\d+(?:-\d+)+$/);

    const stateDir = path.join(root, 'state', 'agent-bot');
    const created = loadOrCreateVouchKey(stateDir, { platform: 'win32', custody });
    assert.equal(created.created, true);
    custody.assertOwnedDirectory(stateDir, sid);
    custody.assertOwnedFile(created.file, sid);

    const reloaded = loadOrCreateVouchKey(stateDir, { platform: 'win32', custody });
    assert.equal(reloaded.created, false);
    assert.equal(reloaded.publicKeyPem, created.publicKeyPem);

    const pemBeforeAclProbe = readFileSync(created.file);
    const grantEveryoneRead = spawnSync('icacls.exe', [created.file, '/grant', '*S-1-1-0:R'], { stdio: 'ignore' });
    assert.equal(grantEveryoneRead.status, 0, 'could not establish disposable ACL refusal fixture');
    try {
      assert.throws(
        () => loadOrCreateVouchKey(stateDir, { platform: 'win32', custody }),
        /vouch key file custody or private access could not be verified/,
      );
      assert.equal(readFileSync(created.file).equals(pemBeforeAclProbe), true, 'ACL refusal changed vouch key bytes');
    } finally {
      const removeEveryoneGrant = spawnSync('icacls.exe', [created.file, '/remove:g', '*S-1-1-0'], { stdio: 'ignore' });
      assert.equal(removeEveryoneGrant.status, 0, 'could not clean disposable ACL refusal fixture');
    }
    const recovered = loadOrCreateVouchKey(stateDir, { platform: 'win32', custody });
    assert.equal(recovered.publicKeyPem, created.publicKeyPem);
    assert.equal(readFileSync(created.file).equals(pemBeforeAclProbe), true, 'ACL recovery changed vouch key bytes');

    const brokerKeys = generateKeyPairSync('ed25519');
    brokerPrivateKey = brokerKeys.privateKey;
    const brokerPublicKey = brokerKeys.publicKey;
    const brokerKey = brokerPublicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const brokerStateDir = path.join(root, 'broker-state');
    mkdirSync(brokerStateDir);
    const brokerIdentityFile = path.join(brokerStateDir, 'identity.json');
    writeFileSync(brokerIdentityFile, `${JSON.stringify({ v: 1, algorithm: 'ed25519', publicKey: brokerKey })}\n`, { flag: 'wx' });
    custody.assertOwnedDirectory(brokerStateDir, sid);
    custody.assertOwnedFile(brokerIdentityFile, sid);
    custody.restrictPrivateFile(brokerIdentityFile, sid);
    assert.equal(readWindowsBrokerPin({ brokerStateDir, brokerUid: sid, custody }), brokerKey);

    const label = `agent-bot-preflight-${process.pid}-${Date.now()}`;
    pipe = `\\\\.\\pipe\\${label}.${sid}`;

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, () => {
        listening = true;
        resolve();
      });
    });

    const client = new CommsClient({
      socketPath: pipe,
      brokerUid: sid,
      brokerKey,
      brokerStateDir,
      mode: 'single-account',
      platform: 'win32',
      serviceLabel: label,
      windowsCustody: custody,
      timeoutMs: 10_000,
      handshakeTimeoutMs: 10_000,
    });
    const reply = await client.request({ op: 'preflight' });
    assert.equal(reply.accepted, 'preflight');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (listening) await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
