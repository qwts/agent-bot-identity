import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CommsClient } from '../comms-client.mjs';
import { isWindowsRelayFailure, readWindowsBrokerPin } from '../comms-windows.mjs';
import { createWindowsAccountCustody } from '../windows-account-custody.mjs';
import { loadOrCreateVouchKey } from '../vouch.mjs';

function lineReader(stream) {
  let buffer = '';
  const queued = [];
  const waiting = [];
  let failure = null;
  const fail = () => {
    failure = new Error('native named-pipe fixture process ended before its marker');
    for (const waiter of waiting.splice(0)) waiter.reject(failure);
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(line);
      else queued.push(line);
    }
  });
  stream.on('error', fail);
  stream.on('end', fail);
  const next = () => {
    if (queued.length) return Promise.resolve(queued.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  next.fail = fail;
  return next;
}

function beforeDeadline(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 10_000); }),
  ]).finally(() => clearTimeout(timer));
}

async function nextMarkerBeforeProof(serverOutput, pendingRequest, description, message) {
  const event = await beforeDeadline(Promise.race([
    serverOutput().then((line) => ({ type: 'marker', line })),
    pendingRequest.then(
      () => ({ type: 'request-complete' }),
      (error) => ({ type: 'request-error', code: error?.code, relayFailure: error?.relayFailure }),
    ),
  ]), message);
  if (event.type === 'request-error') {
    const code = typeof event.code === 'string' && /^[a-z0-9-]{1,48}$/i.test(event.code)
      ? ` (${event.code})`
      : '';
    const relayFailure = isWindowsRelayFailure(event.relayFailure)
      ? event.relayFailure.stage === 'compile'
        ? ` [relay=${event.relayFailure.stage}/${event.relayFailure.code}]`
        : event.relayFailure.stage === 'host-stderr'
          ? ` [relay=${event.relayFailure.stage}/${event.relayFailure.format}/${event.relayFailure.reason}]`
          : event.relayFailure.stage === 'host-process'
            ? ` [relay=${event.relayFailure.stage}/${event.relayFailure.event}]`
            : ` [relay=${event.relayFailure.stage}/${event.relayFailure.exception}/${event.relayFailure.hresult}]`
      : '';
    throw new Error(`CommsClient request failed before ${description}${code}${relayFailure}`);
  }
  assert.equal(event.type, 'marker', `CommsClient request completed before ${description}`);
  return event.line;
}

async function expectMarkerBeforeProof(serverOutput, pendingRequest, expected, message) {
  const actual = await nextMarkerBeforeProof(serverOutput, pendingRequest, expected, message);
  assert.equal(actual, expected, `native server expected ${expected}`);
}

