#!/usr/bin/env node
// agent-bot sop — resolve per-soul SOP selections and read reference documents.
//
// Live org/SOP discovery (qwts-agent-org#66): bare owner/name selects the
// current remote default branch. Explicit @ref selections remain binding.
// Resolve each selected head once per operation and read at that exact SHA.
// Legacy sources.sop.ref is provenance only; capabilities remain pinned.
// No clone, checkout, execution, or implicit policy/persona activation.

import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { withLock } from './file-lock.mjs';
import process from 'node:process';
import { assertOwnerAction } from './owner-action.mjs';
import { pathToFileURL } from 'node:url';
import { ACP_SPAWN_REGISTRY } from './acp-registry.mjs';
import { evaluateSopPolicy, parseSopPolicy } from './sop-policy.mjs';
import {
  COMMIT_SHA, OWNER_NAME, PERSONA_FILE, POLICY_FILE, REFERENCE_HEADER, SCHEMA_VERSION, configPathFor, defaultRunGit, fail,
  githubRemote, isObject, listSopDocuments, loadSopConfig, oneLine, readConfigText, readRepoFile, recordSopPersona,
  resolveSelection, safePath, showSopDocument, sopState, trustNotice,
} from './sop-resolver.mjs';
import { acceptSopTrust, resolveSop } from './sop-selection.mjs';

// The org resolver's and the soul selection's names this file exported
// before the split (#1388).
export {
  PERSONA_FILE, POLICY_FILE, REFERENCE_HEADER, SOP_GIT_COMMANDS, SopError, assertSopGitCommand, cachedDocuments, configPathFor, createRunGit, defaultRunGit, gitSubcommand, githubRemote, listSopDocuments, loadSopConfig, parseOrgPins, parseTomlSubset, parseWorkflowToml, personaRecordFile, readRemoteSopWorkflows, readRepoFile, readSelectedOrganizationProfile, readSopLastGood, readSopPersonaRecord, recordSopLastGood, recordSopPersona, showSopDocument, sopGitEnv, sopLastGoodFile,
} from './sop-resolver.mjs';
export { acceptSopTrust, isSopTrustAccepted, resolveSop } from './sop-selection.mjs';

export const USAGE = `usage: agent-bot sop [--json] [--config <path>] [--soul ID]
       agent-bot sop list [--soul ID] [--workflow NAME] [--json]
       agent-bot sop show PATH [--soul ID] [--workflow NAME]
       agent-bot sop trust REPO [--soul ID]
       agent-bot sop persona [--json]
       agent-bot sop policy show [--json]
       agent-bot sop policy activate|deactivate [--principal-stdin] [--json]

Resolve the soul's agent-sop.toml, then ~/.config/agent-sop/config.toml
(ENG-0355), then no SOP. The soul's sop/ documents override repository
Markdown at the same path. workflows/NAME.toml lists sop = ["path.md"].
Bare owner/name selects the current default branch; explicit @ref is preserved.
The declared SOP follows its default branch; legacy org.json SOP refs are baselines.
Foreign soul selections require explicit trust of the resolved repo + commit.
Fetched documents are cached read-only and never executed or applied;
reference documentation does not override harness or user instructions.
With no config file, report that no SOP is in effect and exit 0.
persona resolves the user's SOP, reads persona.toml at its commit (the
pack's persona mapping: which souls run in their own macOS account) and
records it for offline use by agent-bot sandbox and the daemon's launch.
policy activate (owner only) reads policy-hooks.json at the user's SOP
commit, validates it and pins it; the daemon's launches then apply its
deny rules offline. show reports what is active and what it covers.
`;

// --- selected-pack launch policy (#677) ----------------------------------------
// The owner activates the user's SOP's policy-hooks.json at its resolved
// commit (docs/sop-policy-hooks.md). The exact bytes are kept in
// sop-policy/records/<sha256>.json; sop-policy/state.json is the marker that
// names the active digest and the pinned selection, or records an explicit
// deactivation. The record is written before the marker is swapped, under a
// lock, so a partial write leaves the previous marker in force. Launch reads
// both offline, without the lock, and re-validates on every use.

