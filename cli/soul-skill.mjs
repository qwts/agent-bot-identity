#!/usr/bin/env node
// Library operations are separate from application-skill disclosure.
import { pathToFileURL } from 'node:url';
import { importSkill, listSkills, showSkill, verifySkill, checkSkill } from '../skill-library.mjs';

export const USAGE = `usage: agent-bot soul skill import PATH [--json]
       agent-bot soul skill list [--json]
       agent-bot soul skill show UUID [--json]
       agent-bot soul skill verify UUID [--json]
       agent-bot soul skill check UUID [--json]

Local import preserves the selected skill directory and never executes it.
Remote acquisition, harness installation and soul adoption are not implemented
by these commands. check keeps changed source bytes as a separate candidate;
it never replaces accepted snapshots or local edits. verify reads only.
`;
export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { stdout.write(USAGE); return 0; }
  const flags = argv.filter(arg => arg === '--json');
  const args = argv.filter(arg => arg !== '--json');
  const [verb, value, ...extra] = args;
  const operations = { import: importSkill, show: showSkill, verify: verifySkill, check: checkSkill };
  if (flags.length > 1 || extra.length || (verb === 'list' ? value !== undefined : !Object.hasOwn(operations, verb ?? '') || !value || value.startsWith('--'))) {
    stderr.write(USAGE); return 2;
  }
  try {
    const result = verb === 'list' ? { skills: listSkills(options) } : operations[verb](value, options);
    stdout.write(`${JSON.stringify(result, null, flags.length ? 0 : 2)}\n`);
    return result.verification === 'drifted' || result.status === 'unavailable' ? 1 : 0;
  } catch (error) {
    const failure = { code: error.code ?? 'skill-library-failed', message: error.message };
    if (flags.length) stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else stderr.write(`agent-bot soul skill: ${failure.code}: ${failure.message}\n`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
