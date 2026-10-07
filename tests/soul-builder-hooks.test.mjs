// Soul-declared hooks (#378, slice 3): `hooks/<event>/<name>` executables in
// the package, rendered by soul-builder into each harness's native hook file as
// marker-tagged entries that run the agent-hook runner over the soul's hooks/,
// merged beside foreign and lifecycle entries, and reported by
// `soul build --check --json`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnessFiles, declaredHooks, harnessReport, HOOK_TARGETS, SOUL_HOOK_EVENTS, soulHookCommand } from '../soul-builder.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { computePackageRevision, validateSoulPackage, PACKAGE_IGNORE_LIST, PRIOR_PACKAGE_IGNORE_LISTS, GENERATED_HARNESS_MARKER as MARKER } from '../soul-package.mjs';
import { isGeneratedPath } from '../soul-harness-contract.mjs';
import { DIALECTS, SOUL_HOOK_MARKER } from '../hook-dialects.mjs';
import { MANAGED_MARKER, renderConfig } from '../sync-hooks.mjs';

const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const runner = fileURLToPath(new URL('../agent-hook.mjs', import.meta.url));

const DENY = '#!/bin/sh\ncase "$AGENT_HOOK_TOOL_COMMAND" in *--force*) echo "no force pushes" >&2; exit 2 ;; esac\n';
const HELLO = '#!/bin/sh\nexit 0\n';
const soulJson = (extra = {}) => `${JSON.stringify({ formatVersion: 2, name: 'Hooky', description: 'Hook tests', displaySeed: 'hooky',
  preferredHarnesses: [], parentRevision: null, revision: `sha256:${'0'.repeat(64)}`, ignore: PACKAGE_IGNORE_LIST, ...extra }, null, 2)}\n`;
const file = (path, content, mode = '100644') => ({ path, mode, bytes: Buffer.from(content) });
const dir = (path) => ({ path, mode: '040000', bytes: Buffer.alloc(0) });
const base = (extra) => [file('AGENTS.md', '# Hooky\n'), file('soul.json', soulJson(extra))];
const hooked = (extra) => [...base(extra), dir('hooks'), dir('hooks/pre-command'), file('hooks/pre-command/50-no-force-push', DENY, '100755'),
  dir('hooks/session-start'), file('hooks/session-start/10-hello.sh', HELLO, '100755')];
const json = (output, path) => JSON.parse(output.get(path).toString());
const NAMES = ['pre-command/50-no-force-push', 'session-start/10-hello.sh'];

function put(root, path, bytes, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
  chmodSync(join(root, path), mode);
}
function reseal(root) {
  const path = join(root, 'soul.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.revision = computePackageRevision(root, { manifest });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
function fixture(t, { hooks = true, extra } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soul-hooks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of hooks ? hooked(extra) : base(extra)) {
    if (entry.mode === '040000') mkdirSync(join(root, entry.path), { recursive: true });
    else put(root, entry.path, entry.bytes, entry.mode === '100755' ? 0o755 : 0o644);
  }
  reseal(root);
  return root;
}

test('declared hooks render one runner entry per event in every native hook file', () => {
  const output = buildHarnessFiles(hooked());
  const claude = json(output, '.claude/settings.json');
  assert.equal(output.get('.claude/settings.json').toString().startsWith(`{\n  "_comment": "${MARKER}"`), true);
  // Canonical event order: session-start precedes pre-command.
  assert.deepEqual(Object.keys(claude.hooks), ['SessionStart', 'PreToolUse']);
  assert.deepEqual(claude.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: soulHookCommand('claude', 'pre-command'), timeout: 60 }] }]);
  assert.deepEqual(claude.hooks.SessionStart, [{ hooks: [{ type: 'command', command: soulHookCommand('claude', 'session-start'), timeout: 60 }] }]);

  const codex = json(output, '.codex/hooks.json');
  assert.deepEqual(codex.hooks.PreToolUse, [{ matcher: '^Bash$', hooks: [{ type: 'command', command: soulHookCommand('codex', 'pre-command'), timeout: 60 }] }]);

  const cursor = json(output, '.cursor/hooks.json');
  assert.deepEqual(Object.keys(cursor), ['_comment', 'version', 'hooks']);
  assert.equal(cursor.version, 1);
  // Cursor fails open unless told otherwise: blocking events carry the flag.
  assert.deepEqual(cursor.hooks.beforeShellExecution, [{ command: soulHookCommand('cursor', 'pre-command'), failClosed: true }]);
  assert.deepEqual(cursor.hooks.sessionStart, [{ command: soulHookCommand('cursor', 'session-start') }]);

  const copilot = json(output, '.github/hooks/agent-bot-soul.json');
  assert.equal(copilot.version, 1);
  assert.deepEqual(copilot.hooks.preToolUse, [{ type: 'command', bash: soulHookCommand('copilot', 'pre-command'), matcher: 'bash|powershell', timeoutSec: 30 }]);

  for (const target of HOOK_TARGETS) assert.ok(isGeneratedPath(target.path), target.path);
  // Nothing else gains a hook file, and no other harness file names the hooks.
  assert.ok(![...output.keys()].some((path) => /\.(?:gemini|opencode)\/.*hook/.test(path)));
  assert.equal(output.get('.gemini/settings.json').toString().includes(SOUL_HOOK_MARKER), false);
  assert.equal(output.get('opencode.json').toString().includes(SOUL_HOOK_MARKER), false);
});

