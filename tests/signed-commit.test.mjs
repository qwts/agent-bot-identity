import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertLease,
  encodeRefPath,
  parseSignedCommitArgs,
  repositoryFromRemote,
  runSignedCommit,
} from '../signed-commit.mjs';

test('parses the stable signed-commit options and rejects malformed input', () => {
  assert.deepEqual(parseSignedCommitArgs([
    '--base', 'main', '--branch', 'feature', '--repo', 'acme/widgets', '--dry-run', '--allow-default-branch',
  ]), {
    base: 'main', branch: 'feature', repo: 'acme/widgets', dryRun: true, allowDefaultBranch: true,
  });
  assert.throws(() => parseSignedCommitArgs(['--base']), /requires a value/);
  assert.throws(() => parseSignedCommitArgs(['--wat']), /unknown option/);
  assert.throws(() => parseSignedCommitArgs(['--repo', 'broken']), /owner\/name/);
});

test('derives repositories only from the configured GitHub host', () => {
  assert.equal(repositoryFromRemote('https://github.com/acme/widgets.git'), 'acme/widgets');
  assert.equal(repositoryFromRemote('git@github.example:acme/widgets.git', 'github.example'), 'acme/widgets');
  assert.throws(() => repositoryFromRemote('https://evil.example/acme/widgets.git'), /pass --repo/);
});

test('the remote lease fails closed on unseen work', () => {
  assert.doesNotThrow(() => assertLease(null, null, 'feature'));
  assert.doesNotThrow(() => assertLease('a'.repeat(40), 'a'.repeat(40), 'feature'));
  assert.throws(() => assertLease('a'.repeat(40), 'b'.repeat(40), 'feature'), /someone else pushed/);
});

test('encodes legal ref characters without losing path structure', () => {
  assert.equal(encodeRefPath('heads/feature#123'), 'heads/feature%23123');
  assert.equal(encodeRefPath('heads/team/topic name'), 'heads/team/topic%20name');
});

test('non-dry publishing refuses to mint when no bot identity is stated', async () => {
  // ENG-0339: a delegate in the owner's account has nothing to sign as. The
  // directory is not consulted; only the absence of --app, GH_AGENT_APP, a
  // pin, or an agent account refuses.
  const cwd = mkdtempSync(join(tmpdir(), 'agent-bot-primary-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-b', 'feature');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(cwd, 'file.txt'), 'content\n');
  git('add', 'file.txt');
  git('commit', '-m', 'fixture');
  let minted = false;
  await assert.rejects(
    runSignedCommit(parseSignedCommitArgs(['--repo', 'acme/widgets']), {
      cwd,
      env: { ...process.env, GH_AGENT_APP: '', AGENT_BOT_ACCOUNT: 'user' },
      mintImpl: async () => { minted = true; return { token: 'secret' }; },
    }),
    /no bot identity resolves here/,
  );
  assert.equal(minted, false);
});

test('dry-run previews a linear range without minting or network access', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-bot-signed-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(cwd, 'file.txt'), 'base\n');
  git('add', 'file.txt');
  git('commit', '-m', 'base');
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('switch', '-c', 'feature');
  writeFileSync(join(cwd, 'file.txt'), 'feature\n');
  git('add', 'file.txt');
  git('commit', '-m', 'feature');
  let output = '';
  const result = await runSignedCommit(parseSignedCommitArgs(['--dry-run']), {
    cwd,
    stdout: { write: (value) => { output += value; } },
    mintImpl: async () => { throw new Error('dry-run minted'); },
    fetchImpl: async () => { throw new Error('dry-run fetched'); },
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.commits.length, 1);
  assert.match(output, /feature/);
  assert.match(output, /dry run — nothing was created or pushed/);
  assert.equal(git('status', '--porcelain'), '');
});
