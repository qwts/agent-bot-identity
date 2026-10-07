import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnessFiles, envProblem, harnessReport, harnessSettings } from '../soul-builder.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { computePackageRevision, expectedGeneratedFiles, readSoulPackageEntries, validateSoulPackage, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { GENERATED_HARNESS_MARKER as MARKER } from '../soul-harness-contract.mjs';

// #379 slice 2: environment variables and permission allow/deny rules.
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const env = { LOG_LEVEL: 'debug', SOUL_REGION: 'eu west' };
const permissions = { allow: ['Bash(git:*)', 'Read', 'Edit'], deny: ['Bash(rm *)', 'WebFetch'] };
const entry = (path, content) => ({ path, mode: '100644', bytes: Buffer.from(content) });
const manifest = (extra = {}) => ({ formatVersion: 2, name: 'Rules', description: 'Env and rules tests', displaySeed: 'rules',
  preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, ignore: PACKAGE_IGNORE_LIST, ...extra });
const entries = (soul) => [entry('AGENTS.md', '# Soul\n'), entry('soul.json', JSON.stringify(soul))];
const json = (output, path) => JSON.parse(output.get(path).toString());
const rules = (list) => Object.entries(list).flatMap(([effect, names]) => names.map((rule) => ({ effect, rule })));
function put(root, path, bytes) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soul-env-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const soul = manifest(extra);
  for (const { path, bytes } of entries(soul)) put(root, path, bytes);
  soul.revision = computePackageRevision(root);
  put(root, 'soul.json', JSON.stringify(soul));
  return root;
}

test('Claude renders env and allow/deny lists natively; the report shows them rendered', () => {
  const soul = manifest({ harness: { env, permissions } });
  const output = buildHarnessFiles(entries(soul));
  const value = json(output, '.claude/settings.json');
  assert.deepEqual(value.env, env);
  assert.deepEqual(value.permissions, permissions);
  const report = harnessReport(output, { manifest: soul }).claude;
  assert.deepEqual(report.settings, { received: ['env', 'permissions'], rendered: ['env', 'permissions'] });
  assert.deepEqual(report.unsupported.settings, []);
  assert.deepEqual(report.unsupported.permissions, []);
});

test('Codex renders env as [shell_environment_policy.set] and reports every rule unsupported', () => {
  const soul = manifest({ comms: false, harness: { env, permissions } });
  const output = buildHarnessFiles(entries(soul));
  assert.equal(output.get('.codex/config.toml').toString(),
    `# ${MARKER}\n[shell_environment_policy.set]\nLOG_LEVEL = "debug"\nSOUL_REGION = "eu west"\n`);
  const report = harnessReport(output, { comms: false, manifest: soul }).codex;
  assert.deepEqual(report.settings.rendered, ['env']);
  assert.deepEqual(report.unsupported.settings, ['permissions']);
  assert.deepEqual(report.unsupported.permissions, rules(permissions));
});

test('OpenCode maps shell and edit rules (deny last, so it wins) and reports the rest per rule', () => {
  const soul = manifest({ comms: false, harness: { env, permissionMode: 'safe', permissions } });
  const output = buildHarnessFiles(entries(soul));
  const permission = json(output, 'opencode.json').permission;
  assert.deepEqual(permission, { edit: 'allow', bash: { '*': 'ask', git: 'allow', 'git *': 'allow', 'rm *': 'deny' } });
  assert.deepEqual(Object.keys(permission.bash), ['*', 'git', 'git *', 'rm *']);
  const report = harnessReport(output, { comms: false, manifest: soul }).opencode;
  assert.deepEqual(report.settings.rendered, ['permissionMode', 'permissions']);
  assert.deepEqual(report.unsupported.settings, ['env']);
  assert.deepEqual(report.unsupported.permissions, [{ effect: 'allow', rule: 'Read' }, { effect: 'deny', rule: 'WebFetch' }]);

  // Bare Bash is the `*` pattern; a deny moves to the end, so it overrides earlier allows.
  const wide = manifest({ comms: false, harness: { permissions: { allow: ['Bash(ls *)', 'Write'], deny: ['Bash', 'MultiEdit'] } } });
  assert.deepEqual(json(buildHarnessFiles(entries(wide)), 'opencode.json').permission, { edit: 'deny', bash: { 'ls *': 'allow', '*': 'deny' } });
  const bare = manifest({ comms: false, harness: { permissions: { allow: ['Bash'] } } });
  assert.deepEqual(json(buildHarnessFiles(entries(bare)), 'opencode.json').permission, { bash: 'allow' });
  // Nothing expressible: no opencode.json is created, and the rules are all reported.
  const none = manifest({ comms: false, harness: { permissions: { deny: ['Read(./.env)', 'Edit(src/**)'] } } });
  const files = buildHarnessFiles(entries(none));
  assert.equal(files.has('opencode.json'), false);
  assert.deepEqual(harnessReport(files, { comms: false, manifest: none }).opencode.unsupported,
    { subagents: [], commands: [], settings: ['permissions'], permissions: rules({ deny: ['Read(./.env)', 'Edit(src/**)'] }), hooks: [] });
});

