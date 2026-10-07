import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnessFiles, harnessReport, MCP_TARGETS, SETTINGS_TARGETS } from '../soul-builder.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { computePackageRevision, expectedGeneratedFiles, readSoulPackageEntries, validateSoulPackage, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { GENERATED_HARNESS_MARKER as MARKER, isGeneratedPath } from '../soul-harness-contract.mjs';

const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const defaults = { model: 'shared-model', reasoningEffort: 'medium', permissionMode: 'safe' };
const names = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'devin', 'muse', 'kiro'];
const supported = { claude: ['model', 'permissionMode', 'reasoningEffort'], codex: ['model', 'permissionMode', 'reasoningEffort'],
  gemini: ['model'], opencode: ['model', 'permissionMode'] };
const entry = (path, content) => ({ path, mode: '100644', bytes: Buffer.from(content) });
const manifest = (extra = {}) => ({ formatVersion: 2, name: 'Settings', description: 'Settings tests', displaySeed: 'settings',
  preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ignore: PACKAGE_IGNORE_LIST, ...extra });
const entries = (soul) => [entry('AGENTS.md', '# Soul\n'), entry('soul.json', JSON.stringify(soul))];
const json = (output, path) => JSON.parse(output.get(path).toString());
function put(root, path, bytes) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soul-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const soul = manifest(extra);
  for (const { path, bytes } of entries(soul)) put(root, path, bytes);
  soul.revision = computePackageRevision(root);
  put(root, 'soul.json', JSON.stringify(soul));
  return root;
}

for (const harness of names) {
  for (const override of [false, true]) {
    test(`${harness}: shared defaults${override ? ' with a per-harness override' : ''} render and report capabilities`, () => {
      const settings = override ? { model: 'override-model', permissionMode: 'autopilot', reasoningEffort: 'high' } : defaults;
      const soul = manifest({ harness: defaults, ...(override ? { harnesses: { [harness]: settings } } : {}) });
      const output = buildHarnessFiles(entries(soul));
      const report = harnessReport(new Map(output), { manifest: soul })[harness];
      const keys = Object.keys(defaults).sort();
      assert.deepEqual(report.settings, { received: keys, rendered: supported[harness] ?? [] });
      assert.deepEqual(report.unsupported.settings, keys.filter((key) => !supported[harness]?.includes(key)));
      assert.equal(report.rendered.includes('settings'), !!supported[harness]);
      if (harness === 'claude') {
        const value = json(output, '.claude/settings.json');
        assert.equal(value.model, settings.model);
        assert.equal(value.effortLevel, settings.reasoningEffort);
        assert.deepEqual(value.permissions, { defaultMode: override ? 'bypassPermissions' : 'default' });
      } else if (harness === 'codex') {
        const value = output.get('.codex/config.toml').toString();
        assert.ok(value.startsWith(`# ${MARKER}\nmodel = "${settings.model}"\nmodel_reasoning_effort = "${settings.reasoningEffort}"\n`));
        assert.ok(value.includes(`approval_policy = "${override ? 'never' : 'on-request'}"\nsandbox_mode = "${override ? 'danger-full-access' : 'workspace-write'}"\n`));
        assert.match(value, /\[mcp_servers.agent-bot\]/);
      } else if (harness === 'gemini') assert.equal(json(output, '.gemini/settings.json').model, settings.model);
      else if (harness === 'opencode') {
        const value = json(output, 'opencode.json');
        assert.equal(value.model, settings.model);
        assert.deepEqual(value.permission, { edit: override ? 'allow' : 'ask', bash: override ? 'allow' : 'ask' });
      } else {
        // Only the MCP file is theirs (Cursor, Kiro); it carries no settings.
        const mcp = MCP_TARGETS.find((target) => target.harness === harness)?.path;
        assert.ok(![...output.keys()].some((path) => path.startsWith(`.${harness}/`) && path !== mcp));
        if (mcp) assert.deepEqual(Object.keys(json(output, mcp)), ['_comment', 'mcpServers']);
      }
      if (override && harness !== 'claude') assert.equal(json(output, '.claude/settings.json').model, defaults.model);
    });
  }
}

