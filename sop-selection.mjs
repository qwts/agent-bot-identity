// The soul's SOP selection (HQ plan §2.4, C3; #1388): which agent-sop.toml a
// soul's session selects, and the owner's trust in a foreign selection
// (ADR-0332). The pinned sources a selection names are resolved by the org
// resolver, sop-resolver.mjs. sop.mjs re-exports these names.

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { identityOp } from './daemon-client.mjs';
import { validateAgentId } from './identity-format.mjs';
import { withLock } from './file-lock.mjs';
import { soulDirectory } from './agent-population.mjs';
import { readBinding } from './identity-soul.mjs';
import { OWNER_NAME, configPathFor, fail, readConfigText, resolveSelection, sopState } from './sop-resolver.mjs';

// The session's Agent ID: the environment first, so the common case starts
// no process; only without one does identity's entry read the checkout pin
// (#645, F6).
function sessionAgentId({ env = process.env, cwd } = {}) {
  const fromEnv = env.AGENT_BOT_ID ?? env.QWTS_AGENT_ID;
  if (fromEnv) return validateAgentId(fromEnv);
  return identityOp('current', { pinOnly: true }, cwd === undefined ? {} : { cwd });
}

function trustFile(options) { return join(sopState(options), 'sop-trust.json'); }
function trustKey(repo, commit) { return `${repo.toLowerCase()}@${commit}`; }

export function isSopTrustAccepted(repo, commit, options = {}) {
  if (!repo || !commit) return false;
  return readTrust(options).accepted.includes(trustKey(repo, commit));
}

function readTrust(options) {
  const file = trustFile(options);
  try {
    if (lstatSync(file).isSymbolicLink()) fail('trust-invalid', 'SOP trust file must not be a symlink');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record.schemaVersion !== 1 || !Array.isArray(record.accepted)
      || !record.accepted.every((key) => typeof key === 'string')) fail('trust-invalid', 'invalid SOP trust record');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, accepted: [] };
    throw error;
  }
}

export function acceptSopTrust(report, repo, options = {}) {
  const selected = report.repositories?.sop;
  if (!OWNER_NAME.test(repo) || !selected || repo.toLowerCase() !== selected.repository.toLowerCase()) {
    fail('trust-invalid', 'trust must name the selected SOP repository; use --soul ID to select its soul');
  }
  const dir = sopState(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = trustFile(options);
  withLock(`${file}.lock`, 'SOP trust', () => {
    const record = readTrust(options);
    const key = trustKey(selected.repository, selected.commit);
    if (!record.accepted.includes(key)) record.accepted.push(key);
    const temp = mkdtempSync(join(dir, '.sop-trust-'));
    try {
      const pending = join(temp, 'record');
      writeFileSync(pending, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(pending, 0o600);
      renameSync(pending, file);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}

export function resolveSop(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  let current = null;
  if (!options.soul) {
    try { current = (options.currentAgentId ?? sessionAgentId)({ env, cwd: options.cwd ?? process.cwd() }); }
    catch (error) { if (error.status !== 128) throw error; }
  }
  const identity = options.soul ?? current
    ?? (options.readBinding ?? readBinding)({ env, cwd: options.cwd ?? process.cwd() })?.agentId;
  const soulDir = identity ? (options.soulDirectory ?? soulDirectory)(identity, { home, env, ...options.populationOptions }) : null;
  const userPath = options.configPath ?? configPathFor(home);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const soulPath = soulDir ? join(soulDir, 'agent-sop.toml') : null;
  const soulText = soulPath ? readConfigText(soulPath, readFile) : null;
  const userText = Object.hasOwn(options, 'configText') ? options.configText : readConfigText(userPath, readFile);
  const source = soulText !== null ? 'soul' : userText !== null ? 'user' : 'none';
  const report = resolveSelection({ ...options, configText: soulText ?? userText, configPath: soulText !== null ? soulPath : userPath });
  report.selection = { source, path: source === 'none' ? null : report.configPath };
  if (soulDir) report.soul = { agentId: identity, directory: soulDir };
  if (source === 'soul') {
    // Resolve the user's effective SOP too: it can be selected through org.json.
    const user = userText === null ? null : resolveSelection({ ...options, configText: userText, configPath: userPath });
    const foreign = !user
      || user.repositories.org.repository.toLowerCase() !== report.repositories.org.repository.toLowerCase()
      || user.repositories.sop.repository.toLowerCase() !== report.repositories.sop.repository.toLowerCase();
    if (foreign) {
      const { repository: repo, commit } = report.repositories.sop;
      report.trust = {
        required: true,
        reason: user ? 'Soul selects a different organization or SOP repository from the user' : 'Soul selects an SOP repository without a user selection',
        repo,
        accepted: readTrust(options).accepted.includes(trustKey(repo, commit)),
      };
    }
  }
  return report;
}
