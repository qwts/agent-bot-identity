// Optional signed-in desktop acceptance for #934. Real adapters and tasks;
// no platform/transport/process runner is injected. Use a disposable account.
import assert from 'node:assert/strict';
import { hasDaemonWakeReport, taskQueryProvesAbsence, acceptanceFailureEvidence, startupErrorEvidence, startupLogEvidence } from './windows-supervisor-evidence.mjs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.platform, 'win32');
assert.equal(process.env.AGENT_COMMS_DISPOSABLE_WINDOWS, '1', 'disposable signed-in Windows account required');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--comms', '--report'].includes(process.argv[i]) && process.argv[i + 1]);
  options[process.argv[i].slice(2)] = path.resolve(process.argv[i + 1]);
}
assert.ok(options.comms && options.report);
const repository = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(path.join(process.env.LOCALAPPDATA, "agent-bot acceptance's "));
const home = path.join(root, 'daemon home');
mkdirSync(home);
const label = `test.agent-bot.${randomUUID()}`;
const brokerLabel = `${label}.broker`;
const env = { ...process.env,
  AGENT_BOT_SERVICE_LABEL: label,
  AGENT_BOT_DAEMON_STATE_PATH: path.join(root, 'daemon.json'),
  AGENT_BOT_COMMS_DAEMON_PATH: path.join(root, 'credentials', 'daemon.json'),
  XDG_STATE_HOME: path.join(root, 'identity state'),
  AGENT_COMMS_SERVICE_LABEL: brokerLabel,
  AGENT_COMMS_CREDENTIAL_NAME: `${label}.principal`,
  AGENT_COMMS_SHARED_DIR: path.join(root, 'broker shared'),
  AGENT_COMMS_BROKER_STATE_DIR: path.join(root, 'broker state'),
  AGENT_COMMS_CLIENT_STATE_DIR: path.join(root, 'broker client'),
  AGENT_COMMS_LOG_DIR: path.join(root, 'broker logs'),
};
const selectedBotSettings = new Set(['AGENT_BOT_SERVICE_LABEL', 'AGENT_BOT_DAEMON_STATE_PATH', 'AGENT_BOT_COMMS_DAEMON_PATH']);
for (const key of Object.keys(env)) {
  if (key === 'NODE_OPTIONS' || /^(?:QWTS_AGENT_|GH_APP_HOOK_)/.test(key)
    || (key.startsWith('AGENT_BOT_') && !selectedBotSettings.has(key))
    || ['AGENT_COMMS_BROKER_ACCOUNT', 'AGENT_COMMS_MODE', 'AGENT_COMMS_NO_KEYCHAIN'].includes(key)) {
    delete env[key]; delete process.env[key];
  }
}
Object.assign(process.env, env);
const exec = promisify(execFile);
const result = { node: process.version, platform: process.platform, cases: [],
  scope: 'production supervisor installer and runDaemon API with explicit disposable home and empty config',
  untested: ['CLI default-home installation', 'packaged host update', 'actual logoff/logon', 'full harness launch'] };