test('overrides inherit absent keys; undeclared settings and legacy souls remain untouched', () => {
  const soul = manifest({ harness: defaults, harnesses: { claude: { model: 'claude-only' }, codex: {} } });
  const output = buildHarnessFiles(entries(soul));
  assert.equal(json(output, '.claude/settings.json').effortLevel, 'medium');
  assert.equal(json(output, '.claude/settings.json').model, 'claude-only');
  for (const extra of [{}, { harness: {}, harnesses: {} }]) {
    const legacy = manifest(extra), files = buildHarnessFiles(entries(legacy));
    assert.equal(files.has('.claude/settings.json'), false);
    assert.ok(Object.values(harnessReport(files, { manifest: legacy })).every((report) => report.settings.received.length === 0));
  }
  const only = manifest({ comms: false, harnesses: { codex: { reasoningEffort: 'low' }, cursor: { model: 'unsupported' } } });
  const files = buildHarnessFiles(entries(only));
  assert.equal(files.get('.codex/config.toml').toString(), `# ${MARKER}\nmodel_reasoning_effort = "low"\n`);
  assert.deepEqual(harnessReport(files, { comms: false, manifest: only }).cursor.unsupported.settings, ['model']);
  assert.equal(files.has('.claude/settings.json'), false);
});

const authoredFiles = () => new Map([
  ['.claude/settings.json', Buffer.from(JSON.stringify({ model: 'old', effortLevel: 'low', theme: 'dark',
    permissions: { defaultMode: 'old', allow: ['Read'], deny: ['Bash(rm *)'] }, hooks: { Stop: [] } }))],
  ['.gemini/settings.json', Buffer.from(JSON.stringify({ model: 'old', theme: 'dark', mcpServers: { own: { command: 'own' } } }))],
  ['opencode.json', Buffer.from(JSON.stringify({ model: 'old', theme: 'dark', permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' }, mcp: { own: {} } }))],
  ['.codex/config.toml', Buffer.from('"model" = "old"\r\nmodel_reasoning_effort = "low"\r\napproval_policy = "never"\r\nsandbox_mode = "read-only"\r\n# keep\r\nother = true\r\n\r\n[profiles.local]\r\nmodel = "profile-model"\r\n\r\n[mcp_servers.own]\r\ncommand = "own"\r\n')],
]);

test('authored JSON/TOML keeps unrelated keys and servers, replaces owned keys, and rebuilds identically', () => {
  const source = entries(manifest({ harness: defaults }));
  const authored = authoredFiles(), snapshot = [...authored].map(([path, bytes]) => [path, bytes.toString('base64')]);
  const output = buildHarnessFiles(source, { authored });
  const claude = json(output, '.claude/settings.json');
  assert.deepEqual(claude.permissions, { defaultMode: 'default', allow: ['Read'], deny: ['Bash(rm *)'] });
  assert.deepEqual(claude.hooks, { Stop: [] });
  assert.equal(claude.effortLevel, 'medium');
  assert.equal(json(output, '.gemini/settings.json').mcpServers.own.command, 'own');
  assert.deepEqual(json(output, 'opencode.json').permission, { edit: 'ask', bash: 'ask', webfetch: 'deny' });
  for (const path of ['.claude/settings.json', '.gemini/settings.json', 'opencode.json']) {
    assert.equal(json(output, path).theme, 'dark');
    assert.equal(json(output, path).model, 'shared-model');
    assert.equal(json(output, path)._comment, MARKER);
  }
  const toml = output.get('.codex/config.toml').toString();
  assert.ok(!toml.includes('"old"'));
  assert.match(toml, /# keep\nother = true\n\n\[profiles.local\]\nmodel = "profile-model"/);
  assert.match(toml, /\[mcp_servers.own\]\ncommand = "own"/);
  assert.deepEqual(output, buildHarnessFiles([...source].reverse(), { authored }));
  assert.deepEqual(output, buildHarnessFiles([...source, ...[...output].map(([path, bytes]) => entry(path, bytes))], { authored: output }));
  assert.deepEqual([...authored].map(([path, bytes]) => [path, bytes.toString('base64')]), snapshot);
  assert.ok([...output.values()].every((bytes) => !bytes.includes(13)));
  for (const { path } of SETTINGS_TARGETS) assert.ok(isGeneratedPath(path), path);
});

test('Codex merge respects quoted keys, multiline values, tables, and TOML string escaping', () => {
  const source = entries(manifest({ harness: { model: 'quote"\\\n\u007f', reasoningEffort: 'high' } }));
  const kept = 'description = """\nmodel = "inside a string"\n[mcp_servers.agent-bot]\nkeep this\n"""\nitems = [\n  "model = untouched",\n]\n[profiles.test]\nmodel = "keep"\n';
  const authored = new Map([['.codex/config.toml', Buffer.from(`'model' = '''\nold model\n'''\n${kept}`)]]);
  const output = buildHarnessFiles(source, { authored });
  const toml = output.get('.codex/config.toml').toString();
  assert.ok(toml.includes(kept));
  assert.ok(!toml.includes('old model'));
  assert.ok(toml.includes('model = "quote\\"\\\\\\n\\u007f"\n'));
  assert.deepEqual(output, buildHarnessFiles(source, { authored: output }));
});

for (const [extra, path] of [
  [{ harness: { typo: true } }, 'harness.typo'], [{ harness: { reasoningEffort: 'max' } }, 'harness.reasoningEffort'],
  [{ harness: { permissionMode: 'dangerous' } }, 'harness.permissionMode'], [{ harness: { model: 3 } }, 'harness.model'],
  [{ harness: { model: ' ' } }, 'harness.model'], [{ harness: null }, 'harness'], [{ harness: [] }, 'harness'],
  [{ harnesses: [] }, 'harnesses'], [{ harnesses: null }, 'harnesses'],
  [{ harnesses: { unknown: {} } }, 'harnesses.unknown'], [{ harnesses: { claude: null } }, 'harnesses.claude'],
  [{ harnesses: { muse: { typo: true } } }, 'harnesses.muse.typo'],
  [{ harnesses: { codex: { reasoningEffort: 'extreme' } } }, 'harnesses.codex.reasoningEffort'],
  [{ harnesses: { gemini: { permissionMode: true } } }, 'harnesses.gemini.permissionMode'],
]) {
  test(`validation refuses ${JSON.stringify(extra)} with its path`, (t) => {
    const root = fixture(t);
    put(root, 'soul.json', JSON.stringify(manifest(extra)));
    assert.throws(() => validateSoulPackage(root), (error) => error.message.includes(`soul.json ${path}`));
  });
}

test('validation keeps unknown top-level extensions and souls without settings compatible', (t) => {
  for (const extra of [{ customExtension: { keep: true } }, { harness: defaults }, { harnesses: { muse: { reasoningEffort: 'low' } } }]) {
    assert.equal(validateSoulPackage(fixture(t, extra)).formatVersion, 2);
  }
});

test('invalid authored settings fail before any output is written', (t) => {
  for (const [path, bytes] of [
    ['.claude/settings.json', '{broken'], ['.claude/settings.json', '[]'],
    ['.claude/settings.json', '{"permissions": "allow"}'], ['opencode.json', '{"permission": "allow"}'],
    ['.codex/config.toml', 'other = """unterminated'],
  ]) {
    const root = fixture(t, { harness: defaults });
    put(root, path, bytes);
    assert.throws(() => buildSoulDirectory(root), (error) => error.message.includes(path));
    assert.equal(readFileSync(join(root, path), 'utf8'), bytes);
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
  }
});

for (const comms of [true, false]) {
  test(`disk/CLI settings work with comms ${comms ? 'on' : 'off'}, preserving revision and exact expected bytes`, (t) => {
    const root = fixture(t, { harness: defaults, harnesses: { muse: { model: 'muse' } }, comms });
    const before = readSoulPackageEntries(root), expected = expectedGeneratedFiles(before.entries), revision = computePackageRevision(root);
    for (const status of [1, 0]) {
      const result = spawnSync(process.execPath, [cli, 'soul', 'build', root, '--check', '--json'],
        { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
      assert.equal(result.status, status, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.harnesses, harnessReport(expected, { comms, manifest: before.manifest }));
      assert.deepEqual(report.harnesses.gemini.unsupported.settings, ['permissionMode', 'reasoningEffort']);
      assert.deepEqual(report.harnesses.muse.unsupported.settings, Object.keys(defaults).sort());
      buildSoulDirectory(root);
    }
    for (const [path, bytes] of expected) assert.deepEqual(readFileSync(join(root, path)), bytes);
    assert.deepEqual(readSoulPackageEntries(root).entries, before.entries);
    assert.equal(computePackageRevision(root), revision);
    validateSoulPackage(root);
  });

  test(`disk merges authored settings and rebuilds with comms ${comms ? 'on' : 'off'}`, (t) => {
    const root = fixture(t, { harness: defaults, comms });
    for (const [path, bytes] of authoredFiles()) put(root, path, bytes);
    const result = buildSoulDirectory(root);
    assert.ok(result.merged.some(({ path }) => path === '.claude/settings.json'));
    const snapshot = SETTINGS_TARGETS.map(({ path }) => readFileSync(join(root, path)));
    assert.equal(JSON.parse(snapshot[0]).permissions.defaultMode, 'default');
    assert.equal(JSON.parse(snapshot[0]).theme, 'dark');
    assert.deepEqual(buildSoulDirectory(root, { check: true }).drift, []);
    buildSoulDirectory(root);
    assert.deepEqual(SETTINGS_TARGETS.map(({ path }) => readFileSync(join(root, path))), snapshot);
  });
}
