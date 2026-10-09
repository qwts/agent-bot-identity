// The capture boundary (#312; owner decision 2026-10-09): only agent-bot's own
// skill commands capture, checksum and recheck instruction files. Files a
// harness reads or fetches on its own stay outside, a change to them never
// shows up in verify or check, and every report says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../cli/soul-skill.mjs';
import { NOT_CAPTURED } from '../skill-references.mjs';

const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const SKILL = '---\nname: bounded\ndescription: A capture-boundary fixture\n---\n# Bounded\n'
  + '[Guide](references/guide.md)\n[Workspace rules](../CLAUDE.md)\n[Remote rules](https://example.com/AGENTS.md)\n';

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'skill-capture-boundary-'));
  // The library keeps accepted snapshots read-only; reopen them to clean up.
  t.after(() => {
    function thaw(dir) { chmodSync(dir, 0o700); for (const item of readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) thaw(path.join(dir, item.name)); }
    thaw(home); rmSync(home, { recursive: true, force: true });
  });
  // A workspace a harness works in: its own instruction files and fetch cache
  // sit beside the skill, not inside it.
  const workspace = path.join(home, 'workspace'), source = path.join(workspace, 'skill');
  put(path.join(workspace, 'CLAUDE.md'), 'workspace rules v1\n');
  put(path.join(workspace, 'AGENTS.md'), 'agent rules v1\n');
  put(path.join(source, 'SKILL.md'), SKILL);
  put(path.join(source, 'references/guide.md'), 'guide v1\n');
  const options = { home, env: {}, now: () => new Date('2026-10-09T00:00:00Z') };
  const run = async argv => {
    let stdout = '', stderr = '';
    const status = await main([...argv, '--json'], { ...options, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    return { status, stderr, result: JSON.parse(stdout) };
  };
  return { workspace, source, run };
}

test('only files agent-bot import acquires are captured; harness-read and fetched files are not', async t => {
  const f = fixture(t);
  // A local import never fetches: any network call here would be an
  // undeclared retrieval path.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('local import must not fetch'); };
  t.after(() => { globalThis.fetch = realFetch; });

  const imported = await f.run(['import', f.source]);
  assert.equal(imported.status, 0, imported.stderr);
  const record = imported.result;
  assert.equal(record.notCaptured, NOT_CAPTURED);
  assert.equal(record.coverage.universalRetrieval, false);
  // Lines 6-8 of SKILL.md: the guide inside the skill is captured; the
  // workspace file and the remote instruction file are reported, not captured.
  assert.deepEqual(record.dependencies.map(({ line, target, source, status, reason }) => ({ line, target, source, status, reason })), [
    { line: 6, target: 'references/guide.md', source: undefined, status: 'captured', reason: undefined },
    { line: 7, target: undefined, source: undefined, status: 'unresolved', reason: 'unsafe-reference' },
    { line: 8, target: undefined, source: 'https://example.com/AGENTS.md', status: 'unresolved', reason: 'remote-capture-unsupported' },
  ]);
  assert.deepEqual(Object.keys(record.localBaseline.files).sort(), ['SKILL.md', 'references/guide.md']);
  assert.deepEqual(readdirSync(path.join(record.snapshot, 'payload')).sort(), ['SKILL.md', 'references']);

  // The harness changes what it reads and caches what it fetched: neither is
  // captured, so verify and check see nothing, and both say why.
  put(path.join(f.workspace, 'CLAUDE.md'), 'workspace rules v2\n');
  put(path.join(f.workspace, 'AGENTS.md'), 'agent rules v2\n');
  put(path.join(f.workspace, '.harness-cache/example.com/AGENTS.md'), 'fetched by the harness\n');
  const verified = await f.run(['verify', record.id]);
  assert.equal(verified.result.verification, 'verified');
  assert.equal(verified.result.notCaptured, NOT_CAPTURED);
  const unchanged = await f.run(['check', record.id]);
  assert.equal(unchanged.result.status, 'unchanged');
  assert.equal(unchanged.result.notCaptured, NOT_CAPTURED);

  // A captured file is rechecked: the same kind of edit inside the boundary
  // is reported.
  put(path.join(f.source, 'references/guide.md'), 'guide v2\n');
  const changed = await f.run(['check', record.id]);
  assert.equal(changed.result.status, 'changed');
  assert.deepEqual(changed.result.changes.modified, ['references/guide.md']);
  assert.equal(changed.result.notCaptured, NOT_CAPTURED);
});

test('every library report states what is not captured; errors do not', async t => {
  const f = fixture(t);
  const { result: { id } } = await f.run(['import', f.source]);
  for (const argv of [['list'], ['show', id], ['verify', id], ['check', id]]) {
    const { status, result } = await f.run(argv);
    assert.equal(status, 0, argv.join(' '));
    assert.equal(result.notCaptured, NOT_CAPTURED, argv.join(' '));
  }
  const missing = await f.run(['show', 'not-a-uuid']);
  assert.equal(missing.status, 1);
  assert.equal(missing.result.notCaptured, undefined);
  assert.match(NOT_CAPTURED, /web fetch, MCP tools/);
});
