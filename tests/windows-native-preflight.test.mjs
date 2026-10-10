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
      '$provider = $null',
      'try {',
      "  $phase = 'json-preflight'",
      "  $null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')",
      '  $serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()',
      '  $serializer.MaxJsonLength = 131072',
      '  $serializer.RecursionLimit = 16',
      "  $jsonProbe = $serializer.DeserializeObject('{\"v\":1,\"hello\":\"0000000000000000000000000000000000000000000000000000000000000000\"}')",
      "  if ($jsonProbe['v'] -ne 1 -or $jsonProbe['hello'] -notmatch '^[0-9a-f]{64}$') { throw 'invalid JSON preflight' }",
      "  $phase = 'impersonation-preflight'",
      "  $probeSource = @'",
      'using System;',
      'using System.IO.Pipes;',
      'using System.Security.Principal;',
      'public static class AgentBotNativePipeImpersonationProbe {',
      '    public static string ReadLevel(NamedPipeServerStream server) {',
      '        string level = null;',
      '        server.RunAsClient(delegate {',
      '            using (var identity = WindowsIdentity.GetCurrent()) {',
      '                level = identity.ImpersonationLevel.ToString();',
      '            }',
      '        });',
      '        return level;',
      '    }',
      '}',
      "'@",
      "  [Console]::Out.WriteLine('COMPILER_START')",
      "  $provider = [System.CodeDom.Compiler.CodeDomProvider]::CreateProvider('CSharp')",
      '  $compilerParameters = [System.CodeDom.Compiler.CompilerParameters]::new()',
      '  $compilerParameters.GenerateInMemory = $true',
      "  [void]$compilerParameters.ReferencedAssemblies.Add('System.dll')",
      "  [void]$compilerParameters.ReferencedAssemblies.Add('System.Core.dll')",
      '  $compilerResults = $provider.CompileAssemblyFromSource($compilerParameters, [string[]]@($probeSource))',
      "  if ($compilerResults.Errors.HasErrors) { throw 'native impersonation probe compilation failed' }",
      "  $probeType = $compilerResults.CompiledAssembly.GetType('AgentBotNativePipeImpersonationProbe', $true)",
      "  $readLevel = $probeType.GetMethod('ReadLevel')",
      '  $provider.Dispose()',
      '  $provider = $null',
      "  [Console]::Out.WriteLine('COMPILER_READY')",
      "  $phase = 'server-create'",
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
      "  [Console]::Out.WriteLine('STREAMS_READY')",
      "  $phase = 'hello-read'",
      "  [Console]::Out.WriteLine('READING_HELLO')",
      '  $helloBytes = [System.IO.MemoryStream]::new()',
      '  $firstHelloByte = $true',
      '  $helloLineEnded = $false',
      '  while ($helloBytes.Length -lt 131072) {',
      '    $helloByte = $server.ReadByte()',
      '    if ($helloByte -lt 0) { throw \'unexpected end of hello\' }',
      '    if ($helloByte -eq 10) { $helloLineEnded = $true; break }',
      "    if ($firstHelloByte) { [Console]::Out.WriteLine('FIRST_HELLO_BYTE'); $firstHelloByte = $false }",
      '    $helloBytes.WriteByte([byte]$helloByte)',
      '  }',
      "  if (-not $helloLineEnded) { throw 'hello line too long' }",
      "  [Console]::Out.WriteLine('HELLO_LF')",
      '  $helloText = [System.Text.UTF8Encoding]::new($false, $true).GetString($helloBytes.ToArray())',
      "  [Console]::Out.WriteLine('HELLO_DECODED')",
      '  if ($helloText.EndsWith("`r")) { $helloText = $helloText.Substring(0, $helloText.Length - 1) }',
      "  [Console]::Out.WriteLine('HELLO_TRIMMED')",
      '  $hello = $serializer.DeserializeObject($helloText)',
      "  [Console]::Out.WriteLine('HELLO_PARSED')",
      "  if ($hello['v'] -ne 1 -or $hello['hello'] -notmatch '^[0-9a-f]{64}$') { throw 'invalid hello' }",
      "  [Console]::Out.WriteLine('HELLO')",
      "  $phase = 'impersonation-level'",
      '  $level = $readLevel.Invoke($null, [object[]]@($server))',
      "  [Console]::Out.WriteLine(('LEVEL=' + $level))",
      "  [Console]::Out.WriteLine(('CHALLENGE=' + $hello['hello']))",
      "  $phase = 'broker-proof'",
      '  $proof = [Console]::In.ReadLine()',
      '  if ([string]::IsNullOrEmpty($proof)) { throw \'missing proof\' }',
      '  $writer.WriteLine($proof)',
      "  $phase = 'request'",
      '  $request = $serializer.DeserializeObject($reader.ReadLine())',
      "  if ($request['v'] -ne 1 -or $request['op'] -ne 'preflight') { throw 'invalid request' }",
      "  $response = $serializer.Serialize(@{ v = 1; id = $request['id']; ok = $true; accepted = 'preflight' })",
      '  $writer.WriteLine($response)',
      "  [Console]::Out.WriteLine('REQUEST_OK')",
      '} catch {',
      '  $exception = $_.Exception',
      '  for ($depth = 0; $depth -lt 8 -and $null -ne $exception.InnerException; $depth++) { $exception = $exception.InnerException }',
      "  $exceptionType = $exception.GetType().Name",
      "  if ($exceptionType -notmatch '^(Win32Exception|IOException|SecurityException|UnauthorizedAccessException|ArgumentException|InvalidOperationException|MethodInvocationException|TargetInvocationException)$') { $exceptionType = 'Other' }",
      "  $hresult = $exception.HResult.ToString('X8')",
      "  $nativeErrorCode = 'none'",
      '  if ($exception -is [System.ComponentModel.Win32Exception]) { $nativeErrorCode = $exception.NativeErrorCode.ToString(\'X8\') }',
      "  [Console]::Out.WriteLine(('FAILED=' + $phase + '/' + $exceptionType + '/' + $hresult + '/' + $nativeErrorCode))",
      '  exit 1',
      '} finally {',
      '  if ($null -ne $provider) { $provider.Dispose() }',
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
    assert.equal(await beforeDeadline(serverOutput(), 'native fixture did not enter impersonation probe compilation'), 'COMPILER_START');
    assert.equal(await beforeDeadline(serverOutput(), 'native fixture did not finish impersonation probe compilation'), 'COMPILER_READY');
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
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'STREAMS_READY', 'native server did not prepare its streams');
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'READING_HELLO', 'native server did not begin reading the client hello');
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'FIRST_HELLO_BYTE', 'native server received no hello byte');
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'HELLO_LF', 'native server received no hello line feed');
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'HELLO_DECODED', 'native server did not decode the hello line');
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'HELLO_TRIMMED', 'native server did not trim the hello line');
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'HELLO_PARSED', 'native server did not parse the hello JSON');
    await expectMarkerBeforeProof(serverOutput, pendingRequest, 'HELLO', 'native server did not read the client hello');
    const levelMarker = await nextMarkerBeforeProof(
      serverOutput,
      pendingRequest,
      'impersonation-level marker',
      'native named-pipe server did not report client impersonation level',
    );
    const levelMatch = /^LEVEL=(Anonymous|Identification|Impersonation|Delegation|None)$/.exec(levelMarker);
    const failureMatch = /^FAILED=(json-preflight|server-create|connect|stream-setup|hello-read|impersonation-preflight|impersonation-level|broker-proof|request)\/(Win32Exception|IOException|SecurityException|UnauthorizedAccessException|ArgumentException|InvalidOperationException|MethodInvocationException|TargetInvocationException|Other)\/([0-9A-F]{8})\/(none|[0-9A-F]{8})$/.exec(levelMarker);
    if (failureMatch) {
      throw new Error(`native named-pipe fixture failed during ${failureMatch[1]} (${failureMatch[2]}, HRESULT ${failureMatch[3]}, native ${failureMatch[4]})`);
    }
    assert.ok(levelMatch, 'native named-pipe fixture returned an unexpected impersonation marker');
    assert.ok(
      ['Anonymous', 'Identification'].includes(levelMatch[1]),
      `native named-pipe fixture observed level ${levelMatch[1]}; expected Anonymous or Identification`,
    );
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