test('the rendered command is portable, marked, and never spoofs a lifecycle entry', () => {
  for (const { dialect } of HOOK_TARGETS) {
    for (const event of SOUL_HOOK_EVENTS) {
      const command = soulHookCommand(dialect, event);
      assert.ok(command.endsWith(`# ${SOUL_HOOK_MARKER}`));
      assert.ok(command.includes(`B=agent-bot;`));
      assert.ok(command.includes(`exec "$B" agent-hook --event ${event} --dialect ${dialect}`));
      assert.ok(command.includes('AGENT_BOT_HOOKS_DIR="$D/hooks"'));
      // sync-hooks recognizes its own entries by these strings; ours carry neither.
      assert.equal(command.includes(MANAGED_MARKER), false);
      assert.equal(command.includes('agent-hook --dialect'), false);
      assert.equal(/\/Users\/|\/home\/|\$HOME/.test(command), false, 'no machine path');
      // Only Claude's own row may trust CLAUDE_PROJECT_DIR.
      assert.equal(command.includes('CLAUDE_PROJECT_DIR'), dialect === 'claude');
    }
  }
});

test('the rendered entry runs the soul hook through the real runner, and fails closed without agent-bot', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soul-hook-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(join(root, 'soul'), 'hooks/pre-command/50-no-force-push', DENY, 0o755);
  put(root, 'bin/agent-bot', `#!/bin/sh\n[ "$1" = agent-hook ] && shift\nexec "${process.execPath}" "${runner}" "$@"\n`, 0o755);
  const command = json(buildHarnessFiles(hooked()), '.claude/settings.json').hooks.PreToolUse[0].hooks[0].command;
  const env = { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: root, CLAUDE_PROJECT_DIR: join(root, 'soul'), AGENT_BOT_CONFINEMENT: 'off' };
  const payload = (cmd) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd: join(root, 'soul') });
  const denied = spawnSync('/bin/sh', ['-c', command], { input: payload('git push --force'), encoding: 'utf8', env, cwd: join(root, 'soul') });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /no force pushes/);
  const allowed = spawnSync('/bin/sh', ['-c', command], { input: payload('git push'), encoding: 'utf8', env, cwd: join(root, 'soul') });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
  const missing = { ...env, PATH: '/usr/bin:/bin' };
  const blocked = spawnSync('/bin/sh', ['-c', command], { input: payload('ls'), encoding: 'utf8', env: missing });
  assert.equal(blocked.status, 2, 'a blocking event fails closed when the runner is missing');
  assert.match(blocked.stderr, /agent-bot is not on PATH/);
  const start = soulHookCommand('claude', 'session-start');
  assert.equal(spawnSync('/bin/sh', ['-c', start], { input: '{}', encoding: 'utf8', env: missing }).status, 0);
});

