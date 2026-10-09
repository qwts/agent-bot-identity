import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDreamPreviewStore, DREAM_PREVIEW_RETAIN } from '../skill-dream-previews.mjs';
import { detachDreamPreview, dreamPreviewDigest, validateDreamOutcome } from '../skill-dream-outcomes.mjs';

const A = 'agent_12345678-1234-4234-8234-123456789abc';
const B = 'agent_22345678-1234-4234-8234-123456789abc';
const posix = { skip: process.platform === 'win32' };
const run = n => ({ runId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, journalRevision: n });
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dream-previews-'))), directory = path.join(root, 'previews');
  mkdirSync(directory, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { directory, store: createDreamPreviewStore({ directory }) };
}

test('previews round-trip by digest and prune to the newest twenty per soul', posix, t => {
  const { directory, store } = fixture(t);
  assert.equal(DREAM_PREVIEW_RETAIN, 20);
  for (let n = 1; n <= 23; n++) store.write({ agentId: A, ...run(n), text: `preview ${n}` });
  store.write({ agentId: B, ...run(1), text: 'other soul' });
  assert.equal(store.prune(A), 3);
  assert.equal(store.prune(A), 0);
  assert.equal(readdirSync(path.join(directory, A)).length, 20);
  for (const n of [1, 2, 3]) assert.deepEqual(store.read({ agentId: A, ...run(n), digest: dreamPreviewDigest(`preview ${n}`) }), { status: 'unavailable', text: null });
  for (const n of [4, 23]) assert.deepEqual(store.read({ agentId: A, ...run(n), digest: dreamPreviewDigest(`preview ${n}`) }), { status: 'available', text: `preview ${n}` });
  assert.deepEqual(store.read({ agentId: B, ...run(1), digest: dreamPreviewDigest('other soul') }), { status: 'available', text: 'other soul' });
  assert.deepEqual(store.read({ agentId: B, ...run(9), digest: dreamPreviewDigest('x') }), { status: 'unavailable', text: null });
  assert.deepEqual(store.status(), { location: 'outside-journal', retainPerSoul: 20 });
});

test('retention follows journal order, so a later run is never the one pruned', posix, t => {
  const { store } = fixture(t);
  // Run IDs sort opposite to journal order here; only the revision decides.
  for (let n = 1; n <= 21; n++) store.write({ agentId: A, runId: `00000000-0000-4000-8000-${String(100 - n).padStart(12, '0')}`, journalRevision: n * 3, text: `preview ${n}` });
  store.prune(A);
  assert.equal(store.read({ agentId: A, runId: '00000000-0000-4000-8000-000000000079', journalRevision: 63, digest: dreamPreviewDigest('preview 21') }).status, 'available');
  assert.equal(store.read({ agentId: A, runId: '00000000-0000-4000-8000-000000000099', journalRevision: 3, digest: dreamPreviewDigest('preview 1') }).status, 'unavailable');
});

test('edited, linked or public previews are refused, and the store directory must be private', posix, t => {
  const { directory, store } = fixture(t);
  const write = n => { store.write({ agentId: A, ...run(n), text: `preview ${n}` }); return path.join(directory, A, readdirSync(path.join(directory, A)).sort().at(-1)); };
  const read = n => store.read({ agentId: A, ...run(n), digest: dreamPreviewDigest(`preview ${n}`) }).status;
  writeFileSync(write(1), 'preview 1 edited');
  assert.equal(read(1), 'invalid');
  chmodSync(write(2), 0o644);
  assert.equal(read(2), 'invalid');
  const linked = write(3); rmSync(linked); symlinkSync(write(4), linked);
  assert.equal(read(3), 'invalid');
  assert.equal(read(4), 'available');
  assert.throws(() => store.write({ agentId: 'not-a-soul', ...run(5), text: 'x' }), { code: 'dream-preview-invalid' });
  chmodSync(directory, 0o755);
  assert.throws(() => store.read({ agentId: A, ...run(4), digest: dreamPreviewDigest('preview 4') }), { code: 'dream-store-directory' });
  assert.throws(() => createDreamPreviewStore({ directory, retain: 21 }), { code: 'dream-store-configuration' });
});

test('detaching moves report text out of the outcome and keeps structured reports unchanged', () => {
  const inline = { schemaVersion: 1, runId: run(1).runId, startingRevision: `sha256:${'a'.repeat(64)}`, processingCoverage: 'unverified',
    report: { status: 'unstructured', code: 'no-structured-report', text: 'héllo', textTruncated: false }, items: [], unreported: 1 };
  const { outcome, text } = detachDreamPreview(inline);
  assert.equal(text, 'héllo');
  assert.deepEqual(outcome.report, { status: 'unstructured', code: 'no-structured-report', textTruncated: false, preview: { digest: dreamPreviewDigest('héllo'), bytes: 6 } });
  assert.deepEqual(detachDreamPreview(outcome), { outcome, text: null });
  const structured = detachDreamPreview({ ...inline, report: { status: 'structured', code: null, text: null, textTruncated: false } });
  assert.deepEqual([structured.text, structured.outcome.report.preview], [null, null]);
  for (const report of [{ ...outcome.report, text: 'x' }, { ...outcome.report, preview: { digest: 'sha256:00', bytes: 1 } },
    { ...outcome.report, preview: { digest: dreamPreviewDigest('x'), bytes: 64 * 1024 + 1 } }]) {
    assert.throws(() => validateDreamOutcome({ ...outcome, report }), { code: 'dream-outcome-invalid' });
  }
  assert.throws(() => validateDreamOutcome({ ...inline, schemaVersion: 2 }), { code: 'dream-outcome-invalid' });
});