test('Windows native custody and named-pipe preflight uses disposable state', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-bot-windows-native-'));
  const previousRelayDiagnostics = process.env.AGENT_BOT_WINDOWS_RELAY_DIAGNOSTICS;
  let pipeServer = null;
  let serverClosePromise = null;
  let serverOutput = null;
  let pipe;
  let brokerPrivateKey;
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
    custody.createOwnedDirectory(brokerStateDir, sid);
    const brokerIdentityFile = path.join(brokerStateDir, 'identity.json');
    custody.createPrivateFile(brokerIdentityFile, sid);
    const brokerIdentity = `${JSON.stringify({ v: 1, algorithm: 'ed25519', publicKey: brokerKey })}\n`;
    writeFileSync(brokerIdentityFile, brokerIdentity, { flag: 'w' });
    assert.throws(() => custody.createPrivateFile(brokerIdentityFile, sid), (error) => error?.code === 'EEXIST');
    assert.equal(readFileSync(brokerIdentityFile, 'utf8'), brokerIdentity, 'exclusive creation changed existing identity bytes');
    custody.assertOwnedDirectory(brokerStateDir, sid);
    custody.assertOwnedFile(brokerIdentityFile, sid);
    custody.restrictPrivateFile(brokerIdentityFile, sid);
    assert.equal(readWindowsBrokerPin({ brokerStateDir, brokerUid: sid, custody }), brokerKey);

    const label = `agent-bot-preflight-${process.pid}-${Date.now()}`;
    pipe = `\\\\.\\pipe\\${label}.${sid}`;
    const nativePipeName = `${label}.${sid}`;
    const serverScript = [
      "$ErrorActionPreference = 'Stop'",
      "$phase = 'server-create'",
      'try {',
      `  $pipeName = '${nativePipeName}'`,
      '  $server = [System.IO.Pipes.NamedPipeServerStream]::new($pipeName, [System.IO.Pipes.PipeDirection]::InOut, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::None)',
      "  [Console]::Out.WriteLine('READY')",
      "  $phase = 'connect'",
      '  $server.WaitForConnection()',
      "  [Console]::Out.WriteLine('CONNECTED')",
      "  $phase = 'stream-setup'",
      '  $reader = [System.IO.StreamReader]::new($server, [System.Text.Encoding]::UTF8, $false, 1024, $true)',
      '  $writer = [System.IO.StreamWriter]::new($server, [System.Text.UTF8Encoding]::new($false), 1024, $true)',
      '  $writer.AutoFlush = $true',
      "  $phase = 'hello'",
      '  $hello = ConvertFrom-Json -InputObject $reader.ReadLine()',
      "  if ($hello.v -ne 1 -or $hello.hello -notmatch '^[0-9a-f]{64}$') { throw 'invalid hello' }",
      "  [Console]::Out.WriteLine('HELLO')",
      "  $phase = 'impersonation-level'",
      '  $worker = [System.IO.Pipes.PipeStreamImpersonationWorker] { [Console]::Out.WriteLine((\'LEVEL=\' + [System.Security.Principal.WindowsIdentity]::GetCurrent().ImpersonationLevel.ToString())) }',
      '  $server.RunAsClient($worker)',
      "  [Console]::Out.WriteLine(('CHALLENGE=' + $hello.hello))",
      "  $phase = 'broker-proof'",
      '  $proof = [Console]::In.ReadLine()',
      '  if ([string]::IsNullOrEmpty($proof)) { throw \'missing proof\' }',
      '  $writer.WriteLine($proof)',
      "  $phase = 'request'",
      '  $request = ConvertFrom-Json -InputObject $reader.ReadLine()',
      "  if ($request.v -ne 1 -or $request.op -ne 'preflight') { throw 'invalid request' }",
      "  $response = @{ v = 1; id = $request.id; ok = $true; accepted = 'preflight' } | ConvertTo-Json -Compress",
      '  $writer.WriteLine($response)',
      "  [Console]::Out.WriteLine('REQUEST_OK')",
      '} catch {',
      "  [Console]::Out.WriteLine(('FAILED=' + $phase))",
      '  exit 1',
      '} finally {',
      '  if ($null -ne $reader) { $reader.Dispose() }',
      '  if ($null -ne $writer) { $writer.Dispose() }',
      '  if ($null -ne $server) { $server.Dispose() }',
      '}',
      '',
    ].join('\n');
    const serverEnvNames = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']);
    const cleanServerEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => serverEnvNames.has(name.toUpperCase())),
    );
    pipeServer = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(serverScript, 'utf16le').toString('base64'),
    ], { env: cleanServerEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    serverClosePromise = new Promise((resolve) => pipeServer.once('close', resolve));
    serverOutput = lineReader(pipeServer.stdout);
    pipeServer.once('error', () => serverOutput.fail());
    assert.equal(await beforeDeadline(serverOutput(), 'native named-pipe fixture did not become ready'), 'READY');

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
    process.env.AGENT_BOT_WINDOWS_RELAY_DIAGNOSTICS = '1';
    const pendingRequest = client.request({ op: 'preflight' });
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'CONNECTED', 'native server did not accept the pipe connection');
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'HELLO', 'native server did not read the client hello');
    const levelMarker = await nextMarkerBeforeProof(
      serverOutput,
      pendingRequest,
      'impersonation-level marker',
      'native named-pipe server did not report client impersonation level',
    );
    assert.ok(['LEVEL=Anonymous', 'LEVEL=Identification'].includes(levelMarker), 'native named-pipe server may not impersonate the client');
    const challenge = await beforeDeadline(serverOutput(), 'native named-pipe server did not report a handshake challenge');
    const challengeMatch = /^CHALLENGE=([0-9a-f]{64})$/.exec(challenge);
    assert.ok(challengeMatch, 'native named-pipe server returned an invalid challenge marker');
    // Independently spell out the signed wire contract; the test must catch
    // drift between the production client's transcript and the fixture.
    const transcript = Buffer.from(`agent-comms broker handshake v1\n${pipe}\n${challengeMatch[1]}\n`, 'utf8');
    const proof = sign(null, transcript, brokerPrivateKey).toString('base64');
    pipeServer.stdin.write(`${JSON.stringify({ v: 1, proof })}\n`);
    const reply = await pendingRequest;
    assert.equal(reply.accepted, 'preflight');
    assert.equal(await beforeDeadline(serverOutput(), 'native named-pipe fixture did not complete the request'), 'REQUEST_OK');
  } finally {
    if (previousRelayDiagnostics === undefined) delete process.env.AGENT_BOT_WINDOWS_RELAY_DIAGNOSTICS;
    else process.env.AGENT_BOT_WINDOWS_RELAY_DIAGNOSTICS = previousRelayDiagnostics;
    if (pipeServer && !pipeServer.closed) {
      if (pipeServer.pid) pipeServer.kill();
      await serverClosePromise;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
