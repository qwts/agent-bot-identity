// The settings matrix in docs/soul-builder.md (#379) is the record of which
// harness renders which declared setting. This test keeps it in step with the
// builder: one row per harness in the build report, the file each row names,
// and Unsupported exactly where the report lists a setting as unsupported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildHarnessFiles, harnessReport, SETTINGS_TARGETS } from '../soul-builder.mjs';
import { PROVIDERS } from '../soul-providers.mjs';
import { readSoulPackageEntries, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';

const root = path.join(import.meta.dirname, '..');
const doc = readFileSync(path.join(root, 'docs', 'soul-builder.md'), 'utf8');
const settingsSection = doc.slice(doc.indexOf('\n## Settings (#379)'), doc.indexOf('\n### Environment and permission rules'));

const LABELS = { 'Claude Code': 'claude', Codex: 'codex', Gemini: 'gemini', OpenCode: 'opencode', Cursor: 'cursor',
  Copilot: 'copilot', Devin: 'devin', Kiro: 'kiro', 'Qwen Code': 'qwen', Muse: 'muse' };
const COLUMNS = { Model: 'model', 'Reasoning effort': 'reasoningEffort', 'Permission mode: safe / autopilot': 'permissionMode',
  Env: 'env', 'Allow / deny rules': 'permissions', Provider: 'provider' };

// `[{ harnesses, file, cells: { key: text } }]` from the first table in the section.
function matrix() {
  const lines = settingsSection.split('\n').filter((line) => line.startsWith('|'));
  const cells = (line) => line.slice(1, -1).split(' | ').map((cell) => cell.trim());
  const header = cells(lines[0]);
  assert.equal(header[0], 'Harness / file');
  const keys = header.slice(1).map((name) => COLUMNS[name] ?? assert.fail(`unknown matrix column ${name}`));
  return lines.slice(2).map((line) => {
    const [label, ...values] = cells(line);
    const [names, file] = label.split(' / ');
    return { harnesses: names.split(', ').map((name) => LABELS[name] ?? assert.fail(`unknown matrix row ${name}`)),
      file: file?.replaceAll('`', '') ?? null, cells: Object.fromEntries(keys.map((key, index) => [key, values[index]])) };
  });
}

const unsupportedCell = (text) => text === 'Unsupported' || text.startsWith("Won't do");

const manifest = (extra) => ({ formatVersion: 2, name: 'Matrix', description: 'Settings matrix', displaySeed: 'matrix',
  preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ignore: PACKAGE_IGNORE_LIST, ...extra });
const entries = (soul) => [{ path: 'AGENTS.md', mode: '100644', bytes: Buffer.from('# Soul\n') },
  { path: 'soul.json', mode: '100644', bytes: Buffer.from(JSON.stringify(soul)) }];

test('every harness in the build report has exactly one settings matrix row, with its settings file', () => {
  const rows = matrix();
  const reported = Object.keys(harnessReport(new Map(), {})).sort();
  assert.deepEqual(rows.flatMap((row) => row.harnesses).sort(), reported);
  for (const row of rows) {
    for (const harness of row.harnesses) {
      const target = SETTINGS_TARGETS.find((entry) => entry.harness === harness);
      assert.equal(row.file, target ? target.path : null, `${harness} names its settings file`);
    }
  }
});

test('a matrix cell says Unsupported exactly where the build report lists the setting as unsupported', () => {
  // Every shared setting declared, with a rule OpenCode can spell so its
  // `permissions` renders; the provider is per harness and checked below.
  const soul = manifest({ harness: { model: 'm', reasoningEffort: 'medium', permissionMode: 'safe',
    env: { LOG_LEVEL: 'debug' }, permissions: { allow: ['Bash(git status)'], deny: ['Edit'] } } });
  const report = harnessReport(new Map(buildHarnessFiles(entries(soul))), { manifest: soul });
  for (const row of matrix()) {
    for (const harness of row.harnesses) {
      for (const [key, text] of Object.entries(row.cells)) {
        const unsupported = key === 'provider'
          ? !(SETTINGS_TARGETS.find((entry) => entry.harness === harness)?.keys.includes('provider') && Object.hasOwn(PROVIDERS, harness))
          : report[harness].unsupported.settings.includes(key);
        assert.equal(unsupportedCell(text), unsupported, `${harness} ${key}: the matrix says ${JSON.stringify(text)}`);
      }
    }
  }
});

test('the override names the doc lists are exactly the ones package validation accepts', (t) => {
  const sentence = settingsSection.match(/The supported override names are ([^.]+)\./)?.[1];
  assert.ok(sentence, 'the override-name sentence was found');
  const documented = [...sentence.matchAll(/`([a-z]+)`/g)].map((match) => match[1]);
  const dir = mkdtempSync(path.join(tmpdir(), 'settings-matrix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'AGENTS.md'), '# Soul\n');
  const accepts = (name) => {
    writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(manifest({ harnesses: { [name]: { model: 'm' } } })));
    try { readSoulPackageEntries(dir); return true; }
    catch (error) { if (error.message.includes(`harnesses.${name} is an unknown harness`)) return false; throw error; }
  };
  for (const name of documented) assert.ok(accepts(name), `${name} is accepted`);
  // Every other reported harness is refused, so the list is complete.
  for (const name of Object.keys(harnessReport(new Map(), {})).filter((harness) => !documented.includes(harness))) {
    assert.equal(accepts(name), false, `${name} is not an override name`);
  }
});
