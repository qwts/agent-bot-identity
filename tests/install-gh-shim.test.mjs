import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codexDesktopGhStatePath, inspectConfiguredCodexDesktopGh, inspectGhInterposer,
  inspectShellGhShim,
  installGhInterposer, installGhShim, restoreGhInterposer,
} from '../install-gh-shim.mjs';
import { GH_SHIM_MARKER } from '../gh-shim.mjs';

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

test('shell shim inspection distinguishes missing, replaced, recursive, and ready states', () => {
  const missingHome = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  assert.equal(inspectShellGhShim({ home: missingHome }).status, 'missing');

  const { home, installed } = installWithBrewPath();
  assert.equal(inspectShellGhShim({ home }).status, 'ready');
  writeFileSync(installed.shimPath, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(inspectShellGhShim({ home }).status, 'replaced');

  writeFileSync(installed.shimPath, `${GH_SHIM_MARKER}\n`, { mode: 0o755 });
  rmSync(installed.localShim);
  writeFileSync(installed.localShim, `${GH_SHIM_MARKER}\n`, { mode: 0o755 });
  assert.equal(inspectShellGhShim({ home }).status, 'recursive');
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
  assert.deepEqual(JSON.parse(readFileSync(codexDesktopGhStatePath(home), 'utf8')), {
    schema_version: 1,
    path: ghPath,
  });
  assert.equal(inspectConfiguredCodexDesktopGh({ home }).status, 'ready');

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
  assert.equal(existsSync(codexDesktopGhStatePath(home)), false);
  assert.equal(readFileSync(ghPath, 'utf8'), '#!/bin/sh\n');
});

test('Codex desktop interposition refuses ambiguous or unrecoverable states', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const shimPath = join(home, 'shim');
  const ghPath = join(home, 'gh');
  writeFileSync(shimPath, `${GH_SHIM_MARKER}\n`, { mode: 0o755 });
  writeFileSync(ghPath, '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(`${ghPath}.agent-bot-real`, 'collision\n');
  assert.throws(
    () => installGhInterposer({ path: ghPath, shimPath }),
    /codex-gh-interposer-unrecoverable/,
  );
  assert.throws(
    () => restoreGhInterposer({ path: ghPath, shimPath }),
    /codex-gh-interposer-unrecoverable/,
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
    /codex-gh-interposer-unrecoverable/,
  );
});

test('Codex desktop restore preserves the shim when its backup is unusable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const shimPath = join(home, 'shim');
  writeFileSync(shimPath, `${GH_SHIM_MARKER}\n`, { mode: 0o755 });

  for (const [name, createBackup] of [
    ['non-executable', (path) => writeFileSync(path, '#!/bin/sh\n', { mode: 0o644 })],
    ['dangling', (path) => symlinkSync(join(home, 'missing-gh'), path)],
  ]) {
    const bin = join(home, name);
    const ghPath = join(bin, 'gh');
    mkdirSync(bin);
    symlinkSync(shimPath, ghPath);
    createBackup(`${ghPath}.agent-bot-real`);

    assert.throws(
      () => restoreGhInterposer({ path: ghPath, shimPath }),
      /codex-gh-interposer-unrecoverable/,
    );
    assert.equal(readlinkSync(ghPath), shimPath);
    assert.doesNotThrow(() => lstatSync(`${ghPath}.agent-bot-real`));
  }
});

test('a missing desktop backup fails closed and leaves the shim in place', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const bin = join(home, 'missing-backup');
  const ghPath = join(bin, 'gh');
  const shimPath = join(home, 'shim');
  mkdirSync(bin);
  writeFileSync(shimPath, `${GH_SHIM_MARKER}\n`, { mode: 0o755 });
  symlinkSync(shimPath, ghPath);

  assert.equal(inspectGhInterposer({ path: ghPath, shimPath }).status, 'unrecoverable');
  assert.throws(
    () => restoreGhInterposer({ path: ghPath, shimPath }),
    /codex-gh-interposer-unrecoverable/,
  );
  assert.equal(readlinkSync(ghPath), shimPath);
});

test('Codex desktop interposition repairs a Homebrew relink and remains restorable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const bin = join(home, 'homebrew', 'bin');
  const ghPath = join(bin, 'gh');
  const shimPath = join(home, 'shim');
  const oldGh = join(home, 'Cellar', 'gh', 'old', 'gh');
  const newGh = join(home, 'Cellar', 'gh', 'new', 'gh');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, 'Cellar', 'gh', 'old'), { recursive: true });
  mkdirSync(join(home, 'Cellar', 'gh', 'new'), { recursive: true });
  writeFileSync(shimPath, `${GH_SHIM_MARKER}\n`, { mode: 0o755 });
  writeFileSync(oldGh, '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(newGh, '#!/bin/sh\n', { mode: 0o755 });
  symlinkSync(oldGh, ghPath);

  installGhInterposer({ path: ghPath, shimPath });
  rmSync(ghPath);
  symlinkSync(newGh, ghPath);
  assert.equal(inspectGhInterposer({ path: ghPath, shimPath }).status, 'replaced');

  const repaired = installGhInterposer({ path: ghPath, shimPath });
  assert.equal(repaired.updated, true);
  assert.equal(readlinkSync(ghPath), shimPath);
  assert.equal(readlinkSync(`${ghPath}.agent-bot-real`), newGh);
  restoreGhInterposer({ path: ghPath, shimPath });
  assert.equal(readlinkSync(ghPath), newGh);
});

test('legacy gh.bak is migrated only when it is a real executable', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const ghPath = join(home, 'bin', 'gh');
  const shimPath = join(home, 'shim');
  const realGh = join(home, 'real-gh');
  mkdirSync(join(home, 'bin'));
  writeFileSync(shimPath, `${GH_SHIM_MARKER}\n`, { mode: 0o755 });
  writeFileSync(realGh, '#!/bin/sh\n', { mode: 0o755 });
  symlinkSync(shimPath, ghPath);
  symlinkSync(realGh, `${ghPath}.bak`);

  assert.equal(inspectGhInterposer({ path: ghPath, shimPath }).status, 'legacy-backup');
  const migrated = installGhInterposer({ path: ghPath, shimPath });
  assert.equal(migrated.migratedLegacyBackup, true);
  assert.equal(existsSync(`${ghPath}.bak`), false);
  assert.equal(readlinkSync(`${ghPath}.agent-bot-real`), realGh);

  rmSync(`${ghPath}.agent-bot-real`);
  writeFileSync(`${ghPath}.bak`, `${GH_SHIM_MARKER}\n`, { mode: 0o755 });
  assert.equal(inspectGhInterposer({ path: ghPath, shimPath }).status, 'recursive');
  assert.throws(
    () => installGhInterposer({ path: ghPath, shimPath }),
    /codex-gh-interposer-recursive/,
  );
});

test('configured desktop inspection distinguishes missing and invalid state', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  assert.equal(inspectConfiguredCodexDesktopGh({ home }).status, 'unconfigured');
  mkdirSync(join(home, '.config', 'agent-bot'), { recursive: true });
  writeFileSync(codexDesktopGhStatePath(home), '{broken\n');
  assert.equal(inspectConfiguredCodexDesktopGh({ home }).code, 'codex-gh-interposer-state-invalid');
  writeFileSync(codexDesktopGhStatePath(home), JSON.stringify({
    schema_version: 1,
    path: join(home, 'missing', 'gh'),
  }));
  assert.equal(inspectConfiguredCodexDesktopGh({ home }).status, 'missing');
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
