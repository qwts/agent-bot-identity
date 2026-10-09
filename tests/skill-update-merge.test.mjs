import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSkillUpdate } from '../skill-update-merge.mjs';
const file = (path, text, mode = '100644') => ({ path, bytes: Buffer.from(text), mode });

test('three-way update takes independent upstream changes while preserving local adaptations', () => {
  const base = [file('SKILL.md', 'entry\r\n'), file('guide.md', 'original'), file('retire.txt', 'old'), file('run', 'script')];
  const local = [file('SKILL.md', 'entry\r\n'), file('guide.md', 'local'), file('retire.txt', 'old'), file('run', 'script'), file('local.bin', [0, 255])];
  const upstream = [file('SKILL.md', 'entry\n'), file('guide.md', 'original'), file('run', 'script', '100755'), file('new.md', 'new')];
  const merged = mergeSkillUpdate(base, local, upstream), files = new Map(merged.entries.map(entry => [entry.path, entry]));
  assert.equal(merged.status, 'ready'); assert.equal(files.get('SKILL.md').bytes.toString(), 'entry\n');
  assert.equal(files.get('guide.md').bytes.toString(), 'local'); assert.equal(files.get('run').mode, '100755');
  assert.deepEqual(files.get('local.bin').bytes, Buffer.from([0, 255])); assert.equal(files.has('retire.txt'), false);
  assert.equal(files.get('new.md').bytes.toString(), 'new');
  files.get('guide.md').bytes.fill(0); assert.equal(local[1].bytes.toString(), 'local', 'caller inventories remain unchanged');
});

test('conflicting additions, modifications and deletions remain explicit without text rewriting', () => {
  const base = [file('modified', 'base'), file('deleted-local', 'base'), file('deleted-upstream', 'base')];
  const local = [file('modified', 'local'), file('added', 'local'), file('deleted-upstream', 'local')];
  const upstream = [file('modified', 'upstream'), file('added', 'upstream'), file('deleted-local', 'upstream')];
  const merged = mergeSkillUpdate(base, local, upstream);
  assert.equal(merged.status, 'conflicted');
  assert.deepEqual(merged.conflicts, [
    { path: 'added', reason: 'both-added' }, { path: 'deleted-local', reason: 'delete-modify' },
    { path: 'deleted-upstream', reason: 'delete-modify' }, { path: 'modified', reason: 'both-modified' },
  ]);
  assert.deepEqual(merged.entries, []);
});

test('identical edits/deletions converge and byte or executable-mode conflicts are not silently merged', () => {
  const base = [file('same', 'old'), file('gone', 'old'), file('mixed', 'old')];
  const local = [file('same', 'new'), file('mixed', 'new')];
  const upstream = [file('same', 'new'), file('mixed', 'old', '100755')];
  const result = mergeSkillUpdate(base, local, upstream);
  assert.deepEqual(result.conflicts, [{ path: 'mixed', reason: 'both-modified' }]);
  assert.deepEqual(result.entries.map(entry => entry.path), ['same']);
  assert.equal(result.decisions.find(item => item.path === 'gone').removed, true);
});

test('independently valid additions cannot create file/directory or portable name collisions', () => {
  for (const [local, upstream, reason] of [
    [[file('a', 'file')], [file('a/b', 'nested')], 'file-directory-collision'],
    [[file('Notes.md', 'local')], [file('notes.md', 'upstream')], 'portable-name-collision'],
    [[file('café.md', 'local')], [file('cafe\u0301.md', 'upstream')], 'portable-name-collision'],
  ]) {
    const result = mergeSkillUpdate([], local, upstream);
    assert.equal(result.status, 'conflicted'); assert.equal(result.conflicts[0].reason, reason);
  }
});
