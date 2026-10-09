import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importSkill, checkSkill, showSkill, verifySkill, planSkillUpdate, applySkillUpdate, recoverSkillUpdate } from '../skill-library.mjs';
import { main } from '../cli/soul-skill.mjs';
const put = (file, bytes) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); };
const entry = name => `---\nname: ${name}\ndescription: Update fixture\n---\nUseful skill\n`;
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'skill-updates-'));
  t.after(() => { const thaw = dir => { chmodSync(dir, 0o700); for (const item of readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) thaw(path.join(dir, item.name)); }; thaw(home); rmSync(home, { recursive: true, force: true }); });
  const source = path.join(home, 'source'), options = { home, env: {} };
  put(path.join(source, 'SKILL.md'), entry('demo')); put(path.join(source, 'guide.md'), 'original'); put(path.join(source, 'upstream.md'), 'old');
  const imported = importSkill(source, options), root = path.dirname(imported.path);
  put(path.join(imported.path, 'guide.md'), 'local adaptation');
  put(path.join(source, 'upstream.md'), 'new\r\n');
  const check = checkSkill(imported.id, options);
  const preview = () => planSkillUpdate(imported.id, check.checkId, options);
  const apply = (extra = {}) => { const p = preview(); return applySkillUpdate(imported.id, check.checkId, { ...options, expectedAccepted: p.accepted, expectedLocal: p.currentLocal, ...extra }); };
  return { home, source, options, imported, root, check, preview, apply };
}

test('a reviewed update applies independent upstream edits, preserves local work and retains prior bytes', t => {
  const f = fixture(t), before = readdirSync(f.root), plan = f.preview();
  assert.equal(plan.status, 'ready'); assert.equal(plan.activationChanged, false);
  assert.deepEqual(readdirSync(f.root), before, 'preview is read-only');
  const result = f.apply(), current = showSkill(f.imported.id, f.options);
  assert.equal(result.status, 'updated'); assert.equal(current.accepted, f.check.candidate);
  assert.equal(readFileSync(path.join(current.path, 'guide.md'), 'utf8'), 'local adaptation');
  assert.equal(readFileSync(path.join(current.path, 'upstream.md'), 'utf8'), 'new\r\n');
  assert.equal(readFileSync(path.join(result.previousPayload, 'guide.md'), 'utf8'), 'local adaptation');
  assert.equal(readFileSync(path.join(result.previousPayload, 'upstream.md'), 'utf8'), 'old');
  assert.equal(readFileSync(path.join(f.imported.snapshot, 'payload/upstream.md'), 'utf8'), 'old');
  assert.equal(verifySkill(current.id, f.options).verification, 'verified');
  const next = checkSkill(current.id, f.options);
  assert.deepEqual(next.localAdaptations.modified, ['guide.md']);
  assert.equal(next.status, 'unchanged');
  assert.equal(recoverSkillUpdate(current.id, f.options).status, 'clean');
});

test('stale digests, old checks, unavailable checks and conflicts publish no update', t => {
  const f = fixture(t), plan = f.preview();
  put(path.join(f.imported.path, 'guide.md'), 'changed after review');
  assert.throws(() => applySkillUpdate(f.imported.id, f.check.checkId, { ...f.options, expectedAccepted: plan.accepted, expectedLocal: plan.currentLocal }), /changed since review/);
  put(path.join(f.source, 'guide.md'), 'upstream also changed');
  const conflict = checkSkill(f.imported.id, f.options), p = planSkillUpdate(f.imported.id, conflict.checkId, f.options);
  assert.equal(p.status, 'conflicted'); assert.equal(p.conflicts[0].path, 'guide.md');
  assert.equal(applySkillUpdate(f.imported.id, conflict.checkId, { ...f.options, expectedAccepted: p.accepted, expectedLocal: p.currentLocal }).status, 'conflicted');
  assert.equal(existsSync(path.join(f.root, '.updates')), false);
  assert.equal(showSkill(f.imported.id, f.options).accepted, f.imported.accepted);
  rmSync(f.source, { recursive: true });
  const unavailable = checkSkill(f.imported.id, f.options);
  assert.throws(() => planSkillUpdate(f.imported.id, unavailable.checkId, f.options), /available source check/);
  f.apply();
  assert.throws(f.preview, /older accepted snapshot/);
});

