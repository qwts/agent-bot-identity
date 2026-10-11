import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computePackageRevision, computePackageRevisionFromEntries, readSoulPackageEntries, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { captureDreamConversation, captureDreamInputs, captureDreamMemory, DREAM_MEMORY_LIMITS, dreamInputMetadata, dreamInputMetadataDigest, validateDreamInputMetadata, DREAM_CONVERSATION_LIMITS, DREAM_INPUT_LIMITS, DREAM_PACKAGE_LIMITS } from '../skill-dream-inputs.mjs';

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
  // A newest matching rollout that is a link refuses the session; the older file is not used instead.
  const linked = path.join(f.root, '.soul-state', 'tools', 'codex', 'sessions', '2026', '10', '11', `rollout-2026-10-11T09-00-00-${THREAD}.jsonl`);
  mkdirSync(path.dirname(linked), { recursive: true }); symlinkSync(f.file, linked);
  assert.equal(coverage(f.session).coverage.conversations, 'unavailable', 'no fall back past a linked newest rollout');
  rmSync(path.dirname(linked), { recursive: true });
  // A directory swapped for a link after it was checked is refused, root or day.
  const swapped = mkdtempSync(path.join(tmpdir(), 'dream-swapped-'));
  t.after(() => rmSync(swapped, { recursive: true, force: true }));
  for (const target of ['sessions', path.join('sessions', '2026', '10', '10')]) {
    const directory = path.join(realpathSync(f.root), '.soul-state', 'tools', 'codex', target);
    let swappedOnce = false;
    const result = captureDreamConversation(f.root, f.session, { afterDirectoryOpen: opened => {
      if (opened !== directory || swappedOnce) return;
      swappedOnce = true;
      renameSync(directory, `${directory}.real`);
      symlinkSync(`${directory}.real`, directory);
    } });
    assert.ok(swappedOnce, target);
    assert.equal(result.coverage, 'unavailable', `a ${target} swapped for a link is refused`);
    rmSync(directory); renameSync(`${directory}.real`, directory);
  }
  assert.equal(coverage(f.session).coverage.conversations, 'supported');
  const outside = mkdtempSync(path.join(tmpdir(), 'dream-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, `rollout-x-${THREAD}.jsonl`), '{"secret":true}\n');
  rmSync(f.file); symlinkSync(path.join(outside, `rollout-x-${THREAD}.jsonl`), f.file);
  assert.equal(coverage(f.session).coverage.conversations, 'unavailable', 'a linked file is never followed');
  rmSync(f.file); linkSync(path.join(outside, `rollout-x-${THREAD}.jsonl`), f.file);
  assert.equal(coverage(f.session).coverage.conversations, 'unavailable', 'a hardlinked file from another store is refused');
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

// The soul's harness memory (#903, input format 3).
function memoryFixture(t) {
  const f = fixture(t);
  const home = path.join(f.root, '.soul-state', 'tools', 'claude');
  const projects = path.join(home, 'projects');
  const remember = (relative, text) => { const file = path.join(projects, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); return file; };
  return { ...f, home, projects, remember };
}
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('harness memory in the soul\'s tool home is delivered as format 3, identified by path and whole-file digest', t => {
  const f = memoryFixture(t);
  f.remember('-work-a/memory/MEMORY.md', '- [Prefers short replies](short.md)\n');
  f.remember('-work-a/memory/short.md', 'MEMORY_CANARY: the owner prefers short replies\n');
  f.remember('-work-a-b/memory/notes.md', 'b\n');
  f.remember('-work-a/memory/notes.txt', 'not memory');
  f.remember('-work-a/session.jsonl', '{}\n');
  mkdirSync(path.join(f.projects, '-empty'), { recursive: true });
  const captured = captureDreamInputs(f.root, { memory: { harness: 'claude' } });
  assert.equal(captured.schemaVersion, 3);
  assert.deepEqual([captured.coverage.memory, captured.coverage.conversations, captured.conversation], ['supported', 'unsupported', null]);
  assert.deepEqual(captured.memory.items.map(item => item.path),
    ['projects/-work-a-b/memory/notes.md', 'projects/-work-a/memory/MEMORY.md', 'projects/-work-a/memory/short.md'], 'path order');
  const short = captured.memory.items[2];
  assert.equal(short.excerpt, 'MEMORY_CANARY: the owner prefers short replies\n');
  assert.equal(short.digest, sha(readFileSync(path.join(f.projects, '-work-a/memory/short.md'))));
  assert.deepEqual([captured.memory.remaining, captured.revision], [0, captureDreamInputs(f.root).revision], 'the tool home is not package content');
  const metadata = dreamInputMetadata(captured);
  assert.equal(JSON.stringify(metadata).includes('MEMORY_CANARY'), false, 'durable metadata never holds memory text');
  assert.deepEqual(metadata.memory.items[2], { path: short.path, digest: short.digest, size: short.size, excerptBytes: short.excerptBytes, truncated: false });
  assert.equal(dreamInputMetadataDigest(structuredClone(metadata)), dreamInputMetadataDigest(metadata));
  for (const mutate of [
    value => { value.memory.items[0].excerpt = 'SECRET_CANARY'; },
    value => { value.memory.items[0].path = 'projects/../memory/x.md'; },
    value => { value.memory.items[0].path = 'projects/..'.concat('/memory/x.md'); },
    value => { value.memory.items[0].path = '/projects/a/memory/x.md'; },
    value => { value.memory.items[0].path = 'projects/a/memory/x.txt'; },
    value => { value.memory.items[0].path = 'space/a/memory/x.md'; },
    value => { value.memory.items.push(value.memory.items[0]); },
    value => { value.memory.items.reverse(); },
    value => { value.memory.items[0].truncated = true; },
    value => { value.memory.items[0].excerptBytes = DREAM_MEMORY_LIMITS.excerptBytes + 1; },
    value => { value.memory.harness = 'codex'; },
    value => { value.memory.remaining = -1; },
    value => { value.coverage.memory = 'unavailable'; },
    value => { value.memory = null; },
    value => { delete value.memory; },
    value => { value.schemaVersion = 2; },
  ]) {
    const value = structuredClone(metadata); mutate(value);
    assert.throws(() => validateDreamInputMetadata(value), { code: 'dream-input-metadata-invalid' });
  }
  // Formats 1 and 2 stay exactly as before: no memory key, always unsupported.
  for (const legacy of [dreamInputMetadata(captureDreamInputs(f.root)), dreamInputMetadata(captureDreamInputs(f.root, { session: null }))]) {
    assert.equal(Object.hasOwn(legacy, 'memory'), false);
    assert.throws(() => validateDreamInputMetadata({ ...legacy, memory: null }), { code: 'dream-input-metadata-invalid' });
    assert.throws(() => validateDreamInputMetadata({ ...legacy, coverage: { ...legacy.coverage, memory: 'supported' } }), { code: 'dream-input-metadata-invalid' });
  }
});

test('memory coverage is unsupported without a reader or store, and unavailable for anything unsafe', t => {
  const f = memoryFixture(t);
  const coverage = harness => captureDreamInputs(f.root, { memory: { harness } }).coverage.memory;
  assert.deepEqual([coverage('codex'), coverage(undefined), coverage('claude')], ['unsupported', 'unsupported', 'unsupported'], 'no reader, or no store in the tool home');
  mkdirSync(f.projects, { recursive: true });
  assert.deepEqual(captureDreamMemory(f.root, 'claude'), { coverage: 'supported', memory: { harness: 'claude', items: [], remaining: 0, nextCursor: null } });
  const file = f.remember('-p/memory/a.md', 'mine\n');
  assert.equal(coverage('claude'), 'supported');
  const outside = mkdtempSync(path.join(tmpdir(), 'dream-memory-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'secret.md'), 'SECRET\n');
  mkdirSync(path.join(outside, 'memory'));
  writeFileSync(path.join(outside, 'memory', 'secret.md'), 'SECRET\n');
  const unsafe = [
    ['a linked memory file', () => symlinkSync(path.join(outside, 'secret.md'), path.join(f.projects, '-p/memory/b.md')), () => rmSync(path.join(f.projects, '-p/memory/b.md'))],
    ['a hardlinked memory file', () => linkSync(path.join(outside, 'secret.md'), path.join(f.projects, '-p/memory/b.md')), () => rmSync(path.join(f.projects, '-p/memory/b.md'))],
    ['a linked project', () => symlinkSync(outside, path.join(f.projects, '-q')), () => rmSync(path.join(f.projects, '-q'))],
    ['a linked memory directory', () => { mkdirSync(path.join(f.projects, '-q')); symlinkSync(path.join(outside, 'memory'), path.join(f.projects, '-q/memory')); }, () => rmSync(path.join(f.projects, '-q'), { recursive: true })],
    ['a directory named like a memory file', () => mkdirSync(path.join(f.projects, '-p/memory/c.md')), () => rmSync(path.join(f.projects, '-p/memory/c.md'), { recursive: true })],
    ['binary memory', () => writeFileSync(file, Buffer.from([0x61, 0x00, 0x0a])), () => writeFileSync(file, 'mine\n')],
    ['invalid UTF-8', () => writeFileSync(file, Buffer.from([0x61, 0xff, 0x0a])), () => writeFileSync(file, 'mine\n')],
  ];
  for (const [name, make, undo] of unsafe) {
    make();
    assert.equal(coverage('claude'), 'unavailable', name);
    undo();
    assert.equal(coverage('claude'), 'supported', `${name} undone`);
  }
  // A linked store root or tool home is never followed.
  renameSync(f.projects, path.join(outside, 'projects'));
  symlinkSync(path.join(outside, 'projects'), f.projects);
  assert.equal(coverage('claude'), 'unavailable', 'a linked projects directory');
  rmSync(f.projects); renameSync(path.join(outside, 'projects'), f.projects);
  renameSync(f.home, path.join(outside, 'claude'));
  symlinkSync(path.join(outside, 'claude'), f.home);
  assert.equal(coverage('claude'), 'unavailable', 'a tool home outside the soul');
  rmSync(f.home); renameSync(path.join(outside, 'claude'), f.home);
  // A memory directory swapped for a link after it was checked is refused.
  const directory = path.join(realpathSync(f.root), '.soul-state', 'tools', 'claude', 'projects', '-p', 'memory');
  let swapped = false;
  const result = captureDreamMemory(f.root, 'claude', { afterDirectoryOpen: opened => {
    if (opened !== directory || swapped) return;
    swapped = true; renameSync(directory, `${directory}.real`); symlinkSync(`${directory}.real`, directory);
  } });
  assert.deepEqual([swapped, result.coverage], [true, 'unavailable']);
  rmSync(directory); renameSync(`${directory}.real`, directory);
  // A file changed while it is read is unavailable, so digest, excerpt and
  // size never describe different versions; so is one hardlinked meanwhile.
  for (const [name, change] of [['appended', target => appendFileSync(target, 'more\n')],
    ['rewritten in place', target => { writeFileSync(target, 'MINE\n'); utimesSync(target, new Date(0), new Date(0)); }],
    ['hardlinked', target => linkSync(target, path.join(outside, 'second-name.md'))]]) {
    const changed = captureDreamMemory(f.root, 'claude', { afterFileScan: scanned => { if (scanned === realpathSync(file)) change(scanned); } });
    assert.equal(changed.coverage, 'unavailable', name);
    rmSync(path.join(outside, 'second-name.md'), { force: true }); writeFileSync(file, 'mine\n');
    assert.equal(coverage('claude'), 'supported', `${name} undone`);
  }
  // The whole walk is bounded, not only each listing.
  for (const project of ['-q', '-r']) f.remember(`${project}/memory/a.md`, 'x\n');
  assert.equal(captureDreamMemory(f.root, 'claude', { visitedLimit: 6 }).coverage, 'unavailable');
  assert.equal(captureDreamMemory(f.root, 'claude', { visitedLimit: 9 }).coverage, 'supported');
  for (const project of ['-q', '-r']) rmSync(path.join(f.projects, project), { recursive: true });
  // A listing past the bound is unavailable rather than partial.
  for (let index = 0; index <= DREAM_MEMORY_LIMITS.entries; index++) writeFileSync(path.join(f.projects, '-p/memory', `n${index}.txt`), '');
  assert.equal(coverage('claude'), 'unavailable');
});

test('memory is delivered within item and byte limits, with truncation and the rest counted', t => {
  const f = memoryFixture(t);
  const count = DREAM_MEMORY_LIMITS.items + 3;
  for (let index = 0; index < count; index++) f.remember(`-p/memory/m${String(index).padStart(3, '0')}.md`, `note ${index}\n`);
  let { memory } = captureDreamInputs(f.root, { memory: { harness: 'claude' } });
  assert.deepEqual([memory.items.length, memory.remaining], [DREAM_MEMORY_LIMITS.items, 3]);
  assert.equal(memory.items[0].path, 'projects/-p/memory/m000.md');
  rmSync(path.join(f.projects, '-p'), { recursive: true });
  // A long memory is cut at a character boundary; its digest is still of the whole file.
  const long = Buffer.from('é'.repeat(DREAM_MEMORY_LIMITS.excerptBytes));
  f.remember('-p/memory/a.md', long);
  for (let index = 0; index < 4; index++) f.remember(`-p/memory/b${index}.md`, Buffer.alloc(DREAM_MEMORY_LIMITS.excerptBytes, 0x62));
  ({ memory } = captureDreamInputs(f.root, { memory: { harness: 'claude' } }));
  const [first] = memory.items;
  assert.deepEqual([first.truncated, first.size, first.excerptBytes, first.digest], [true, long.length, DREAM_MEMORY_LIMITS.excerptBytes, sha(long)]);
  assert.equal(memory.items.reduce((sum, item) => sum + item.excerptBytes, 0), DREAM_MEMORY_LIMITS.bytes);
  assert.deepEqual([memory.items.length, memory.remaining], [4, 1], 'the byte budget stops delivery and counts the rest');
  assert.ok(dreamInputMetadata(captureDreamInputs(f.root, { memory: { harness: 'claude' } })));
});

test('a memory cursor lets later runs reach files past the limits, then wraps', t => {
  const f = memoryFixture(t);
  const count = DREAM_MEMORY_LIMITS.items + 3;
  for (let index = 0; index < count; index++) f.remember(`-p/memory/m${String(index).padStart(3, '0')}.md`, `note ${index}\n`);
  const page = cursor => captureDreamInputs(f.root, { memory: { harness: 'claude', cursor } }).memory;
  const first = page(null);
  const last = `projects/-p/memory/m${String(DREAM_MEMORY_LIMITS.items - 1).padStart(3, '0')}.md`;
  assert.equal(first.nextCursor, last);
  const second = page(first.nextCursor);
  assert.deepEqual(second.items.map(item => item.path), [64, 65, 66].map(index => `projects/-p/memory/m${String(index).padStart(3, '0')}.md`));
  assert.deepEqual([second.nextCursor, second.remaining], [null, DREAM_MEMORY_LIMITS.items], 'the end wraps the next run to the start');
  assert.equal(page(second.nextCursor).items[0].path, 'projects/-p/memory/m000.md');
  // A cursor whose file is gone starts at the next path; one past the end wraps.
  rmSync(path.join(f.projects, '-p/memory/m064.md'));
  assert.equal(page('projects/-p/memory/m064.md').items[0].path, 'projects/-p/memory/m065.md');
  assert.equal(page('projects/-p/memory/z.md').items[0].path, 'projects/-p/memory/m000.md');
  assert.equal(page('../elsewhere').items[0].path, 'projects/-p/memory/m000.md', 'an invalid cursor starts from the beginning');
  const metadata = dreamInputMetadata(captureDreamInputs(f.root, { memory: { harness: 'claude', cursor: null } }));
  assert.equal(metadata.memory.nextCursor, last);
  for (const mutate of [
    value => { value.memory.nextCursor = 'projects/-p/memory/m000.md'; },
    value => { value.memory.nextCursor = '../x.md'; },
    value => { value.memory.remaining = 0; },
    value => { delete value.memory.nextCursor; },
  ]) {
    const value = structuredClone(metadata); mutate(value);
    assert.throws(() => validateDreamInputMetadata(value), { code: 'dream-input-metadata-invalid' });
  }
});
