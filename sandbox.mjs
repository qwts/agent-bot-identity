#!/usr/bin/env node
// Persona accounts for sandboxed souls (#376, GeniusBar#66, ADR-0274).
//
// `agent-bot sandbox` reports whether the sandbox account exists and is
// onboarded, gives the owner the exact steps that still need doing, and keeps
// the global switch (`features.persona-accounts`), the account name and each
// soul's override. It never creates an account itself: that needs admin
// rights, so every step is one the owner runs, and nothing here runs `sudo`.
//
// Which souls get an account, and what it is called, is the SOP pack's
// persona mapping (ADR-0274 decision 3): persona.toml in the SOP repository,
// recorded offline by `agent-bot sop persona`. A pack decision wins over the
// user's override and switch; the switch and overrides are the user's choice
// only for a soul no SOP decides. The pack never turns the add-on on: with
// `features.persona-accounts` off its decision is reported, not applied.
//
//   agent-bot sandbox status [--json]
//   agent-bot sandbox plan [--json]
//   agent-bot sandbox on|off [--json] [--principal-stdin]
//   agent-bot sandbox account NAME [--json] [--principal-stdin]
//   agent-bot sandbox override <agentId|name> [show|inherit|sandboxed|unrestricted] [--json] [--principal-stdin]
//   agent-bot sandbox resolve <agentId|name> [--json]
//   agent-bot sandbox remove [ACCOUNT] --dry-run [--json]
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
import { assertOwnerAction } from './owner-action.mjs';
import { PERSONA_FILE, parseTomlSubset, readSopPersonaRecord } from './sop.mjs';

export const SANDBOX_PROVIDER = 'standard_macos_account';
export const DEFAULT_SANDBOX_ACCOUNT = 'geniusbar-agent';
export const SANDBOX_STATUSES = Object.freeze(['unsupported', 'missing', 'creating', 'ready']);
export const PERSONA_SANDBOX = Object.freeze(['sandboxed', 'unrestricted']);
export const PERSONA_MATCHERS = Object.freeze(['soul', 'role']);
export const PERSONA_STATES = Object.freeze(['none', 'unrecorded', 'stale', 'absent', 'error', 'invalid', 'ok']);
const GATE = 'persona-accounts';
const USAGE = 'usage: agent-bot sandbox status [--json] | sandbox plan [--json] | sandbox on|off [--json] [--principal-stdin] | sandbox account NAME [--json] [--principal-stdin] | sandbox override <agentId|name> [show|inherit|sandboxed|unrestricted] [--json] [--principal-stdin] | sandbox resolve <agentId|name> [--json] | sandbox remove [ACCOUNT] --dry-run [--json]';
// What sysadminctl and dscl accept as a short name; it lands in argv, never a shell.
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,30}$/;

function fail(code, message) { return Object.assign(new Error(message), { code }); }

// The broker's launch-result detail limit (what reportCommsLaunch sends).
const LAUNCH_DETAIL_LIMIT = 512;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

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

// --- the pack's persona mapping ---------------------------------------------
// persona.toml at the SOP repository's root, in the TOML subset agent-sop.toml
// uses (comments, [table] and [table.sub] headers, quoted strings, integers):
//
//   schema_version = 1
//   [persona]                    # optional: souls no rule matches
//   sandbox = "unrestricted"     #   sandboxed | unrestricted; absent: the user setting
//   account = "geniusbar-agent"  #   the account for sandboxed souls whose rule names none
//   [soul.reviewer]              # by the soul's name (as GeniusBar shows it, or its handle)
//   sandbox = "sandboxed"
//   account = "gb-reviewer"      # optional
//   [role.auditor]               # by the role in the soul's soul.json
//   sandbox = "sandboxed"
//
// A name rule wins over a role rule, which wins over the default. Names and
// roles compare lowercased with spaces as hyphens, so `[soul.release-bot]`
// matches a soul named "Release Bot". Souls are not matched by template: the
// census keeps no template name, only a revision.

