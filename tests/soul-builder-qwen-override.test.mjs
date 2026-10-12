// `harnesses.qwen` is an accepted override name (owner decision, #379), but
// report-only: Qwen Code renders no settings, so a declaration is validated,
// listed under the report's `unsupported.settings`, and never written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildHarnessFiles, harnessReport } from '../soul-builder.mjs';
import { readSoulPackageEntries, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';

const manifest = (extra) => ({ formatVersion: 2, name: 'Qwen', description: 'Qwen override', displaySeed: 'qwen',
  preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ignore: PACKAGE_IGNORE_LIST, ...extra });
const entries = (soul) => [{ path: 'AGENTS.md', mode: '100644', bytes: Buffer.from('# Soul\n') },
  { path: 'soul.json', mode: '100644', bytes: Buffer.from(JSON.stringify(soul)) }];

function read(t, soul) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qwen-override-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'AGENTS.md'), '# Soul\n');
  writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(soul));
  return () => readSoulPackageEntries(dir);
}

test('harnesses.qwen validates like any override and is reported, not rendered', (t) => {
  const qwen = { model: 'qwen3-coder', reasoningEffort: 'high', permissionMode: 'autopilot',
    env: { LOG_LEVEL: 'debug' }, permissions: { deny: ['Bash(rm *)'] } };
  const soul = manifest({ harness: { model: 'shared' }, harnesses: { qwen } });
  read(t, soul)();
  const output = buildHarnessFiles(entries(soul));
  const before = buildHarnessFiles(entries(manifest({ harness: { model: 'shared' } })));
  // Nothing Qwen reads changes: its settings file carries only the MCP entry.
  assert.deepEqual(output.get('.qwen/settings.json'), before.get('.qwen/settings.json'));
  const report = harnessReport(new Map(output), { manifest: soul }).qwen;
  assert.deepEqual(report.settings, { received: Object.keys(qwen).sort(), rendered: [] });
  assert.deepEqual(report.unsupported.settings, Object.keys(qwen).sort());
  assert.deepEqual(report.unsupported.permissions, [{ effect: 'deny', rule: 'Bash(rm *)' }]);
  assert.equal(report.rendered.includes('settings'), false);
});

test('harnesses.qwen refuses invalid values with the declaration path', (t) => {
  assert.throws(read(t, manifest({ harnesses: { qwen: { reasoningEffort: 'max' } } })), /soul\.json harnesses\.qwen\.reasoningEffort must be low, medium or high/);
  assert.throws(read(t, manifest({ harnesses: { qwen: { theme: 'dark' } } })), /soul\.json harnesses\.qwen\.theme is an unknown harness setting/);
});
