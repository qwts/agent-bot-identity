#!/usr/bin/env node
// agent-bot skill — disclose one skill's SKILL.md, a reference of the bundled
// agent-bot skill, or report the agent skill bundle path and source commit
// (ENG-0055 decision 2, #226).
//
// Bundled names (agent-bot, agent-space, thread-orders) are this repository's
// own skills. They are read from this runtime's tree with no network, and
// they always win over the fleet catalog: the copy that ships with the
// running release is the one its commands match. Every other name resolves
// through the fleet catalog (qwts/qwts-agent-sop skills/README.md) to exactly
// one entry, and that entry's SKILL.md is fetched at the entry's pinned
// commit. Absent, ambiguous, or unpinned names fail; a branch or tag is never
// followed. Nothing is installed or cached: output goes to stdout only.
//
// GitHub access is read-only `gh api` GETs with a timeout. The document is
// printed only after it has been fetched and decoded in full.
//
// The commit comes from `git rev-parse` in a source checkout, and from
// RELEASE_COMMIT in a release archive, where GitHub's archive export fills in
// the `$Format:%H$` placeholder (.gitattributes).

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SKILL_REFERENCES, NO_SKILL_REFERENCE, skillReferenceFor } from './cli/skill-references.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const OWN_REPOSITORY = 'qwts/agent-bot-identity';
export const BUNDLED_SKILLS = Object.freeze(['agent-bot', 'agent-space', 'thread-orders']);
export const CATALOG = Object.freeze({ repository: 'qwts/qwts-agent-sop', path: 'skills/README.md' });
export const FETCH_TIMEOUT_MS = 20_000;
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SKILL_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const MAX_DOCUMENT = 1024 * 1024;

const USAGE = `usage: agent-bot skill path [--json]
       agent-bot skill <name> [--json]
       agent-bot skill agent-bot --for <subcommand> [--json]

path: Print this release's agent skill bundle directory and its source commit.
<name>: Print one skill's SKILL.md. Bundled skills (${BUNDLED_SKILLS.join(', ')})
  are read from this release with no network. Any other name is resolved
  through the fleet catalog (${CATALOG.repository} ${CATALOG.path}) to exactly
  one entry and fetched read-only at that entry's pinned commit; an absent,
  ambiguous, or unpinned name is an error. Nothing is installed.
--for <subcommand>: Print the one agent-bot reference file that covers that
  agent-bot subcommand (static table; an unknown subcommand is an error).
--json: Print {name, repository, commit, path, text} (plus "for" with --for).
`;

export class SkillError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'SkillError';
    this.exitCode = exitCode;
  }
}

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

// Parse the catalog's "## Available skills" list. An entry is
//   - [name](https://github.com/OWNER/REPO/tree/REF/PATH)
//     — owned by [OWNER/REPO](https://github.com/OWNER/REPO). ...
// and runs until the next "- [" line or the end of the section. `commit` is
// REF when REF is a full 40-hex commit, otherwise null (a branch or a tag is
// not a pin). A link that is not a tree link has no ref and no path.
export function parseCatalog(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => /^##\s+Available skills\s*$/u.test(line));
  if (start < 0) throw new SkillError('the fleet catalog has no "Available skills" section');
  const entries = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/u.test(line)) break;
    const item = line.match(/^- \[([^\]]+)\]\(([^)\s]+)\)/u);
    if (item) {
      current = { name: item[1].trim(), link: item[2], body: line };
      entries.push(current);
    } else if (current && /^\s+\S/u.test(line)) {
      current.body += `\n${line}`;
    } else if (!line.trim()) {
      current = null;
    }
  }
  return entries.map(({ name, link, body }) => {
    const tree = link.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/tree\/([^/]+)\/(.+?)\/?$/u);
    const owner = body.replace(/\s+/gu, ' ').match(/owned by \[([^\]]+)\]/u)?.[1] ?? null;
    const ref = tree?.[2] ?? null;
    return {
      name,
      repository: tree?.[1] ?? null,
      owner,
      ref,
      commit: ref && COMMIT.test(ref) ? ref : null,
      directory: tree?.[3] ?? null,
    };
  });
}

// Exactly one entry, pinned, with a well-formed repository and path.
export function resolveCatalogEntry(entries, name) {
  const matches = entries.filter((entry) => entry.name === name);
  if (matches.length === 0) {
    throw new SkillError(`no skill named ${name} in the fleet catalog (${CATALOG.repository} ${CATALOG.path}); bundled: ${BUNDLED_SKILLS.join(', ')}`);
  }
  if (matches.length > 1) {
    const where = matches.map((entry) => entry.repository ?? entry.owner ?? 'unknown repository').join(', ');
    throw new SkillError(`skill name ${name} is ambiguous: the fleet catalog lists it ${matches.length} times (${where}); a colliding name must be resolved in the catalog`);
  }
  const [entry] = matches;
  if (!entry.repository || !REPOSITORY.test(entry.repository) || !entry.directory || !SKILL_PATH.test(entry.directory)
    || entry.directory.split('/').some((part) => part === '.' || part === '..')) {
    throw new SkillError(`catalog entry ${name} is not a GitHub tree link to a skill directory at a commit`);
  }
  if (entry.owner && entry.owner !== entry.repository) {
    throw new SkillError(`catalog entry ${name} links ${entry.repository} but says it is owned by ${entry.owner}`);
  }
  if (!entry.commit) {
    throw new SkillError(`catalog entry ${name} is not pinned: ${entry.ref ? `ref ${entry.ref} is not a 40-hex commit` : 'it carries no ref'}; a branch or tag is never followed`);
  }
  return { name, repository: entry.repository, commit: entry.commit, path: `${entry.directory}/SKILL.md` };
}