export function parsePersonaMapping(text) {
  const problem = (message) => fail('persona-invalid', `${PERSONA_FILE}: ${message}`);
  let parsed;
  try { parsed = parseTomlSubset(text); }
  catch (error) { throw problem(error.message); }
  const { root, tables } = parsed;
  for (const key of Object.keys(root)) if (key !== 'schema_version') throw problem(`unsupported key ${key}; this file allows schema_version, [persona], [soul.NAME] and [role.ROLE]`);
  if (root.schema_version !== 1) throw problem(`schema_version must be the integer 1 (got ${JSON.stringify(root.schema_version)})`);
  const entry = (table, fields, { required }) => {
    for (const key of Object.keys(fields)) if (key !== 'sandbox' && key !== 'account') throw problem(`[${table}] has unsupported key ${key}; expected sandbox and account`);
    if (fields.sandbox !== undefined && !PERSONA_SANDBOX.includes(fields.sandbox)) throw problem(`[${table}] sandbox must be sandboxed or unrestricted`);
    if (required && fields.sandbox === undefined) throw problem(`[${table}] needs sandbox = "sandboxed" or "unrestricted"`);
    let account = null;
    if (fields.account !== undefined) {
      try { account = validateSandboxAccount(fields.account); }
      catch (error) { throw problem(`[${table}] ${error.message}`); }
    }
    return { sandbox: fields.sandbox ?? null, account };
  };
  const mapping = { schemaVersion: 1, default: { sandbox: null, account: null }, rules: [] };
  for (const [table, fields] of Object.entries(tables)) {
    if (table === 'persona') { mapping.default = entry(table, fields, { required: false }); continue; }
    const dot = table.indexOf('.');
    const match = dot > 0 ? table.slice(0, dot) : null;
    const value = dot > 0 ? table.slice(dot + 1) : '';
    if (!PERSONA_MATCHERS.includes(match) || !value || value.includes('.')) {
      throw problem(`unsupported table [${table}]; expected [persona], [soul.NAME] or [role.ROLE]`);
    }
    mapping.rules.push({ match, value: personaKey(value), ...entry(table, fields, { required: true }) });
  }
  return mapping;
}

function personaKey(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, '-');
}

// The role a soul's soul.json declares (#535), from the folder the census records.
function soulRole(soul) {
  if (!soul?.soulDir) return null;
  try {
    const role = JSON.parse(readFileSync(join(soul.soulDir, 'soul.json'), 'utf8'))?.role;
    return typeof role === 'string' && role.trim() ? role : null;
  } catch { return null; }
}

export function matchPersona(mapping, { names = [], role = null } = {}) {
  const hit = (match, value) => mapping.rules.find((rule) => rule.match === match && rule.value === value) ?? null;
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const rule = hit('soul', personaKey(name));
    if (rule) return { rule: `soul:${rule.value}`, sandbox: rule.sandbox, account: rule.account };
  }
  if (typeof role === 'string' && role.trim()) {
    const rule = hit('role', personaKey(role));
    if (rule) return { rule: `role:${rule.value}`, sandbox: rule.sandbox, account: rule.account };
  }
  if (mapping.default.sandbox) return { rule: 'default', sandbox: mapping.default.sandbox, account: null };
  return null;
}