test('recovery distinguishes pre-commit rollback from committed metadata at every interruption point', t => {
  for (const phase of ['prepared', 'previous-retained', 'payload-published', 'record-published']) {
    const f = fixture(t);
    assert.throws(() => f.apply({ checkpoint: step => { if (step === phase) throw new Error('simulated process interruption'); } }), error => error.code === 'skill-update-pending');
    assert.throws(() => showSkill(f.imported.id, f.options), error => error.code === 'skill-update-pending');
    assert.throws(() => checkSkill(f.imported.id, f.options), error => error.code === 'skill-update-pending');
    const result = recoverSkillUpdate(f.imported.id, f.options), committed = phase === 'record-published';
    assert.equal(result.status, committed ? 'updated' : 'rolled-back', phase);
    const current = showSkill(f.imported.id, f.options);
    assert.equal(current.accepted, committed ? f.check.candidate : f.imported.accepted);
    assert.equal(readFileSync(path.join(current.path, 'upstream.md'), 'utf8'), committed ? 'new\r\n' : 'old');
    assert.equal(readFileSync(path.join(current.path, 'guide.md'), 'utf8'), 'local adaptation');
    assert.equal(recoverSkillUpdate(f.imported.id, f.options).status, 'clean');
  }
});

test('rollback retains edits made to the published payload and refuses unrelated destinations', t => {
  const f = fixture(t);
  assert.throws(() => f.apply({ checkpoint: phase => { if (phase === 'payload-published') { put(path.join(f.imported.path, 'concurrent.md'), 'preserve me'); throw new Error('interrupt'); } } }), /interrupted/);
  const result = recoverSkillUpdate(f.imported.id, f.options);
  assert.equal(readFileSync(path.join(result.retainedMaterial, 'interrupted-payload/concurrent.md'), 'utf8'), 'preserve me');
  assert.equal(readFileSync(path.join(f.imported.path, 'upstream.md'), 'utf8'), 'old');
  const other = fixture(t);
  assert.throws(() => other.apply({ checkpoint: phase => { if (phase === 'previous-retained') throw new Error('interrupt'); } }), /interrupted/);
  mkdirSync(other.imported.path); put(path.join(other.imported.path, 'unmanaged'), 'keep');
  assert.throws(() => recoverSkillUpdate(other.imported.id, other.options), /unexpected destination/);
  assert.equal(readFileSync(path.join(other.imported.path, 'unmanaged'), 'utf8'), 'keep');
});

test('upstream name changes are recoverable and excluded local material cannot disappear silently', t => {
  const f = fixture(t);
  put(path.join(f.source, 'SKILL.md'), entry('renamed'));
  const check = checkSkill(f.imported.id, f.options), p = planSkillUpdate(f.imported.id, check.checkId, f.options);
  const result = applySkillUpdate(f.imported.id, check.checkId, { ...f.options, expectedAccepted: p.accepted, expectedLocal: p.currentLocal });
  assert.equal(result.status, 'updated'); assert.equal(existsSync(f.imported.path), false);
  const current = showSkill(f.imported.id, f.options);
  assert.equal(path.basename(current.path), 'renamed'); assert.equal(readFileSync(path.join(current.path, 'guide.md'), 'utf8'), 'local adaptation');
  const other = fixture(t); put(path.join(other.imported.path, '.git/config'), 'unmanaged');
  assert.throws(other.preview, /excluded local material/);
  assert.equal(readFileSync(path.join(other.imported.path, '.git/config'), 'utf8'), 'unmanaged');
});

test('update CLI requires explicit reviewed digests and supports preview and recovery', t => {
  const f = fixture(t); let output = '', error = '';
  const options = { ...f.options, stdout: { write: value => { output += value; } }, stderr: { write: value => { error += value; } } };
  const args = ['update', f.imported.id, '--check', f.check.checkId];
  assert.equal(main([...args, '--json'], options), 0);
  const plan = JSON.parse(output); output = '';
  assert.equal(main([...args, '--apply'], options), 2); assert.match(error, /usage/);
  assert.equal(main([...args, '--apply', '--expected-accepted', plan.accepted, '--expected-local', plan.currentLocal, '--json'], options), 0);
  assert.equal(JSON.parse(output).status, 'updated'); output = '';
  assert.equal(main(['update', f.imported.id, '--recover', '--json'], options), 0);
  assert.equal(JSON.parse(output).status, 'clean');
  assert.equal(main([...args, '--recover'], options), 2);
});

