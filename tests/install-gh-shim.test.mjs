import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhShim } from '../install-gh-shim.mjs';

test('gh shim installation is stable and idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const brewBin = join(home, 'brew', 'bin');
  mkdirSync(brewBin, { recursive: true });
  writeFileSync(join(brewBin, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(home, '.zprofile'), `export PATH="${brewBin}:$PATH"\n`);
  const first = installGhShim({ home });
  assert.equal(readlinkSync(first.localShim), first.shimPath);
  const body = readFileSync(first.shimPath, 'utf8');
  assert.match(body, /\.local\/bin\/agent-bot/);
  assert.doesNotMatch(body, /PLAYBOOK_HOME|playbook-home|tools\/agent-bot/);
  assert.match(readFileSync(join(home, '.zshenv'), 'utf8'), /\.config\/agent-bot\/bin/);
  assert.match(readFileSync(join(home, '.zprofile'), 'utf8'), /brew\/bin[\s\S]+gh shim login priority/);

  const env = { ...process.env, HOME: home, ZDOTDIR: home, PATH: `${brewBin}:/usr/bin:/bin` };
  const nonLogin = execFileSync('zsh', ['-c', 'command -v gh'], { env, encoding: 'utf8' }).trim();
  const login = execFileSync('zsh', ['-lic', 'command -v gh'], { env, encoding: 'utf8' }).trim();
  const loginPath = execFileSync('zsh', ['-lic', 'print -r -- $PATH'], { env, encoding: 'utf8' }).trim();
  assert.equal(nonLogin, first.shimPath);
  assert.equal(login, first.localShim);
  assert.equal(loginPath.split(':').filter((entry) => entry === join(home, '.local', 'bin')).length, 1);

  const second = installGhShim({ home });
  assert.equal(second.zshenv.updated, false);
  assert.equal(second.zprofile.updated, false);
});

test('gh shim installer preserves foreign files and symlinks', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'gh'), 'foreign\n');
  assert.throws(() => installGhShim({ home }), /real file/);
  const otherHome = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  mkdirSync(join(otherHome, '.local', 'bin'), { recursive: true });
  writeFileSync(join(otherHome, 'foreign-gh'), 'foreign\n');
  symlinkSync(join(otherHome, 'foreign-gh'), join(otherHome, '.local', 'bin', 'gh'));
  assert.throws(() => installGhShim({ home: otherHome }), /foreign symlink/);
});
