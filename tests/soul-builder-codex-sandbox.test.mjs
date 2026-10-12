// Codex's workspace-write sandbox from the soul (#379): `harness.sandbox`
// renders `[sandbox_workspace_write]` in `.codex/config.toml`, merges with an
// authored table, and is refused or reported everywhere it cannot apply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildHarnessFiles, harnessReport } from '../soul-builder.mjs';
import { readSoulPackageEntries, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { GENERATED_HARNESS_MARKER as MARKER } from '../soul-harness-contract.mjs';

const manifest = (extra) => ({ formatVersion: 2, name: 'Sandbox', description: 'Codex sandbox', displaySeed: 'sandbox',
  preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ignore: PACKAGE_IGNORE_LIST, ...extra });
const entries = (soul) => [{ path: 'AGENTS.md', mode: '100644', bytes: Buffer.from('# Soul\n') },
  { path: 'soul.json', mode: '100644', bytes: Buffer.from(JSON.stringify(soul)) }];
const codex = (soul, authored) => buildHarnessFiles(entries(soul), authored ? { authored: new Map([['.codex/config.toml', Buffer.from(authored)]]) } : {})
  .get('.codex/config.toml').toString();
const sandbox = { networkAccess: true, writableRoots: ['/opt/cache', 'C:\\work'], excludeTmpdirEnvVar: false, excludeSlashTmp: true };

function reads(t, soul) {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-sandbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'AGENTS.md'), '# Soul\n');
  writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(soul));
  return () => readSoulPackageEntries(dir);
}

test('a declared sandbox renders Codex\'s [sandbox_workspace_write] table and is reported', (t) => {
  const soul = manifest({ comms: false, harness: { permissionMode: 'safe', sandbox } });
  reads(t, soul)();
  assert.equal(codex(soul), `# ${MARKER}\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\n`
    + 'exclude_slash_tmp = true\nexclude_tmpdir_env_var = false\nnetwork_access = true\nwritable_roots = ["/opt/cache","C:\\\\work"]\n');
  const report = harnessReport(new Map(buildHarnessFiles(entries(soul))), { manifest: soul, comms: false });
  assert.ok(report.codex.settings.rendered.includes('sandbox'));
  assert.deepEqual(report.codex.unsupported.settings, []);
  for (const harness of ['claude', 'gemini', 'opencode', 'cursor', 'qwen']) assert.ok(report[harness].unsupported.settings.includes('sandbox'), harness);
});

test('an override replaces the shared sandbox whole', () => {
  const soul = manifest({ comms: false, harness: { sandbox }, harnesses: { codex: { sandbox: { networkAccess: false } } } });
  assert.equal(codex(soul), `# ${MARKER}\n[sandbox_workspace_write]\nnetwork_access = false\n`);
});

test('authored sandbox keys the soul does not declare stay; declared ones are replaced; rebuilds are identical', () => {
  const soul = manifest({ comms: false, harness: { sandbox: { networkAccess: false } } });
  const authored = 'model = "mine"\n\n[sandbox_workspace_write]\nnetwork_access = true\nexclude_slash_tmp = true # keep\n\n[profiles.x]\nmodel = "p"\n';
  const once = codex(soul, authored);
  assert.equal(once, `# ${MARKER}\nmodel = "mine"\n\n[profiles.x]\nmodel = "p"\n\n[sandbox_workspace_write]\nnetwork_access = false\nexclude_slash_tmp = true # keep\n`);
  assert.equal(codex(soul, once), once);
});

test('a sandbox that is not a plain table cannot be merged', () => {
  const soul = manifest({ comms: false, harness: { sandbox: { networkAccess: false } } });
  for (const authored of ['sandbox_workspace_write = { network_access = true }\n', '[sandbox_workspace_write.extra]\nx = 1\n']) {
    assert.throws(() => codex(soul, authored), /sandbox_workspace_write must be a \[sandbox_workspace_write\] table/);
  }
});

test('package validation refuses unknown keys and bad values with the declaration path', (t) => {
  const refuse = (value, pattern) => assert.throws(reads(t, manifest({ harnesses: { codex: { sandbox: value } } })), pattern);
  refuse(true, /soul\.json harnesses\.codex\.sandbox must be an object/);
  refuse({ network_access: true }, /harnesses\.codex\.sandbox\.network_access is an unknown sandbox setting/);
  refuse({ networkAccess: 'yes' }, /sandbox\.networkAccess must be true or false/);
  refuse({ writableRoots: ['relative/dir'] }, /sandbox\.writableRoots must be an array of absolute paths/);
  refuse({ writableRoots: ['/a', '/a'] }, /sandbox\.writableRoots must not repeat a path/);
  refuse({ writableRoots: ['/a\nb'] }, /sandbox\.writableRoots must be an array of absolute paths/);
});
