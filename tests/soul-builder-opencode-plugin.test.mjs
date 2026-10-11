// OpenCode's soul hook adapter (#378): soul-builder renders one fixed plugin
// at `.opencode/plugins/agent-bot-soul.js` that runs the agent-hook runner for
// every event the opencode row maps. These tests load the rendered file the
// way OpenCode 1.18.34 does (a module whose every export is a plugin
// function), call its hooks with that release's input and output shapes, and
// check that a deny, a missing runner, a crash and a timeout all abort a
// blocking event while a non-blocking one never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildHarnessFiles, declaredHooks, harnessReport, HOOK_TARGETS, OPENCODE_PLUGIN_PATH, opencodeHookPlugin } from '../soul-builder.mjs';
import { buildSoulDirectory } from '../soul-build.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, GENERATED_HARNESS_MARKER as MARKER } from '../soul-package.mjs';
import { isGeneratedPath } from '../soul-harness-contract.mjs';
import { dialect } from '../hook-dialects.mjs';
import { opencodePluginCheck } from '../readiness.mjs';

const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const runner = fileURLToPath(new URL('../agent-hook.mjs', import.meta.url));

const soulJson = () => `${JSON.stringify({ formatVersion: 2, name: 'Plug', description: 'Plugin tests', displaySeed: 'plug',
  preferredHarnesses: [], parentRevision: null, revision: `sha256:${'0'.repeat(64)}`, ignore: PACKAGE_IGNORE_LIST }, null, 2)}\n`;
const file = (path, content, mode = '100644') => ({ path, mode, bytes: Buffer.from(content) });
const dir = (path) => ({ path, mode: '040000', bytes: Buffer.alloc(0) });
const base = () => [file('AGENTS.md', '# Plug\n'), file('soul.json', soulJson())];

function put(root, path, content, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  chmodSync(join(root, path), mode);
}

