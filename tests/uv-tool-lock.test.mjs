import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHarnessInstall, uvToolRequirements } from '../runtime-catalog.mjs';

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
    [[{ name: 'goose-ai', version: '1.9.0', sha256: [A] }, { name: 'goose.ai', version: '1.9.0', sha256: [B] }], /locked twice/],
    [[{ name: 'goose-ai', version: '>=1.9', sha256: [A] }], /exact version/],
    [[{ name: 'goose ai', version: '1.9.0', sha256: [A] }], /PyPI package name/],
    [[{ name: 'goose-ai', version: '1.9.0', sha256: [A], url: 'https://x' }], /\[0\]\.url is unknown/],
    [['goose-ai'], /must be an object/],
  ]) assert.throws(() => normalizeHarnessInstall(tool(lock), 'soul.json harnesses.muse.install'), (error) => message.test(error.message) && error.message.includes('harnesses.muse.install.lock'), JSON.stringify(lock));
});

test('an archive install still refuses a lock key (#617)', () => {
  assert.throws(() => normalizeHarnessInstall({ kind: 'archive', version: '1.2.3', url: 'https://e.test/x.zip', sha256: { 'linux-x64': A }, lock: LOCK }, 'x'), /x\.lock is unknown/);
});