// The recorded pack decision, read offline (never git, never the network):
// `agent-bot sop persona` records the user's SOP's persona.toml, pinned to
// its commit. `state` is one of PERSONA_STATES; only `ok` decides anything.
// `none` and `absent` (verified absence) leave the user setting in charge;
// the rest refuse a launch (see PERSONA_REFUSALS).
//
// `acceptStale` is for a launch the owner verified past a stale record
// (#613, owner decision 2026-10-09): the digest of the record the owner
// approved. Only that very record is accepted, so a record that changed
// while the owner was asked is stale again. That one launch is decided by
// the stale record's own mapping, never by the user setting in its place,
// so the owner's approval cannot lower what the last recorded pack
// required. The result keeps `stale: true` and the refresh message.
export function loadPersona({ env = process.env, home = homedir(), acceptStale = null } = {}) {
  const record = readSopPersonaRecord({ env, home });
  const base = { state: record.state, decides: false, repository: record.repository ?? null, commit: record.commit ?? null,
    recordedAt: record.recordedAt ?? null, message: record.message ?? null, mapping: null, ...(record.digest ? { digest: record.digest } : {}) };
  if (record.state === 'stale' && typeof acceptStale === 'string' && acceptStale === record.digest) {
    const stale = { ...base, stale: true };
    if (record.text === null) return { ...stale, state: 'absent' };
    try { return { ...stale, state: 'ok', decides: true, mapping: parsePersonaMapping(record.text) }; }
    catch (error) { return { ...stale, state: 'invalid', message: `${error.message}; launches are refused until the pack is fixed` }; }
  }
  if (record.state !== 'recorded') return base;
  try { return { ...base, state: 'ok', decides: true, mapping: parsePersonaMapping(record.text) }; }
  catch (error) { return { ...base, state: 'invalid', message: `${error.message}; launches are refused until the pack is fixed` }; }
}

// ADR-0274 (#613): configured persona policy that cannot be evaluated is a
// refusal, never a fall back to the user setting or a soul override. The
// action names the repair; nothing here changes the record or the add-on.
const PERSONA_REFUSALS = Object.freeze({
  // A missing local record is not verified absence (#613 requirement 1).
  unrecorded: { code: 'persona-policy-unavailable', action: 'run `agent-bot sop persona` to record the selected SOP\'s mapping' },
  error: { code: 'persona-policy-unavailable', action: 'fix the SOP config or record, then run `agent-bot sop persona`' },
  invalid: { code: 'persona-policy-unavailable', action: 'fix persona.toml in the SOP, then run `agent-bot sop persona`' },
  stale: { code: 'persona-policy-stale', action: 'run `agent-bot sop persona` to record the selected SOP\'s mapping' },
});

function personaRefusal(persona, wanted) {
  if (!persona) return null;
  const source = persona.repository ? { repository: persona.repository, commit: persona.commit } : null;
  const known = PERSONA_REFUSALS[persona.state];
  if (known) {
    return { ...known, reason: persona.message ?? `the SOP persona policy is ${persona.state}`, ...(source ? { source } : {}),
      ...(persona.state === 'stale' && persona.digest ? { digest: persona.digest } : {}) };
  }
  if (wanted) {
    return { code: 'persona-policy-requires-addon', reason: `the SOP decides sandboxed as ${wanted}, but features.persona-accounts is off`,
      action: 'the owner turns persona accounts on with `agent-bot sandbox on`; agent-bot never turns it on itself', ...(source ? { source } : {}) };
  }
  return null;
}

// Resolution order: the pack's decision for this soul (source `sop`), else
// the soul's override, else the global switch. Without `persona` (an older
// caller) the pack is not consulted and the result has no `sop` field.
function decideSandbox(soul, settings, { owner, persona = null, role = null, names = [] }) {
  const override = soul.sandbox ?? 'inherit';
  const decision = persona?.decides
    ? matchPersona(persona.mapping, { names: [soulShownName(soul, soul.soulDir ?? null), soul.displayName, soul.name, ...names], role: role ?? soulRole(soul) })
    : null;
  const account = decision ? (decision.account ?? persona.mapping.default.account ?? settings.account) : settings.account;
  let sandboxed;
  let source;
  let reason = null;
  if (decision) {
    source = 'sop';
    const wants = decision.sandbox === 'sandboxed';
    sandboxed = wants && settings.enabled;
    if (wants && !settings.enabled) reason = `the SOP decides sandboxed as ${account}, but features.persona-accounts is off (agent-bot sandbox on turns it on); launches are refused`;
  } else if (override !== 'inherit') {
    source = 'override';
    sandboxed = override === 'sandboxed';
  } else {
    source = 'global';
    sandboxed = settings.enabled;
  }
  const sop = persona ? {
    decides: Boolean(decision),
    state: persona.state,
    ...(persona.stale ? { stale: true } : {}),
    ...(persona.repository ? { repository: persona.repository, commit: persona.commit } : {}),
    ...(decision ? { rule: decision.rule, sandbox: decision.sandbox, account: decision.sandbox === 'sandboxed' ? account : owner } : {}),
    ...(persona.message ? { message: persona.message } : {}),
  } : null;
  const refusal = personaRefusal(persona, decision?.sandbox === 'sandboxed' && !settings.enabled ? account : null);
  if (refusal && !reason) reason = `${refusal.reason}; launches are refused`;
  return { override, sandboxed, source, account, runsAs: sandboxed ? account : owner, sop, reason, refusal };
}