// Read one file through `gh api` (GET only). `ref` is undefined only for the
// catalog itself, which is read at its repository's default branch: it is the
// reviewed index of pins, and every skill it names is then read at a commit.
export function ghContentsFetcher({ timeoutMs = FETCH_TIMEOUT_MS, gh = 'gh', env = process.env } = {}) {
  return (repository, path, ref) => {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const endpoint = `repos/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}${query}`;
    const result = spawnSync(gh, ['api', '--method', 'GET', endpoint], {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * MAX_DOCUMENT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    if (result.error?.code === 'ETIMEDOUT' || result.signal) {
      throw new SkillError(`timed out after ${Math.round(timeoutMs / 1000)}s reading ${repository}/${path}`);
    }
    if (result.error) throw new SkillError(`cannot run gh to read ${repository}/${path}: ${result.error.code ?? result.error.message}`);
    if (result.status !== 0) {
      const reason = (result.stderr ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? `gh exited ${result.status}`;
      throw new SkillError(`cannot read ${repository}/${path}${ref ? ` at ${ref}` : ''}: ${reason.slice(0, 200)}`);
    }
    return decodeContents(result.stdout, `${repository}/${path}`);
  };
}

export function decodeContents(body, label) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new SkillError(`incomplete or invalid response reading ${label}`);
  }
  if (data?.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new SkillError(`${label} is not a file in the GitHub contents response`);
  }
  const bytes = Buffer.from(data.content.replace(/\s+/gu, ''), 'base64');
  if (typeof data.size === 'number' && bytes.length !== data.size) {
    throw new SkillError(`incomplete content reading ${label}: ${bytes.length} of ${data.size} bytes`);
  }
  if (bytes.length > MAX_DOCUMENT) throw new SkillError(`${label} is larger than ${MAX_DOCUMENT} bytes`);
  return bytes.toString('utf8');
}

export function resolveCatalogSkill(name, fetchContents) {
  const catalog = fetchContents(CATALOG.repository, CATALOG.path);
  const entry = resolveCatalogEntry(parseCatalog(catalog), name);
  const text = fetchContents(entry.repository, entry.path, entry.commit);
  if (typeof text !== 'string' || !text.length) throw new SkillError(`${entry.repository}/${entry.path} at ${entry.commit} is empty`);
  return { ...entry, text };
}

function parseArgs(argv) {
  const [sub, ...rest] = argv;
  if (!sub) throw new SkillError('expected the path subcommand or a skill name', 2);
  const options = { sub, json: false, for: null };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--json' && !options.json) options.json = true;
    else if (rest[i] === '--for' && options.for === null && i + 1 < rest.length) options.for = rest[++i];
    else throw new SkillError(rest[i] === '--for' ? '--for needs a subcommand' : 'unexpected arguments', 2);
  }
  return options;
}

function forReference(options) {
  if (options.sub !== 'agent-bot') {
    throw new SkillError(`--for applies only to the agent-bot skill, not ${options.sub}`, 2);
  }
  const reference = skillReferenceFor(options.for);
  if (!reference) {
    const known = Object.keys(SKILL_REFERENCES).sort().join(', ');
    const why = NO_SKILL_REFERENCE.includes(options.for)
      ? `${options.for} has no reference file; read the agent-bot skill itself or \`agent-bot ${options.for} --help\``
      : `unknown subcommand ${options.for}`;
    throw new SkillError(`${why}; --for knows: ${known}`, 2);
  }
  const path = join(skillBundle(), 'references', reference);
  return { name: 'agent-bot', for: options.for, repository: OWN_REPOSITORY, commit: sourceCommit(), path, text: readFileSync(path, 'utf8') };
}

function disclose(options, fetchContents) {
  if (options.for !== null) return forReference(options);
  const name = options.sub;
  if (!NAME.test(name)) throw new SkillError(`invalid skill name ${name}`, 2);
  if (BUNDLED_SKILLS.includes(name)) {
    const path = join(ROOT, 'skills', name, 'SKILL.md');
    return { name, repository: OWN_REPOSITORY, commit: sourceCommit(), path, text: readFileSync(path, 'utf8') };
  }
  return resolveCatalogSkill(name, fetchContents);
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (argv[0] === '--help' || argv[0] === '-h') {
    stdout.write(USAGE);
    return 0;
  }
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`agent-bot skill: ${error.message}\n${USAGE}`);
    return error.exitCode ?? 2;
  }
  if (options.sub === 'path') {
    if (options.for !== null) {
      stderr.write(`agent-bot skill: unexpected arguments\n${USAGE}`);
      return 2;
    }
    const bundle = skillBundle();
    if (!existsSync(join(bundle, 'SKILL.md'))) {
      stderr.write(`agent-bot skill: no skill bundle at ${bundle}\n`);
      return 1;
    }
    const commit = sourceCommit();
    stdout.write(options.json ? `${JSON.stringify({ path: bundle, commit })}\n` : `${bundle}\ncommit ${commit}\n`);
    return 0;
  }
  let skill;
  try {
    skill = disclose(options, deps.fetchContents ?? ghContentsFetcher());
  } catch (error) {
    if (!(error instanceof SkillError)) throw error;
    stderr.write(`agent-bot skill: ${error.message}\n`);
    return error.exitCode;
  }
  stdout.write(options.json ? `${JSON.stringify(skill)}\n` : skill.text);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