test('the report lists every hook as rendered or unsupported, per harness', () => {
  const output = buildHarnessFiles(hooked());
  const report = harnessReport(output, { hooks: declaredHooks(hooked()) });
  for (const harness of ['claude', 'devin', 'codex', 'cursor', 'copilot']) {
    assert.deepEqual(report[harness].hooks, { received: NAMES, rendered: NAMES }, harness);
    assert.deepEqual(report[harness].unsupported.hooks, [], harness);
    assert.ok(report[harness].rendered.includes('hooks'), harness);
  }
  for (const harness of ['gemini', 'opencode', 'muse', 'kiro']) {
    assert.deepEqual(report[harness].hooks, { received: NAMES, rendered: [] }, harness);
    assert.deepEqual(report[harness].unsupported.hooks, NAMES, harness);
    assert.equal(report[harness].rendered.includes('hooks'), false, harness);
  }
  assert.ok(report.codex.files.includes('.codex/hooks.json'));
  assert.ok(report.cursor.files.includes('.cursor/hooks.json'));
  assert.ok(report.copilot.files.includes('.github/hooks/agent-bot-soul.json'));
  assert.ok(report.devin.files.includes('.claude/settings.json'), 'Devin CLI reads Claude settings');
  // No hooks declared: nothing is rendered and nothing is reported.
  const none = harnessReport(buildHarnessFiles(base()), {});
  assert.ok(Object.values(none).every((entry) => entry.hooks.received.length === 0 && entry.unsupported.hooks.length === 0));
  assert.equal(buildHarnessFiles(base()).has('.codex/hooks.json'), false);
});

test('a rebuild over its own output is byte-identical, with settings sharing Claude\'s file', () => {
  const entries = hooked({ harness: { model: 'sonnet', permissionMode: 'safe' } });
  const first = buildHarnessFiles(entries);
  assert.equal(json(first, '.claude/settings.json').model, 'sonnet');
  assert.equal(json(first, '.claude/settings.json').hooks.PreToolUse.length, 1);
  const second = buildHarnessFiles(entries, { authored: first });
  assert.deepEqual([...second.keys()], [...first.keys()]);
  for (const [path, bytes] of first) assert.ok(second.get(path).equals(bytes), path);
});

test('foreign and lifecycle entries survive, in place, and removing the declaration removes only ours', () => {
  const lifecycle = { hooks: [{ type: 'command', command: `x # ${MANAGED_MARKER}`, timeout: 60 }] };
  const foreign = { matcher: 'Write', hooks: [{ type: 'command', command: './lint.sh' }] };
  const authored = new Map([
    ['.claude/settings.json', Buffer.from(JSON.stringify({ env: { A: '1' }, hooks: { PreToolUse: [foreign], SessionStart: [lifecycle], Stop: [] } }))],
    ['.cursor/hooks.json', Buffer.from(JSON.stringify({ version: 1, hooks: { stop: [{ command: './done.sh' }] } }))],
  ]);
  const output = buildHarnessFiles(hooked(), { authored });
  const claude = json(output, '.claude/settings.json');
  assert.deepEqual(Object.keys(claude), ['_comment', 'env', 'hooks']);
  assert.deepEqual(Object.keys(claude.hooks), ['PreToolUse', 'SessionStart', 'Stop']);
  assert.deepEqual(claude.hooks.PreToolUse[0], foreign);
  assert.equal(claude.hooks.PreToolUse.length, 2);
  assert.deepEqual(claude.hooks.SessionStart[0], lifecycle);
  assert.deepEqual(claude.hooks.Stop, [], 'an authored empty event is left alone');
  const cursor = json(output, '.cursor/hooks.json');
  assert.deepEqual(cursor.hooks.stop, [{ command: './done.sh' }]);
  assert.equal(cursor.version, 1);
  // Rebuild: identical.
  const again = buildHarnessFiles(hooked(), { authored: output });
  for (const [path, bytes] of output) assert.ok(again.get(path).equals(bytes), path);
  // sync-hooks over a file holding soul entries keeps them.
  const claudeRow = DIALECTS.find((row) => row.key === 'claude');
  const synced = JSON.parse(renderConfig(claudeRow, output.get('.claude/settings.json').toString()));
  assert.equal(JSON.stringify(synced.hooks.PreToolUse).includes(SOUL_HOOK_MARKER), true);
  assert.equal(JSON.stringify(synced.hooks.SessionStart).includes(SOUL_HOOK_MARKER), true);
  // The declaration goes: ours go, theirs stay; a file that held only ours is dropped.
  const removed = buildHarnessFiles(base(), { authored: output });
  const left = json(removed, '.claude/settings.json');
  assert.deepEqual(left.hooks, { PreToolUse: [foreign], SessionStart: [lifecycle], Stop: [] });
  assert.deepEqual(json(removed, '.cursor/hooks.json').hooks, { stop: [{ command: './done.sh' }] });
  for (const path of ['.codex/hooks.json', '.github/hooks/agent-bot-soul.json']) assert.equal(removed.has(path), false, path);
});

