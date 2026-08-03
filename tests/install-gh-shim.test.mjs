import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhShim } from '../install-gh-shim.mjs';

const HAS_ZSH = spawnSync('zsh', ['-c', ':'], { stdio: 'ignore' }).status === 0;

function installWithBrewPath() {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const brewBin = join(home, 'brew', 'bin');
  mkdirSync(brewBin, { recursive: true });
  writeFileSync(join(brewBin, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(home, '.zprofile'), `export PATH="${brewBin}:$PATH"\n`);
  return { home, brewBin, installed: installGhShim({ home }) };
}

test('gh shim installation is stable and idempotent', () => {
  const { home, installed } = installWithBrewPath();
  const first = installed;
  assert.equal(readlinkSync(first.localShim), first.shimPath);
  const body = readFileSync(first.shimPath, 'utf8');
  assert.match(body, /\.local\/bin\/agent-bot/);
  assert.doesNotMatch(body, /PLAYBOOK_HOME|playbook-home|tools\/agent-bot/);
  assert.match(readFileSync(join(home, '.zshenv'), 'utf8'), /\.config\/agent-bot\/bin/);
  assert.match(readFileSync(join(home, '.zprofile'), 'utf8'), /brew\/bin[\s\S]+gh shim login priority/);

  const second = installGhShim({ home });
  assert.equal(second.zshenv.updated, false);
  assert.equal(second.zprofile.updated, false);
});

test('zsh resolves the shim in non-login and login shells', { skip: !HAS_ZSH }, () => {
  const { home, brewBin, installed } = installWithBrewPath();
  const env = { ...process.env, HOME: home, ZDOTDIR: home, PATH: `${brewBin}:/usr/bin:/bin` };
  const nonLogin = execFileSync('zsh', ['-c', 'command -v gh'], { env, encoding: 'utf8' }).trim();
  const login = execFileSync('zsh', ['-lic', 'command -v gh'], { env, encoding: 'utf8' }).trim();
  const loginPath = execFileSync('zsh', ['-lic', 'print -r -- $PATH'], { env, encoding: 'utf8' }).trim();
  assert.equal(nonLogin, installed.shimPath);
  assert.equal(login, installed.localShim);
  assert.equal(loginPath.split(':').filter((entry) => entry === join(home, '.local', 'bin')).length, 1);
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
