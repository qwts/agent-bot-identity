import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computePackageRevision, computePackageRevisionFromEntries, readSoulPackageEntries, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { captureDreamInputs, dreamInputMetadata, dreamInputMetadataDigest, validateDreamInputMetadata, DREAM_CONVERSATION_LIMITS, DREAM_INPUT_LIMITS, DREAM_PACKAGE_LIMITS } from '../skill-dream-inputs.mjs';

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

test('durable input metadata excludes text and rejects forged fields, locators and coverage', t => {
  const f = fixture(t), captured = captureDreamInputs(f.root), metadata = dreamInputMetadata(captured);
  assert.equal(JSON.stringify(metadata).includes('Learned instructions'), false);
  assert.ok(metadata.sources.every(source => !Object.hasOwn(source, 'excerpt')));
  assert.equal(dreamInputMetadataDigest(structuredClone(metadata)), dreamInputMetadataDigest(metadata));
  for (const mutate of [
    value => { value.sources[0].excerpt = 'SECRET_CANARY'; },
    value => { value.sources[0].path = '../outside'; },
    value => { value.sources[0].path = 'skills/example/secrets.txt'; value.sources[0].kind = 'skill'; },
    value => { value.sources[0].kind = 'generated'; },
    value => { value.sources[0].digest += '\n'; },
    value => { value.sources[0].truncated = true; },
    value => { value.sources[0].size = DREAM_PACKAGE_LIMITS.maxFileBytes + 1; },
    value => { value.sources.push(value.sources[0]); },
    value => { value.coverage.suppliedBytes++; },
    value => { value.coverage.memory = 'supported'; },
    value => { value.nextCursor = { revision: HASH, path: 'AGENTS.md' }; },
  ]) {
    const malformed = structuredClone(metadata); mutate(malformed);
    assert.throws(() => validateDreamInputMetadata(malformed), { code: 'dream-input-metadata-invalid' });
  }
  captured.coverage.selected = 0;
  assert.equal(metadata.coverage.selected, 3, 'capture and durable metadata do not alias');
});

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

// The soul's own conversation (#603, owner decision 1, input format 2).
const THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
function conversationFixture(t) {
  const f = fixture(t);
  const day = path.join(f.root, '.soul-state', 'tools', 'codex', 'sessions', '2026', '10', '10');
  const file = path.join(day, `rollout-2026-10-10T10-00-00-${THREAD}.jsonl`);
  const write = text => { mkdirSync(day, { recursive: true }); writeFileSync(file, text); };
  return { ...f, day, file, write, session: { harness: 'codex', sessionId: THREAD, store: 'soul' } };
}

test('a recorded soul-store session is delivered as format 2, with the excerpt kept out of durable metadata', t => {
  const f = conversationFixture(t);
  f.write('{"type":"user","text":"remember the owner prefers short replies"}\n');
  const captured = captureDreamInputs(f.root, { session: f.session });
  assert.equal(captured.schemaVersion, 2);
  assert.equal(captured.coverage.conversations, 'supported');
  assert.equal(captured.conversation.excerpt, readFileSync(f.file, 'utf8'));
  assert.equal(captured.conversation.digest, `sha256:${createHash('sha256').update(readFileSync(f.file)).digest('hex')}`);
  assert.deepEqual([captured.conversation.truncated, captured.revision], [false, captureDreamInputs(f.root).revision], 'the tool home is not package content');
  const metadata = dreamInputMetadata(captured);
  assert.equal(JSON.stringify(metadata).includes('short replies'), false);
  assert.deepEqual(metadata.conversation, { harness: 'codex', sessionId: THREAD, digest: captured.conversation.digest,
    size: captured.conversation.size, excerptBytes: captured.conversation.excerptBytes, truncated: false });
  assert.equal(dreamInputMetadataDigest(structuredClone(metadata)), dreamInputMetadataDigest(metadata));
  for (const mutate of [
    value => { value.conversation.excerpt = 'SECRET_CANARY'; },
    value => { value.conversation.sessionId = '../other'; },
    value => { value.conversation.harness = 'claude'; },
    value => { value.conversation.truncated = true; },
    value => { value.conversation.excerptBytes = DREAM_CONVERSATION_LIMITS.excerptBytes + 1; },
    value => { value.coverage.conversations = 'unavailable'; },
    value => { value.conversation = null; },
    value => { delete value.conversation; },
    value => { value.schemaVersion = 1; },
    value => { value.schemaVersion = 3; },
  ]) {
    const value = structuredClone(metadata); mutate(value);
    assert.throws(() => validateDreamInputMetadata(value), { code: 'dream-input-metadata-invalid' });
  }
  // Format 1 stays exactly as before: no conversation key, always unsupported.
  const legacy = dreamInputMetadata(captureDreamInputs(f.root));
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(Object.hasOwn(legacy, 'conversation'), false);
  assert.throws(() => validateDreamInputMetadata({ ...legacy, conversation: null }), { code: 'dream-input-metadata-invalid' });
  assert.throws(() => validateDreamInputMetadata({ ...legacy, coverage: { ...legacy.coverage, conversations: 'supported' } }), { code: 'dream-input-metadata-invalid' });
});