test('Gemini, Cursor, Copilot, Devin, Muse and Kiro report env and every rule unsupported', () => {
  const soul = manifest({ harness: { env, permissions } });
  const output = buildHarnessFiles(entries(soul));
  assert.equal(json(output, '.gemini/settings.json').env, undefined);
  assert.equal(output.has('.gemini/.env'), false);
  const report = harnessReport(output, { manifest: soul });
  for (const harness of ['gemini', 'cursor', 'copilot', 'devin', 'muse', 'kiro']) {
    assert.deepEqual(report[harness].settings, { received: ['env', 'permissions'], rendered: [] }, harness);
    assert.deepEqual(report[harness].unsupported.settings, ['env', 'permissions'], harness);
    assert.deepEqual(report[harness].unsupported.permissions, rules(permissions), harness);
  }
});

test('overrides merge env per variable and replace only the rule lists they declare', () => {
  const soul = manifest({ harness: { env, permissions }, harnesses: {
    claude: { env: { LOG_LEVEL: 'info', EXTRA: '1' }, permissions: { deny: ['Bash(sudo *)'] } },
    codex: { env: {} }, opencode: { permissions: { allow: [] } } } });
  assert.deepEqual(harnessSettings(soul, 'claude').env, { LOG_LEVEL: 'info', SOUL_REGION: 'eu west', EXTRA: '1' });
  assert.deepEqual(harnessSettings(soul, 'claude').permissions, { allow: permissions.allow, deny: ['Bash(sudo *)'] });
  assert.deepEqual(harnessSettings(soul, 'codex').env, env);
  assert.deepEqual(harnessSettings(soul, 'opencode').permissions, { allow: [], deny: permissions.deny });
  const output = buildHarnessFiles(entries(soul));
  assert.deepEqual(json(output, '.claude/settings.json').permissions.deny, ['Bash(sudo *)']);
  assert.deepEqual(json(output, 'opencode.json').permission.bash, { 'rm *': 'deny' });
});

const authoredFiles = () => new Map([
  ['.claude/settings.json', Buffer.from(JSON.stringify({ theme: 'dark', env: { KEEP: 'yes', LOG_LEVEL: 'old' },
    permissions: { allow: ['Old'], ask: ['Bash(git push:*)'], additionalDirectories: ['../shared'] } }))],
  ['opencode.json', Buffer.from(JSON.stringify({ permission: { bash: { 'old *': 'allow' }, webfetch: 'deny' } }))],
  ['.codex/config.toml', Buffer.from('[shell_environment_policy]\r\ninherit = "core"\r\n\r\n[shell_environment_policy.set]\r\nKEEP = "yes"\r\nLOG_LEVEL = "old"\r\n# kept comment\r\n\r\n[profiles.local]\r\nmodel = "m"\r\n')],
]);

