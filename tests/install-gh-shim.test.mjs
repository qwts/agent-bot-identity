import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installGhInterposer, installGhShim, restoreGhInterposer,
} from '../install-gh-shim.mjs';

const HAS_ZSH = spawnSync('zsh', ['-c', ':'], { stdio: 'ignore' }).status === 0;
const INSTALLER = fileURLToPath(new URL('../install-gh-shim.mjs', import.meta.url));

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

test('Codex runtime override resolves the managed gh shim before Homebrew', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const codexOverrideDir = join(home, 'codex-runtime', 'bin', 'override');
  mkdirSync(codexOverrideDir, { recursive: true });

  const first = installGhShim({ home, codexOverrideDir });
  assert.equal(first.codexShim, join(codexOverrideDir, 'gh'));
  assert.equal(readlinkSync(first.codexShim), first.shimPath);

  const second = installGhShim({ home, codexOverrideDir });
  assert.equal(readlinkSync(second.codexShim), second.shimPath);
});

test('Codex desktop interposition is explicit, reversible, and idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const bin = join(home, 'homebrew', 'bin');
  const cellar = join(home, 'homebrew', 'Cellar', 'gh', 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(cellar, { recursive: true });
  const realGh = join(cellar, 'gh');
  const ghPath = join(bin, 'gh');
  writeFileSync(realGh, '#!/bin/sh\n', { mode: 0o755 });
  symlinkSync(realGh, ghPath);

  const installed = installGhShim({ home, codexGhPath: ghPath });
  assert.equal(readlinkSync(ghPath), installed.shimPath);
  assert.equal(readlinkSync(`${ghPath}.agent-bot-real`), realGh);

  const again = installGhInterposer({ path: ghPath, shimPath: installed.shimPath });
  assert.equal(again.updated, false);

  const restored = restoreGhInterposer({ path: ghPath, shimPath: installed.shimPath });
  assert.equal(restored.restored, true);
  assert.equal(readlinkSync(ghPath), realGh);
  assert.equal(existsSync(`${ghPath}.agent-bot-real`), false);
});

test('install-gh-shim CLI installs and restores an explicit desktop interposer', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const ghPath = join(home, 'homebrew', 'bin', 'gh');
  mkdirSync(join(home, 'homebrew', 'bin'), { recursive: true });
  writeFileSync(ghPath, '#!/bin/sh\n', { mode: 0o755 });
  const env = { ...process.env, HOME: home, ZDOTDIR: home };

  const installed = execFileSync(
    process.execPath,
    [INSTALLER, '--codex-desktop-gh', ghPath],
    { env, encoding: 'utf8' },
  );
  assert.match(installed, /Codex desktop gh shim/);
  assert.equal(readlinkSync(ghPath), join(home, '.config', 'agent-bot', 'bin', 'gh'));
  assert.equal(existsSync(`${ghPath}.agent-bot-real`), true);

  const restored = execFileSync(
    process.execPath,
    [INSTALLER, '--restore-codex-desktop-gh', ghPath],
    { env, encoding: 'utf8' },
  );
  assert.match(restored, /Codex desktop gh restored/);
  assert.equal(existsSync(`${ghPath}.agent-bot-real`), false);
  assert.equal(readFileSync(ghPath, 'utf8'), '#!/bin/sh\n');
});

test('Codex desktop interposition refuses ambiguous or unrecoverable states', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const shimPath = join(home, 'shim');
  const ghPath = join(home, 'gh');
  writeFileSync(shimPath, '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(ghPath, '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(`${ghPath}.agent-bot-real`, 'collision\n');
  assert.throws(
    () => installGhInterposer({ path: ghPath, shimPath }),
    /already exists.*refusing/,
  );
  assert.throws(
    () => restoreGhInterposer({ path: ghPath, shimPath }),
    /not an agent-bot managed interposer/,
  );
  assert.throws(
    () => installGhInterposer({ path: join(home, 'not-gh'), shimPath }),
    /absolute path ending in \/gh/,
  );
  assert.throws(
    () => installGhInterposer({ path: ghPath, shimPath: ghPath }),
    /external gh, not the managed shim/,
  );

  const nonExecutable = join(home, 'non-executable', 'gh');
  mkdirSync(join(home, 'non-executable'), { recursive: true });
  writeFileSync(nonExecutable, '#!/bin/sh\n', { mode: 0o644 });
  assert.throws(
    () => installGhInterposer({ path: nonExecutable, shimPath }),
    /does not resolve to an executable file/,
  );
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
