#!/usr/bin/env node
// agent-bot skill path — report where this installed release's agent skill
// bundle lives and the source commit it was built from (ENG-0055 decision 2).
//
// Read-only: it touches no network, credential, or Git state beyond reading
// this runtime's own tree. The commit comes from `git rev-parse` in a source
// checkout, and from RELEASE_COMMIT in a release archive, where GitHub's
// archive export fills in the `$Format:%H$` placeholder (.gitattributes).

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: agent-bot skill path [--json]

Print this release's agent skill bundle directory and its source commit.
`;

export function skillBundle(root = ROOT) {
  return join(root, 'skills', 'agent-bot');
}

export function sourceCommit(root = ROOT) {
  if (existsSync(join(root, '.git'))) {
    const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const sha = git.status === 0 ? git.stdout.trim() : '';
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  try {
    const stamped = readFileSync(join(root, 'RELEASE_COMMIT'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(stamped)) return stamped;
  } catch {
    // No stamp: report unknown rather than guess.
  }
  return 'unknown';
}

export function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const [sub, ...rest] = argv;
  const json = rest.length === 1 && rest[0] === '--json';
  if (sub !== 'path' || (rest.length && !json)) {
    process.stderr.write(`agent-bot skill: ${sub === 'path' ? 'unexpected arguments' : 'expected the path subcommand'}\n${USAGE}`);
    return 2;
  }
  const bundle = skillBundle();
  if (!existsSync(join(bundle, 'SKILL.md'))) {
    process.stderr.write(`agent-bot skill: no skill bundle at ${bundle}\n`);
    return 1;
  }
  const commit = sourceCommit();
  process.stdout.write(json ? `${JSON.stringify({ path: bundle, commit })}\n` : `${bundle}\ncommit ${commit}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
