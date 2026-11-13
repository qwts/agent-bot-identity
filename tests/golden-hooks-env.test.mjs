// Golden surface, slice 4 (#1379): the hook path and the environment
// variable names.
//
//   - Git hooks: the names agent-bot installs, the wrapper each installed hook
//     is (`exec "${HOME}/.local/bin/agent-bot" hook <name>`), where they are
//     installed, that `agent-bot hook <name>` runs hooks/<name> with its
//     arguments, and how a bad hook name is refused.
//   - Harness hooks: the agent-hook entrypoint, and the hook config agent-bot
//     writes into each harness's user file. Every entry is one readable line
//     naming the co-located dispatcher by purpose, with a fail-closed guard;
//     the dispatcher and the uninstalled policy it falls back to are pinned
//     beside the config (the policy by digest — it is behaviour, not the
//     path, but a change still shows).
//   - Environment: every AGENT_BOT_* and QWTS_* name the runtime reads or
//     writes.
//
// tests/helpers/golden.mjs says how to regenerate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { GIT_HOOK_NAMES } from '../identity-format.mjs';
import { CANONICAL_EVENTS, DIALECTS } from '../hook-dialects.mjs';
import { agentHookFastPath, installationPaths, installHookWrappers } from '../install.mjs';
import { MANAGED_MARKER, eventsFor, renderConfig, renderHookDispatcher, renderUninstalledPolicy, withHomeMcpServer } from '../sync-hooks.mjs';
import { ROOT, cli, golden, inPool, transcript } from './helpers/golden.mjs';

const HOOKS = path.join(ROOT, 'hooks');
const HOME = '/HOME';

test('git hooks: names, installed wrappers and where they go', () => {
  for (const name of GIT_HOOK_NAMES) {
    const stat = statSync(path.join(HOOKS, name));
    assert.ok(stat.isFile(), `hooks/${name} is missing`);
    if (process.platform !== 'win32') assert.ok(stat.mode & 0o111, `hooks/${name} is not executable`);
  }
  const written = new Map();
  installHookWrappers({
    home: HOME,
    mkdir: () => {},
    list: (dir) => (dir === HOOKS ? readdirSync(HOOKS) : []),
    write: (file, text) => written.set(path.basename(file), { dir: path.dirname(file), text }),
    remove: () => {},
    chmod: () => {},
    // Nothing is written, so the wrappers it would check are already 0755.
    statFile: (file) => (file.startsWith(HOME) ? { mode: 0o100755 } : statSync(file)),
  });
  assert.deepEqual([...written.keys()], GIT_HOOK_NAMES);
  const wrapper = (name) => written.get(name).text.replaceAll(name, '<name>');
  for (const name of GIT_HOOK_NAMES) assert.equal(wrapper(name), wrapper(GIT_HOOK_NAMES[0]), `the ${name} wrapper differs`);
  golden('git-hooks.json', {
    names: GIT_HOOK_NAMES,
    installedIn: written.get(GIT_HOOK_NAMES[0]).dir.replace(HOME, '<home>'),
    wrapper: wrapper(GIT_HOOK_NAMES[0]),
    installationPaths: Object.fromEntries(Object.entries(installationPaths(HOME)).map(([key, value]) => [key, value.replace(HOME, '<home>')])),
    agentHookEntrypoint: agentHookFastPath(),
  });
});

test('agent-bot hook <name> runs hooks/<name> with its arguments', { skip: process.platform === 'win32' && 'runs through Git for Windows sh' }, async () => {
  // The fence stops the hook itself, so it records what would have run.
  const results = await inPool(GIT_HOOK_NAMES, 8, (name) => cli(['hook', name, 'golden-argument']));
  GIT_HOOK_NAMES.forEach((name, index) => {
    assert.deepEqual(results[index].refused, [{ kind: 'exec', target: path.join(HOOKS, name), args: ['golden-argument'] }], name);
  });
});

test('bad hook invocations: agent-bot hook and agent-hook', async () => {
  const cases = [
    ['hook'], ['hook', '--x'], ['hook', 'Bad_Name'], ['hook', 'chain-hook'], ['hook', 'no-such-hook'],
    ['agent-hook'], ['agent-hook', '--dialect', 'claude'], ['agent-hook', '--dialect', 'claude', '--event', 'no-such-event'],
    ['agent-hook', '--dialect', 'no-such-dialect', '--event', 'session-start'], ['agent-hook', '--no-such-flag-golden'],
  ];
  const results = await inPool(cases, 8, (args) => cli(args));
  results.forEach((result, index) => {
    assert.deepEqual(result.refused, [], cases[index].join(' '));
    assert.deepEqual(result.home, [], cases[index].join(' '));
  });
  golden('hook-errors.txt', cases.map((args, index) => transcript(args, results[index])).join('\n'));
});

test('harness hooks: the config agent-bot writes into each harness user file', () => {
  const harnesses = {};
  for (const row of DIALECTS.filter((candidate) => candidate.homeFile)) {
    const rendered = withHomeMcpServer(row, renderConfig(row, '{}', undefined, { home: true }), HOME);
    const events = eventsFor(row, true);
    harnesses[row.key] = {
      file: `<home>/${row.homeFile}`,
      config: JSON.parse(rendered.replaceAll(HOME, '<home>')),
      adapterDir: `<home>/${row.homeAdapterDir}`,
      dispatcher: renderHookDispatcher(row, events),
      policySha256: createHash('sha256').update(renderUninstalledPolicy(row, events)).digest('hex'),
    };
  }
  golden('harness-hooks.json', { canonicalEvents: CANONICAL_EVENTS, managedMarker: MANAGED_MARKER, harnesses });
});

// The runtime is what ships: tests, docs and change notes are not.
function runtimeFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
    .filter((file) => file && !/^(tests|docs|changes|\.github)\//.test(file) && !file.endsWith('.md'));
}

test('AGENT_BOT_* and QWTS_* names the runtime reads and writes', () => {
  const names = new Set();
  for (const file of runtimeFiles()) {
    let text;
    try { text = readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
    for (const [name] of text.matchAll(/\b(?:AGENT_BOT|QWTS)_[A-Z0-9_]*[A-Z0-9]\b/g)) names.add(name);
  }
  golden('environment.json', [...names].sort());
});