test('a file that cannot be merged is refused, never overwritten', () => {
  for (const [bytes, pattern] of [['not json', /not valid JSON/], ['[]', /JSON object/],
    ['{"hooks":[]}', /hooks must be a JSON object/], ['{"hooks":{"Stop":{}}}', /hooks\.Stop must be an array/]]) {
    assert.throws(() => buildHarnessFiles(hooked(), { authored: new Map([['.codex/hooks.json', Buffer.from(bytes)]]) }), pattern);
  }
});

test('bad declarations fail the build with the path that is wrong', () => {
  const cases = [
    [[file('hooks/pre-tool/x', HELLO, '100755')], /hooks\/pre-tool: unknown hook event/],
    [[file('hooks/pre-commit/x', HELLO, '100755')], /pre-commit is not a harness hook event \(the git hook layer serves it\)/],
    [[file('hooks/pre-push/x', HELLO, '100755')], /pre-push is not a harness hook event/],
    [[file('hooks/spawn/x', HELLO, '100755')], /the daemon runs spawn hooks/],
    [[file('hooks/pre-command/x', HELLO)], /must be executable/],
    [[file('hooks/pre-command/Bad_Name', HELLO, '100755')], /name must use lowercase/],
    [[file('hooks/pre-command/a.b.c', HELLO, '100755')], /name must use lowercase/],
    [[file('hooks/pre-command/nested/x', HELLO, '100755')], /not nested directories/],
    [[dir('hooks/pre-command/nested')], /not nested directories/],
    [[file('hooks/pre-command', HELLO, '100755')], /must be a directory of executables/],
    [[file('hooks/notes.md', 'x')], /unknown hook event/],
    [[file('hooks', 'x')], /hooks must be a directory/],
  ];
  for (const [extra, pattern] of cases) assert.throws(() => buildHarnessFiles([...base(), ...extra]), pattern, String(pattern));
  // A README may document the folder; an empty event directory is just empty.
  const ok = buildHarnessFiles([...base(), dir('hooks'), file('hooks/README.md', '# hooks\n'), dir('hooks/agent-stop')]);
  assert.equal(ok.has('.codex/hooks.json'), false);
});