let failed = false;
let supervisor;
let substage;
let startupDiagnostics;
const phase = name => { substage = name; };
const bin = path.join(options.comms, 'bin', 'agent-comms.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
async function command(file, args) {
  try { return { exit: 0, ...(await exec(file, args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })) }; }
  catch (error) { return { exit: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
async function cli(args, substageName) {
  phase(substageName ?? `comms-${args.slice(0, 2).join('-')}`);
  const response = await command(process.execPath, [bin, ...args]);
  let body;
  try { body = JSON.parse(response.stdout); } catch { /* report only safe error classification */ }
  assert.equal(response.exit, 0, `comms CLI failed (${body?.error?.code ?? 'non-json'})`);
  return body;
}
async function until(check, code) {
  phase(code);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Object.assign(new Error(code), { code });
}
async function record(name, run) {
  phase('start-case');
  try { result.cases.push({ name, status: 'passed', ...await run() }); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { result.cases.push({ name, status: 'failed', ...acceptanceFailureEvidence(error, substage) }); result.failureStage = name; throw error; }
}
function safeCode(code) { return typeof code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? code : null; }
try {
  for (const [name, directory] of [['bot', repository], ['comms', options.comms]]) {
    const dirty = (await exec('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=normal'])).stdout;
    if (dirty.trim()) throw Object.assign(new Error('clean source checkout required'), { code: `dirty-${name}-checkout` });
  }
  result.botCommit = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  result.commsCommit = (await exec('git', ['-C', options.comms, 'rev-parse', 'HEAD'])).stdout.trim();
  const [{ pairDaemonComms, commsCredentialFile, daemonVouchKeyFile }, daemon, services, vouch, client, pathsModule, principalModule] = await Promise.all([
    import('../comms-client.mjs'), import('../agent-daemon.mjs'), import('../daemon-supervisor.mjs'), import('../vouch.mjs'),
    import(pathToFileURL(path.join(options.comms, 'lib/client.mjs'))),
    import(pathToFileURL(path.join(options.comms, 'lib/paths.mjs'))),
    import(pathToFileURL(path.join(options.comms, 'lib/principal-client.mjs'))),
  ]);
  supervisor = services;
  const paths = pathsModule.brokerPaths(env);
  let principal;
  let account;
  let daemonAccount;
  let credentialHash;
  let keyHash;
  let firstPid;
  let restartedPid;
  const soul = `agent_${randomUUID()}`;
  await record('real namespaced broker and normal native daemon pairing', async () => {
    await cli(['broker', 'install', '--single-account']);
    await until(async () => (await command(process.execPath, [bin, 'broker', 'pairings'])).exit === 0, 'broker-start-timeout');
    // The broker requires an approved OS-account pairing before either a
    // principal or daemon can request its own credential kind. Requests
    // return pending codes immediately; approval follows each request.
    const pairedAccount = await cli(['account', 'pair']);
    await cli(['broker', 'approve', pairedAccount.code], 'approve-account-pairing');
    phase('load-account-credential');
    account = client.loadCredential(pathsModule.clientPaths(env));
    const pairedPrincipal = await cli(['principal', 'pair', '--name', 'Disposable supervised daemon acceptance']);
    await cli(['admin', 'principal-approve', pairedPrincipal.code], 'approve-principal-pairing');
    phase('create-principal-client');
    principal = principalModule.createPrincipalClient({ env });
    phase('native-vouch-public-key');
    // Match the production daemon CLI composition after #645/F11: the comms
    // module receives only the native provider's public half.
    const publicKey = vouch.vouchPublicKeyPem({ env, home });
    phase('native-daemon-pair');
    const pairing = await pairDaemonComms({ env, home, publicKey });
    await cli(['broker', 'approve', pairing.code], 'approve-daemon-pairing');
    daemonAccount = pairing.account;
    assert.equal(account.account, daemonAccount);
    phase('hash-daemon-credential-and-vouch-key');
    credentialHash = hash(commsCredentialFile({ env, home }));
    keyHash = hash(daemonVouchKeyFile({ env, home }));
    phase('reload-native-vouch-key');
    const key = vouch.loadOrCreateVouchKey(vouch.vouchStateDir({ env, home }));
    const soulToken = vouch.signSoulToken({ account: account.account, agentId: soul, parent: null }, key.privateKey);
    phase('join-acceptance-soul');
    await client.call(paths, account, { op: 'join', agentId: soul, soulToken, name: 'supervised acceptance', harness: 'acceptance' });
    return { providerInjected: false };
  });
  const bootstrap = path.join(root, 'run daemon.mjs');
  const startupFailure = path.join(root, 'startup-failure.json');
  writeFileSync(bootstrap, `import {writeFileSync} from 'node:fs';\nimport {startupErrorEvidence} from ${JSON.stringify(pathToFileURL(path.join(repository, 'scripts/windows-supervisor-evidence.mjs')).href)};\ntry { const {runDaemon} = await import(${JSON.stringify(pathToFileURL(path.join(repository, 'agent-daemon.mjs')).href)}); await runDaemon({env:process.env,home:${JSON.stringify(home)},config:{}}); } catch(error) { writeFileSync(${JSON.stringify(startupFailure)}, JSON.stringify(startupErrorEvidence(error))); process.exitCode=1; }\n`);
  const status = () => daemon.daemonStatus({ env, home });
  const connected = async () => { const state = await status(); return state.running && state.comms?.connected ? state : null; };
  startupDiagnostics = async () => {
    const evidence = {};
    const state = await status();
    evidence.daemon = { running: state.running === true, connected: state.comms?.connected === true,
      stateFileExists: existsSync(env.AGENT_BOT_DAEMON_STATE_PATH),
      ...(Number.isSafeInteger(state.pid) ? { pid: state.pid } : {}) };
    try { evidence.bootstrapFailure = startupErrorEvidence(JSON.parse(readFileSync(startupFailure, 'utf8'))); } catch { /* bootstrap may not have started */ }
    const taskPaths = services.supervisorPaths(home, process.platform, env);
    try {
      const log = readFileSync(taskPaths.logPath);
      evidence.log = startupLogEvidence(log.subarray(-65536).toString('utf8'));
      copyFileSync(taskPaths.logPath, path.join(root, 'supervisor-startup.log'));
    } catch { evidence.log ??= { present: false }; }
    // Select only enum/numeric fields; never copy task actions, paths or output.
    const query = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$t=Get-ScheduledTask -TaskName '${label}' -ErrorAction Stop; $i=$t|Get-ScheduledTaskInfo; @{state=[string]$t.State;lastResult=[long]$i.LastTaskResult}|ConvertTo-Json -Compress`]);
    evidence.scheduler = { queryExit: query.exit };
    try {
      const task = JSON.parse(query.stdout);
      if (['Unknown', 'Disabled', 'Queued', 'Ready', 'Running'].includes(task.state)) evidence.scheduler.state = task.state;
      if (Number.isSafeInteger(task.lastResult)) evidence.scheduler.lastResult = task.lastResult;
    } catch { /* retain exit only */ }
    return evidence;
  };
  await record('production supervisor installer starts the actual daemon with custom namespace', async () => {
    phase('install-native-daemon-supervisor');
    const installed = await services.ensureDaemonSupervisor({ env, home, programArguments: [process.execPath, bootstrap], reloadUnchanged: false });
    phase('verify-supervisor-install-result');
    assert.equal(installed.applied, true);
    assert.equal(installed.loaded, true);
    assert.equal(installed.skippedLoad, false);
    await until(async () => { const state = await connected(); firstPid = state?.pid; return !!state; }, 'daemon-watch-start-timeout');
    assert.equal(hash(commsCredentialFile({ env, home })), credentialHash);
    assert.equal(hash(daemonVouchKeyFile({ env, home })), keyHash);
    return { pid: firstPid };
  });
  async function freshWakeAndReport(stage) {
    phase(`send-fresh-message-${stage}`);
    const sent = await principal.send({ to: `${account.account}/${soul}`, body: `native supervised wake ${stage}`, key: randomUUID() });
    await until(async () => (await status()).comms?.lastWake?.messageIds?.includes(sent.messageId), `daemon-receive-${stage}-timeout`);
    await until(async () => {
      const records = readFileSync(path.join(paths.state, 'events.jsonl'), 'utf8').split('\n').flatMap(line => {
        try { return line ? [JSON.parse(line)] : []; } catch { return []; }
      });
      return hasDaemonWakeReport(records, { account: daemonAccount, agentId: soul, messageId: sent.messageId });
    }, `daemon-report-${stage}-timeout`);
    return { receivedFreshMessage: true, brokerRecordedDaemonReport: true };
  }
  await record('actual daemon receives and reports wake before task restart', () => freshWakeAndReport('before-restart'));
  await record('production supervisor refresh replaces the running daemon and reports fresh wakes', async () => {
    const previousPid = (await connected()).pid;
    phase('refresh-running-native-daemon-supervisor');
    const refreshed = await services.ensureDaemonSupervisor({ env, home, programArguments: [process.execPath, bootstrap], reloadUnchanged: true });
    assert.equal(refreshed.applied, true); assert.notEqual(refreshed.pid, previousPid);
    await until(async () => { const state = await connected(); return state && state.pid !== previousPid; }, 'daemon-production-refresh-timeout');
    assert.equal(hash(commsCredentialFile({ env, home })), credentialHash);
    assert.equal(hash(daemonVouchKeyFile({ env, home })), keyHash);
    firstPid = refreshed.pid;
    return { previousPid, refreshedPid: refreshed.pid, sameCredential: true, sameVouchKey: true, ...await freshWakeAndReport('after-production-refresh') };
  });
  await record('Task Scheduler stop removes daemon tree and restart reconnects with unchanged credentials', async () => {
    phase('task-end');
    assert.equal((await command('schtasks.exe', ['/End', '/TN', label])).exit, 0);
    await until(async () => {
      if ((await status()).running) return false;
      try { process.kill(firstPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
    }, 'daemon-task-stop-timeout');
    phase('task-run');
    assert.equal((await command('schtasks.exe', ['/Run', '/TN', label])).exit, 0);
    await until(async () => { const state = await connected(); restartedPid = state?.pid; return !!state && state.pid !== firstPid; }, 'daemon-task-restart-timeout');
    assert.equal(hash(commsCredentialFile({ env, home })), credentialHash);
    assert.equal(hash(daemonVouchKeyFile({ env, home })), keyHash);
    const wake = await freshWakeAndReport('after-task-restart');
    return { previousPid: firstPid, restartedPid, sameCredential: true, sameVouchKey: true, ...wake };
  });
  await record('actual supervised daemon reconnects after broker task restart', async () => {
    const reconnects = (await status()).comms.reconnects;
    await cli(['broker', 'uninstall']);
    await until(async () => !(await status()).comms?.connected, 'daemon-observe-broker-stop-timeout');
    await cli(['broker', 'install', '--single-account']);
    await until(async () => { const state = await connected(); return state && state.comms.reconnects > reconnects; }, 'daemon-broker-reconnect-timeout');
    assert.equal(hash(commsCredentialFile({ env, home })), credentialHash);
    assert.equal(hash(daemonVouchKeyFile({ env, home })), keyHash);
    const wake = await freshWakeAndReport('after-broker-restart');
    return { sameCredential: true, sameVouchKey: true, ...wake };
  });
} catch (error) {
  failed = true;
  result.failure = acceptanceFailureEvidence(error, substage);
  if (startupDiagnostics) {
    try { result.startup = await startupDiagnostics(); } catch (diagnosticError) { result.startup = { collectionFailure: acceptanceFailureEvidence(diagnosticError) }; }
  }
} finally {
  const cleanupErrors = [];
  const note = (operation, error) => cleanupErrors.push({ operation, code: safeCode(error?.code) ?? 'cleanup-failed' });
  if (supervisor) {
    try { await supervisor.disableDaemonSupervisor({ env, home }); } catch (error) { note('disable-daemon', error); }
  }
  for (const task of [label, brokerLabel]) {
    await command('schtasks.exe', ['/End', '/TN', task]);
    await command('schtasks.exe', ['/Delete', '/TN', task, '/F']);
    const remaining = await command('schtasks.exe', ['/Query', '/TN', task]);
    if (!taskQueryProvesAbsence(remaining)) note('verify-task-absence');
    try { rmSync(path.join(env.LOCALAPPDATA, task), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (error) { note('remove-task-directory', error); }
  }
  try {
    if (failed) result.retainedRuntimeDirectory = root;
    else rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  catch (error) { note('remove-runtime-directory', error); result.retainedRuntimeDirectory = root; }
  if (cleanupErrors.length) { failed = true; result.cleanupErrors = cleanupErrors; }
  result.cleanup = cleanupErrors.length ? 'failed' : 'namespaced-tasks-absent';
  result.requiredSupervisorChecks = failed ? 'failed' : 'passed';
  mkdirSync(path.dirname(options.report), { recursive: true });
  writeFileSync(options.report, `${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = failed ? 1 : 0;
}