function soulFolder(t) {
  const root = mkdtempSync(join(tmpdir(), 'soul-opencode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'AGENTS.md', '# Plug\n');
  put(root, 'soul.json', soulJson());
  const manifest = JSON.parse(readFileSync(join(root, 'soul.json'), 'utf8'));
  manifest.revision = computePackageRevision(root, { manifest });
  writeFileSync(join(root, 'soul.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

// The plugin reads process.env when it spawns, as it does inside OpenCode.
function useEnv(t, env) {
  const saved = process.env;
  process.env = env;
  t.after(() => { process.env = saved; });
}

// A soul folder holding the rendered plugin, loaded as OpenCode loads it.
let loads = 0;
async function loadPlugin(t, hooks = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soul-opencode-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const soul = join(root, 'soul');
  // Node 20 needs the module type that Bun, OpenCode's runtime, assumes.
  put(root, 'package.json', '{"type":"module"}\n');
  put(soul, OPENCODE_PLUGIN_PATH, opencodeHookPlugin());
  for (const [path, content] of Object.entries(hooks)) put(soul, `hooks/${path}`, content, 0o755);
  const module = await import(`${pathToFileURL(join(soul, OPENCODE_PLUGIN_PATH)).href}?load=${loads += 1}`);
  // OpenCode's legacy loader calls every export and throws on one that is not
  // a function, so the module must export nothing else.
  assert.deepEqual(Object.keys(module), ['AgentBotSoul']);
  assert.ok(Object.values(module).every((value) => typeof value === 'function'));
  const plugin = await module.AgentBotSoul({ directory: soul, worktree: soul, project: {}, client: {}, $: () => {} });
  return { root, soul, plugin };
}

// A stand-in agent-bot that records each call and answers by FAKE_MODE.
function fakeRunner(root) {
  put(root, 'fake/agent-bot', `#!/bin/sh
printf '%s\\n' "$*" >> "${join(root, 'calls.log')}"
cat > "${join(root, 'stdin.json')}"
case "$FAKE_MODE" in
  deny) echo "fake runner says no" >&2; exit 2 ;;
  error) echo "fake runner broke" >&2; exit 1 ;;
  sleep) exec sleep 5 ;;
esac
exit 0
`, 0o755);
  return join(root, 'fake');
}
const calls = (root) => (existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n') : []);
const call = (event) => `agent-hook --event ${event} --dialect opencode`;

// OpenCode 1.18.34 shapes: session/tools.ts and session/prompt.ts call sites,
// and the bus event the plugin layer forwards as `{event: {id, type, properties}}`.
const before = (tool, args) => [{ tool, sessionID: 'ses_1', callID: 'call_1' }, { args }];
const after = (tool, args) => [{ tool, sessionID: 'ses_1', callID: 'call_1', args }, { title: tool, output: 'ok', metadata: {} }];
const chat = (text) => [{ sessionID: 'ses_1', agent: 'build', model: { providerID: 'anthropic', modelID: 'claude' }, messageID: 'msg_1' },
  { message: { id: 'msg_1', sessionID: 'ses_1', role: 'user' }, parts: [{ type: 'text', text }] }];
const bus = (type, properties = {}) => [{ event: { id: 'evt_1', type, properties } }];

test('the plugin renders for every soul, marked, from the opencode row', () => {
  const output = buildHarnessFiles(base());
  assert.equal(OPENCODE_PLUGIN_PATH, dialect('opencode').pluginFile);
  assert.equal(OPENCODE_PLUGIN_PATH, '.opencode/plugins/agent-bot-soul.js');
  assert.ok(isGeneratedPath(OPENCODE_PLUGIN_PATH));
  // Not a merge target: an unmarked file there must stay a conflict.
  assert.ok(!HOOK_TARGETS.some((target) => target.path === OPENCODE_PLUGIN_PATH));
  const text = output.get(OPENCODE_PLUGIN_PATH).toString();
  assert.equal(text.split('\n')[0], `// ${MARKER}`);
  assert.deepEqual(output.get(OPENCODE_PLUGIN_PATH), opencodeHookPlugin());
  // Fixed bytes: declared hooks change nothing in the file itself.
  const hooked = [...base(), dir('hooks'), dir('hooks/pre-command'), file('hooks/pre-command/10-x', '#!/bin/sh\n', '100755')];
  assert.deepEqual(buildHarnessFiles(hooked).get(OPENCODE_PLUGIN_PATH), opencodeHookPlugin());
  // Nothing machine-specific, and only the runner from PATH.
  assert.ok(!text.includes(process.cwd()) && !text.includes(tmpdir()));
  assert.match(text, /spawn\('agent-bot', \['agent-hook', '--event', event, '--dialect', 'opencode'\]/);
  const routes = JSON.parse(/const ROUTES = (.*);/.exec(text)[1]);
  assert.deepEqual(routes, {
    event: [['session-start', '^session\\.created$', false]],
    'chat.message': [['prompt-submit', null, true]],
    'tool.execute.before': [['pre-tool-use', null, true], ['pre-command', '^bash$', true], ['pre-file-write', '^(write|edit|apply_patch)$', true]],
    'tool.execute.after': [['post-tool-use', null, false]],
  });
  // A soul without AGENTS.md renders nothing at all.
  assert.equal(buildHarnessFiles([file('soul.json', soulJson())]).size, 0);
});

test('the report delivers hooks OpenCode can express and lists the rest as unsupported', () => {
  const entries = [...base(), dir('hooks'), dir('hooks/pre-command'), file('hooks/pre-command/10-x', '#!/bin/sh\n', '100755'),
    dir('hooks/session-end'), file('hooks/session-end/10-y', '#!/bin/sh\n', '100755')];
  const report = harnessReport(buildHarnessFiles(entries), { hooks: declaredHooks(entries) });
  assert.deepEqual(report.opencode.hooks.rendered, ['pre-command/10-x']);
  assert.deepEqual(report.opencode.unsupported.hooks, ['session-end/10-y']);
  assert.ok(report.opencode.rendered.includes('hooks'));
  assert.ok(report.opencode.files.includes(OPENCODE_PLUGIN_PATH));
  const bare = harnessReport(buildHarnessFiles(base()), { hooks: [] });
  assert.ok(bare.opencode.files.includes(OPENCODE_PLUGIN_PATH));
  assert.ok(!bare.opencode.rendered.includes('hooks'));
});

test('soul build writes the plugin once and a rebuild is byte-identical', (t) => {
  const root = soulFolder(t);
  const first = buildSoulDirectory(root);
  assert.ok(first.writes.includes(OPENCODE_PLUGIN_PATH));
  assert.deepEqual(readFileSync(join(root, OPENCODE_PLUGIN_PATH)), opencodeHookPlugin());
  const again = buildSoulDirectory(root, { check: true });
  assert.deepEqual(again.drift, []);
  const cliCheck = spawnSync(process.execPath, [cli, 'soul', 'build', root, '--check'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(cliCheck.status, 0, cliCheck.stdout + cliCheck.stderr);
  // A marked but edited copy is generated output: the next build restores it.
  writeFileSync(join(root, OPENCODE_PLUGIN_PATH), `// ${MARKER}\nexport const Edited = async () => ({});\n`);
  assert.deepEqual(buildSoulDirectory(root, { check: true }).drift, [OPENCODE_PLUGIN_PATH]);
  buildSoulDirectory(root);
  assert.deepEqual(readFileSync(join(root, OPENCODE_PLUGIN_PATH)), opencodeHookPlugin());
});

test('an unmarked plugin is never overwritten or removed', (t) => {
  const root = soulFolder(t);
  const mine = 'export const Mine = async () => ({});\n';
  put(root, '.opencode/plugins/mine.js', mine);
  buildSoulDirectory(root);
  assert.equal(readFileSync(join(root, '.opencode/plugins/mine.js'), 'utf8'), mine);
  buildSoulDirectory(root);
  assert.equal(readFileSync(join(root, '.opencode/plugins/mine.js'), 'utf8'), mine);
  // The soul's own file at our path: the build refuses, and leaves it as is.
  put(root, OPENCODE_PLUGIN_PATH, mine);
  assert.throws(() => buildSoulDirectory(root), /unmarked generated path conflict: \.opencode\/plugins\/agent-bot-soul\.js/);
  assert.throws(() => buildSoulDirectory(root, { check: true }), /unmarked generated path conflict/);
  assert.equal(readFileSync(join(root, OPENCODE_PLUGIN_PATH), 'utf8'), mine);
  assert.equal(readFileSync(join(root, '.opencode/plugins/mine.js'), 'utf8'), mine);
});

test('tool.execute.before runs pre-tool-use, then the narrower event its matcher picks', async (t) => {
  const { root, soul, plugin } = await loadPlugin(t);
  useEnv(t, { PATH: `${fakeRunner(root)}:/usr/bin:/bin`, HOME: root });
  await plugin['tool.execute.before'](...before('bash', { command: 'ls', description: 'list' }));
  assert.deepEqual(calls(root), [call('pre-tool-use'), call('pre-command')]);
  // The hook's input and output, merged, plus the plugin's directory.
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'stdin.json'), 'utf8')),
    { tool: 'bash', sessionID: 'ses_1', callID: 'call_1', args: { command: 'ls', description: 'list' }, directory: soul });
  for (const tool of ['write', 'edit', 'apply_patch']) {
    rmSync(join(root, 'calls.log'));
    await plugin['tool.execute.before'](...before(tool, { filePath: join(soul, 'a.txt') }));
    assert.deepEqual(calls(root), [call('pre-tool-use'), call('pre-file-write')], tool);
  }
  rmSync(join(root, 'calls.log'));
  await plugin['tool.execute.before'](...before('read', { filePath: join(soul, 'a.txt') }));
  await plugin['tool.execute.after'](...after('read', { filePath: join(soul, 'a.txt') }));
  await plugin['chat.message'](...chat('hello'));
  await plugin.event(...bus('message.part.updated'));
  await plugin.event(...bus('session.created', { info: { id: 'ses_2' } }));
  assert.deepEqual(calls(root), [call('pre-tool-use'), call('post-tool-use'), call('prompt-submit'), call('session-start')]);
});

test('a deny aborts a blocking event and is ignored on a non-blocking one', async (t) => {
  const { root, plugin } = await loadPlugin(t);
  useEnv(t, { PATH: `${fakeRunner(root)}:/usr/bin:/bin`, HOME: root, FAKE_MODE: 'deny' });
  await assert.rejects(plugin['tool.execute.before'](...before('bash', { command: 'ls' })),
    /agent-bot pre-tool-use denied this: fake runner says no/);
  // The first deny ends the call: the narrower event never runs.
  assert.deepEqual(calls(root), [call('pre-tool-use')]);
  await assert.rejects(plugin['chat.message'](...chat('hello')), /agent-bot prompt-submit denied this/);
  await plugin['tool.execute.after'](...after('bash', { command: 'ls' }));
  await plugin.event(...bus('session.created'));
});

test('a missing, crashing or silent runner fails closed on a blocking event only', async (t) => {
  const { root, plugin } = await loadPlugin(t);
  const fake = fakeRunner(root);

  useEnv(t, { PATH: '/usr/bin:/bin', HOME: root });
  await assert.rejects(plugin['tool.execute.before'](...before('bash', { command: 'ls' })),
    /agent-bot pre-tool-use failed closed: cannot run agent-bot/);
  await assert.rejects(plugin['chat.message'](...chat('hi')), /prompt-submit failed closed/);
  await plugin['tool.execute.after'](...after('bash', { command: 'ls' }));
  await plugin.event(...bus('session.created'));

  process.env = { PATH: `${fake}:/usr/bin:/bin`, HOME: root, FAKE_MODE: 'error' };
  await assert.rejects(plugin['tool.execute.before'](...before('write', { filePath: 'a' })),
    /agent-bot pre-tool-use failed closed: fake runner broke/);
  await plugin['tool.execute.after'](...after('write', { filePath: 'a' }));

  process.env = { PATH: `${fake}:/usr/bin:/bin`, HOME: root, FAKE_MODE: 'sleep', AGENT_BOT_PLUGIN_TIMEOUT_MS: '300' };
  const started = Date.now();
  await assert.rejects(plugin['tool.execute.before'](...before('bash', { command: 'ls' })),
    /agent-bot pre-tool-use failed closed: agent-hook did not answer within 300ms/);
  assert.ok(Date.now() - started < 4000, 'the plugin answered on its own clock');
  await plugin.event(...bus('session.created'));
});

test('the plugin hands the real runner an envelope its hooks and guards can read', async (t) => {
  const record = '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$AGENT_HOOK_EVENT" "$AGENT_HOOK_TOOL_NAME" "$AGENT_HOOK_SESSION_ID" "$AGENT_HOOK_CWD" >> "$HOME/seen.log"\n';
  const { root, soul, plugin } = await loadPlugin(t, {
    'pre-tool-use/10-record': record,
    'pre-command/50-no-force-push': '#!/bin/sh\ncase "$AGENT_HOOK_TOOL_COMMAND" in *--force*) echo "no force pushes" >&2; exit 2 ;; esac\n',
    'pre-file-write/50-no-env': '#!/bin/sh\ncase "$AGENT_HOOK_TOOL_PATH" in *.env) echo "no env files" >&2; exit 2 ;; esac\n',
    'prompt-submit/50-no-secrets': '#!/bin/sh\ncase "$AGENT_HOOK_PROMPT" in *password*) echo "no secrets in prompts" >&2; exit 2 ;; esac\n',
  });
  put(root, 'bin/agent-bot', `#!/bin/sh\n[ "$1" = agent-hook ] && shift\nexec "${process.execPath}" "${runner}" "$@"\n`, 0o755);
  useEnv(t, { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: root, AGENT_BOT_CONFINEMENT: 'off' });

  await assert.rejects(plugin['tool.execute.before'](...before('bash', { command: 'git push --force' })),
    /agent-bot pre-command denied this: pre-command\/50-no-force-push: no force pushes/);
  await plugin['tool.execute.before'](...before('bash', { command: 'ls' }));
  await assert.rejects(plugin['tool.execute.before'](...before('write', { filePath: join(soul, '.env'), content: 'x' })),
    /pre-file-write\/50-no-env: no env files/);
  await plugin['tool.execute.before'](...before('write', { filePath: join(soul, 'notes.md'), content: 'x' }));
  await assert.rejects(plugin['chat.message'](...chat('my password is hunter2')), /no secrets in prompts/);
  await plugin['chat.message'](...chat('hello'));
  assert.deepEqual(readFileSync(join(root, 'seen.log'), 'utf8').trim().split('\n'),
    Array(4).fill(null).map((_, i) => `pre-tool-use|${i < 2 ? 'bash' : 'write'}|ses_1|${soul}`));
});

test('the runner\'s built-in guards reach OpenCode through the plugin, with no soul hooks at all', async (t) => {
  const { root, soul, plugin } = await loadPlugin(t);
  put(root, 'bin/agent-bot', `#!/bin/sh\n[ "$1" = agent-hook ] && shift\nexec "${process.execPath}" "${runner}" "$@"\n`, 0o755);
  useEnv(t, { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: root });
  await plugin['tool.execute.before'](...before('write', { filePath: join(soul, 'notes.md'), content: 'x' }));
  // A session that states a soul whose credentials cannot be checked is
  // refused by confinement on pre-tool-use, in every mode.
  process.env = { ...process.env, AGENT_BOT_ID: 'agent_00000000-0000-4000-8000-000000000000' };
  await assert.rejects(plugin['tool.execute.before'](...before('write', { filePath: join(soul, 'notes.md'), content: 'x' })),
    /agent-bot pre-tool-use denied this: confinement: /);
});

test('doctor reports each soul\'s plugin as current, missing, stale or unmarked', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soul-opencode-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const soul = (id, plugin) => {
    put(join(root, id), 'AGENTS.md', '# x\n');
    if (plugin !== undefined) put(join(root, id), OPENCODE_PLUGIN_PATH, plugin);
    return { id, soulDir: join(root, id) };
  };
  const current = soul('agent_current', opencodeHookPlugin());
  const ready = opencodePluginCheck({ souls: [current, { id: 'agent_empty', soulDir: join(root, 'agent_empty') }] });
  assert.equal(ready.id, 'hooks.opencode_plugin');
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.evidence.current, ['agent_current']);

  const stale = opencodePluginCheck({ souls: [current, soul('agent_missing'), soul('agent_stale', `// ${MARKER}\nold\n`)] });
  assert.equal(stale.status, 'warning');
  assert.equal(stale.code, 'opencode-plugin-stale');
  assert.deepEqual(stale.evidence.missing, ['agent_missing']);
  assert.deepEqual(stale.evidence.stale, ['agent_stale']);
  assert.match(stale.action, /agent-bot soul build/);

  const unmarked = opencodePluginCheck({ souls: [soul('agent_mine', 'export const Mine = async () => ({});\n')] });
  assert.equal(unmarked.status, 'warning');
  assert.equal(unmarked.code, 'opencode-plugin-unmarked');
  assert.deepEqual(unmarked.evidence.unmarked, ['agent_mine']);
  // Reporting never touches the soul's own file.
  assert.equal(readFileSync(join(root, 'agent_mine', OPENCODE_PLUGIN_PATH), 'utf8'), 'export const Mine = async () => ({});\n');
});
