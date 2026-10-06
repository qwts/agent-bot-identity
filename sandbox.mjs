#!/usr/bin/env node
// Persona accounts for sandboxed souls (#376, GeniusBar#66, ADR-0274).
//
// `agent-bot sandbox` reports whether the sandbox account exists and is
// onboarded, gives the owner the exact steps that still need doing, and keeps
// the global switch (`features.persona-accounts`), the account name and each
// soul's override. It never creates an account itself: that needs admin
// rights, so every step is one the owner runs, and nothing here runs `sudo`.
//
//   agent-bot sandbox status [--json]
//   agent-bot sandbox plan [--json]
//   agent-bot sandbox on|off [--json] [--principal-stdin]
//   agent-bot sandbox account NAME [--json] [--principal-stdin]
//   agent-bot sandbox override <agentId|name> [show|inherit|sandboxed|unrestricted] [--json] [--principal-stdin]
//   agent-bot sandbox resolve <agentId|name> [--json]
//
// Everything printed is secret-free: account names, booleans and commands.

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { validateAgentId } from './agent-identity.mjs';
import { SANDBOX_OVERRIDES, listSouls, populationFile, setSoulSandbox, showSoul, showSoulByName, soulShownName } from './agent-population.mjs';
import { assertOwnerAction } from './owner-gate.mjs';

export const SANDBOX_PROVIDER = 'standard_macos_account';
export const DEFAULT_SANDBOX_ACCOUNT = 'geniusbar-agent';
export const SANDBOX_STATUSES = Object.freeze(['unsupported', 'missing', 'creating', 'ready']);
const GATE = 'persona-accounts';
const USAGE = 'usage: agent-bot sandbox status [--json] | sandbox plan [--json] | sandbox on|off [--json] [--principal-stdin] | sandbox account NAME [--json] [--principal-stdin] | sandbox override <agentId|name> [show|inherit|sandboxed|unrestricted] [--json] [--principal-stdin] | sandbox resolve <agentId|name> [--json]';
// What sysadminctl and dscl accept as a short name; it lands in argv, never a shell.
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,30}$/;

function fail(code, message) { return Object.assign(new Error(message), { code }); }

function configPath({ env = process.env, home = homedir() } = {}) {
  return env.AGENT_BOT_CONFIG ?? join(home, '.config', 'agent-bot', 'config.json');
}

