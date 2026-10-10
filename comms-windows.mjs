// Windows local transport for the agent-comms v1 broker wire contract.
// Keep this bot-owned adapter independent of the agent-comms checkout.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { createWindowsAccountCustody, isWindowsSid, legacyPowerShellEnv } from './windows-account-custody.mjs';

export const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\';
export const WINDOWS_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_LINE_BYTES = 128 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const READY_MARKER = 'AGENT_COMMS_PIPE_READY';
const FAILED_MARKER = 'AGENT_COMMS_PIPE_FAILED';
const TIMEOUT_MARKER = 'AGENT_COMMS_PIPE_TIMEOUT';
const RELAY_FAILURE_PREFIX = 'AGENT_COMMS_PIPE_FAILURE';
const COMPILE_FAILURE_PREFIX = 'AGENT_COMMS_PIPE_COMPILE_FAILURE';
const RELAY_FAILURE_STAGES = new Set([
  'pipe-construction', 'pipe-connect', 'stdin-open', 'stdout-open', 'worker-start',
]);
const RELAY_EXCEPTION = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const RELAY_HRESULT = /^[0-9A-F]{8}$/;
const HOST_PROCESS_EVENTS = new Set([
  'spawn-error', 'stdin-error', 'stdout-error', 'stderr-error', 'stderr-end', 'exit',
]);

export function isWindowsRelayFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.stage === 'compile') {
    return keys === 'code,stage' && typeof value.code === 'string'
      && (value.code === 'unknown' || /^CS[0-9]{4}$/.test(value.code));
  }
  if (value.stage === 'host-stderr') {
    return keys === 'format,reason,stage'
      && (value.format === 'clixml' || value.format === 'other')
      && (value.reason === 'unexpected' || value.reason === 'limit');
  }
  if (value.stage === 'host-process') {
    return keys === 'event,stage' && HOST_PROCESS_EVENTS.has(value.event);
  }
  return keys === 'exception,hresult,stage'
    && RELAY_FAILURE_STAGES.has(value.stage)
    && typeof value.exception === 'string' && RELAY_EXCEPTION.test(value.exception)
    && typeof value.hresult === 'string' && RELAY_HRESULT.test(value.hresult);
}

function withRelayFailure(error, failure) {
  if (isWindowsRelayFailure(failure)) {
    Object.defineProperty(error, 'relayFailure', { value: Object.freeze({ ...failure }), enumerable: false });
  }
  return error;
}

function hostStderrFailure(bytes, reason) {
  return {
    stage: 'host-stderr',
    format: bytes.subarray(0, 9).equals(Buffer.from('#< CLIXML', 'ascii')) ? 'clixml' : 'other',
    reason,
  };
}

function hostProcessFailure(event) {
  return { stage: 'host-process', event };
}

function parseRelayFailure(line) {
  const runtime = /^AGENT_COMMS_PIPE_FAILURE:([a-z-]+):([A-Za-z][A-Za-z0-9]{0,63}):([0-9A-F]{8})$/.exec(line);
  if (runtime) {
    const failure = { stage: runtime[1], exception: runtime[2], hresult: runtime[3] };
    return isWindowsRelayFailure(failure) ? failure : null;
  }
  const compile = /^AGENT_COMMS_PIPE_COMPILE_FAILURE:(CS[0-9]{4}|unknown)$/.exec(line);
  return compile ? { stage: 'compile', code: compile[1] } : null;
}

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