test('invalid checks and linked update metadata refuse without changing live material', t => {
  for (const alteration of [value => ({ ...value, id: '11111111-1111-4111-8111-111111111111' }),
    value => ({ ...value, coverage: { ...value.coverage, acquisition: 'partial' } }), () => null]) {
    const f = fixture(t), file = path.join(f.root, '.checks', `${f.check.checkId}.json`);
    writeFileSync(file, JSON.stringify(alteration(f.check)));
    assert.throws(f.preview, error => error.code === 'skill-check-invalid');
    assert.equal(showSkill(f.imported.id, f.options).accepted, f.imported.accepted);
  }
  const f = fixture(t), outside = path.join(f.home, 'outside'); mkdirSync(outside);
  symlinkSync(outside, path.join(f.root, '.updates'));
  assert.throws(f.apply, error => error.code === 'skill-path-unsafe');
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(showSkill(f.imported.id, f.options).accepted, f.imported.accepted);
});

test('recovery refuses altered metadata and linked payloads, and keeps post-commit local edits', t => {
  const f = fixture(t);
  assert.throws(() => f.apply({ checkpoint: phase => { if (phase === 'record-published') throw new Error('interrupt'); } }), /interrupted/);
  put(path.join(f.imported.path, 'guide.md'), 'edited after commit');
  const result = recoverSkillUpdate(f.imported.id, f.options);
  assert.equal(result.status, 'updated'); assert.equal(result.localDrift, true);
  assert.equal(readFileSync(path.join(f.imported.path, 'guide.md'), 'utf8'), 'edited after commit');
  const other = fixture(t);
  assert.throws(() => other.apply({ checkpoint: phase => { if (phase === 'previous-retained') throw new Error('interrupt'); } }), /interrupted/);
  symlinkSync(other.source, other.imported.path);
  assert.throws(() => recoverSkillUpdate(other.imported.id, other.options), error => error.code === 'skill-path-unsafe');
  assert.equal(readFileSync(path.join(other.source, 'upstream.md'), 'utf8'), 'new\r\n');
  rmSync(other.imported.path);
  const pending = path.join(other.root, '.pending-update.json'), txn = JSON.parse(readFileSync(pending));
  const afterFile = path.join(other.root, '.updates', txn.updateId, 'after-manifest.json');
  const original = readFileSync(afterFile), after = JSON.parse(original);
  writeFileSync(afterFile, JSON.stringify({ ...after, updatedAt: 'altered' }));
  assert.throws(() => recoverSkillUpdate(other.imported.id, other.options), /records disagree/);
  writeFileSync(afterFile, original);
  assert.equal(recoverSkillUpdate(other.imported.id, other.options).status, 'rolled-back');
});

test('renamed updates refuse occupied destinations and recover without losing the old name', t => {
  for (const phase of ['previous-retained', 'payload-published']) {
    const f = fixture(t); put(path.join(f.source, 'SKILL.md'), entry('renamed'));
    const check = checkSkill(f.imported.id, f.options);
    const occupied = path.join(f.root, 'renamed'); put(path.join(occupied, 'keep'), 'unrelated');
    const conflict = planSkillUpdate(f.imported.id, check.checkId, f.options);
    assert.equal(conflict.status, 'conflicted'); assert.ok(conflict.conflicts.some(c => c.reason === 'destination-exists'));
    rmSync(occupied, { recursive: true });
    const plan = planSkillUpdate(f.imported.id, check.checkId, f.options);
    assert.throws(() => applySkillUpdate(f.imported.id, check.checkId, { ...f.options, expectedAccepted: plan.accepted,
      expectedLocal: plan.currentLocal, checkpoint: step => { if (step === phase) throw new Error('interrupt'); } }), /interrupted/);
    assert.equal(recoverSkillUpdate(f.imported.id, f.options).status, 'rolled-back');
    assert.equal(showSkill(f.imported.id, f.options).name, 'demo');
    assert.equal(existsSync(occupied), false);
    assert.equal(readFileSync(path.join(f.imported.path, 'guide.md'), 'utf8'), 'local adaptation');
  }
});
