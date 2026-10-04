// Changelog fragments: the release assembles changes/*.md into CHANGELOG.md,
// and the CI check refuses a PR that edits CHANGELOG.md directly or adds no
// fragment, unless it carries the skip-changelog label.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assemble, assembleChangelog, check, checkChanges, validateFragment } from '../scripts/changelog.mjs';
import { hermeticGitEnv } from './helpers/hermetic-git.mjs';

const OLD = '# Changelog\n\n## 0.1.0\n\n- First.\n';

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'abi-changelog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('assemble puts fragments under the version, newest section first, and deletes them', (t) => {
  const root = tempRoot(t);
  mkdirSync(join(root, 'changes'));
  writeFileSync(join(root, 'CHANGELOG.md'), OLD);
  writeFileSync(join(root, 'changes', 'README.md'), '# not an entry\n');
  writeFileSync(join(root, 'changes', 'b-second.md'), '- Second (#2).\n  - detail\n');
  writeFileSync(join(root, 'changes', 'a-first.md'), '- First fragment (#1).\n\n');

  const removed = assemble(root, '0.2.0');

  assert.equal(removed.length, 2);
  assert.equal(
    readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## 0.2.0\n\n- First fragment (#1).\n- Second (#2).\n  - detail\n\n## 0.1.0\n\n- First.\n',
  );
  assert.deepEqual(readdirSync(join(root, 'changes')), ['README.md']);
});

test('assemble folds a legacy Unreleased section in after the fragments and drops its heading', () => {
  const changelog = '# Changelog\n\n## Unreleased\n\n- Legacy (#9).\n\n## 0.1.0\n\n- First.\n';
  assert.equal(
    assembleChangelog(changelog, '0.2.0', ['- New (#10).']),
    '# Changelog\n\n## 0.2.0\n\n- New (#10).\n- Legacy (#9).\n\n## 0.1.0\n\n- First.\n',
  );
});

test('assemble refuses a bad version, a repeated version, or nothing to release', () => {
  assert.throws(() => assembleChangelog(OLD, 'v0.2.0', ['- x']), /X\.Y\.Z/);
  assert.throws(() => assembleChangelog(OLD, '0.1.0', ['- x']), /already has/);
  assert.throws(() => assembleChangelog(OLD, '0.2.0', []), /nothing to release/);
  assert.throws(() => assembleChangelog('# Changelog\n\n## Unreleased\n\n## 0.1.0\n', '0.2.0', []), /nothing to release/);
});

test('a fragment is one bullet', () => {
  assert.equal(validateFragment('- ok\n\n'), '- ok');
  assert.throws(() => validateFragment('  \n'), /empty/);
  assert.throws(() => validateFragment('## Heading\n- x'), /must start with "- "/);
});

test('check: a fragment passes; none, or a direct CHANGELOG edit, fails unless labelled', () => {
  const fragment = { status: 'A', path: 'changes/soul-fork.md' };
  const code = { status: 'M', path: 'soul-remove.mjs' };
  const changelog = { status: 'M', path: 'CHANGELOG.md' };

  assert.equal(checkChanges([code, fragment]).ok, true);
  assert.equal(checkChanges([code, { status: 'M', path: 'changes/soul-fork.md' }]).ok, true);
  assert.match(checkChanges([code]).reason, /add a changelog entry as changes\/<slug>\.md/);
  assert.equal(checkChanges([code, { status: 'A', path: 'changes/README.md' }]).ok, false);
  assert.equal(checkChanges([code, { status: 'A', path: 'changes/sub/x.md' }]).ok, false);
  assert.match(checkChanges([code, fragment, changelog]).reason, /CHANGELOG\.md is edited only by the release step/);
  assert.equal(checkChanges([code], ['skip-changelog']).ok, true);
  assert.equal(checkChanges([changelog], ['skip-changelog']).ok, true);
  // The release PR edits CHANGELOG.md while deleting the fragments it assembled.
  assert.equal(checkChanges([changelog, { status: 'M', path: 'package.json' }, { status: 'D', path: 'changes/soul-fork.md' }]).ok, true);
});

test('check reads the PR diff from git and validates the added fragment', (t) => {
  const root = tempRoot(t);
  const env = hermeticGitEnv(process.env, {
    GIT_CONFIG_GLOBAL: join(root, 'no-global'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'CHANGELOG.md'), OLD);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  mkdirSync(join(root, 'changes'));
  writeFileSync(join(root, 'changes', 'bad.md'), 'no bullet\n');
  git('add', '.');
  git('commit', '-q', '-m', 'bad fragment');
  assert.throws(() => check(root, { base, head: git('rev-parse', 'HEAD'), labels: [] }, env), /must start with "- "/);

  writeFileSync(join(root, 'changes', 'bad.md'), '- Fixed.\n');
  git('commit', '-q', '-am', 'fix fragment');
  assert.equal(check(root, { base, head: git('rev-parse', 'HEAD'), labels: [] }, env).ok, true);

  writeFileSync(join(root, 'CHANGELOG.md'), `${OLD}- edited\n`);
  git('commit', '-q', '-am', 'direct edit');
  assert.equal(check(root, { base, head: git('rev-parse', 'HEAD'), labels: [] }, env).ok, false);
  assert.equal(existsSync(join(root, 'changes', 'bad.md')), true);
});

test('this repo keeps its changelog entries in changes/', () => {
  const repo = new URL('..', import.meta.url).pathname;
  assert.ok(existsSync(join(repo, 'changes', 'README.md')));
  const workflow = readFileSync(join(repo, '.github', 'workflows', 'changelog.yml'), 'utf8');
  assert.match(workflow, /types: \[[^\]]*labeled, unlabeled\]/);
  assert.match(workflow, /node scripts\/changelog\.mjs check/);
  for (const name of readdirSync(join(repo, 'changes')).filter((n) => n !== 'README.md')) {
    validateFragment(readFileSync(join(repo, 'changes', name), 'utf8'), name);
  }
});