test('soul build writes, checks clean, merges an authored file, and keeps the revision', (t) => {
  const root = fixture(t);
  put(root, '.codex/hooks.json', `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: './mine.sh' }] }] } })}\n`);
  reseal(root);
  const revision = validateSoulPackage(root).revision;
  const check = buildSoulDirectory(root, { check: true });
  assert.ok(check.drift.includes('.claude/settings.json'));
  assert.deepEqual(check.merged.map((entry) => entry.path), ['.codex/hooks.json']);
  assert.deepEqual(check.harnesses.gemini.unsupported.hooks, NAMES);
  buildSoulDirectory(root);
  assert.deepEqual(buildSoulDirectory(root, { check: true }).drift, []);
  const codex = JSON.parse(readFileSync(join(root, '.codex/hooks.json'), 'utf8'));
  assert.deepEqual(codex.hooks.Stop, [{ hooks: [{ type: 'command', command: './mine.sh' }] }]);
  assert.equal(codex.hooks.PreToolUse.length, 1);
  for (const target of HOOK_TARGETS) assert.ok(existsSync(join(root, target.path)), target.path);
  // The merged Codex file holds authored content, so it stays revision
  // content; every other hook file is exact pure output and is ignored.
  rmSync(join(root, '.codex/hooks.json'));
  reseal(root);
  const pure = computePackageRevision(root);
  buildSoulDirectory(root);
  assert.equal(computePackageRevision(root), pure);
  assert.notEqual(pure, revision);

  // Declaration removed: generated-only files go, the merged one keeps its own entry.
  rmSync(join(root, 'hooks'), { recursive: true });
  put(root, '.codex/hooks.json', `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: './mine.sh' }] }] } })}\n`);
  buildSoulDirectory(root);
  buildSoulDirectory(root);
  assert.equal(existsSync(join(root, '.github/hooks/agent-bot-soul.json')), false);
  assert.equal(existsSync(join(root, '.github/hooks')), false, 'no empty generated parent is left');
  assert.equal(existsSync(join(root, '.cursor/hooks.json')), false);
  assert.equal(existsSync(join(root, '.claude/settings.json')), false);
  assert.equal(readFileSync(join(root, '.codex/hooks.json'), 'utf8').includes('./mine.sh'), true);
  assert.equal(readFileSync(join(root, '.codex/hooks.json'), 'utf8').includes(SOUL_HOOK_MARKER), false);
});

test('a hooked soul\'s revision ignores exact build output, including Copilot\'s file', (t) => {
  const root = fixture(t);
  const revision = computePackageRevision(root);
  buildSoulDirectory(root);
  assert.equal(computePackageRevision(root), revision);
  assert.equal(validateSoulPackage(root).revision, JSON.parse(readFileSync(join(root, 'soul.json'), 'utf8')).revision);
  writeFileSync(join(root, '.github/hooks/agent-bot-soul.json'), '{}\n');
  assert.notEqual(computePackageRevision(root), revision, 'an edited generated file is content');
});

test('the ignore list only grows by the Copilot hook file; the list before it still validates', () => {
  // The adapters slice appended to the list after this one (see
  // soul-builder-adapters.test.mjs); the slice-3 list is the one before it.
  const slice3 = PRIOR_PACKAGE_IGNORE_LISTS[0].generatedPaths;
  assert.deepEqual(PACKAGE_IGNORE_LIST.generatedPaths.slice(0, slice3.length), slice3);
  assert.deepEqual(slice3.slice(0, -1), PRIOR_PACKAGE_IGNORE_LISTS[1].generatedPaths);
  assert.equal(slice3.at(-1), '.github/hooks/agent-bot-soul.json');
  assert.equal(isGeneratedPath('.github/hooks/other.json'), false, 'other Copilot hook files stay the soul\'s');
});

test('soul build --check --json and the plain summary name unsupported hooks', (t) => {
  const root = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [cli, 'soul', 'build', root, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
  const dirty = run('--check', '--json');
  assert.equal(dirty.status, 1);
  const report = JSON.parse(dirty.stdout);
  assert.deepEqual(report.harnesses.opencode.unsupported.hooks, NAMES);
  assert.deepEqual(report.harnesses.claude.hooks.rendered, NAMES);
  const plain = run();
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^gemini: instructions, mcp \(unsupported: hooks pre-command\/50-no-force-push, session-start\/10-hello\.sh\)$/m);
  assert.match(plain.stdout, /^claude: instructions, mcp, hooks$/m);
  assert.equal(run('--check').status, 0);
});