// --- per-soul resolution ----------------------------------------------------

export function resolveSandbox(soul, settings, { owner = userInfo().username, persona = null, role = null, names = [] } = {}) {
  const decided = decideSandbox(soul, settings, { owner, persona, role, names });
  return {
    agentId: soul.id,
    name: soulShownName(soul),
    override: decided.override,
    sandboxed: decided.sandboxed,
    runsAs: decided.runsAs,
    source: decided.source,
    ...(decided.sop ? { sop: decided.sop } : {}),
    ...(decided.reason ? { reason: decided.reason } : {}),
    ...(decided.refusal ? { refused: decided.refusal } : {}),
  };
}

function resolveSoul(target, file) {
  try { return showSoul(validateAgentId(target), { file }); }
  catch (error) {
    if (/^agent_/.test(target)) throw error;
    return showSoulByName(target, { file });
  }
}

// --- at launch ----------------------------------------------------------------
// The daemon's launch handler asks this what a soul gets before it starts it
// (#376). The pack decides first, from the recorded mapping (no network: no
// SOP or no persona.toml leaves the user setting; a selected SOP whose policy
// is unrecorded or cannot be evaluated refuses the launch, #613).
// A soul not in the census yet (a package or team launch makes a new one)
// is matched by the launch's `name` and `role`, and has no override, so
// otherwise it follows the global switch. Only a sandboxed launch probes the
// account: an unrestricted one runs nothing.

function censusSoul(agentId, { env, home }) {
  if (!agentId) return { id: agentId, sandbox: 'inherit' };
  try { return showSoul(validateAgentId(agentId), { file: populationFile({ env, home }) }); }
  catch (error) {
    // Only an absent row means "no override"; an unreadable census fails
    // the launch rather than starting a sandboxed soul unrestricted.
    if (!/^no population record/.test(error.message)) throw error;
    return { id: agentId, sandbox: 'inherit' };
  }
}

export function launchSandbox(agentId, { env = process.env, home = homedir(), platform = process.platform, exec = defaultExec, fileExists = existsSync, owner = userInfo().username, name = null, role = null, acceptStale = null } = {}) {
  // Read now, not at daemon start: the switch, overrides and record change under it.
  const settings = sandboxSettings(loadConfig({ env, home }));
  const persona = loadPersona({ env, home, acceptStale });
  const soul = censusSoul(agentId, { env, home });
  const decided = decideSandbox(soul, settings, { owner, persona, role, names: [name] });
  const resolved = { resolution: decided.sandboxed ? 'sandboxed' : 'unrestricted', override: decided.override, source: decided.source,
    account: decided.runsAs, self: owner, sop: decided.sop, ...(decided.reason ? { reason: decided.reason } : {}),
    ...(decided.refusal ? { refused: decided.refusal } : {}) };
  if (decided.refusal || !decided.sandboxed) return resolved;
  const checks = probeSandboxAccount(decided.account, { platform, exec, fileExists });
  return { ...resolved, status: sandboxAccountStatus(checks), steps: sandboxPlan({ account: decided.account, owner, checks }) };
}

