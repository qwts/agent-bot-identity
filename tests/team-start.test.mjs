import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  TEAM_DEFAULTS, createTeamStarter, defaultTeamTemplate, effectiveProvider, harnessLaunchProblem, harnessLaunchRefusal, harnessLaunchable, teamLimits,
  templateProviderId,
} from '../team-start.mjs';
import { ACP_SPAWN_REGISTRY } from '../acp-registry.mjs';

const LEAD = 'agent_11111111-1111-4111-8111-111111111111';
const id = (n) => `agent_${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// A census in memory: launches append a child under the parent they name.
function team({ rows = [{ id: LEAD, parentId: null }], harness = 'claude', launchable = () => true,
  template = () => '/souls/starter.soul', limits, launchStatus = 'launched', models = () => null, templateProvider = () => null } = {}) {
  const census = [...rows];
  const receipts = [];
  const launches = [];
  let next = 100;
  const start = createTeamStarter({
    souls: () => census,
    identities: (agentId) => (agentId === LEAD ? { harness } : null),
    launch: async (event) => {
      launches.push(event);
      await new Promise((resolve) => setImmediate(resolve));
      if (launchStatus !== 'launched') return { status: launchStatus, agentId: null, detail: 'harness exited' };
      const child = id(next += 1);
      census.push({ id: child, parentId: event.parent });
      return { status: 'launched', agentId: child };
    },
    receipt: (row) => receipts.push(row),
    limits, launchable, template, account: 'owner', models, templateProvider,
  });
  return { start, census, receipts, launches };
}

test('a soul starts a teammate under itself on its own harness and the default template', async () => {
  const t = team();
  const started = await t.start(LEAD, { name: ' Researcher ' });
  // The result reports what the new soul effectively runs with: the harness
  // default model (null) and claude's built-in provider, as the template declares none.
  assert.deepEqual(started, { agentId: id(101), name: 'Researcher', harness: 'claude', model: null, provider: 'anthropic', parent: LEAD, startedBy: LEAD });
  assert.equal(t.launches.length, 1);
  // A legacy `{ name }` request launches exactly as before: no model key, the caller as parent.
  assert.equal('model' in t.launches[0], false);
  assert.deepEqual({ ...t.launches[0], requestId: 'x' },
    { requestId: 'x', account: 'owner', package: '/souls/starter.soul', harness: 'claude', name: 'Researcher', parent: LEAD });
  assert.match(t.launches[0].requestId, /^team_[0-9a-f-]{36}$/);
  assert.deepEqual(t.receipts, [{ agentId: LEAD, decision: 'launched' }]);
});

test('the child cap refuses the sixth teammate, with a receipt for every attempt', async () => {
  const t = team();
  for (let n = 0; n < TEAM_DEFAULTS.maxChildren; n += 1) await t.start(LEAD, { name: `Member ${n}` });
  await assert.rejects(t.start(LEAD, { name: 'One too many' }), (error) => error.statusCode === 429 && /limit 5/.test(error.message));
  assert.equal(t.launches.length, 5);
  assert.deepEqual(t.receipts.map((row) => row.decision), [...Array(5).fill('launched'), 'refused: child cap']);
});

test('concurrent starts are serialized, so they cannot race past the cap', async () => {
  const t = team({ limits: { maxChildren: 2, maxDepth: 2 } });
  const outcomes = await Promise.allSettled([1, 2, 3, 4].map((n) => t.start(LEAD, { name: `M${n}` })));
  assert.deepEqual(outcomes.map((o) => o.status), ['fulfilled', 'fulfilled', 'rejected', 'rejected']);
  assert.equal(t.census.filter((row) => row.parentId === LEAD).length, 2);
});

test('depth: a child may start a grandchild-level team only up to maxDepth', async () => {
  const child = id(1);
  const grandchild = id(2);
  const t = team({ rows: [{ id: LEAD, parentId: null }, { id: child, parentId: LEAD }, { id: grandchild, parentId: child }],
    limits: { maxChildren: 5, maxDepth: 2 } });
  // The child (depth 1) may start one at depth 2.
  await t.start(child, { name: 'Ok', harness: 'claude' });
  // The grandchild (depth 2) may not start one at depth 3.
  await assert.rejects(t.start(grandchild, { name: 'Too deep', harness: 'claude' }), (error) => error.statusCode === 403 && /2 levels/.test(error.message));
  assert.equal(t.receipts.at(-1).decision, 'refused: depth');
  assert.equal(t.receipts.at(-1).agentId, grandchild);
});

test('a corrupt parent cycle is refused rather than walked forever', async () => {
  const a = id(1);
  const b = id(2);
  const t = team({ rows: [{ id: a, parentId: b }, { id: b, parentId: a }], limits: { maxChildren: 5, maxDepth: 100 } });
  await assert.rejects(t.start(a, { name: 'Loop', harness: 'claude' }), /too long/);
});

test('harness refusals: unknown, not launchable, or none recorded', async () => {
  const t = team({ launchable: (harness) => harness === 'claude' });
  await assert.rejects(t.start(LEAD, { name: 'X', harness: 'muse' }), /not launchable/);
  await assert.rejects(t.start(LEAD, { name: 'X', harness: 'Bad Harness' }), /name a harness/);
  const none = team({ harness: null });
  await assert.rejects(none.start(LEAD, { name: 'X' }), /name a harness/);
  assert.deepEqual(t.receipts.map((row) => row.decision), ['refused: harness', 'refused: harness']);
  assert.equal(t.launches.length, 0);
});

test('a soul only starts souls as itself, and bad requests are refused and receipted', async () => {
  const t = team();
  await assert.rejects(t.start(LEAD, { name: 'X', parent: id(9) }), (error) => error.statusCode === 403 && /as itself or with no parent/.test(error.message));
  await assert.rejects(t.start(LEAD, { name: '' }), /printable/);
  await assert.rejects(t.start(LEAD, { name: 'a\nb' }), /printable/);
  await assert.rejects(t.start(LEAD, ['x']), /object/);
  await assert.rejects(t.start(LEAD, { name: 'X', template: 'relative/path' }), /absolute/);
  const noTemplate = team({ template: () => null });
  await assert.rejects(noTemplate.start(LEAD, { name: 'X' }), /no default soul template/);
  assert.deepEqual(t.receipts.map((row) => row.decision),
    ['refused: not self', 'refused: invalid request', 'refused: invalid request', 'refused: invalid request', 'refused: template']);
  assert.equal(t.launches.length, 0);
});

test('a launch that does not start is a failure with a receipt', async () => {
  const t = team({ launchStatus: 'failed' });
  await assert.rejects(t.start(LEAD, { name: 'X' }), (error) => error.statusCode === 502 && /harness exited/.test(error.message));
  assert.deepEqual(t.receipts, [{ agentId: LEAD, decision: 'failed' }]);
});

test('team limits come from config within bounds, else the defaults', () => {
  assert.deepEqual(teamLimits({}), { maxChildren: 5, maxDepth: 2 });
  assert.deepEqual(teamLimits({ teams: { maxChildren: 3, maxDepth: 4 } }), { maxChildren: 3, maxDepth: 4 });
  assert.deepEqual(teamLimits({ teams: { maxChildren: 0, maxDepth: '9' } }), { maxChildren: 5, maxDepth: 2 });
  assert.deepEqual(teamLimits({ teams: { maxChildren: 1000 } }), { maxChildren: 5, maxDepth: 2 });
});

test('a harness is launchable only when enabled and runnable here', () => {
  const registry = {
    on: { enabled: true, command: 'definitely-not-on-path-377' },
    adapter: { enabled: true, command: 'x-acp', soulBin: 'x-acp' },
    off: { enabled: false, command: 'node', soulBin: 'node' },
    abs: { enabled: true, command: process.execPath },
    gone: { enabled: true, command: '/opt/x/bin/acp' },
  };
  const env = { PATH: '/nonexistent' };
  assert.equal(harnessLaunchable('on', { registry, env }), false);
  assert.equal(harnessLaunchable('adapter', { registry, env }), true);
  assert.equal(harnessLaunchable('off', { registry, env }), false);
  assert.equal(harnessLaunchable('abs', { registry, env }), true);
  assert.equal(harnessLaunchable('gone', { registry, env }), false, 'an absolute command must exist (#536)');
  assert.equal(harnessLaunchable('missing', { registry, env }), false);
});

test('a refusal says why: the missing CLI and how to install it, or the adapter (#418)', async () => {
  const env = { PATH: '/nonexistent' };
  assert.match(harnessLaunchProblem('opencode', { env }), /`opencode` command is not on this host's PATH \(\/nonexistent\); install OpenCode/);
  assert.equal(harnessLaunchProblem('codex', { env }), null, 'an adapter installs with the soul package');
  assert.equal(harnessLaunchProblem('opencode', { env, declared: true }), null, 'a soul.json install pin provisions it at launch (#583 slice 3)');
  assert.equal(harnessLaunchProblem('muse', { registry: { muse: { enabled: false } } }), 'it is disabled in agent-bot');
  // The stable code beside each message (#536).
  assert.equal(harnessLaunchRefusal('opencode', { env }).code, 'harness-tool-missing');
  assert.equal(harnessLaunchRefusal('muse', { registry: { muse: { enabled: false } } }).code, 'harness-disabled');
  assert.deepEqual(harnessLaunchRefusal('nope', { env }), { code: 'harness-unknown', message: 'agent-bot has no such harness' });
  assert.equal(harnessLaunchRefusal('codex', { env }), null);
  assert.equal(ACP_SPAWN_REGISTRY.codex.installHint.includes('codex login'), true);
  const t = team({ launchable: () => 'the `opencode` command is not on this host\'s PATH' });
  await assert.rejects(t.start(LEAD, { name: 'X', harness: 'opencode' }), /not launchable on this host: the `opencode` command/);
});

test('the default template: configured, else the Starter this install ships', async () => {
  const starter = () => '/bundle/souls/starter.soul';
  assert.equal(await defaultTeamTemplate({ config: {}, starter }), '/bundle/souls/starter.soul');
  assert.equal(await defaultTeamTemplate({ config: {}, starter: () => null }), null);
  assert.equal(await defaultTeamTemplate({ config: { teams: { template: '/c.soul' } }, starter }), '/c.soul');
  assert.equal(await defaultTeamTemplate({ config: { teams: { template: 'rel.soul' } }, starter }), '/bundle/souls/starter.soul');
  assert.equal(await defaultTeamTemplate({ config: {}, env: { AGENT_BOT_STARTER_TEMPLATE: '/env/starter.soul' } }), '/env/starter.soul');
});

// --- GeniusBar#261: parent, model and provider chosen at the tool boundary ---

test('parent "none" starts an independent root soul: no parent in the launch or census, the caller in the receipt and result', async () => {
  const t = team();
  const rick = await t.start(LEAD, { name: 'Rick', parent: 'none' });
  assert.deepEqual(rick, { agentId: id(101), name: 'Rick', harness: 'claude', model: null, provider: 'anthropic', parent: null, startedBy: LEAD });
  assert.equal(t.launches[0].parent, null, 'the launch event carries a null parent, never the caller');
  assert.deepEqual(t.census.at(-1), { id: id(101), parentId: null });
  assert.deepEqual(t.receipts, [{ agentId: LEAD, decision: 'launched', detail: 'independent soul, no parent' }]);
  // A JSON null asks for the same; "self" and the caller's own id keep it as a teammate.
  const other = await t.start(LEAD, { name: 'Morty', parent: null });
  assert.equal(other.parent, null);
  assert.equal((await t.start(LEAD, { name: 'Summer', parent: 'self' })).parent, LEAD);
  assert.equal((await t.start(LEAD, { name: 'Beth', parent: LEAD })).parent, LEAD);
});

test('an independent start still counts against the caller\'s cap and depth', async () => {
  const t = team({ limits: { maxChildren: 1, maxDepth: 2 } });
  await t.start(LEAD, { name: 'Only' });
  await assert.rejects(t.start(LEAD, { name: 'Free', parent: 'none' }), (error) => error.statusCode === 429);
  const grandchild = id(2);
  const deep = team({ rows: [{ id: LEAD, parentId: null }, { id: id(1), parentId: LEAD }, { id: grandchild, parentId: id(1) }],
    limits: { maxChildren: 5, maxDepth: 2 } });
  await assert.rejects(deep.start(grandchild, { name: 'Free', harness: 'claude', parent: 'none' }), /2 levels/);
  assert.equal(deep.launches.length, 0);
});

test('a requested model travels in the launch event and the result, never replaced by the default', async () => {
  const t = team();
  const started = await t.start(LEAD, { name: 'Rick', model: 'claude-haiku-5-5', parent: 'none' });
  assert.equal(started.model, 'claude-haiku-5-5');
  assert.equal(t.launches[0].model, 'claude-haiku-5-5');
  await assert.rejects(t.start(LEAD, { name: 'X', model: 'a\u0000b' }), /model: modelId must be/);
  await assert.rejects(t.start(LEAD, { name: 'X', model: '' }), /model: modelId must be/);
  assert.deepEqual(t.receipts.map((row) => row.decision), ['launched', 'refused: model', 'refused: model']);
  assert.equal(t.launches.length, 1);
});

test('a model the caller\'s harness listed as unavailable is refused before launch, with the list', async () => {
  const listed = () => ({ model: null, available: [{ modelId: 'claude-sonnet-4-5', name: 'Sonnet' }, { modelId: 'claude-haiku-5-5', name: 'Haiku' }], listedAt: null });
  const t = team({ models: listed });
  await assert.rejects(t.start(LEAD, { name: 'X', model: 'gpt-5' }),
    (error) => error.statusCode === 400 && /'gpt-5' is not one the claude harness listed as available \(claude-sonnet-4-5, claude-haiku-5-5\)/.test(error.message));
  assert.equal(t.launches.length, 0);
  assert.equal((await t.start(LEAD, { name: 'Ok', model: 'claude-haiku-5-5' })).model, 'claude-haiku-5-5');
  // Another harness's model is not checked against the caller's list; an empty or absent list checks nothing.
  assert.equal((await t.start(LEAD, { name: 'Codex', harness: 'codex', model: 'gpt-5' })).model, 'gpt-5');
  const unlisted = team({ models: () => ({ model: null, available: null, listedAt: null }) });
  assert.equal((await unlisted.start(LEAD, { name: 'Any', model: 'whatever-1' })).model, 'whatever-1');
});

test('a provider must be one the harness knows and the one the template gives; it is never substituted', async () => {
  const t = team();
  await assert.rejects(t.start(LEAD, { name: 'X', provider: 'openai' }), /provider 'openai' is not one the claude harness knows \(anthropic, anthropic-compatible\)/);
  await assert.rejects(t.start(LEAD, { name: 'X', harness: 'muse', provider: 'openai' }), /harness 'muse' has no selectable providers; omit provider, or start on one of codex, claude, opencode/);
  await assert.rejects(t.start(LEAD, { name: 'X', provider: 'anthropic-compatible' }),
    /not selectable at launch: the claude harness takes its provider from the soul template's soul.json \(harnesses.claude.provider\), and \/souls\/starter.soul gives anthropic; pass a template that declares provider 'anthropic-compatible'/);
  await assert.rejects(t.start(LEAD, { name: 'X', provider: '' }), /provider must be a provider id/);
  assert.deepEqual(t.receipts.map((row) => row.decision), Array(4).fill('refused: provider'));
  assert.equal(t.launches.length, 0);
  // The built-in provider, or the template's declared one, is confirmed and reported.
  assert.equal((await t.start(LEAD, { name: 'Ok', provider: 'anthropic' })).provider, 'anthropic');
  const github = team({ templateProvider: (packagePath, harness) => (harness === 'codex' ? 'github' : null) });
  assert.equal((await github.start(LEAD, { name: 'Gh', harness: 'codex', provider: 'github' })).provider, 'github');
  await assert.rejects(github.start(LEAD, { name: 'X', harness: 'codex', provider: 'openai' }), /gives github/);
  assert.equal((await github.start(LEAD, { name: 'Default', harness: 'codex' })).provider, 'github', 'absent reports the effective one');
});

test('the effective provider is the template\'s declaration, else the harness\'s built-in one', () => {
  assert.equal(effectiveProvider('claude'), 'anthropic');
  assert.equal(effectiveProvider('codex'), 'openai');
  assert.equal(effectiveProvider('opencode', 'github'), 'github');
  assert.equal(effectiveProvider('muse'), null);
  const dir = mkdtempSync(path.join(tmpdir(), 'team-start-'));
  assert.equal(templateProviderId(dir, 'codex'), null, 'no manifest reads as none');
  writeFileSync(path.join(dir, 'soul.json'), JSON.stringify({ harnesses: { codex: { provider: { id: 'github', baseUrl: 'https://models.github.ai/inference' } } } }));
  assert.equal(templateProviderId(dir, 'codex'), 'github');
  assert.equal(templateProviderId(dir, 'claude'), null);
  writeFileSync(path.join(dir, 'soul.json'), '{not json');
  assert.equal(templateProviderId(dir, 'codex'), null);
});

test('availability needs an executable regular file, absolute or on PATH (#536)', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-exec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(path.join(bin, 'dir-cli'), { recursive: true });
  writeFileSync(path.join(bin, 'plain-cli'), '#!/bin/sh\n', { mode: 0o644 });
  writeFileSync(path.join(bin, 'good-cli'), '#!/bin/sh\n');
  chmodSync(path.join(bin, 'good-cli'), 0o755);
  chmodSync(path.join(bin, 'dir-cli'), 0o755);
  const env = { PATH: bin };
  const registry = Object.fromEntries([
    ['bare-good', 'good-cli'], ['bare-dir', 'dir-cli'], ['bare-plain', 'plain-cli'], ['bare-missing', 'none-cli'],
    ['abs-good', path.join(bin, 'good-cli')], ['abs-dir', path.join(bin, 'dir-cli')], ['abs-plain', path.join(bin, 'plain-cli')], ['abs-missing', path.join(bin, 'none-cli')],
  ].map(([key, command]) => [key, { enabled: true, command }]));
  const refusals = Object.fromEntries(Object.keys(registry).map((key) => [key, harnessLaunchRefusal(key, { registry, env })?.code ?? null]));
  assert.deepEqual(refusals, {
    'bare-good': null, 'bare-dir': 'harness-tool-missing', 'bare-plain': 'harness-tool-missing', 'bare-missing': 'harness-tool-missing',
    'abs-good': null, 'abs-dir': 'harness-tool-missing', 'abs-plain': 'harness-tool-missing', 'abs-missing': 'harness-tool-missing',
  });
  assert.match(harnessLaunchRefusal('abs-dir', { registry, env }).message, /is not an executable file on this host/);
  // An adapter the soul installs, or a declared download, is still not looked up here.
  assert.equal(harnessLaunchRefusal('x', { registry: { x: { enabled: true, command: 'none-cli', soulBin: 'x-acp' } }, env }), null);
  assert.equal(harnessLaunchRefusal('bare-missing', { registry, env, declared: true }), null);
});
