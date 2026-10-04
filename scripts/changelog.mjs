#!/usr/bin/env node
// Changelog fragments. A PR adds its entry as changes/<slug>.md instead of
// editing CHANGELOG.md, so concurrent PRs never conflict on the same lines.
//
//   node scripts/changelog.mjs assemble 0.10.12
//     The release step: moves every fragment (and any legacy `## Unreleased`
//     body) under a new `## 0.10.12` heading and deletes the fragments.
//
//   node scripts/changelog.mjs check --base <sha> --head <sha> --labels '["…"]'
//     The CI check: a PR must add or edit a fragment, and may edit
//     CHANGELOG.md only while assembling fragments for a release. The
//     `skip-changelog` label skips it.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SKIP_LABEL = 'skip-changelog';
export const CHANGES_DIR = 'changes';
const VERSION = /^\d+\.\d+\.\d+$/;
const FRAGMENT = /^changes\/(?!README\.md$)[^/]+\.md$/;

export function isFragmentPath(path) {
  return FRAGMENT.test(path);
}

// A fragment is one changelog bullet, optionally with indented sub-bullets.
export function validateFragment(text, name = 'fragment') {
  const body = text.replace(/\s+$/, '');
  if (!body) throw new Error(`${name} is empty`);
  if (!body.startsWith('- ')) throw new Error(`${name} must start with "- " (one changelog bullet)`);
  return body;
}

export function listFragments(root) {
  const dir = join(root, CHANGES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => isFragmentPath(`${CHANGES_DIR}/${name}`))
    .sort()
    .map((name) => join(dir, name));
}

// Pure: returns the new CHANGELOG text.
export function assembleChangelog(changelog, version, entries) {
  if (!VERSION.test(version)) throw new Error(`version must be X.Y.Z, got ${version}`);
  const lines = changelog.split('\n');
  if (lines.some((line) => line.trim() === `## ${version}`)) {
    throw new Error(`CHANGELOG.md already has a ## ${version} section`);
  }
  const titleAt = lines.findIndex((line) => line.startsWith('# '));
  if (titleAt === -1) throw new Error('CHANGELOG.md has no "# " title');

  // Fold a legacy `## Unreleased` body in after the fragments; it predates them.
  let legacy = [];
  const unreleasedAt = lines.findIndex((line) => line.trim() === '## Unreleased');
  if (unreleasedAt !== -1) {
    let end = lines.findIndex((line, i) => i > unreleasedAt && line.startsWith('## '));
    if (end === -1) end = lines.length;
    const text = lines.slice(unreleasedAt + 1, end).join('\n').trim();
    lines.splice(unreleasedAt, end - unreleasedAt);
    if (text) legacy = [text];
  }

  const body = [...entries, ...legacy];
  if (body.length === 0) throw new Error(`nothing to release: no fragments in ${CHANGES_DIR}/ and no Unreleased entries`);

  const rest = lines.slice(titleAt + 1).join('\n').replace(/^\n+/, '');
  const head = lines.slice(0, titleAt + 1).join('\n');
  return `${head}\n\n## ${version}\n\n${body.join('\n')}\n${rest ? `\n${rest}` : ''}`.replace(/\n*$/, '\n');
}

export function assemble(root, version) {
  const files = listFragments(root);
  const entries = files.map((file) => validateFragment(readFileSync(file, 'utf8'), file));
  const path = join(root, 'CHANGELOG.md');
  writeFileSync(path, assembleChangelog(readFileSync(path, 'utf8'), version, entries));
  for (const file of files) rmSync(file);
  return files;
}

// Pure: changes = [{ status: 'A'|'M'|'D'|…, path }]. Returns { ok, reason }.
export function checkChanges(changes, labels = []) {
  if (labels.includes(SKIP_LABEL)) return { ok: true, reason: `label ${SKIP_LABEL}` };
  const fragments = changes.filter((c) => isFragmentPath(c.path));
  const written = fragments.filter((c) => c.status !== 'D');
  const deleted = fragments.filter((c) => c.status === 'D');
  const editsChangelog = changes.some((c) => c.path === 'CHANGELOG.md');
  if (editsChangelog && deleted.length === 0) {
    return {
      ok: false,
      reason: `CHANGELOG.md is edited only by the release step; add your entry as ${CHANGES_DIR}/<slug>.md instead (or label the PR ${SKIP_LABEL})`,
    };
  }
  if (editsChangelog) return { ok: true, reason: `release assembles ${deleted.length} fragment(s)` };
  if (written.length === 0) {
    return {
      ok: false,
      reason: `add a changelog entry as ${CHANGES_DIR}/<slug>.md (see ${CHANGES_DIR}/README.md), or label the PR ${SKIP_LABEL} if it needs none`,
    };
  }
  return { ok: true, reason: `fragment ${written.map((c) => c.path).join(', ')}` };
}

function git(root, args, env) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env });
}

export function check(root, { base, head, labels }, env = process.env) {
  const changes = git(root, ['diff', '--name-status', '--no-renames', `${base}...${head}`], env)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status: status[0], path };
    });
  const result = checkChanges(changes, labels);
  if (result.ok && !labels.includes(SKIP_LABEL)) {
    for (const c of changes) {
      if (isFragmentPath(c.path) && c.status !== 'D') validateFragment(git(root, ['show', `${head}:${c.path}`], env), c.path);
    }
  }
  return result;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || args[i + 1] === undefined) throw new Error(`bad argument ${args[i]}`);
    flags[args[i].slice(2)] = args[i + 1];
  }
  return flags;
}

function main(argv) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const [command, ...rest] = argv;
  if (command === 'assemble' && rest.length === 1) {
    const files = assemble(root, rest[0]);
    console.log(`CHANGELOG.md: ## ${rest[0]} from ${files.length} fragment(s); removed them from ${CHANGES_DIR}/`);
    return 0;
  }
  if (command === 'check') {
    const flags = parseFlags(rest);
    if (!flags.base || !flags.head) throw new Error('check needs --base and --head');
    const result = check(root, { base: flags.base, head: flags.head, labels: JSON.parse(flags.labels ?? '[]') });
    console.log(`${result.ok ? 'ok' : 'FAIL'}: ${result.reason}`);
    return result.ok ? 0 : 1;
  }
  console.error('usage: changelog.mjs assemble X.Y.Z | check --base SHA --head SHA [--labels JSON]');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`changelog: ${error.message}`);
    process.exitCode = 1;
  }
}