// Why a launch cannot start as `launchSandbox` resolved it, or null when it
// can. The `join` step is the one this launch performs, so a sandbox left
// only that step to do takes the launch; a step agent-bot cannot see (`done`
// null) never blocks. Every error is secret-free and fits the broker's
// 512-character launch detail: the next step with its command, then the ids
// of the rest, which `agent-bot sandbox plan` prints in full.
export function sandboxLaunchProblem(sandbox) {
  if (sandbox?.refused) {
    const { code, reason, source, action, digest = null } = sandbox.refused;
    // The launch handler sends `${code}: ${message}` as the broker's detail,
    // so the whole line, prefix included, fits LAUNCH_DETAIL_LIMIT: the
    // reason and the source/action tail are each bounded.
    const budget = LAUNCH_DETAIL_LIMIT - code.length - 2;
    const from = source ? ` (${clip(source.repository, 100)}@${source.commit.slice(0, 12)})` : '';
    const tail = clip(`${from}; ${action}`, Math.floor(budget / 2));
    return Object.assign(fail(code, `${clip(reason, budget - tail.length)}${tail}`), { source: source ?? null, action, ...(digest ? { digest } : {}) });
  }
  if (!sandbox || sandbox.resolution !== 'sandboxed') return null;
  const { account, status, steps = [] } = sandbox;
  if (status === 'unsupported') {
    return fail('sandbox-not-ready', `this soul runs sandboxed as ${account}, but persona accounts need macOS; set it unrestricted with \`agent-bot sandbox override <soul> unrestricted\` or turn the sandbox off`);
  }
  const owed = steps.filter((step) => step.id !== 'join' && step.done !== true);
  if (status === 'missing' || owed.some((step) => step.done === false)) {
    const [next, ...rest] = owed;
    const then = rest.length ? ` Then: ${rest.map((step) => step.id).join(', ')}.` : '';
    return fail('sandbox-not-ready', `this soul runs sandboxed as ${account}, which is ${status}. Next: ${next.title} (${next.run}): ${next.commands[0]}.${then} \`agent-bot sandbox plan\` prints every step's commands.`);
  }
  if (account !== sandbox.self) {
    // The executor spawns a harness as the daemon's own macOS user; it has
    // no account or uid to start one as, and the owner's daemon holds no
    // privilege to switch. A daemon running in the account itself can.
    return fail('sandbox-other-account', `this soul runs sandboxed as ${account}, and this daemon runs as ${sandbox.self}: agent-bot starts a harness only as its own daemon's account, so start it from a daemon running in ${account}`);
  }
  return null;
}

// --- every turn ---------------------------------------------------------------
// The owner's decision on #613 (2026-10-09): the persona policy is evaluated
// again at the start of every turn the daemon runs (launch, wake, task and
// dream turns), once for the turn. The turn is refused, as a launch is, when
// the policy cannot be evaluated or is stale, or when the pack now puts the
// soul in an account this daemon is not. Account readiness stays a launch
// question, so nothing is probed. `acceptStale` carries a launch the owner
// verified (see loadPersona) into that launch's own turn, and only that one.
export function turnSandboxProblem(agentId, { env = process.env, home = homedir(), owner = userInfo().username, acceptStale = null } = {}) {
  const settings = sandboxSettings(loadConfig({ env, home }));
  const persona = loadPersona({ env, home, acceptStale });
  const decided = decideSandbox(censusSoul(agentId, { env, home }), settings, { owner, persona });
  if (decided.refusal) return sandboxLaunchProblem({ refused: decided.refusal });
  if (decided.source === 'sop' && decided.sandboxed && decided.runsAs !== owner) {
    return sandboxLaunchProblem({ resolution: 'sandboxed', account: decided.runsAs, self: owner, status: 'ready', steps: [] });
  }
  return null;
}

// --- reads ------------------------------------------------------------------

export function readSandboxStatus({ env = process.env, home = homedir(), platform = process.platform, exec = defaultExec, fileExists = existsSync, owner = userInfo().username, config } = {}) {
  const loaded = config ?? loadConfig({ env, home });
  const settings = sandboxSettings(loaded);
  const persona = loadPersona({ env, home });
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
    sop: {
      state: persona.state,
      decides: persona.decides,
      repository: persona.repository,
      commit: persona.commit,
      recordedAt: persona.recordedAt,
      message: persona.message,
      rules: persona.mapping ? persona.mapping.rules.map((rule) => ({ match: rule.match, value: rule.value, sandbox: rule.sandbox, account: rule.account })) : [],
      default: persona.mapping ? persona.mapping.default : null,
    },
    souls: souls.map((soul) => resolveSandbox(soul, settings, { owner, persona })),
  };
}

