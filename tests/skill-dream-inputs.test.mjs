import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computePackageRevision, computePackageRevisionFromEntries, readSoulPackageEntries, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { captureDreamInputs, DREAM_INPUT_LIMITS, DREAM_PACKAGE_LIMITS } from '../skill-dream-inputs.mjs';

const HASH = `sha256:${'0'.repeat(64)}`;
function fixture(t, formatVersion = 2) {
  const root = mkdtempSync(path.join(tmpdir(), 'dream-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { formatVersion, ...(formatVersion === 2 ? { ignore: PACKAGE_IGNORE_LIST } : {}), name: 'Dream fixture', description: 'Fixture', displaySeed: 'fixture', preferredHarnesses: ['codex'], revision: HASH, parentRevision: null, template: false };
  const put = (name, bytes) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); };
  put('soul.json', JSON.stringify(manifest)); put('AGENTS.md', '# Definition\n'); put('soul.md', 'Current soul\n');
  put('skills/example/SKILL.md', '---\nname: example\ndescription: Example skill\n---\nLearned instructions\n');
  const seal = () => { manifest.revision = computePackageRevision(root); put('soul.json', JSON.stringify(manifest)); return manifest.revision; };
  seal();
  return { root, manifest, put, seal };
}

test('bounded snapshot hashing agrees with canonical revisions and does not mutate captured bytes', t => {
  for (const version of [1, 2]) {
    const f = fixture(t, version);
    const read = readSoulPackageEntries(f.root, { limits: DREAM_PACKAGE_LIMITS });
    const manifestBytes = Buffer.from(read.entries.find(entry => entry.path === 'soul.json').bytes);
    assert.equal(computePackageRevisionFromEntries(read), computePackageRevision(f.root));
    assert.deepEqual(read.entries.find(entry => entry.path === 'soul.json').bytes, manifestBytes);
    f.put('AGENTS.md', 'later edits');
    assert.equal(computePackageRevisionFromEntries(read), f.manifest.revision, 'snapshot hashing never reopens changed files');
  }
});

