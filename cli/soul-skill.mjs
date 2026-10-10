#!/usr/bin/env node
// Library operations are separate from application-skill disclosure.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { importSkill, listSkills, showSkill, verifySkill, checkSkill, planSkillUpdate, applySkillUpdate, recoverSkillUpdate } from '../skill-library.mjs';
import { skillLearningPacket, proposeSkillLearning, readLearningOutcome } from '../skill-learning.mjs';
import { checkSoulSkillSource, proposeSoulSkillCandidate } from '../skill-source-check.mjs';
import { NOT_CAPTURED } from '../skill-references.mjs';
import { currentAgentId } from '../agent-identity.mjs';
import { discardRevisionStaging, revisionCommand, revisionOwnerGate } from '../soul-revisions.mjs';
import { stageSkillInstall, stageSkillUninstall, trashSoulSkill } from '../skill-install.mjs';
import { loadGlobalSkill, loadSkill, unloadGlobalSkill, unloadSkill } from '../skill-workspace.mjs';
import { assertOwnerAction, presenceOrConsent, soulMarkers } from '../owner-action.mjs';
import { soulDreamCommand } from './soul-dream.mjs';

export const USAGE = `usage: agent-bot soul skill import PATH_OR_HTTPS_DOCUMENT [--json]
       agent-bot soul skill list [--json]
       agent-bot soul skill show UUID [--json]
       agent-bot soul skill verify UUID [--json]
       agent-bot soul skill check UUID [--json]
       agent-bot soul skill check UUID --soul AGENT_ID [--json]
       agent-bot soul skill update UUID --check CHECK_ID [--json]
       agent-bot soul skill update UUID --check CHECK_ID --apply --expected-accepted DIGEST --expected-local DIGEST [--json]
       agent-bot soul skill update UUID --recover [--json]
       agent-bot soul skill learn UUID --soul AGENT_ID [--json]
       agent-bot soul skill learn UUID --soul AGENT_ID --package STAGING --outcome FILE --reason TEXT [--json]
       agent-bot soul skill learn UUID --soul AGENT_ID --candidate DIGEST --package STAGING --outcome FILE --reason TEXT [--json]
       agent-bot soul skill install UUID|NAME --soul AGENT_ID [--json] [--principal-stdin]
       agent-bot soul skill uninstall NAME --soul AGENT_ID [--trash] [--json] [--principal-stdin]
       agent-bot soul skill load NAME --soul AGENT_ID --workspace WORKTREE [--harness HARNESS] [--json]
       agent-bot soul skill unload NAME --soul AGENT_ID --workspace WORKTREE [--harness HARNESS] [--json]
       agent-bot soul skill load NAME --soul AGENT_ID --global --reason TEXT [--harness claude] [--json] [--principal-stdin]
       agent-bot soul skill unload NAME --soul AGENT_ID --global [--harness claude] [--json]
       agent-bot soul skill dream --soul ID|NAME --schedule PT<N>H|--run-now|--pause|--unschedule|--cancel RUN_ID|--ack-notice NOTICE_ID|--status|--history [--json]

Local import preserves the selected directory; HTTPS import captures a skill
document and supported inline instruction links. Public GitHub tree URLs preserve
the selected directory at one resolved commit. Neither executes content.
install copies the library's editable copy into the soul's skills/<name>/ with
a file-hash record; uninstall archives it to archive/skills/<name>/ in the soul,
or with --trash (owner only) moves it to the OS trash. The owner's install or
uninstall applies as an owner-approved revision edit; a soul's is a proposal
under its revision policy.
load copies an installed skill into one of the soul's worktrees at the
harness's skills folder (.claude/skills/<name>/ by default) while the work
needs it, keeping it out of commits through the repository's local
info/exclude; unload removes that copy, refusing if it was edited there.
load --global places it in the harness's user-level skills folder
(~/.claude/skills/<name>/, or $CLAUDE_CONFIG_DIR/skills/), where every session
sees it: opt-in, with a recorded --reason, and only after the owner approves
(the owner gate; Touch ID through keyd when a soul asks for itself). unload
--global removes it when unchanged, only for the soul the owner's record names.
Other repository adapters remain unimplemented.
check never replaces accepted snapshots or local edits. update previews a recorded
check; applying requires reviewed digests and preserves prior material. learn supplies guidance;
recording outcomes proposes reviewed adaptations through the soul revision policy.
check --soul reads accepted portable provenance without the local library and
stages source bytes for review. learn --candidate refetches that reviewed digest
and proposes it through the soul revision policy; nothing applies it directly.
dream manages daemon-run maintenance; see agent-bot soul skill dream --help.
Results carry notCaptured: only these commands capture and recheck instruction
files; what a harness fetches or reads on its own (web fetch, MCP tools) is not.
`;
// Every successful report states what capture leaves out (#312).
const report = (result, json) => `${JSON.stringify({ ...result, notCaptured: NOT_CAPTURED }, null, json ? 0 : 2)}\n`;
async function portableCheckMain(args, json, { stdout, stderr, assertSoulTarget = id => {
  if (currentAgentId() !== id) throw new Error('a soul may check portable sources only for its own package; bind an Agent ID first');
}, ...options }) {
  const [id, flag, agentId] = args;
  if (args.length !== 3 || !id || id.startsWith('--') || flag !== '--soul' || !agentId || agentId.startsWith('--')) { stderr.write(USAGE); return 2; }
  try {
    await assertSoulTarget(agentId);
    const result = await checkSoulSkillSource(id, agentId, options);
    stdout.write(report(result, json));
    return result.status === 'unavailable' ? 1 : 0;
  } catch (error) {
    const failure = { code: error.code ?? 'skill-source-check-failed', message: error.message };
    if (json) stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else stderr.write(`agent-bot soul skill: ${failure.code}: ${failure.message}\n`);
    return 1;
  }
}
async function learningMain(args, json, { stdout, stderr, assertSoulTarget = id => {
  if (currentAgentId() !== id) throw new Error('a soul may record learning only for its own package; bind an Agent ID first');
}, ...options }) {
  const [id, ...rest] = args, parsed = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--soul', '--candidate', '--package', '--outcome', '--reason'].includes(key) || Object.hasOwn(parsed, key) || !rest[i + 1] || rest[i + 1].startsWith('--')) { stderr.write(USAGE); return 2; }
    parsed[key] = rest[i + 1];
  }
  const recording = ['--package', '--outcome', '--reason'].some(key => key in parsed);
  if (!id || !parsed['--soul'] || ((recording || '--candidate' in parsed) && !['--package', '--outcome', '--reason'].every(key => key in parsed))) { stderr.write(USAGE); return 2; }
  try {
    const agentId = parsed['--soul'];
    if (recording) await assertSoulTarget(agentId);
    const record = '--candidate' in parsed ? proposeSoulSkillCandidate : proposeSkillLearning;
    const result = recording ? await record(id, agentId, parsed['--package'], readLearningOutcome(parsed['--outcome']), {
      ...options, reason: parsed['--reason'], ...('--candidate' in parsed ? { candidate: parsed['--candidate'] } : {}), propose: (id, tree, proposalOptions) => revisionCommand(['propose', id, tree, parsed['--reason']], { ...proposalOptions, assertSoulTarget }),
    }) : skillLearningPacket(id, agentId, options);
    stdout.write(report(result, json));
    return result.proposal?.status === 'rejected' ? 1 : 0;
  } catch (error) {
    const failure = { code: error.code ?? 'skill-learning-failed', message: error.message };
    if (json) stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else stderr.write(`agent-bot soul skill: ${failure.code}: ${failure.message}\n`);
    return 1;
  }
}
function updateMain(args, json, { stdout, stderr, ...options }) {
  const [id, ...rest] = args, parsed = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!['--check', '--apply', '--expected-accepted', '--expected-local', '--recover'].includes(key) || Object.hasOwn(parsed, key)) { stderr.write(USAGE); return 2; }
    if (['--apply', '--recover'].includes(key)) parsed[key] = true;
    else { const value = rest[++i]; if (!value || value.startsWith('--')) { stderr.write(USAGE); return 2; } parsed[key] = value; }
  }
  const recover = parsed['--recover'], apply = parsed['--apply'];
  if (!id || id.startsWith('--') || (recover ? Object.keys(parsed).length !== 1 : !parsed['--check']
    || (apply ? !parsed['--expected-accepted'] || !parsed['--expected-local'] : Object.keys(parsed).length !== 1))) { stderr.write(USAGE); return 2; }
  try {
    const result = recover ? recoverSkillUpdate(id, options) : apply ? applySkillUpdate(id, parsed['--check'], {
      ...options, expectedAccepted: parsed['--expected-accepted'], expectedLocal: parsed['--expected-local'],
    }) : planSkillUpdate(id, parsed['--check'], options);
    stdout.write(report(result, json));
    return result.status === 'conflicted' ? 1 : 0;
  } catch (error) {
    const failure = { code: error.code ?? 'skill-update-failed', message: error.message };
    if (json) stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else stderr.write(`agent-bot soul skill: ${failure.code}: ${failure.message}\n`);
    return 1;
  }
}
// A soul's own request to loosen reaches the owner the way the daemon's
// loosening does (agent-daemon.mjs): keyd's Touch ID or login password only,
// no signed challenge and no administrator dialog, since the soul runs it.
const noLooseningDialog = async () => { throw Object.assign(new Error('agent-bot-keyd could not ask, and a soul\'s global load has no administrator-dialog fallback'), { code: 'presence-unavailable' }); };
const askOwnerForSoul = (action, { env, presence }) => presenceOrConsent(action, { env, presence, allowChallenge: false, consent: noLooseningDialog });
// load/unload (#603) place an installed skill in one of the soul's own
// worktrees and take it out again. The package is unchanged, so there is no
// revision; a soul may do this only for itself. --global reaches every
// session of the harness instead, which loosens what the soul's skill
// touches: like a global tool home (#617), the owner approves it even when
// the soul asks for itself, and a soul cannot present the owner's principal.
async function loadMain(verb, args, json, { stdout, stderr, markers = soulMarkers, readStdin = () => readFileSync(0, 'utf8'),
  ownerGate = (action, options) => assertOwnerAction(action, { ...options, detect: false }), askOwner = askOwnerForSoul,
  assertSoulTarget = id => { if (currentAgentId() !== id) throw new Error('a soul may load skills only into its own worktrees; bind an Agent ID first'); }, ...options }) {
  const [name, ...rest] = args, values = {}, flags = new Set();
  for (let i = 0; i < rest.length; i++) {
    const key = { '--soul': 'agentId', '--workspace': 'workspace', '--harness': 'harness', '--reason': 'reason' }[rest[i]];
    if (key && values[key] === undefined && rest[i + 1] && !rest[i + 1].startsWith('--')) values[key] = rest[++i];
    else if ((rest[i] === '--global' || rest[i] === '--principal-stdin') && !flags.has(rest[i])) flags.add(rest[i]);
    else { stderr.write(USAGE); return 2; }
  }
  const global = flags.has('--global'), presented = flags.has('--principal-stdin');
  if (!name || name.startsWith('--') || !values.agentId) { stderr.write(USAGE); return 2; }
  if (global ? values.workspace !== undefined || (verb === 'unload' && (values.reason !== undefined || presented))
    : !values.workspace || values.reason !== undefined || presented) { stderr.write(USAGE); return 2; }
  try {
    const caller = markers({ env: options.env, cwd: options.cwd }).length ? 'soul' : 'owner';
    if (caller === 'soul') {
      assertSoulTarget(values.agentId);
      if (presented) throw Object.assign(new Error('--principal-stdin is the owner\'s; a soul asks the owner instead'), { code: 'skill-global-principal-not-accepted' });
    }
    const harness = values.harness ? { harness: values.harness } : {};
    let result;
    if (!global) result = (verb === 'load' ? loadSkill : unloadSkill)(name, values.agentId, { ...options, workspace: values.workspace, ...harness });
    else if (verb === 'unload') result = unloadGlobalSkill(name, values.agentId, { ...options, ...harness });
    else {
      const authorize = async action => {
        let principal = null;
        if (presented) {
          try { principal = JSON.parse(readStdin()); }
          catch { throw Object.assign(new Error('--principal-stdin needs the principal credential as JSON on stdin'), { code: 'skill-global-principal-invalid' }); }
        }
        try {
          return caller === 'owner'
            ? await ownerGate(action, { principal, env: options.env ?? process.env, cwd: options.cwd ?? process.cwd() })
            : await askOwner(action, { env: options.env ?? process.env, presence: options.presence });
        } catch (error) {
          throw Object.assign(new Error(`${action} needs the owner and was not approved: ${error.message}`),
            { code: error.code === 'owner-credential-required' ? error.code : 'skill-global-owner-not-approved', cause: error });
        }
      };
      result = await loadGlobalSkill(name, values.agentId, { ...options, ...harness, reason: values.reason, authorize });
    }
    stdout.write(report(result, json));
    return 0;
  } catch (error) {
    const failure = { code: error.code ?? `skill-${verb}-failed`, message: error.message };
    if (json) stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else stderr.write(`agent-bot soul skill: ${failure.code}: ${failure.message}\n`);
    return 1;
  }
}
// install/uninstall (#603) record through the existing revision path: an
// owner (no soul marker) applies an owner-gated edit; a soul proposes.
async function installMain(verb, args, json, { stdout, stderr, markers = soulMarkers, readStdin = () => readFileSync(0, 'utf8'),
  assertSoulTarget = id => { if (currentAgentId() !== id) throw new Error('a soul may change only its own skills; bind an Agent ID first'); },
  assertUser, trashOptions = {}, trash: trashMove, recordRemoval, runRevision = revisionCommand, ...options }) {
  const [target, ...rest] = args, flags = new Set();
  let agentId;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--soul' && agentId === undefined && rest[i + 1] && !rest[i + 1].startsWith('--')) agentId = rest[++i];
    else if ((rest[i] === '--principal-stdin' || (verb === 'uninstall' && rest[i] === '--trash')) && !flags.has(rest[i])) flags.add(rest[i]);
    else { stderr.write(USAGE); return 2; }
  }
  if (!target || target.startsWith('--') || !agentId) { stderr.write(USAGE); return 2; }
  const trash = flags.has('--trash');
  let staging;
  try {
    const owner = markers({ env: options.env, cwd: options.cwd }).length === 0;
    if (trash && !owner) throw Object.assign(new Error('soul skill uninstall --trash is owner only; a soul can archive instead'), { code: 'owner-credential-required' });
    const principal = flags.has('--principal-stdin') ? (() => {
      try { return JSON.parse(readStdin()); }
      catch { throw Object.assign(new Error('--principal-stdin needs the principal credential as JSON on stdin'), { code: 'skill-principal-invalid' }); }
    })() : null;
    const stage = verb === 'install' ? stageSkillInstall(target, agentId, options) : stageSkillUninstall(target, agentId, options);
    staging = stage.staging;
    const reason = verb === 'install' ? `Install skill ${stage.name}` : `Archive skill ${stage.name}${trash ? ' before moving it to the trash' : ''}`;
    const gate = assertUser ?? ((action, context) => revisionOwnerGate(action, { ...context, presence: options.presence, env: options.env, cwd: options.cwd }));
    let result;
    if (trash) {
      // Archive first (a recorded revision), then trash, then record the
      // removal; see trashSoulSkill.
      const trashed = await trashSoulSkill(stage, agentId, { ...options, trashOptions, ...(trashMove ? { trash: trashMove } : {}), ...(recordRemoval ? { recordRemoval } : {}),
        commit: onAuthorized => runRevision(['edit', agentId, staging, reason, '--apply'], { ...options, principal,
          assertUser: async (action, context) => { const authorization = await gate(action, context); onAuthorized(authorization); return authorization; } }) });
      result = { ...trashed, outcome: 'applied' };
    } else {
      const revision = owner
        ? await runRevision(['edit', agentId, staging, reason, '--apply'], { ...options, principal, assertUser: gate })
        : await runRevision(['propose', agentId, staging, reason], { ...options, assertSoulTarget });
      const { staging: _, parentRevision: __, hasRecord: ___, ...summary } = stage;
      result = { ...summary, outcome: owner ? 'applied' : revision.status,
        ...(owner ? { revision: revision.revision, changed: revision.changed } : { proposal: { proposalId: revision.proposalId, status: revision.status, revision: revision.revision } }) };
    }
    stdout.write(report(result, json));
    return result.outcome === 'rejected' ? 1 : 0;
  } catch (error) {
    const failure = { code: error.code ?? `skill-${verb}-failed`, message: error.message };
    if (json) stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else stderr.write(`agent-bot soul skill: ${failure.code}: ${failure.message}\n`);
    return 1;
  } finally {
    if (staging) try { discardRevisionStaging(staging); } catch { /* already gone */ }
  }
}
export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { stdout.write(USAGE); return 0; }
  if (argv[0] === 'dream') return soulDreamCommand(argv.slice(1), { stdout, stderr, ...options });
  const flags = argv.filter(arg => arg === '--json');
  const args = argv.filter(arg => arg !== '--json');
  const [verb, value, ...extra] = args;
  if (verb === 'update' && flags.length <= 1) return updateMain(args.slice(1), flags.length, { stdout, stderr, ...options });
  if ((verb === 'install' || verb === 'uninstall') && flags.length <= 1) return installMain(verb, args.slice(1), flags.length, { stdout, stderr, ...options });
  if ((verb === 'load' || verb === 'unload') && flags.length <= 1) return loadMain(verb, args.slice(1), flags.length, { stdout, stderr, ...options });
  if (verb === 'learn' && flags.length <= 1) return learningMain(args.slice(1), flags.length, { stdout, stderr, ...options });
  if (verb === 'check' && extra.length && flags.length <= 1) return portableCheckMain(args.slice(1), flags.length, { stdout, stderr, ...options });
  const operations = { import: importSkill, show: showSkill, verify: verifySkill, check: checkSkill };
  if (flags.length > 1 || extra.length || (verb === 'list' ? value !== undefined : !Object.hasOwn(operations, verb ?? '') || !value || value.startsWith('--'))) {
    stderr.write(USAGE); return 2;
  }
  try {
    const result = verb === 'list' ? { skills: listSkills(options) } : operations[verb](value, options);
    const finish = value => {
      stdout.write(report(value, flags.length));
      return value.verification === 'drifted' || value.status === 'unavailable' || value.coverage?.acquisition === 'partial' ? 1 : 0;
    };
    return result?.then ? result.then(finish, failed) : finish(result);
  } catch (error) { return failed(error); }
  function failed(error) {
    const failure = { code: error.code ?? 'skill-library-failed', message: error.message };
    if (flags.length) stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else stderr.write(`agent-bot soul skill: ${failure.code}: ${failure.message}\n`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