function formatPersonaLine(sop) {
  if (!sop) return null;
  if (sop.state === 'ok') {
    const fallback = sop.default?.sandbox ? `default ${sop.default.sandbox}` : 'no default';
    return `sop: persona mapping from ${sop.repository}@${sop.commit}: ${sop.rules.length} ${sop.rules.length === 1 ? 'rule' : 'rules'}, ${fallback}`;
  }
  return `sop: ${sop.state}${sop.message ? ` (${sop.message})` : ''}`;
}

export function formatSandboxStatus(result) {
  const mark = (value) => value === true ? 'yes' : value === false ? 'no' : '?';
  const lines = [
    `sandbox ${result.enabled ? 'on' : 'off'} (${result.provider})`,
    `account: ${result.account} ${result.status}`,
    `  exists ${mark(result.checks.exists)}  standard ${mark(result.checks.standard)}  home ${mark(result.checks.home?.exists ?? null)}  dev tools ${mark(result.checks.devTools)}  paired ${mark(result.checks.paired)}  joined ${mark(result.checks.fleet)}`,
    ...(formatPersonaLine(result.sop) ? [formatPersonaLine(result.sop)] : []),
    '', 'steps',
    ...result.steps.map((step) => `  [${step.done === true ? 'x' : step.done === false ? ' ' : '?'}] ${step.id}: ${step.title}`),
  ];
  if (result.souls.length) {
    lines.push('', 'souls', ...result.souls.flatMap((soul) => [
      `  ${soul.agentId} ${soul.name}: ${soul.override}, runs as ${soul.runsAs} (${soul.source}${soul.sop?.rule ? ` ${soul.sop.rule}` : ''})`,
      ...(soul.reason ? [`    ${soul.reason}`] : []),
    ]));
  }
  return `${lines.join('\n')}\n`;
}

export function formatSandboxPlan(steps) {
  return `${steps.map((step) => [`${step.done === true ? '[x]' : step.done === false ? '[ ]' : '[?]'} ${step.title} (${step.run})`,
    ...step.commands.map((command) => `    ${command}`), ...(step.note ? [`    ${step.note}`] : [])].join('\n')).join('\n')}\n`;
}

// --- removal inventory (#750) -----------------------------------------------
// The owner's decision (2026-10-10): removing a persona account keeps by
// default and removes only what is named. Souls, workspaces and transcripts
// are exported to the owner's account and the export verified first; broker
// pairings go only after that; each retained soul keeps its census row,
// marked retired; harness sign-ins are listed, never removed; deleting the
// macOS account is a guided step the owner does by hand. Every category has
// its own owner-gated confirm, and a partial failure stops with everything
// left in place.
//
// This slice is the dry run: what is there and what would happen to it. It
// reads and runs nothing that changes anything. Another account's home is
// usually unreadable from here, so a path is reported present, absent or
// unreadable, never guessed at.

// The account's own environment cannot be read from here, so the paths in its
// home are the defaults, and a category built from them is never complete.
const ELSEWHERE = 'the account may set AGENT_BOT_SOULS_HOME, CLAUDE_CONFIG_DIR or CODEX_HOME elsewhere, which cannot be read from here';

export const REMOVAL_CATEGORIES = Object.freeze(['souls', 'workspaces', 'transcripts', 'pairings', 'census', 'harness-sign-ins', 'macos-account']);

function inspectPath(path) {
  try { statSync(path); return 'present'; }
  catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : 'unreadable'; }
}

