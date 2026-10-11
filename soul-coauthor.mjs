#!/usr/bin/env node
// The soul's co-author trailer (ADR-0815). The GitHub App stays the commit's
// author and GitHub its committer and signer, so commits stay Verified; the
// soul is credited in the final trailer block, next to `Agent-Identity`:
//
//   Co-authored-by: <census name> <agent_<uuid>@souls.agent-bot.invalid>
//   Agent-Identity: agent_<uuid>
//
// hooks/prepare-commit-msg calls `prepare` with the Agent ID it resolved from
// the worktree's binding; the trailer never comes from caller text. `check`
// reports where a published commit (a squash merge, say) carries the trailer.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { assertSoulCoAuthor, soulCoAuthorCredits, soulCoAuthorDomains, soulCoAuthorTrailer, validateAgentId } from './agent-identity.mjs';
import { loadConfig } from './config.mjs';
import { displayName, populationFile, showSoul, soulDirectory, soulShownName } from './agent-population.mjs';

// The census name at commit time (#429): the launch or join name, else the
// soul.json name, else the generated handle. A soul with no census row (an
// identity minted before the census knew it) is credited by its handle,
// which is derived from the Agent ID and so names no one else. A census that
// cannot be read fails the commit: its row may exist, and a guessed name
// would be an unverifiable credit.
export function soulCoAuthorName(id, { env = process.env } = {}) {
  const file = populationFile({ env });
  let soul;
  try {
    soul = showSoul(id, { file });
  } catch (error) {
    if (/^no population record/.test(error.message)) return displayName(id);
    throw new Error(`cannot read the census for the soul's co-author name: ${error.message}`);
  }
  let directory = null;
  try { directory = soulDirectory(id, { file, env, readOnly: true }); } catch { /* no soul folder */ }
  return soulShownName(soul, directory) || displayName(id);
}

function git(args, { cwd, input } = {}) {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
}

// The final trailer block as git parses it. --no-divider keeps a `---` line
// in a message from being read as the start of a patch.
function finalTrailers(message, cwd) {
  return git(['interpret-trailers', '--parse', '--no-divider'], { cwd, input: message }).split('\n').filter(Boolean);
}

function creditsIn(lines, id, domains) {
  return soulCoAuthorCredits(lines.join('\n'), domains).includes(id);
}

// Adds the soul's co-author trailer and `Agent-Identity` to a commit message
// file, joining the message's final trailer block so human co-authors
// (`Co-Authored-By: Claude …`) and both trailers stay in one block. A
// message that credits another soul is refused. A message that already
// credits this soul keeps that line, so an amend after a rename does not add
// a second credit; the new name appears on new commits only. The trailer is
// written in the organization's domain when its profile names one.
export function prepareSoulTrailers(messageFile, id, { cwd = process.cwd(), env = process.env } = {}) {
  validateAgentId(id);
  const domains = soulCoAuthorDomains(loadConfig({ env }));
  const message = readFileSync(messageFile, 'utf8');
  assertSoulCoAuthor(message, id, domains);
  // As for Agent-Identity since ENG-0081, a credit already anywhere in the
  // message is not repeated (a hook re-run, an amend).
  const trailers = [];
  if (!soulCoAuthorCredits(message, domains).includes(id)) trailers.push(soulCoAuthorTrailer(id, soulCoAuthorName(id, { env }), domains[0]));
  if (!message.split('\n').includes(`Agent-Identity: ${id}`)) trailers.push(`Agent-Identity: ${id}`);
  if (trailers.length === 0) return;
  git([
    'interpret-trailers', '--in-place', '--no-divider', '--where', 'end', '--if-exists', 'addIfDifferent',
    ...trailers.flatMap((trailer) => ['--trailer', trailer]),
    messageFile,
  ], { cwd });
}

// Where a message credits the soul (ADR-0815 matrix row 10): `trailer` in
// the final block, `body` when only elsewhere (a GitHub squash merge appends
// its own co-author block after the commit's trailers), `absent` when
// nowhere. In the
// last two cases the local identity record stays the authority.
export function soulTrailerStatus(message, id, { cwd = process.cwd(), domains = soulCoAuthorDomains() } = {}) {
  validateAgentId(id);
  if (creditsIn(finalTrailers(message, cwd), id, domains)) return 'trailer';
  return soulCoAuthorCredits(message, domains).includes(id) ? 'body' : 'absent';
}

async function main(argv) {
  const [command, target, id] = argv;
  if (command === 'prepare' && target && id) return prepareSoulTrailers(target, id);
  if (command === 'check' && target && id) {
    if (target.startsWith('-')) throw new Error('check takes a commit, not an option');
    const message = git(['log', '-1', '--format=%B', target, '--']);
    process.stdout.write(`${soulTrailerStatus(message, id)}\n`);
    return undefined;
  }
  throw new Error('usage: soul-coauthor.mjs prepare <message-file> <agent-id> | check <commit> <agent-id>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`agent-bot: ${error.message}`);
    process.exit(1);
  });
}