// Every route through the daemon's launch handler, and what it does not reach.
export const POLICY_COVERAGE = Object.freeze({
  covered: Object.freeze(['before-launch: package launch, relaunch, team start']),
  notCovered: 'wake/resume, bind, spawn, send, commit, push, and processes started outside agent-bot',
});
const POLICY_STATE_FIELDS = ['schemaVersion', 'active', 'digest', 'org', 'sop', 'selection', 'account', 'changedAt', 'authorization'];
const POLICY_REPAIR = 'reactivate with `agent-bot sop policy activate`, or turn it off with `agent-bot sop policy deactivate`';
const DIGEST = /^[0-9a-f]{64}$/;

function policyDir(options) { return join(sopState(options), 'sop-policy'); }
export function policyStateFile(options = {}) { return join(policyDir(options), 'state.json'); }
function policyRecordFile(options, digest) { return join(policyDir(options), 'records', `${digest}.json`); }
function sha256(text) { return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'); }
// The local selection the activation was made under: the user's [repos]
// table as written. Editing it requires an explicit reactivation.
function selectionFingerprint(config) { return sha256(JSON.stringify(config.repos)); }
function canonicalHarnesses(options) { return options.canonicalHarnesses ?? Object.keys(ACP_SPAWN_REGISTRY); }
function currentAccount(options) { return options.account ?? userInfo().username; }

function writeAtomic(dir, file, text) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(dir, '.sop-policy-'));
  try {
    const pending = join(temp, 'record');
    writeFileSync(pending, text, { mode: 0o600, flag: 'wx' });
    chmodSync(pending, 0o600);
    renameSync(pending, file);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

// One open, never through a link, and never blocking on a FIFO: the launch
// path reads these on every launch, so a replaced file must not stall the
// daemon or exhaust its memory. ENOENT stays distinguishable.
const POLICY_MARKER_MAX = 16 * 1024;
const POLICY_RECORD_MAX = 256 * 1024;
function readPrivateJson(file, what, limit) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) fail('policy-unavailable', `${what} must be a regular file of at most ${limit} bytes`);
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

// Online: resolve the user's SOP (never a soul's), read policy-hooks.json at
// the SOP commit and validate it completely. Nothing is written. A commit
// without the file is an error: asking to activate is not deactivating.
// `readPolicyText(repo, commit)` is injectable for tests.
export function prepareSopPolicy(options = {}) {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? configPathFor(home);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const userText = Object.hasOwn(options, 'configText') ? options.configText : readConfigText(configPath, readFile);
  if (userText === null) fail('policy-unavailable', `no SOP is selected at ${configPath}; select one before activating its policy`);
  const report = resolveSelection({ ...options, configText: userText, configPath, missingConfig: 'error' });
  const { repository, commit } = report.repositories.sop;
  const text = options.readPolicyText
    ? options.readPolicyText(repository, commit)
    : readRepoFile(repository, commit, POLICY_FILE, { runGit: options.runGit ?? defaultRunGit,
      remoteUrl: options.remoteUrl ?? githubRemote, makeTemp: options.makeTemp, required: false });
  if (text === null) fail('policy-unavailable', `${repository}@${commit} has no ${POLICY_FILE}; nothing was activated`);
  const policy = parseSopPolicy(text, { canonicalHarnesses: canonicalHarnesses(options) });
  return {
    text, policy, digest: sha256(text),
    org: { repository: report.repositories.org.repository, commit: report.repositories.org.commit },
    sop: { repository, commit },
    selection: selectionFingerprint(loadSopConfig(userText)),
  };
}

