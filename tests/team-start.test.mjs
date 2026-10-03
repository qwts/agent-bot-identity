import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEAM_DEFAULTS, createTeamStarter, defaultTeamTemplate, harnessLaunchProblem, harnessLaunchable, teamLimits,
} from '../team-start.mjs';
import { ACP_SPAWN_REGISTRY } from '../acp-registry.mjs';

const LEAD = 'agent_11111111-1111-4111-8111-111111111111';
const id = (n) => `agent_${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// A census in memory: launches append a child under the parent they name.
function team({ rows = [{ id: LEAD, parentId: null }], harness = 'claude', launchable = () => true,
  template = () => '/souls/starter.soul', limits, launchStatus = 'launched' } = {}) {
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
    limits, launchable, template, account: 'owner',
  });
  return { start, census, receipts, launches };
}

test('a soul starts a teammate under itself on its own harness and the default template', async () => {
  const t = team();
  const started = await t.start(LEAD, { name: ' Researcher ' });
  assert.deepEqual(started, { agentId: id(101), name: 'Researcher', harness: 'claude', parent: LEAD });
  assert.equal(t.launches.length, 1);
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
  await assert.rejects(t.start(LEAD, { name: 'X', parent: id(9) }), (error) => error.statusCode === 403);
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
    abs: { enabled: true, command: '/opt/x/bin/acp' },
  };
  const env = { PATH: '/nonexistent' };
  assert.equal(harnessLaunchable('on', { registry, env }), false);
  assert.equal(harnessLaunchable('adapter', { registry, env }), true);
  assert.equal(harnessLaunchable('off', { registry, env }), false);
  assert.equal(harnessLaunchable('abs', { registry, env }), true);
  assert.equal(harnessLaunchable('missing', { registry, env }), false);
});

test('a refusal says why: the missing CLI and how to install it, or the adapter (#418)', async () => {
  const env = { PATH: '/nonexistent' };
  assert.match(harnessLaunchProblem('opencode', { env }), /`opencode` command is not on this host's PATH \(\/nonexistent\); install OpenCode/);
  assert.equal(harnessLaunchProblem('codex', { env }), null, 'an adapter installs with the soul package');
  assert.equal(harnessLaunchProblem('muse', { registry: { muse: { enabled: false } } }), 'it is disabled in agent-bot');
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