test('authored files keep unrelated keys and variables, and rebuild byte-identically', () => {
  const source = entries(manifest({ harness: { env, permissions } }));
  const output = buildHarnessFiles(source, { authored: authoredFiles() });
  const claude = json(output, '.claude/settings.json');
  assert.equal(claude.theme, 'dark');
  assert.deepEqual(claude.env, { KEEP: 'yes', LOG_LEVEL: 'debug', SOUL_REGION: 'eu west' });
  assert.deepEqual(claude.permissions, { allow: permissions.allow, ask: ['Bash(git push:*)'], additionalDirectories: ['../shared'], deny: permissions.deny });
  assert.deepEqual(json(output, 'opencode.json').permission, { bash: { git: 'allow', 'git *': 'allow', 'rm *': 'deny' }, webfetch: 'deny', edit: 'allow' });
  const toml = output.get('.codex/config.toml').toString();
  assert.match(toml, /\[shell_environment_policy\]\ninherit = "core"\n/);
  assert.match(toml, /\[profiles.local\]\nmodel = "m"\n/);
  assert.ok(toml.endsWith('[shell_environment_policy.set]\nLOG_LEVEL = "debug"\nSOUL_REGION = "eu west"\nKEEP = "yes"\n# kept comment\n'));
  assert.equal(toml.match(/shell_environment_policy.set/g).length, 1);
  assert.ok([...output.values()].every((bytes) => !bytes.includes(13)));
  assert.deepEqual(output, buildHarnessFiles(source, { authored: output }));
  assert.deepEqual(output, buildHarnessFiles([...source].reverse(), { authored: authoredFiles() }));
});

test('merges that would clobber incompatible authored structures are refused', () => {
  const source = entries(manifest({ harness: { env, permissions } }));
  for (const [path, bytes, pattern] of [
    ['.claude/settings.json', '{"env": "LOG_LEVEL=x"}', /\.claude\/settings\.json env must be a JSON object/],
    ['.claude/settings.json', '{"permissions": []}', /\.claude\/settings\.json permissions must be a JSON object/],
    ['opencode.json', '{"permission": "allow"}', /opencode\.json permission must be a JSON object/],
    ['.codex/config.toml', 'shell_environment_policy = { set = { A = "1" } }\n', /shell_environment_policy\.set must be a \[shell_environment_policy\.set\] table/],
    ['.codex/config.toml', '[shell_environment_policy]\nset = { A = "1" }\n', /shell_environment_policy\.set must be/],
    ['.codex/config.toml', '[shell_environment_policy.set.nested]\nA = "1"\n', /shell_environment_policy\.set must be/],
  ]) {
    assert.throws(() => buildHarnessFiles(source, { authored: new Map([[path, Buffer.from(bytes)]]) }), pattern, bytes);
  }
});

const secretValues = [`ghp_${'a1B2'.repeat(9)}`, 'sk-proj-abcdefgh12345678', '-----BEGIN OPENSSH PRIVATE KEY-----', 'a'.repeat(16) + '0123456789abcdef',
  'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA=', `prefix xoxb-${'1'.repeat(12)}`];
for (const [extra, path] of [
  [{ harness: { env: [] } }, 'harness.env'], [{ harness: { env: { lower: 'x' } } }, 'harness.env.lower'],
  [{ harness: { env: { '1BAD': 'x' } } }, 'harness.env.1BAD'], [{ harness: { env: { NUMBER: 3 } } }, 'harness.env.NUMBER'],
  [{ harness: { env: { GITHUB_TOKEN: 'x' } } }, 'harness.env.GITHUB_TOKEN'],
  [{ harness: { env: { SECRET: 'x' } } }, 'harness.env.SECRET'],
  [{ harness: { env: { MY_API_KEY_2: 'x' } } }, 'harness.env.MY_API_KEY_2'],
  [{ harnesses: { codex: { env: { OPENAI_API_KEY: 'x' } } } }, 'harnesses.codex.env.OPENAI_API_KEY'],
  [{ harness: { env: { DB_PASSWORD: '' } } }, 'harness.env.DB_PASSWORD'], [{ harness: { env: { MY_Secret_X: 'x' } } }, 'harness.env.MY_Secret_X'],
  [{ harness: { env: { SSH_PRIVATE_KEY: 'x' } } }, 'harness.env.SSH_PRIVATE_KEY'], [{ harness: { env: { AWS_CREDENTIALS: 'x' } } }, 'harness.env.AWS_CREDENTIALS'],
  ...secretValues.map((value, i) => [{ harnesses: { claude: { env: { [`VALUE_${i}`]: value } } } }, `harnesses.claude.env.VALUE_${i}`]),
  [{ harness: { permissions: [] } }, 'harness.permissions'], [{ harness: { permissions: { ask: ['Read'] } } }, 'harness.permissions.ask'],
  [{ harness: { permissions: { allow: 'Read' } } }, 'harness.permissions.allow'],
  [{ harness: { permissions: { allow: ['Read', ''] } } }, 'harness.permissions.allow[1]'],
  [{ harness: { permissions: { deny: ['Bash()'] } } }, 'harness.permissions.deny[0]'],
  [{ harness: { permissions: { deny: ['rm -rf /'] } } }, 'harness.permissions.deny[0]'],
  [{ harnesses: { opencode: { permissions: { allow: ['Read', 'Edit', 'Read'] } } } }, 'harnesses.opencode.permissions.allow[2]'],
]) {
  test(`validation refuses ${JSON.stringify(extra).slice(0, 90)} with its path`, (t) => {
    const root = fixture(t);
    put(root, 'soul.json', JSON.stringify(manifest(extra)));
    assert.throws(() => validateSoulPackage(root), (error) => {
      assert.ok(error.message.includes(`soul.json ${path} `), error.message);
      // A refused credential is never echoed back.
      for (const value of secretValues) assert.ok(!error.message.includes(value));
      return true;
    });
  });
}