function swapPolicyState(options, state, record = null) {
  const dir = policyDir(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  withLock(join(dir, 'state.lock'), 'SOP policy', () => {
    if (record) {
      const file = policyRecordFile(options, record.digest);
      writeAtomic(dirname(file), file, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, digest: record.digest, policy: record.text })}\n`);
    }
    writeAtomic(dir, policyStateFile(options), `${JSON.stringify(state)}\n`);
  });
  return state;
}

// `authorization` is the owner gate's proof method, never a credential.
export function activateSopPolicy(prepared, authorization, options = {}) {
  return swapPolicyState(options, {
    schemaVersion: SCHEMA_VERSION, active: true, digest: prepared.digest, org: prepared.org, sop: prepared.sop,
    selection: prepared.selection, account: currentAccount(options),
    changedAt: (options.now ?? (() => new Date()))().toISOString(), authorization,
  }, prepared);
}

// The marker stays, inactive, as the receipt of an explicit deactivation.
export function deactivateSopPolicy(authorization, options = {}) {
  return swapPolicyState(options, {
    schemaVersion: SCHEMA_VERSION, active: false, digest: null, org: null, sop: null, selection: null,
    account: currentAccount(options), changedAt: (options.now ?? (() => new Date()))().toISOString(), authorization,
  });
}

// Offline and never throws: no git, no network, no lock. `state` is one of
//   none         never configured: no marker
//   inactive     the owner deactivated it
//   active       `policy` is the validated policy pinned at `sop.commit`
//   unavailable  a marker that cannot be honoured: missing, corrupt or
//                mismatched record, a changed selection, another account,
//                or a rule this runtime no longer understands
export function readSopPolicyState(options = {}) {
  const home = options.home ?? homedir();
  const configPath = options.configPath ?? configPathFor(home);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const unavailable = (why) => ({ state: 'unavailable', message: `the active SOP policy is unavailable: ${why}; ${POLICY_REPAIR}` });
  let marker;
  try { marker = readPrivateJson(policyStateFile(options), 'the SOP policy marker', POLICY_MARKER_MAX); }
  catch (error) {
    if (error.code !== 'ENOENT') return unavailable('its marker is unreadable');
    // Never configured only when nothing was ever written: a policy
    // directory without its marker is an interrupted activation.
    try { lstatSync(policyDir(options)); }
    catch (dirError) { if (dirError.code === 'ENOENT') return { state: 'none', message: 'No SOP policy is active.' }; }
    return unavailable('its marker is missing (an interrupted activation)');
  }
  try {
    const sane = isObject(marker) && marker.schemaVersion === SCHEMA_VERSION && typeof marker.active === 'boolean'
      && Object.keys(marker).length === POLICY_STATE_FIELDS.length && POLICY_STATE_FIELDS.every((key) => Object.hasOwn(marker, key))
      && typeof marker.changedAt === 'string' && typeof marker.authorization === 'string' && typeof marker.account === 'string';
    if (!sane) return unavailable('its marker is invalid');
    if (marker.account !== currentAccount(options)) return unavailable('it was changed for another account');
    if (!marker.active) {
      // Turning enforcement off needs the complete deactivation receipt.
      if (['digest', 'org', 'sop', 'selection'].some((key) => marker[key] !== null)) return unavailable('its marker is invalid');
      return { state: 'inactive', changedAt: marker.changedAt, message: 'The SOP policy was deactivated by the owner.' };
    }
    const pinned = isObject(marker.org) && isObject(marker.sop) && DIGEST.test(marker.digest ?? '') && DIGEST.test(marker.selection ?? '')
      && OWNER_NAME.test(marker.sop.repository ?? '') && COMMIT_SHA.test(marker.sop.commit ?? '')
      && OWNER_NAME.test(marker.org.repository ?? '') && COMMIT_SHA.test(marker.org.commit ?? '');
    if (!pinned) return unavailable('its marker is invalid');
    const where = { digest: marker.digest, org: marker.org, sop: marker.sop, changedAt: marker.changedAt };
    let record;
    try { record = readPrivateJson(policyRecordFile(options, marker.digest), 'the SOP policy record', POLICY_RECORD_MAX); }
    catch { return { ...unavailable('its record is missing or unreadable'), ...where }; }
    const envelope = isObject(record) && record.schemaVersion === SCHEMA_VERSION && Object.keys(record).length === 3
      && ['schemaVersion', 'digest', 'policy'].every((key) => Object.hasOwn(record, key));
    if (!envelope) return { ...unavailable('its record has an unsupported format'), ...where };
    if (record.digest !== marker.digest || typeof record.policy !== 'string' || sha256(record.policy) !== marker.digest) {
      return { ...unavailable('its record does not match the activated digest'), ...where };
    }
    const userText = readConfigText(configPath, readFile);
    if (userText === null || selectionFingerprint(loadSopConfig(userText)) !== marker.selection) {
      return { ...unavailable('the SOP selection changed since it was activated'), ...where };
    }
    let policy;
    try { policy = parseSopPolicy(record.policy, { canonicalHarnesses: canonicalHarnesses(options) }); }
    catch (error) { return { ...unavailable(`this runtime cannot apply it (${error.message})`), ...where }; }
    return { state: 'active', ...where, policy };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

const shortCommit = (commit) => commit.slice(0, 12);

// The launch check the daemon wires into its handler. Null lets the launch
// continue to its own checks; otherwise `{ code, message, ... }` is the
// refusal: `policy-denied` for a matching rule, `policy-unavailable` for an
// active marker that cannot be honoured. `harness` is the resolved key.
export function checkSopLaunchPolicy(harness, options = {}) {
  const current = readSopPolicyState(options);
  if (current.state === 'none' || current.state === 'inactive') return null;
  if (current.state !== 'active') return { code: 'policy-unavailable', message: current.message, ...(current.sop ? { sop: current.sop, digest: current.digest } : {}) };
  let verdict;
  try { verdict = evaluateSopPolicy(current.policy, { event: 'before-launch', harness }, { canonicalHarnesses: canonicalHarnesses(options) }); }
  catch (error) { return { code: 'policy-unavailable', message: `the SOP policy cannot evaluate this launch: ${error.message}`, sop: current.sop, digest: current.digest }; }
  if (verdict.decision !== 'deny') return null;
  return { code: 'policy-denied', ruleId: verdict.ruleId, reason: verdict.reason, sop: current.sop, digest: current.digest,
    message: `SOP policy rule ${verdict.ruleId} (${current.sop.repository}@${shortCommit(current.sop.commit)}) denies launching on ${harness}: ${verdict.reason}` };
}

export function formatSopPolicyState(result) {
  const lines = [];
  if (result.state === 'active') {
    const { rules } = result.policy;
    lines.push(`SOP policy active: ${result.sop.repository}@${result.sop.commit}`, `digest: ${result.digest}`, `activated: ${result.changedAt}`,
      `rules: ${rules.length ? rules.length : 'none (no additional policy)'}`);
    for (const rule of rules) lines.push(`  ${rule.id}: ${rule.event} deny ${rule.when.harnesses ? rule.when.harnesses.join(', ') : 'every harness'}: ${oneLine(rule.reason)}`);
  } else {
    lines.push(oneLine(result.message));
  }
  lines.push(`Covers ${POLICY_COVERAGE.covered.join('; ')}.`, `Not covered: ${POLICY_COVERAGE.notCovered}.`,
    'A soul starting its team is refused by a deny rule; an owner launch it denies asks for Touch ID or a password to override, and is recorded.');
  return `${lines.join('\n')}\n`;
}

function appendRepo(lines, role, repo) {
  lines.push(`${role}:`);
  if (!repo) {
    lines.push('  none');
    return;
  }
  lines.push(`  repository: ${repo.repository}`);
  lines.push(`  ref: ${repo.ref}`);
  lines.push(`  commit: ${repo.commit}`);
  lines.push(`  selected: ${repo.selected}`);
}

export function formatSopReport(report) {
  if (!report.inEffect) return `${report.message ?? 'No SOP is in effect.'}\n${trustNotice(report)}`;
  const lines = ['SOP in effect', ''];
  if (report.soul) {
    lines.push(`soul: ${report.soul.agentId}`, `selection: ${report.selection.source} (${oneLine(report.selection.path)})`, '');
  }
  for (const role of ['org', 'sop', 'comms']) {
    appendRepo(lines, role, report.repositories[role]);
    lines.push('');
  }
  const pinned = report.orgJson;
  lines.push(`org.json at ${pinned.repository}@${pinned.commit} (reported, not applied):`);
  lines.push(`  organization: ${oneLine(pinned.organization.id)}`);
  lines.push(`  account: ${oneLine(pinned.organization.account)}`);
  lines.push(`  profile: ${oneLine(pinned.organization.profile)}`);
  for (const [name, source] of Object.entries(pinned.sources)) {
    lines.push(`  source ${name}: ${source.repository}@${source.ref}`);
    lines.push(`    entry: ${oneLine(source.entry)}`);
    lines.push(`    summary: ${oneLine(source.summary)}`);
  }
  const capabilities = Object.entries(pinned.capabilities);
  if (capabilities.length === 0) lines.push('  capabilities: none');
  for (const [name, capability] of capabilities) {
    lines.push(`  capability ${name}: ${capability.repository}@${capability.commit}`);
    lines.push(`    entry: ${oneLine(capability.entry)}`);
    lines.push(`    summary: ${oneLine(capability.summary)}`);
  }
  return `${lines.join('\n')}\n${trustNotice(report)}`;
}

export function formatPersonaRecord(result) {
  if (!result.inEffect) return `${result.message ?? 'No SOP is in effect.'} Nothing recorded.\n`;
  const lines = [`SOP ${result.sop.repository}@${result.sop.commit}`];
  if (result.mapping) {
    const { rules, default: fallback } = result.mapping;
    lines.push(`persona mapping recorded: ${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}, default ${fallback.sandbox ?? 'user setting'}${fallback.account ? ` (account ${fallback.account})` : ''}`);
    for (const rule of rules) lines.push(`  ${rule.match}:${rule.value}: ${rule.sandbox}${rule.account ? ` as ${rule.account}` : ''}`);
    lines.push('agent-bot sandbox status shows what each soul gets.');
  } else if (result.error) {
    lines.push(`persona mapping recorded, but invalid: ${oneLine(result.error.message)}`, 'Launches are refused until the pack is fixed (#613).');
  } else {
    lines.push(`no ${PERSONA_FILE} at this commit: the user's sandbox setting applies.`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseSopArgs(argv) {
  const parsed = { help: false, json: false, configPath: null, soul: null, workflow: null, command: 'report', target: null };
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { ...parsed, help: true };
  if (argv[0] === 'policy') {
    // The user's selection only: no --soul or --config, so a soul cannot
    // pick the policy its account runs under.
    const verb = argv[1];
    if (!['show', 'activate', 'deactivate'].includes(verb)) fail('usage', 'policy requires show, activate or deactivate');
    const flags = argv.slice(2);
    const allowed = verb === 'show' ? ['--json'] : ['--json', '--principal-stdin'];
    if (flags.some((flag) => !allowed.includes(flag)) || new Set(flags).size !== flags.length) fail('usage', `unexpected arguments: ${flags.join(' ')}`);
    return { ...parsed, command: 'policy', target: verb, json: flags.includes('--json'), principal: flags.includes('--principal-stdin') };
  }
  let i = 0;
  if (['list', 'show', 'trust', 'persona'].includes(argv[0])) {
    parsed.command = argv[i++];
    if (['show', 'trust'].includes(parsed.command)) {
      parsed.target = argv[i++];
      if (!parsed.target || parsed.target.startsWith('-')) fail('usage', `${parsed.command} requires a path or repository`);
    }
  }
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json' && !parsed.json) { parsed.json = true; continue; }
    const key = { '--config': 'configPath', '--soul': 'soul', '--workflow': 'workflow' }[arg];
    if (key && !parsed[key] && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      parsed[key] = argv[++i];
      continue;
    }
    fail('usage', `unexpected arguments: ${arg}`);
  }
  if (parsed.workflow && !['list', 'show'].includes(parsed.command)) fail('usage', '--workflow requires list or show');
  if (parsed.json && ['show', 'trust'].includes(parsed.command)) fail('usage', '--json requires report, list or persona');
  if (parsed.command === 'persona' && (parsed.soul || parsed.configPath)) fail('usage', 'persona reads the user\'s SOP selection only');
  return parsed;
}

// `sop policy` (#677). Activation and deactivation are the owner's: the
// existing owner gate (Touch ID or the login password through keyd, the
// administrator dialog, or a principal on stdin), never a soul's binding.
// Activation resolves and validates first, so the owner approves a concrete
// repository and commit; nothing is written until the gate passes.
async function policyCommand(parsed, deps, writeOut, writeErr) {
  const assertOwner = deps.assertOwner ?? ((action, { principal }) => assertOwnerAction(action, { principal }));
  const readStdin = deps.readStdin ?? (() => readFileSync(0, 'utf8'));
  const show = (result) => {
    writeOut(parsed.json ? `${JSON.stringify({ ...result, coverage: POLICY_COVERAGE })}\n` : formatSopPolicyState(result));
    return result.state === 'unavailable' ? 1 : 0;
  };
  try {
    if (parsed.target === 'show') return show(readSopPolicyState(deps));
    let principal = null;
    if (parsed.principal) {
      try { principal = JSON.parse(readStdin()); }
      catch { fail('usage', '--principal-stdin needs the principal credential as JSON on stdin'); }
    }
    if (parsed.target === 'activate') {
      const prepared = prepareSopPolicy(deps);
      const proof = await assertOwner(`sop policy activate ${prepared.sop.repository}@${prepared.sop.commit}`, { principal });
      activateSopPolicy(prepared, proof?.method ?? 'owner', deps);
    } else {
      const proof = await assertOwner('sop policy deactivate', { principal });
      deactivateSopPolicy(proof?.method ?? 'owner', deps);
    }
    return show(readSopPolicyState(deps));
  } catch (error) {
    writeErr(`agent-bot sop: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const writeOut = deps.writeStdout ?? ((text) => { process.stdout.write(text); });
  const writeErr = deps.writeStderr ?? ((text) => { process.stderr.write(text); });
  let parsed;
  try {
    parsed = parseSopArgs(argv);
  } catch (error) {
    writeErr(`agent-bot sop: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    writeOut(USAGE);
    return 0;
  }
  if (parsed.command === 'policy') return policyCommand(parsed, deps, writeOut, writeErr);
  if (parsed.command === 'persona') {
    // The pack's persona mapping, read online and recorded for the sandbox
    // (ADR-0274 decision 3). The parser lives beside the sandbox, which
    // owns account names; it is imported here on demand to keep sop.mjs
    // free of that dependency.
    return import('./sandbox.mjs').then(({ parsePersonaMapping }) => {
      const record = recordSopPersona(deps);
      const result = { ...record, persona: undefined, mapping: null, error: null };
      if (record.inEffect && record.persona !== null) {
        try { result.mapping = parsePersonaMapping(record.persona); }
        catch (error) { result.error = { code: error.code ?? 'persona-invalid', message: error.message }; }
      }
      writeOut(parsed.json ? `${JSON.stringify(result)}\n` : formatPersonaRecord(result));
      return result.error ? 1 : 0;
    }, (error) => {
      writeErr(`agent-bot sop: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    });
  }
  try {
    const options = {
      ...deps,
      soul: parsed.soul ?? deps.soul,
      configPath: parsed.configPath ?? deps.configPath,
      missingConfig: parsed.configPath ? 'error' : 'absent',
    };
    const report = resolveSop(options);
    if (parsed.command === 'trust') {
      // Trusting another org's SOP is the owner's decision (ADR-0332
      // decision 9): a soul must not accept its own selection.
      const assertOwner = deps.assertOwner ?? ((action) => assertOwnerAction(action));
      return Promise.resolve()
        .then(() => assertOwner(`trusting SOP repository ${parsed.target}`))
        .then(() => {
          acceptSopTrust(report, parsed.target, options);
          writeOut(`Trusted ${report.repositories.sop.repository}@${report.repositories.sop.commit} for reference documentation.\n`);
          return 0;
        }, (error) => {
          writeErr(`agent-bot sop: ${error instanceof Error ? error.message : String(error)}\n`);
          return 1;
        });
    }
    if (parsed.command === 'report') {
      writeOut(parsed.json ? `${JSON.stringify(report)}\n` : formatSopReport(report));
    } else {
      if (parsed.command === 'show') safePath(parsed.target);
      const documents = listSopDocuments(report, { ...options, workflow: parsed.workflow });
      if (parsed.command === 'list') {
        writeOut(parsed.json ? `${JSON.stringify({ ...report, documents })}\n`
          : `${trustNotice(report)}${documents.map((doc) => `${oneLine(doc.path)} (${doc.source}${doc.commit ? ` @ ${doc.commit}` : ''})`).join('\n')}${documents.length ? '\n' : ''}`);
      } else {
        const content = showSopDocument(report, parsed.target, { ...options, workflow: parsed.workflow, documents });
        writeOut(`${REFERENCE_HEADER}\n${content}`);
      }
    }
    return 0;
  } catch (error) {
    writeErr(`agent-bot sop: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  Promise.resolve(main()).then((code) => { process.exitCode = code; });
}