export function sandboxRemovalInventory(account, { env = process.env, home = homedir(), platform = process.platform, exec = defaultExec, fileExists = existsSync, inspect = inspectPath, owner = userInfo().username } = {}) {
  validateSandboxAccount(account);
  if (account === owner) throw fail('sandbox-remove-self', `${account} is the account agent-bot runs as; only a persona account can be removed`);
  const checks = probeSandboxAccount(account, { platform, exec, fileExists });
  const base = { account, owner, dryRun: true, supported: checks.supported, exists: checks.exists, home: checks.home?.path ?? null };
  if (!checks.supported) return { ...base, categories: [] };
  // Only the fields the plan needs: a pairing row can carry a secret.
  const pairings = jsonOf(tryExec(exec, 'agent-comms', ['account', 'pairings']).output);
  const census = jsonOf(tryExec(exec, 'agent-comms', ['census']).output);
  const pairingRows = Array.isArray(pairings?.pairings)
    ? pairings.pairings.filter((row) => row?.account === account).map((row) => ({ account: row.account, uid: row.uid ?? null, state: row.state ?? null }))
    : null;
  const censusRows = Array.isArray(census?.souls)
    ? census.souls.filter((row) => row?.account === account).map((row) => ({ agentId: row.agentId ?? null, presence: row.presence ?? null }))
    : null;
  // Souls this machine's own census sends to the account.
  let local = [];
  try {
    const settings = sandboxSettings(loadConfig({ env, home }));
    const persona = loadPersona({ env, home });
    local = listSouls({ file: populationFile({ env, home }) })
      .map((soul) => resolveSandbox(soul, settings, { owner, persona }))
      .filter((soul) => soul.sandboxed && soul.runsAs === account)
      .map((soul) => ({ agentId: soul.agentId, name: soul.name }));
  } catch { local = null; }
  const souls = new Map();
  for (const row of local ?? []) souls.set(row.agentId, { agentId: row.agentId, name: row.name, presence: null });
  for (const row of censusRows ?? []) {
    if (!row.agentId) continue;
    souls.set(row.agentId, { name: null, ...souls.get(row.agentId), agentId: row.agentId, presence: row.presence });
  }
  const at = (path) => ({ path, state: checks.home ? inspect(path) : 'absent' });
  const under = (...parts) => (checks.home ? join(checks.home.path, ...parts) : null);
  const category = (id, action, items, note, known = true) => ({ id, action, known, items, note });
  return {
    ...base,
    categories: [
      category('souls', 'export', [...souls.values()],
        'exported to your account and verified before anything that depends on it is removed', local !== null && censusRows !== null),
      category('workspaces', 'export', checks.home ? [at(under('.agent-bot', 'souls'))] : [],
        `the souls' folders, worktrees and state at the default location; ${ELSEWHERE}`, false),
      category('transcripts', 'export', checks.home ? [at(under('.claude', 'projects')), at(under('.codex', 'sessions'))] : [],
        `harness session stores at the default locations; ${ELSEWHERE}`, false),
      category('pairings', 'remove-after-export', pairingRows ?? [],
        'removed from the broker only after the export is verified', pairingRows !== null),
      category('census', 'mark-retired', censusRows ?? [],
        'each retained soul keeps its row, marked retired, so it stays identifiable and recoverable', censusRows !== null),
      category('harness-sign-ins', 'list-only', checks.home ? [at(under('.claude')), at(under('.codex'))] : [],
        `listed only: agent-bot never removes a harness sign-in. Default locations; ${ELSEWHERE}`, false),
      category('macos-account', 'manual', checks.exists ? [{ account, home: checks.home?.path ?? null }] : [],
        'deleting the account is a guided step you do by hand after the export; agent-bot never runs it'),
    ],
  };
}