test('capture verifies revision, selects only definition/skill content, and reports absent readers', t => {
  const f = fixture(t);
  f.put('skills/example/secrets/token.txt', 'PRIVATE_CANARY');
  f.put('skills/example/assets/image.bin', Buffer.from([0, 255, 1]));
  f.put('notes.txt', 'UNRELATED_CANARY');
  f.seal(); buildSoulDirectory(f.root);
  f.put('.soul-state/credentials/private.txt', 'CREDENTIAL_CANARY');
  f.put('.soul-state/home/AGENTS.md', 'HOME_CANARY');
  symlinkSync(path.join(f.root, 'missing'), path.join(f.root, '.soul-state/unsafe'));
  const packet = captureDreamInputs(f.root);
  assert.equal(packet.revision, f.manifest.revision);
  assert.deepEqual(packet.sources.map(item => item.path), ['AGENTS.md', 'skills/example/SKILL.md', 'soul.md']);
  assert.equal(packet.coverage.memory, 'unsupported'); assert.equal(packet.coverage.conversations, 'unsupported');
  assert.equal(packet.coverage.skippedBinary, 1); assert.equal(packet.nextCursor, null);
  for (const source of packet.sources) {
    const bytes = readFileSync(path.join(f.root, source.path));
    assert.equal(source.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.equal(source.excerpt, bytes.toString('utf8')); assert.equal(source.truncated, false);
  }
  assert.equal(JSON.stringify(packet).includes('CANARY'), false);
  assert.equal(JSON.stringify(packet).includes(f.root), false);
  f.put('soul.md', 'changed without updating revision');
  assert.throws(() => captureDreamInputs(f.root), { code: 'dream-input-drift' });
});

test('selection pagination is stable, bounded, and invalidated by a new revision', t => {
  const f = fixture(t);
  for (let i = 0; i < 110; i++) f.put(`skills/example/references/${String(i).padStart(3, '0')}.md`, `reference ${i}`);
  f.seal();
  const first = captureDreamInputs(f.root), second = captureDreamInputs(f.root, { cursor: first.nextCursor });
  assert.equal(first.sources.length, 100); assert.ok(first.nextCursor); assert.equal(second.sources.length, 13);
  const all = [...first.sources, ...second.sources].map(item => item.path);
  assert.equal(new Set(all).size, 113); assert.equal(second.nextCursor, null);
  assert.deepEqual(captureDreamInputs(f.root), first);
  assert.throws(() => captureDreamInputs(f.root, { cursor: { revision: first.revision, path: '../outside' } }), { code: 'dream-input-cursor-invalid' });
  for (const cursor of [false, {}, { revision: first.revision + '\n', path: 'AGENTS.md' }, { revision: first.revision, path: 'soul.json', extra: true }]) {
    assert.throws(() => captureDreamInputs(f.root, { cursor }), { code: 'dream-input-cursor-invalid' });
  }
  f.put('AGENTS.md', 'new revision'); f.seal();
  assert.deepEqual(captureDreamInputs(f.root, { cursor: first.nextCursor }), captureDreamInputs(f.root), 'old revision cursor restarts selection');
});

test('text excerpts honor UTF-8 boundaries and aggregate byte limits without claiming full coverage', t => {
  const f = fixture(t);
  f.put('soul.md', 'a' + '🙂'.repeat(20_000));
  for (let i = 0; i < 20; i++) f.put(`skills/example/${i}.md`, 'x'.repeat(65_537));
  f.seal();
  const packet = captureDreamInputs(f.root);
  assert.ok(packet.coverage.remaining > 0); assert.ok(packet.nextCursor);
  assert.ok(packet.coverage.suppliedBytes <= DREAM_INPUT_LIMITS.bytes);
  assert.equal(packet.coverage.suppliedBytes, packet.sources.reduce((sum, source) => sum + Buffer.byteLength(source.excerpt), 0));
  for (const source of packet.sources) assert.ok(source.excerptBytes <= DREAM_INPUT_LIMITS.excerptBytes);
  assert.ok(packet.sources.some(source => source.truncated));
  const tail = captureDreamInputs(f.root, { cursor: packet.nextCursor });
  const emoji = tail.sources.find(source => source.path === 'soul.md');
  assert.ok(emoji); assert.equal(emoji.excerpt.includes('\ufffd'), false); assert.equal(emoji.truncated, true);
  assert.equal(emoji.excerptBytes, 65_533, 'the final partial codepoint stays out of the excerpt');
  assert.equal(emoji.digest, `sha256:${createHash('sha256').update('a' + '🙂'.repeat(20_000)).digest('hex')}`);
});

test('unsafe links, oversized files and legacy packages fail closed without leaking input data', t => {
  for (const kind of ['symlink', 'hardlink', 'oversize', 'legacy']) {
    const f = fixture(t, kind === 'legacy' ? 1 : 2);
    if (kind === 'symlink') symlinkSync(path.join(f.root, 'AGENTS.md'), path.join(f.root, 'skills/example/link.md'));
    if (kind === 'hardlink') linkSync(path.join(f.root, 'soul.md'), path.join(f.root, 'skills/example/linked.md'));
    if (kind === 'oversize') { f.put('skills/example/large.md', ''); truncateSync(path.join(f.root, 'skills/example/large.md'), 20 * 1024 * 1024); }
    assert.throws(() => captureDreamInputs(f.root), error => {
      assert.equal(error.code, kind === 'oversize' ? 'dream-input-limit' : 'dream-input-unavailable');
      assert.equal(error.message.includes(f.root), false); return true;
    });
  }
});

test('package read limits apply to directory counts, nesting, files and aggregate bytes', t => {
  const f = fixture(t);
  for (const override of [{ maxEntries: 1 }, { maxFileBytes: 10 }, { maxBytes: 100 }, { maxDepth: 1 }]) {
    assert.throws(() => readSoulPackageEntries(f.root, { limits: { ...DREAM_PACKAGE_LIMITS, ...override } }), { code: 'soul-package-read-limit' });
  }
  assert.throws(() => readSoulPackageEntries(f.root, { limits: { ...DREAM_PACKAGE_LIMITS, maxEntries: 0 } }), /invalid package read limits/);
  const onePassBytes = readSoulPackageEntries(f.root).entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  assert.throws(() => readSoulPackageEntries(f.root, { limits: { ...DREAM_PACKAGE_LIMITS, maxBytes: onePassBytes + 1 } }), { code: 'soul-package-read-limit' }, 'both passes and the initial manifest count toward actual read bytes');
});

test('bounded verification refuses a manifest replaced between format-2 inventory passes', t => {
  const f = fixture(t);
  assert.throws(() => readSoulPackageEntries(f.root, { limits: DREAM_PACKAGE_LIMITS, expectedGeneratedFiles: () => {
    f.put('soul.json', JSON.stringify({ ...f.manifest, description: 'changed during capture' }));
    return new Map();
  } }), /manifest changed during read/);
});