function powershellRelayScript(pipe, connectTimeoutMs) {
  if (typeof pipe !== 'string' || !pipe.startsWith(WINDOWS_PIPE_PREFIX)) throw new Error('invalid Windows pipe path');
  const pipeName = pipe.slice(WINDOWS_PIPE_PREFIX.length);
  // The only interpolated string is a generated label + validated SID. Keep
  // the script non-generic so an arbitrary pipe name cannot become PS code.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.S-1-\d+(?:-\d+)+$/.test(pipeName)) throw new Error('invalid Windows pipe name');
  const timeout = Number.isInteger(connectTimeoutMs) && connectTimeoutMs > 0
    ? Math.min(connectTimeoutMs, 2_147_483_647)
    : WINDOWS_HANDSHAKE_TIMEOUT_MS;
  const relaySource = [
    'using System;',
    'using System.IO;',
    'using System.IO.Pipes;',
    'using System.Runtime.InteropServices;',
    'using System.Security.Principal;',
    'using System.Threading;',
    'using Microsoft.Win32.SafeHandles;',
    'public static class AgentCommsPipeRelay {',
    '  private const int STD_INPUT_HANDLE = -10;',
    '  private const int STD_OUTPUT_HANDLE = -11;',
    `  private const string READY = "${READY_MARKER}";`,
    `  private const string FAILED = "${FAILED_MARKER}";`,
    `  private const string TIMEOUT = "${TIMEOUT_MARKER}";`,
    `  private const string FAILURE = "${RELAY_FAILURE_PREFIX}";`,
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  private static extern IntPtr GetStdHandle(int nStdHandle);',
    '  private static string ExceptionTypeName(Exception error) {',
    '    string name = error.GetType().Name;',
    '    if (name.Length == 0 || name.Length > 64) return "Exception";',
    '    for (int i = 0; i < name.Length; i++) {',
    '      char c = name[i];',
    "      if (!(c >= 'A' && c <= 'Z') && !(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9')) return \"Exception\";",
    '    }',
    '    return name;',
    '  }',
    '  private static void WriteFailure(string stage, Exception error) {',
    '    uint hresult = unchecked((uint)error.HResult);',
    '    Console.Error.WriteLine(FAILURE + ":" + stage + ":" + ExceptionTypeName(error) + ":" + hresult.ToString("X8"));',
    '  }',
    '  private sealed class CopyState {',
    '    public Stream Source;',
    '    public Stream Destination;',
    '    public ManualResetEvent Completed = new ManualResetEvent(false);',
    '    public int Failed;',
    '  }',
    '  private static Stream OpenStandardStream(int handle, FileAccess access) {',
    '    IntPtr value = GetStdHandle(handle);',
    '    if (value == IntPtr.Zero || value == new IntPtr(-1)) throw new IOException();',
    '    SafeFileHandle safe = new SafeFileHandle(value, false);',
    '    return new FileStream(safe, access);',
    '  }',
    '  private static void Copy(object value) {',
    '    CopyState state = (CopyState)value;',
    '    try {',
    '      byte[] buffer = new byte[81920];',
    '      int count;',
    '      while ((count = state.Source.Read(buffer, 0, buffer.Length)) != 0) {',
    '        state.Destination.Write(buffer, 0, count);',
    '        state.Destination.Flush();',
    '      }',
    '    } catch {',
    '      Interlocked.Exchange(ref state.Failed, 1);',
    '    } finally {',
    '      state.Completed.Set();',
    '    }',
    '  }',
    '  private static Thread StartCopy(Stream source, Stream destination, out CopyState state) {',
    '    state = new CopyState();',
    '    state.Source = source;',
    '    state.Destination = destination;',
    '    Thread worker = new Thread(Copy);',
    '    worker.IsBackground = true;',
    '    worker.Start(state);',
    '    return worker;',
    '  }',
    '  public static int Run(string pipeName, int timeout) {',
    '    NamedPipeClientStream pipe = null;',
    '    Stream input = null;',
    '    Stream output = null;',
    '    string stage = "pipe-construction";',
    '    try {',
    '      pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);',
    '      stage = "pipe-connect";',
    '      pipe.Connect(timeout);',
    '      stage = "stdin-open";',
    '      input = OpenStandardStream(STD_INPUT_HANDLE, FileAccess.Read);',
    '      stage = "stdout-open";',
    '      output = OpenStandardStream(STD_OUTPUT_HANDLE, FileAccess.Write);',
    '      CopyState inputState;',
    '      CopyState outputState;',
    '      stage = "worker-start";',
    '      StartCopy(input, pipe, out inputState);',
    '      StartCopy(pipe, output, out outputState);',
    '      Console.Error.WriteLine(READY);',
    '      WaitHandle.WaitAny(new WaitHandle[] { inputState.Completed, outputState.Completed });',
    '      pipe.Dispose();',
    '      if (inputState.Failed != 0 || outputState.Failed != 0) Console.Error.WriteLine(FAILED);',
    '      return 0;',
    '    } catch (TimeoutException error) {',
    '      WriteFailure(stage, error);',
    '      Console.Error.WriteLine(TIMEOUT);',
    '      return 2;',
    '    } catch (Exception error) {',
    '      WriteFailure(stage, error);',
    '      Console.Error.WriteLine(FAILED);',
    '      return 1;',
    '    } finally {',
    '      if (pipe != null) pipe.Dispose();',
    '      // Standard handles belong to the process; a blocked background read may still be unwinding.',
    '    }',
    '  }',
    '}',
  ].join('\n');
  return [
    "$ErrorActionPreference = 'Stop'",
    "$relaySource = @'",
    relaySource,
    "'@",
    'try {',
    "  Add-Type -TypeDefinition $relaySource -ReferencedAssemblies 'System.Core.dll'",
    '} catch {',
    `  $compilerCode = [regex]::Match([string]$_.Exception.Message, 'CS[0-9]{4}').Value`,
    `  if ($compilerCode) { [Console]::Error.WriteLine('${COMPILE_FAILURE_PREFIX}:' + $compilerCode) } else { [Console]::Error.WriteLine('${COMPILE_FAILURE_PREFIX}:unknown') }`,
    '  exit 1',
    '}',
    'try {',
    `  $relayExitCode = [AgentCommsPipeRelay]::Run('${pipeName}', ${timeout})`,
    '  exit $relayExitCode',
    '} catch {',
    `  [Console]::Error.WriteLine('${RELAY_FAILURE_PREFIX}:worker-start:Exception:00000000')`,
    `  [Console]::Error.WriteLine('${FAILED_MARKER}')`,
    '  exit 1',
    '}',
  ].join('\n');
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// PowerShell/.NET exposes the Windows named-pipe client impersonation level,
// while Node's libuv CreateFileW path does not. Framework Connect explicitly
// sets SECURITY_SQOS_PRESENT for Identification (None omits that flag):
// https://github.com/microsoft/referencesource/blob/main/System.Core/System/IO/Pipes/Pipe.cs
// Bridge raw bytes over stdio;
// the broker's signed hello remains the application authentication layer.
function createPowerShellPipeConnection(pipe, {
  spawnProcess = spawn,
  env = process.env,
  connectTimeoutMs = WINDOWS_HANDSHAKE_TIMEOUT_MS,
} = {}) {
  const script = powershellRelayScript(pipe, connectTimeoutMs);
  let child;
  try {
    // -EncodedCommand selects CLIXML for redirected host errors in Windows
    // PowerShell, so startup progress can precede and invalidate our markers.
    // Keep stdin for binary traffic and decode only this generated public script.
    const command = `$ProgressPreference = 'SilentlyContinue'; & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePowerShell(script)}'))))`;
    child = spawnProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', command,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: legacyPowerShellEnv(env) });
  } catch {
    throw withRelayFailure(new Error('Windows pipe relay process could not start'), hostProcessFailure('spawn-error'));
  }
  let ready = false;
  let done = false;
  let childExited = false;
  let stdoutEnded = false;
  let stderr = Buffer.alloc(0);
  let pendingRelayFailure = null;
  let pendingOutput = [];
  let pendingOutputBytes = 0;
  const relay = new Duplex({
    allowHalfOpen: false,
    read() { child.stdout.resume(); },
    write(chunk, encoding, callback) {
      if (done || child.stdin.destroyed) return callback(new Error('Windows pipe relay is closed'));
      child.stdin.write(chunk, encoding, callback);
    },
    final(callback) {
      child.stdin.end(callback);
    },
    destroy(error, callback) {
      done = true;
      pendingOutput = [];
      pendingOutputBytes = 0;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      callback(error);
    },
  });
  const fail = (code, relayFailure = null) => {
    if (done) return;
    relay.destroy(withRelayFailure(Object.assign(new Error(
      code === 'broker-timeout' ? 'Windows broker pipe connection timed out' : 'Windows broker pipe connection failed',
    ), { code }), relayFailure));
  };
  child.stdout.on('data', (chunk) => {
    if (done) return;
    if (!ready) {
      pendingOutputBytes += chunk.length;
      if (pendingOutputBytes > MAX_LINE_BYTES) return fail('broker-untrusted');
      pendingOutput.push(Buffer.from(chunk));
      return;
    }
    if (!relay.push(chunk)) child.stdout.pause();
  });
  child.stdout.on('end', () => {
    stdoutEnded = true;
    if (!done && ready) relay.push(null);
  });
  child.stderr.on('data', (chunk) => {
    if (done || ready) return;
    stderr = Buffer.concat([stderr, chunk]);
    if (stderr.length > 1024) return fail('broker-unreachable', pendingRelayFailure ?? hostStderrFailure(stderr, 'limit'));
    let newline;
    while ((newline = stderr.indexOf(0x0a)) !== -1) {
      const rawMarker = stderr.subarray(0, newline);
      const marker = rawMarker.toString('ascii').replace(/\r$/, '');
      stderr = stderr.subarray(newline + 1);
      const relayFailure = parseRelayFailure(marker);
      if (relayFailure) {
        if (relayFailure.stage === 'compile') {
          fail('broker-unreachable', relayFailure);
          return;
        }
        pendingRelayFailure = relayFailure;
        continue;
      }
      if (marker === READY_MARKER) {
        ready = true;
        stderr = Buffer.alloc(0);
        relay.emit('connect');
        let backpressured = false;
        for (const output of pendingOutput) {
          if (!relay.push(output)) backpressured = true;
        }
        if (backpressured) child.stdout.pause();
        pendingOutput = [];
        pendingOutputBytes = 0;
        if (stdoutEnded) relay.push(null);
      } else if (marker === TIMEOUT_MARKER) {
        fail('broker-timeout', pendingRelayFailure);
      } else if (marker === FAILED_MARKER) {
        fail('broker-unreachable', pendingRelayFailure);
      } else {
        fail('broker-unreachable', pendingRelayFailure ?? hostStderrFailure(rawMarker, 'unexpected'));
      }
      return;
    }
  });
  child.stderr.once('end', () => {
    if (!done && !ready) fail(
      child.exitCode === 2 ? 'broker-timeout' : 'broker-unreachable',
      pendingRelayFailure ?? hostProcessFailure(childExited ? 'exit' : 'stderr-end'),
    );
  });
  child.once('error', () => fail('broker-unreachable', pendingRelayFailure ?? hostProcessFailure('spawn-error')));
  child.stdin.on('error', () => fail('broker-unreachable', pendingRelayFailure ?? hostProcessFailure('stdin-error')));
  child.stdout.on('error', () => fail('broker-unreachable', pendingRelayFailure ?? hostProcessFailure('stdout-error')));
  child.stderr.on('error', () => fail('broker-unreachable', pendingRelayFailure ?? hostProcessFailure('stderr-error')));
  child.once('exit', () => {
    childExited = true;
    if (!done && !ready && child.stderr.readableEnded) {
      fail('broker-unreachable', pendingRelayFailure ?? hostProcessFailure('exit'));
    }
  });
  return relay;
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
  createConnection = null,
  spawnProcess = spawn,
  env = process.env,
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
    raw = createConnection
      ? createConnection(pipe)
      : createPowerShellPipeConnection(pipe, { spawnProcess, env, connectTimeoutMs: handshakeTimeoutMs });
  } catch (error) {
    const reason = typeof error?.code === 'string' && /^[a-z0-9-]{1,48}$/i.test(error.code)
      ? error.code
      : 'broker-unreachable';
    throw withRelayFailure(Object.assign(new Error(`cannot reach the broker: ${reason}`), {
      code: 'broker-unreachable',
    }), error?.relayFailure);
  }
  let channel;
  let timer;
  let verified = false;
  let closed = false;
  let head = Buffer.alloc(0);
  const queued = [];
  channel = new Duplex({
    allowHalfOpen: false,
    read() { raw.resume?.(); },
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
    raw.on('data', (data) => {
      if (!channel.push(data)) raw.pause?.();
    });
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
  raw.on('error', (error) => reject(withRelayFailure(Object.assign(new Error(
    error.code === 'broker-timeout'
      ? 'broker handshake timed out'
      : `cannot reach the broker: ${error.code ?? error.message}`,
  ), { code: ['broker-timeout', 'broker-untrusted', 'bad-response'].includes(error.code) ? error.code : 'broker-unreachable' }), error.relayFailure)));
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