test('only the recorded session in the soul store is read; anything else is unsupported or unavailable', t => {
  const f = conversationFixture(t);
  f.write('{"type":"user"}\n');
  const coverage = session => captureDreamInputs(f.root, { session });
  for (const session of [null, { ...f.session, store: 'host' }, { ...f.session, harness: 'claude' }, { ...f.session, sessionId: '../escape' }]) {
    const captured = coverage(session);
    assert.deepEqual([captured.schemaVersion, captured.coverage.conversations, captured.conversation], [2, 'unsupported', null]);
  }
  // A recorded session that is missing or reached through a link is unavailable.
  assert.equal(coverage({ ...f.session, sessionId: '0199a1b2-c3d4-7e5f-8a9b-000000000000' }).coverage.conversations, 'unavailable');
  // A thread with several rollout files is read from its newest one.
  const later = path.join(f.root, '.soul-state', 'tools', 'codex', 'sessions', '2026', '10', '11', `rollout-2026-10-11T09-00-00-${THREAD}.jsonl`);
  mkdirSync(path.dirname(later), { recursive: true }); writeFileSync(later, '{"newest":true}\n');
  assert.equal(coverage(f.session).conversation.excerpt, '{"newest":true}\n');
  rmSync(path.dirname(later), { recursive: true });
  const outside = mkdtempSync(path.join(tmpdir(), 'dream-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, `rollout-x-${THREAD}.jsonl`), '{"secret":true}\n');
  rmSync(f.file); symlinkSync(path.join(outside, `rollout-x-${THREAD}.jsonl`), f.file);
  assert.equal(coverage(f.session).coverage.conversations, 'unavailable', 'a linked file is never followed');
  rmSync(path.join(f.root, '.soul-state', 'tools', 'codex', 'sessions'), { recursive: true });
  mkdirSync(path.join(outside, '2026', '10', '10'), { recursive: true });
  writeFileSync(path.join(outside, '2026', '10', '10', `rollout-x-${THREAD}.jsonl`), '{"secret":true}\n');
  symlinkSync(outside, path.join(f.root, '.soul-state', 'tools', 'codex', 'sessions'));
  assert.equal(coverage(f.session).coverage.conversations, 'unavailable', 'a linked store is never followed');
  // A linked store root is refused before it is listed, whatever it holds.
  writeFileSync(path.join(outside, '2026', '10', '10', `rollout-2026-10-10T10-00-00-${THREAD}.jsonl`), '{"secret":true}\n');
  assert.equal(coverage(f.session).coverage.conversations, 'unavailable', 'a linked store root is never walked');
  rmSync(path.join(f.root, '.soul-state', 'tools', 'codex', 'sessions'));
  f.write('{"bytes":"\u0000"}\n'.replace('\\u0000', '\0'));
  assert.equal(coverage(f.session).coverage.conversations, 'unavailable', 'binary content is not delivered');
});

test('a long session delivers its newest whole lines within the bound', t => {
  const f = conversationFixture(t);
  const line = index => `${JSON.stringify({ index, text: 'é'.repeat(200) })}\n`;
  const lines = Array.from({ length: 400 }, (_, index) => line(index));
  f.write(lines.join(''));
  const { conversation } = captureDreamInputs(f.root, { session: f.session });
  assert.equal(conversation.truncated, true);
  assert.ok(conversation.excerptBytes <= DREAM_CONVERSATION_LIMITS.excerptBytes);
  assert.equal(conversation.size, Buffer.byteLength(lines.join('')));
  assert.ok(conversation.excerpt.endsWith(lines.at(-1)) && lines.includes(conversation.excerpt.split('\n')[0] + '\n'), 'whole lines, newest last');
  assert.equal(dreamInputMetadata({ ...captureDreamInputs(f.root, { session: f.session }) }).conversation.truncated, true);
  // Binary or invalid UTF-8 bytes in the omitted older part still refuse the session.
  for (const bad of [Buffer.from([0x7b, 0x00, 0x7d, 0x0a]), Buffer.from([0x7b, 0xff, 0x7d, 0x0a])]) {
    writeFileSync(f.file, Buffer.concat([bad, Buffer.from(lines.join(''))]));
    assert.equal(captureDreamInputs(f.root, { session: f.session }).coverage.conversations, 'unavailable');
  }
  // A multibyte character split across the streaming chunk boundary is still valid text.
  const edge = Buffer.concat([Buffer.alloc(DREAM_CONVERSATION_LIMITS.excerptBytes - 1, 0x61), Buffer.from('é\n'), Buffer.from(lines.join(''))]);
  writeFileSync(f.file, edge);
  assert.equal(captureDreamInputs(f.root, { session: f.session }).coverage.conversations, 'supported');
});

test('a growing session store never makes the recorded session unavailable, whichever day it started', t => {
  const f = conversationFixture(t);
  const sessions = path.join(f.root, '.soul-state', 'tools', 'codex', 'sessions');
  // More than DREAM_CONVERSATION_LIMITS.entries entries across the store: 60 days of 80 other sessions.
  let entries = 0;
  for (let day = 1; day <= 60; day++) {
    const dir = path.join(sessions, '2026', String(7 + Math.floor((day - 1) / 30)).padStart(2, '0'), String((day - 1) % 30 + 1).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 80; index++) {
      writeFileSync(path.join(dir, `rollout-2026-x-${String(index).padStart(8, '0')}-0000-4000-8000-${String(day).padStart(12, '0')}.jsonl`), '{}\n');
    }
    entries += 81;
  }
  assert.ok(entries > DREAM_CONVERSATION_LIMITS.entries);
  // The newest session is found first; the oldest is still found past every newer day.
  f.write('{"newest":true}\n');
  assert.equal(captureDreamInputs(f.root, { session: f.session }).conversation.excerpt, '{"newest":true}\n');
  rmSync(f.file);
  const oldest = path.join(sessions, '2026', '01', '01', `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`);
  mkdirSync(path.dirname(oldest), { recursive: true }); writeFileSync(oldest, '{"oldest":true}\n');
  assert.equal(captureDreamInputs(f.root, { session: f.session }).conversation.excerpt, '{"oldest":true}\n');
  // Only one directory listing past the bound is unavailable, and says so rather than guessing.
  const crowded = path.join(sessions, '2026', '01', '02');
  mkdirSync(crowded, { recursive: true });
  for (let index = 0; index <= DREAM_CONVERSATION_LIMITS.entries; index++) writeFileSync(path.join(crowded, `f${index}`), '');
  assert.equal(captureDreamInputs(f.root, { session: f.session }).coverage.conversations, 'unavailable');
});
