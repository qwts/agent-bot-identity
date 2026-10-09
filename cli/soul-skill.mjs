#!/usr/bin/env node
// Library operations are separate from application-skill disclosure.
import { pathToFileURL } from 'node:url';
import { importSkill, listSkills, showSkill, verifySkill, checkSkill, planSkillUpdate, applySkillUpdate, recoverSkillUpdate } from '../skill-library.mjs';
import { skillLearningPacket, proposeSkillLearning, readLearningOutcome } from '../skill-learning.mjs';
import { currentAgentId } from '../agent-identity.mjs';
import { revisionCommand } from '../soul-revisions.mjs';

export const USAGE = `usage: agent-bot soul skill import PATH_OR_HTTPS_DOCUMENT [--json]
       agent-bot soul skill list [--json]
       agent-bot soul skill show UUID [--json]
       agent-bot soul skill verify UUID [--json]
       agent-bot soul skill check UUID [--json]
       agent-bot soul skill update UUID --check CHECK_ID [--json]
       agent-bot soul skill update UUID --check CHECK_ID --apply --expected-accepted DIGEST --expected-local DIGEST [--json]
       agent-bot soul skill update UUID --recover [--json]
       agent-bot soul skill learn UUID --soul AGENT_ID [--json]
       agent-bot soul skill learn UUID --soul AGENT_ID --package STAGING --outcome FILE --reason TEXT [--json]

Local import preserves the selected directory; HTTPS import captures a skill
document and supported inline instruction links. Neither executes content.
Repository directory adapters and harness installation remain unimplemented.
check never replaces accepted snapshots or local edits. update previews a recorded
check; applying requires reviewed digests and preserves prior material. learn supplies guidance;
recording outcomes proposes reviewed adaptations through the soul revision policy.
`;
async function learningMain(args, json, { stdout, stderr, assertSoulTarget = id => {
  if (currentAgentId() !== id) throw new Error('a soul may record learning only for its own package; bind an Agent ID first');
}, ...options }) {
  const [id, ...rest] = args, parsed = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--soul', '--package', '--outcome', '--reason'].includes(key) || Object.hasOwn(parsed, key) || !rest[i + 1] || rest[i + 1].startsWith('--')) { stderr.write(USAGE); return 2; }
    parsed[key] = rest[i + 1];
  }
  const recording = ['--package', '--outcome', '--reason'].some(key => key in parsed);
  if (!id || !parsed['--soul'] || (recording && !['--package', '--outcome', '--reason'].every(key => key in parsed))) { stderr.write(USAGE); return 2; }
  try {
    const agentId = parsed['--soul'];
    if (recording) await assertSoulTarget(agentId);
    const result = recording ? await proposeSkillLearning(id, agentId, parsed['--package'], readLearningOutcome(parsed['--outcome']), {
      ...options, reason: parsed['--reason'], propose: (id, tree, proposalOptions) => revisionCommand(['propose', id, tree, parsed['--reason']], { ...proposalOptions, assertSoulTarget }),
    }) : skillLearningPacket(id, agentId, options);
    stdout.write(`${JSON.stringify(result, null, json ? 0 : 2)}\n`);
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
    stdout.write(`${JSON.stringify(result, null, json ? 0 : 2)}\n`);
    return result.status === 'conflicted' ? 1 : 0;
  } catch (error) {
    const failure = { code: error.code ?? 'skill-update-failed', message: error.message };
    if (json) stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else stderr.write(`agent-bot soul skill: ${failure.code}: ${failure.message}\n`);
    return 1;
  }
}
export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { stdout.write(USAGE); return 0; }
  const flags = argv.filter(arg => arg === '--json');
  const args = argv.filter(arg => arg !== '--json');
  const [verb, value, ...extra] = args;
  if (verb === 'update' && flags.length <= 1) return updateMain(args.slice(1), flags.length, { stdout, stderr, ...options });
  if (verb === 'learn' && flags.length <= 1) return learningMain(args.slice(1), flags.length, { stdout, stderr, ...options });
  const operations = { import: importSkill, show: showSkill, verify: verifySkill, check: checkSkill };
  if (flags.length > 1 || extra.length || (verb === 'list' ? value !== undefined : !Object.hasOwn(operations, verb ?? '') || !value || value.startsWith('--'))) {
    stderr.write(USAGE); return 2;
  }
  try {
    const result = verb === 'list' ? { skills: listSkills(options) } : operations[verb](value, options);
    const finish = value => {
      stdout.write(`${JSON.stringify(value, null, flags.length ? 0 : 2)}\n`);
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
