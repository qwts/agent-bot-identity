import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhShim } from '../install-gh-shim.mjs';

test('gh shim installation is stable and idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-gh-'));
  const first = installGhShim({ home });
  assert.equal(readlinkSync(first.localShim), first.shimPath);
  const body = readFileSync(first.shimPath, 'utf8');
  assert.match(body, /\.local\/bin\/agent-bot/);
  assert.doesNotMatch(body, /PLAYBOOK_HOME|playbook-home|tools\/agent-bot/);
  assert.equal(existsSync(join(home, '.zshenv')), false);
  assert.equal(existsSync(join(home, '.zshrc')), false);
  assert.match(readFileSync(join(home, '.zprofile'), 'utf8'), /^export PATH="\$HOME\/\.local\/bin:\$PATH"/m);
  const second = installGhShim({ home });
  assert.equal(second.pathRegistration.updated, false);
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
