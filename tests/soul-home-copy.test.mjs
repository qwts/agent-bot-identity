import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copySoulPackage } from '../soul-home.mjs';
import { SOUL_PACKAGE_LIMITS } from '../soul-package.mjs';

// #1102: launch copies a package into the soul's new home through the bounded
// package reader, before the bounded build, never with an unbounded cpSync.
function dirs(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-copy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const from = path.join(root, 'pkg'), to = path.join(root, 'home');
  mkdirSync(from); mkdirSync(to);
  writeFileSync(path.join(from, 'AGENTS.md'), 'be kind\n');
  return { from, to };
}

test('the copy keeps files, modes, directories and links, and skips working state', (t) => {
  const { from, to } = dirs(t);
  mkdirSync(path.join(from, 'skills', 'hello'), { recursive: true });
  writeFileSync(path.join(from, 'skills', 'hello', 'SKILL.md'), 'hi\n');
  writeFileSync(path.join(from, 'run'), '#!/bin/sh\n', { mode: 0o755 });
  symlinkSync('AGENTS.md', path.join(from, 'link'));
  mkdirSync(path.join(from, 'locked')); writeFileSync(path.join(from, 'locked', 'f'), 'x'); chmodSync(path.join(from, 'locked'), 0o555);
  for (const skipped of ['.soul-state', 'worktrees', 'node_modules']) { mkdirSync(path.join(from, skipped)); writeFileSync(path.join(from, skipped, 'x'), 'x'); }
  copySoulPackage(from, to);
  assert.deepEqual(readdirSync(to).sort(), ['AGENTS.md', 'link', 'locked', 'run', 'skills']);
  assert.equal(readFileSync(path.join(to, 'skills', 'hello', 'SKILL.md'), 'utf8'), 'hi\n');
  assert.equal(statSync(path.join(to, 'run')).mode & 0o777, 0o755);
  assert.equal(readlinkSync(path.join(to, 'link')), 'AGENTS.md');
  // A read-only package directory is copied writable (0755), as cpSync left
  // it, so a failed launch can still remove the half-made home.
  assert.equal(statSync(path.join(to, 'locked')).mode & 0o777, 0o755);
  assert.equal(readFileSync(path.join(to, 'locked', 'f'), 'utf8'), 'x');
  chmodSync(path.join(from, 'locked'), 0o755);
});

// #1109 review: a read-only directory copied before a refused entry must not
// stop the cleanup from removing the half-made home, nor hide the refusal.
test('a refused copy after a read-only directory leaves a home that cleanup removes', (t) => {
  const { from, to } = dirs(t);
  mkdirSync(path.join(from, 'aaa')); writeFileSync(path.join(from, 'aaa', 'f'), 'x'); chmodSync(path.join(from, 'aaa'), 0o555);
  const made = spawnSync('mkfifo', [path.join(from, 'zzz')]);
  if (made.status !== 0) { chmodSync(path.join(from, 'aaa'), 0o755); t.skip('mkfifo is not available'); return; }
  assert.throws(() => copySoulPackage(from, to), /unsupported package entry: zzz/);
  assert.deepEqual(readdirSync(to), ['aaa']);
  rmSync(to, { recursive: true, force: true });
  assert.equal(existsSync(to), false, 'the half-made home is gone');
  chmodSync(path.join(from, 'aaa'), 0o755);
});

test('the copy stops at the package limits instead of copying everything first', (t) => {
  const { from, to } = dirs(t);
  mkdirSync(path.join(from, 'many'));
  for (let i = 0; i < 50; i += 1) writeFileSync(path.join(from, 'many', `f${i}`), '');
  const limits = { ...SOUL_PACKAGE_LIMITS, maxEntries: 20 };
  assert.throws(() => copySoulPackage(from, to, { limits }), (error) => error.code === 'soul-package-read-limit');
  const copied = existsSync(path.join(to, 'many')) ? readdirSync(path.join(to, 'many')).length : 0;
  assert.ok(copied < 20, `stopped early: ${copied} files copied`);
  // A sparse 4 GiB file is refused, never copied.
  const big = dirs(t);
  writeFileSync(path.join(big.from, 'big.bin'), '');
  truncateSync(path.join(big.from, 'big.bin'), 4 * 1024 * 1024 * 1024);
  assert.throws(() => copySoulPackage(big.from, big.to), (error) => error.code === 'soul-package-read-limit');
  assert.equal(existsSync(path.join(big.to, 'big.bin')), false);
});

test('a FIFO in the package is refused without waiting on it', (t) => {
  const { from, to } = dirs(t);
  const made = spawnSync('mkfifo', [path.join(from, 'pipe')]);
  if (made.status !== 0) { t.skip('mkfifo is not available'); return; }
  const started = Date.now();
  assert.throws(() => copySoulPackage(from, to), /unsupported package entry: pipe/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(lstatSync(path.join(to)).isDirectory(), true);
});