// Atomic, mode-preserving rewrite of config.json; a new file is private.
function writeConfig(next, options) {
  const path = configPath(options);
  let mode = 0o600;
  try { mode = statSync(path).mode & 0o777; } catch { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
  const tmp = join(dirname(path), `.config.json.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  return path;
}

export function validateSandboxAccount(name) {
  if (typeof name !== 'string' || !ACCOUNT_NAME.test(name)) {
    throw fail('invalid-account', `sandbox account must be a short macOS account name like ${DEFAULT_SANDBOX_ACCOUNT} (lowercase letters, digits, _ and -), not ${JSON.stringify(name)}`);
  }
  return name;
}

function sandboxSection(config) {
  const section = config.sandbox ?? {};
  if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error('agent-bot config sandbox must be an object');
  if (section.provider !== undefined && section.provider !== SANDBOX_PROVIDER) throw new Error(`unknown sandbox provider: ${section.provider}`);
  if (section.account !== undefined) validateSandboxAccount(section.account);
  return section;
}

export function sandboxSettings(config) {
  const section = sandboxSection(config);
  return {
    enabled: config.features?.[GATE] === true,
    provider: SANDBOX_PROVIDER,
    account: section.account ?? DEFAULT_SANDBOX_ACCOUNT,
  };
}

// --- probes -----------------------------------------------------------------
// Every probe is a plain command whose output is a fact about the machine,
// never a secret. `exec` is injectable so tests never touch the real machine.

function defaultExec(file, args, { timeout = 10_000 } = {}) {
  return execFileSync(file, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryExec(exec, file, args) {
  try { return { ok: true, output: String(exec(file, args) ?? '') }; }
  catch (error) { return { ok: false, output: String(error?.stdout ?? ''), message: error?.message ?? String(error) }; }
}

function jsonOf(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export function probeSandboxAccount(account, { platform = process.platform, exec = defaultExec, fileExists = existsSync } = {}) {
  if (platform !== 'darwin') {
    return { supported: false, exists: null, standard: null, home: null, devTools: null, paired: null, fleet: null, harnessSignIn: 'unknown' };
  }
  const id = tryExec(exec, '/usr/bin/id', ['-u', account]);
  const exists = id.ok && /^\d+$/.test(id.output.trim());
  let standard = null;
  let home = null;
  if (exists) {
    const membership = tryExec(exec, '/usr/bin/dsmemberutil', ['checkmembership', '-U', account, '-G', 'admin']);
    standard = membership.ok ? /is not a member/.test(membership.output) : null;
    const dscl = tryExec(exec, '/usr/bin/dscl', ['.', '-read', `/Users/${account}`, 'NFSHomeDirectory']);
    const path = dscl.ok ? (dscl.output.match(/NFSHomeDirectory:\s*(\S+)/)?.[1] ?? null) : null;
    home = path ? { path, exists: fileExists(path) } : null;
  }
  const devTools = tryExec(exec, '/usr/bin/xcode-select', ['-p']).ok;
  // agent-comms answers for the owner's account: who is paired with the
  // broker, and which souls are joined from which account.
  const pairings = jsonOf(tryExec(exec, 'agent-comms', ['account', 'pairings']).output);
  const paired = Array.isArray(pairings?.pairings)
    ? pairings.pairings.some((row) => row?.account === account && row?.state === 'approved')
    : null;
  const census = jsonOf(tryExec(exec, 'agent-comms', ['census']).output);
  const fleet = Array.isArray(census?.souls)
    ? census.souls.some((row) => row?.account === account && row?.presence === 'joined')
    : null;
  // Another account's home is unreadable from here, so a harness sign-in
  // can only be confirmed by a turn running there (#84 records failures).
  return { supported: true, exists, standard, home, devTools, paired, fleet, harnessSignIn: 'unknown' };
}

export function sandboxAccountStatus(checks) {
  if (checks.supported === false) return 'unsupported';
  if (!checks.exists) return 'missing';
  const ready = checks.standard === true && checks.home?.exists === true && checks.devTools === true
    && checks.paired === true && checks.fleet === true;
  return ready ? 'ready' : 'creating';
}

// --- the owner's steps ------------------------------------------------------
// Each step names who runs it and the exact commands. `done` is what the
// probes can see; null means agent-bot cannot tell from this account.

export function sandboxPlan({ account, owner = userInfo().username, checks }) {
  const unsupported = checks.supported === false;
  const step = (id, title, run, commands, done, note = null) => ({ id, title, run, commands, done, ...(note ? { note } : {}) });
  return [
    step('create-account', `Create the standard account ${account}`, 'owner-admin', [
      `sudo sysadminctl -addUser ${account} -fullName "GeniusBar Agent" -password -`,
      'open "x-apple.systempreferences:com.apple.Users-Groups-Settings.extension"',
    ], unsupported ? null : checks.exists === true,
    'Either command; the first asks for a password for the new account. Leave it a Standard account: no admin rights.'),
    step('standard-account', `${account} has no admin rights`, 'owner-admin', [
      `sudo dseditgroup -o edit -d ${account} -t user admin`,
    ], unsupported ? null : checks.exists ? checks.standard : null,
    'Only needed when the account was created as an administrator.'),
    step('dev-tools', 'Apple command-line tools are installed (shared by every account)', 'owner', [
      'xcode-select --install',
    ], unsupported ? null : checks.devTools),
    step('broker-group', `${account} may reach the agent-comms broker`, 'owner-admin', [
      `sudo dseditgroup -o edit -a ${account} -t user agent-comms`,
      'agent-comms broker status --json',
    ], null,
    'Use the group the broker was installed with (agent-comms broker install --group GROUP); agent-comms is the usual name.'),
    step('pair', `Pair ${account} with the broker`, 'account', [
      `agent-comms account pair --broker ${owner}`,
      'agent-comms broker approve CODE',
    ], unsupported ? null : checks.paired,
    `Log in as ${account} (fast user switching) for the first command; approve the code it prints from your own account or in GeniusBar.`),
    step('harness-sign-in', `Sign the harnesses in as ${account}`, 'account', [
      'claude', 'codex login',
    ], null,
    `Run the harness once while logged in as ${account} and complete its sign-in; agent-bot cannot read that account's home to check.`),
    step('join', 'A sandboxed soul joins the fleet', 'owner', [
      'agent-bot sandbox override <soul> sandboxed',
    ], unsupported ? null : checks.fleet,
    'Launch a soul with the sandbox on (globally or by override); its join from the account completes onboarding.'),
  ];
}

// --- per-soul resolution ----------------------------------------------------

export function resolveSandbox(soul, settings, { owner = userInfo().username } = {}) {
  const override = soul.sandbox ?? 'inherit';
  const sandboxed = override === 'sandboxed' ? true : override === 'unrestricted' ? false : settings.enabled;
  return {
    agentId: soul.id,
    name: soulShownName(soul),
    override,
    sandboxed,
    runsAs: sandboxed ? settings.account : owner,
    source: override === 'inherit' ? 'global' : 'override',
  };
}

function resolveSoul(target, file) {
  try { return showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    return showSoulByName(target, { file });
  }
}

// --- reads ------------------------------------------------------------------

export function readSandboxStatus({ env = process.env, home = homedir(), platform = process.platform, exec = defaultExec, fileExists = existsSync, owner = userInfo().username, config } = {}) {
  const loaded = config ?? loadConfig({ env, home });
  const settings = sandboxSettings(loaded);
  const checks = probeSandboxAccount(settings.account, { platform, exec, fileExists });
  const file = populationFile({ env, home });
  let souls = [];
  try { souls = listSouls({ file }); } catch { souls = []; }
  return {
    ...settings,
    status: sandboxAccountStatus(checks),
    owner,
    checks,
    steps: sandboxPlan({ account: settings.account, owner, checks }),
    souls: souls.map((soul) => resolveSandbox(soul, settings, { owner })),
  };
}

export function formatSandboxStatus(result) {
  const mark = (value) => value === true ? 'yes' : value === false ? 'no' : '?';
  const lines = [
    `sandbox ${result.enabled ? 'on' : 'off'} (${result.provider})`,
    `account: ${result.account} ${result.status}`,
    `  exists ${mark(result.checks.exists)}  standard ${mark(result.checks.standard)}  home ${mark(result.checks.home?.exists ?? null)}  dev tools ${mark(result.checks.devTools)}  paired ${mark(result.checks.paired)}  joined ${mark(result.checks.fleet)}`,
    '', 'steps',
    ...result.steps.map((step) => `  [${step.done === true ? 'x' : step.done === false ? ' ' : '?'}] ${step.id}: ${step.title}`),
  ];
  if (result.souls.length) {
    lines.push('', 'souls', ...result.souls.map((soul) => `  ${soul.agentId} ${soul.name}: ${soul.override}, runs as ${soul.runsAs}`));
  }
  return `${lines.join('\n')}\n`;
}

export function formatSandboxPlan(steps) {
  return `${steps.map((step) => [`${step.done === true ? '[x]' : step.done === false ? '[ ]' : '[?]'} ${step.title} (${step.run})`,
    ...step.commands.map((command) => `    ${command}`), ...(step.note ? [`    ${step.note}`] : [])].join('\n')).join('\n')}\n`;
}

// --- writes -----------------------------------------------------------------

export function setSandboxEnabled(enabled, { env = process.env, home = homedir() } = {}) {
  if (typeof enabled !== 'boolean') throw fail('usage', 'enabled must be a boolean');
  const config = loadConfig({ env, home });
  const next = { ...config, features: { ...(config.features ?? {}), [GATE]: enabled } };
  writeConfig(next, { env, home });
  return sandboxSettings(next);
}

export function setSandboxAccount(account, { env = process.env, home = homedir() } = {}) {
  validateSandboxAccount(account);
  const config = loadConfig({ env, home });
  const next = { ...config, sandbox: { ...sandboxSection(config), provider: SANDBOX_PROVIDER, account } };
  writeConfig(next, { env, home });
  return sandboxSettings(next);
}

export function setSandboxOverride(target, override, { env = process.env, home = homedir() } = {}) {
  if (!SANDBOX_OVERRIDES.includes(override)) throw fail('usage', `override must be one of ${SANDBOX_OVERRIDES.join(', ')}`);
  const file = populationFile({ env, home });
  const soul = resolveSoul(target, file);
  const row = soul.sandbox === override ? soul : setSoulSandbox(soul.id, override, { file });
  return resolveSandbox(row, sandboxSettings(loadConfig({ env, home })), {});
}

// --- CLI --------------------------------------------------------------------

export async function sandboxCommand(argv, {
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  platform = process.platform,
  exec = defaultExec,
  owner = userInfo().username,
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  gate = (action, { principal }) => assertOwnerAction(action, { principal, env, cwd }),
} = {}) {
  const json = argv.includes('--json');
  const presented = argv.includes('--principal-stdin');
  const args = argv.filter((arg) => arg !== '--json' && arg !== '--principal-stdin');
  const [verb, ...rest] = args;
  const out = (value, text) => { write(json ? `${JSON.stringify(value)}\n` : text); return value; };
  const principalFor = async (action) => {
    let principal = null;
    if (presented) {
      try { principal = JSON.parse(readStdin()); }
      catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
    }
    await gate(action, { principal });
  };
  if (verb === 'status' && rest.length === 0) {
    if (presented) throw new Error(USAGE);
    const result = readSandboxStatus({ env, home, platform, exec, owner });
    return out(result, formatSandboxStatus(result));
  }
  if (verb === 'plan' && rest.length === 0) {
    if (presented) throw new Error(USAGE);
    const result = readSandboxStatus({ env, home, platform, exec, owner });
    return out({ account: result.account, status: result.status, steps: result.steps }, formatSandboxPlan(result.steps));
  }
  if ((verb === 'on' || verb === 'off') && rest.length === 0) {
    await principalFor(`sandbox ${verb}`);
    const settings = setSandboxEnabled(verb === 'on', { env, home });
    return out(settings, `sandbox ${settings.enabled ? 'on' : 'off'} (${settings.provider}, account ${settings.account})\n`);
  }
  if (verb === 'account' && rest.length === 1) {
    validateSandboxAccount(rest[0]);
    await principalFor(`sandbox account ${rest[0]}`);
    const settings = setSandboxAccount(rest[0], { env, home });
    return out(settings, `sandbox account ${settings.account}\n`);
  }
  if (verb === 'override' && rest.length >= 1 && rest.length <= 2) {
    const [target, action = 'show'] = rest;
    if (action === 'show') {
      if (presented) throw new Error(USAGE);
      const soul = resolveSoul(target, populationFile({ env, home }));
      const result = resolveSandbox(soul, sandboxSettings(loadConfig({ env, home })), { owner });
      return out(result, `${result.agentId} sandbox ${result.override}, runs as ${result.runsAs}\n`);
    }
    if (!SANDBOX_OVERRIDES.includes(action)) throw new Error(USAGE);
    const soul = resolveSoul(target, populationFile({ env, home }));
    await principalFor(`sandbox override ${soul.id} ${action}`);
    const result = setSandboxOverride(soul.id, action, { env, home });
    return out({ ...result, runsAs: result.sandboxed ? result.runsAs : owner }, `${result.agentId} sandbox ${result.override}, runs as ${result.sandboxed ? result.runsAs : owner}\n`);
  }
  if (verb === 'resolve' && rest.length === 1) {
    if (presented) throw new Error(USAGE);
    const soul = resolveSoul(rest[0], populationFile({ env, home }));
    const result = resolveSandbox(soul, sandboxSettings(loadConfig({ env, home })), { owner });
    return out(result, `${result.agentId} runs as ${result.runsAs} (${result.sandboxed ? 'sandboxed' : 'unrestricted'}, ${result.source})\n`);
  }
  throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sandboxCommand(process.argv.slice(2)).catch((error) => {
    const failure = { code: error.code ?? 'sandbox-failed', message: error.message };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot sandbox: ${failure.message}\n`);
    process.exitCode = 1;
  });
}