test('validation accepts ordinary values, empty lists, the same rule in allow and deny, and long plain words', (t) => {
  for (const extra of [
    { harness: { env: { PATH_HINT: '/usr/local/bin:/opt/homebrew/bin', EMPTY: '' } } },
    { harness: { env: { NODE_OPTIONS: '--max-old-space-size=4096', LONG: 'this_is_a_long_plain_lowercase_identifier_name' } } },
    { harness: { permissions: { allow: [], deny: [] } } },
    { harness: { permissions: { allow: ['Bash(npm run test:*)'], deny: ['Bash(npm run test:*)', 'mcp__agent-bot__send'] } } },
  ]) {
    assert.equal(validateSoulPackage(fixture(t, extra)).formatVersion, 2);
  }
});

test('the builder itself refuses a secret even from an unvalidated manifest', () => {
  for (const soul of [manifest({ harness: { env: { GH_TOKEN: 'x' } } }), manifest({ harness: { env: { V: secretValues[0] } } })]) {
    assert.throws(() => buildHarnessFiles(entries(soul)), (error) => !error.message.includes(secretValues[0]) && /credentials/.test(error.message));
  }
});

test('soul build --check --json reports env and per-rule results, and disk rebuilds are stable', (t) => {
  const root = fixture(t, { harness: { env, permissions } });
  const before = readSoulPackageEntries(root), expected = expectedGeneratedFiles(before.entries);
  const result = spawnSync(process.execPath, [cli, 'soul', 'build', root, '--check', '--json'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout).harnesses;
  assert.deepEqual(report, harnessReport(expected, { manifest: before.manifest }));
  assert.deepEqual(report.claude.settings.rendered, ['env', 'permissions']);
  assert.deepEqual(report.codex.settings.rendered, ['env']);
  assert.deepEqual(report.opencode.unsupported.permissions, [{ effect: 'allow', rule: 'Read' }, { effect: 'deny', rule: 'WebFetch' }]);
  assert.deepEqual(report.gemini.unsupported.settings, ['env', 'permissions']);
  buildSoulDirectory(root);
  for (const [path, bytes] of expected) assert.deepEqual(readFileSync(join(root, path)), bytes);
  assert.deepEqual(buildSoulDirectory(root, { check: true }).drift, []);
});

test('secret-looking names are whole words: TOKENIZER_MODE and SECRETARY are ordinary variables', () => {
  for (const name of ['SOUL_TOKENIZER_MODE', 'SECRETARY', 'AUTHOR_NAME', 'PASSWORDLESS']) assert.equal(envProblem(name, 'plain'), null, name);
  for (const name of ['TOKEN', 'MY_TOKEN', 'TOKEN_FILE', 'X_AUTH_Y', 'API_KEY']) assert.match(envProblem(name, 'plain') ?? '', /names a secret/, name);
});
