import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeHarnessInstall, uvToolRequirements } from '../runtime-catalog.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const tool = (lock) => ({ kind: 'uv-tool', package: 'goose-ai', version: '1.9.0', bin: 'goose', ...(lock === undefined ? {} : { lock }) });
const LOCK = [{ name: 'goose-ai', version: '1.9.0', sha256: [A, B] }, { name: 'requests', version: '2.32.3', sha256: [C] }];

test('a uv tool lock normalizes and renders hash-pinned requirements (#617)', () => {
  const install = normalizeHarnessInstall(tool(LOCK), 'x');
  assert.deepEqual(install.lock, LOCK);
  assert.equal(uvToolRequirements(install),
    `goose-ai==1.9.0 --hash=sha256:${A} --hash=sha256:${B}\nrequests==2.32.3 --hash=sha256:${C}\n`);
});

test('a uv tool without a lock keeps its old shape and renders no requirements (#617)', () => {
  const install = normalizeHarnessInstall(tool(), 'x');
  assert.deepEqual(install, { kind: 'uv-tool', package: 'goose-ai', version: '1.9.0', bin: 'goose' });
  assert.equal(uvToolRequirements(install), null);
  assert.equal(uvToolRequirements({ kind: 'archive' }), null);
});

test('the lock names the tool itself under PEP 503 normalization (#617)', () => {
  const install = normalizeHarnessInstall(tool([{ name: 'Goose_AI', version: '1.9.0', sha256: [A] }]), 'x');
  assert.equal(install.lock[0].name, 'Goose_AI');
});

test('a malformed uv tool lock is refused with its path (#617)', () => {
  for (const [lock, message] of [
    [[], /must list every package/],
    ['goose-ai==1.9.0', /must list every package/],
    [[{ name: 'requests', version: '2.32.3', sha256: [C] }], /must include the tool package goose-ai/],
    [[{ name: 'goose-ai', version: '1.8.0', sha256: [A] }], /locks goose-ai at 1\.8\.0, but the install pins 1\.9\.0/],
    [[{ name: 'goose-ai', version: '1.9.0', sha256: [] }], /sha256 must list/],
    [[{ name: 'goose-ai', version: '1.9.0', sha256: A }], /sha256 must list/],
    [[{ name: 'goose-ai', version: '1.9.0', sha256: ['A'.repeat(64)] }], /64 lowercase hex/],
    [[{ name: 'goose-ai', version: '1.9.0', sha256: [A, A] }], /digest twice/],
    [[{ name: 'goose-ai', version: '1.9.0', sha256: [B, A] }], /sorted ascending/],
    [[{ name: 'goose-ai', version: '1.9.0', sha256: [A] }, { name: 'goose.ai', version: '1.9.0', sha256: [B] }], /locked twice/],
    ...['>=1.9', '1..0', '1!', '1+foo+bar', '1.0+', 'v1.0', '1.0 ', '1.*', '1.0a1a2', ''].map((version) => [[{ name: 'goose-ai', version: '1.9.0', sha256: [A] }, { name: 'dep', version, sha256: [B] }], /exact PEP 440 version/]),
    [[{ name: 'goose ai', version: '1.9.0', sha256: [A] }], /PyPI package name/],
    [[{ name: 'goose-ai', version: '1.9.0', sha256: [A], url: 'https://x' }], /\[0\]\.url is unknown/],
    [['goose-ai'], /must be an object/],
  ]) assert.throws(() => normalizeHarnessInstall(tool(lock), 'soul.json harnesses.muse.install'), (error) => message.test(error.message) && error.message.includes('harnesses.muse.install.lock'), JSON.stringify(lock));
});

test('an archive install still refuses a lock key (#617)', () => {
  assert.throws(() => normalizeHarnessInstall({ kind: 'archive', version: '1.2.3', url: 'https://e.test/x.zip', sha256: { 'linux-x64': A }, lock: LOCK }, 'x'), /x\.lock is unknown/);
});

test('a uv tool lock accepts every exact PEP 440 form (#617)', () => {
  for (const version of ['2.32.3', '1!2.0', '1.0a1', '1.0rc2', '1.0.post1', '1.0-1', '1.0.dev3', '1.0a1.post2.dev3', '1.0+local.7', '2024.10.1', '1.0B2']) {
    const install = normalizeHarnessInstall(tool([{ name: 'goose-ai', version: '1.9.0', sha256: [A] }, { name: 'dep', version, sha256: [B] }]), 'x');
    assert.equal(install.lock[1].version, version);
  }
});

test('nothing in a lock entry can inject a pip option, marker, URL or line (#617)', () => {
  for (const dep of [
    { name: 'dep\n--index-url https://evil.test', version: '1.0', sha256: [B] },
    { name: 'dep', version: '1.0\n--index-url https://evil.test', sha256: [B] },
    { name: 'dep', version: '1.0', sha256: [`${B}\n-e git+https://evil.test`] },
    { name: '--index-url', version: '1.0', sha256: [B] },
    { name: '-e', version: '1.0', sha256: [B] },
    { name: 'dep', version: '1.0 ; python_version>"3"', sha256: [B] },
    { name: 'dep @ https://evil.test/dep.whl', version: '1.0', sha256: [B] },
    { name: 'dep[extra]', version: '1.0', sha256: [B] },
    { name: 'dep', version: '1.0\\', sha256: [B] },
    { name: 'dep', version: '1.0#x', sha256: [B] },
    { name: 'dep', version: '1.0', sha256: [`sha512:${B}`] },
  ]) {
    assert.throws(() => normalizeHarnessInstall(tool([{ name: 'goose-ai', version: '1.9.0', sha256: [A] }, dep]), 'x'), /x\.lock\[1\]/, JSON.stringify(dep));
  }
});

test('the lock is part of the package revision, and editing it after sealing is refused (#617)', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uv-lock-rev-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'AGENTS.md'), '# Billy\n');
  const write = (manifest) => writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  const manifest = (lock) => ({ formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Billy', description: 'T', displaySeed: 'billy', preferredHarnesses: ['opencode'],
    revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, runtimes: { python: '3.12' },
    harnesses: { muse: { install: { kind: 'uv-tool', package: 'muse-cli', version: '2.0.0', bin: 'muse', ...(lock ? { lock } : {}) } } } });
  const seal = (lock) => { const m = manifest(lock); write(m); m.revision = computePackageRevision(dir); write(m); return m; };
  const revisions = [
    null,
    [{ name: 'muse-cli', version: '2.0.0', sha256: [A] }],
    [{ name: 'muse-cli', version: '2.0.0', sha256: [B] }],
    [{ name: 'muse-cli', version: '2.0.0', sha256: [A, B] }],
    [{ name: 'muse-cli', version: '2.0.0', sha256: [A] }, { name: 'dep', version: '1.0', sha256: [C] }],
  ].map((lock) => { seal(lock); return validateSoulPackage(dir).revision; });
  assert.equal(new Set(revisions).size, revisions.length);
  const sealed = seal([{ name: 'muse-cli', version: '2.0.0', sha256: [A] }]);
  sealed.harnesses.muse.install.lock[0].sha256 = [B];
  write(sealed);
  assert.throws(() => validateSoulPackage(dir), /revision/);
});