export function formatSandboxRemoval(result) {
  const lines = [`dry run: removing persona account ${result.account} (nothing is changed)`];
  if (!result.supported) return `${lines[0]}\npersona accounts need macOS; there is nothing to list\n`;
  if (!result.exists) lines.push(`${result.account} does not exist on this Mac`);
  for (const category of result.categories) {
    lines.push(`${category.id}: ${category.action}${category.known ? '' : ' (may be incomplete)'}`);
    for (const item of category.items) {
      if (item.path) lines.push(`  ${item.path} (${item.state})`);
      else if (item.agentId) lines.push(`  ${item.agentId}${item.name ? ` ${item.name}` : ''}${item.presence ? ` (${item.presence})` : ''}`);
      else if (item.uid !== undefined) lines.push(`  pairing uid ${item.uid ?? '?'} (${item.state ?? '?'})`);
      else lines.push(`  ${item.account}${item.home ? ` (home ${item.home})` : ''}`);
    }
    lines.push(`  ${category.note}`);
  }
  return `${lines.join('\n')}\n`;
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

// A soul the pack decides takes no override: the pack's persona.toml is where
// that decision changes (ADR-0274 decision 3). `inherit` is always accepted,
// so an override left from before the pack decided can be cleared.
export function sandboxOverrideProblem(resolved, override) {
  if (override === 'inherit' || resolved.source !== 'sop') return null;
  const { repository, commit, rule, sandbox } = resolved.sop;
  return fail('usage', `${resolved.name} runs ${sandbox} by the SOP pack ${repository}@${commit} (${rule}); change ${PERSONA_FILE} in the pack rather than an override here, or set the override to inherit`);
}

export function setSandboxOverride(target, override, { env = process.env, home = homedir() } = {}) {
  if (!SANDBOX_OVERRIDES.includes(override)) throw fail('usage', `override must be one of ${SANDBOX_OVERRIDES.join(', ')}`);
  const file = populationFile({ env, home });
  const soul = resolveSoul(target, file);
  const settings = sandboxSettings(loadConfig({ env, home }));
  const persona = loadPersona({ env, home });
  const refused = sandboxOverrideProblem(resolveSandbox(soul, settings, { persona }), override);
  if (refused) throw refused;
  const row = soul.sandbox === override ? soul : setSoulSandbox(soul.id, override, { file });
  return resolveSandbox(row, settings, { persona });
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
      const result = resolveSandbox(soul, sandboxSettings(loadConfig({ env, home })), { owner, persona: loadPersona({ env, home }) });
      return out(result, `${result.agentId} sandbox ${result.override}, runs as ${result.runsAs} (${result.source})\n`);
    }
    if (!SANDBOX_OVERRIDES.includes(action)) throw new Error(USAGE);
    const soul = resolveSoul(target, populationFile({ env, home }));
    // Refused before the owner gate: a pack-decided soul takes no override.
    const refused = sandboxOverrideProblem(resolveSandbox(soul, sandboxSettings(loadConfig({ env, home })), { owner, persona: loadPersona({ env, home }) }), action);
    if (refused) throw refused;
    await principalFor(`sandbox override ${soul.id} ${action}`);
    const result = setSandboxOverride(soul.id, action, { env, home });
    const runsAs = result.sandboxed ? result.runsAs : owner;
    return out({ ...result, runsAs }, `${result.agentId} sandbox ${result.override}, runs as ${runsAs} (${result.source})\n`);
  }
  if (verb === 'remove') {
    // Only the dry run exists so far (#750): removal itself comes with the
    // verified export and a confirm per category.
    const named = rest.filter((arg) => arg !== '--dry-run');
    if (presented || !rest.includes('--dry-run') || named.length > 1 || named.some((arg) => arg.startsWith('-'))) throw new Error(USAGE);
    const account = named[0] ?? sandboxSettings(loadConfig({ env, home })).account;
    const result = sandboxRemovalInventory(account, { env, home, platform, exec, owner });
    return out(result, formatSandboxRemoval(result));
  }
  if (verb === 'resolve' && rest.length === 1) {
    if (presented) throw new Error(USAGE);
    const soul = resolveSoul(rest[0], populationFile({ env, home }));
    const result = resolveSandbox(soul, sandboxSettings(loadConfig({ env, home })), { owner, persona: loadPersona({ env, home }) });
    const why = result.sop?.rule ? ` ${result.sop.rule}` : '';
    return out(result, `${result.agentId} runs as ${result.runsAs} (${result.sandboxed ? 'sandboxed' : 'unrestricted'}, ${result.source}${why})\n${result.reason ? `  ${result.reason}\n` : ''}`);
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
