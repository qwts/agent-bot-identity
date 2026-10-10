// Route authorization (#785): the daemon bearer proves only a process in this
// account, so every owner-level route also asks the owner (presence through
// keyd or the dialog, or a verified principal credential). The table in
// docs/daemon-api.md classifies every route; this test keeps the two in step
// and checks that a bearer-only caller is refused on each owner route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDaemonServer } from '../agent-daemon.mjs';
import { setSoulPaused, showSoul, upsertSoul } from '../agent-population.mjs';
import { readSandboxStatus } from '../sandbox.mjs';

const root = path.join(import.meta.dirname, '..');
const ID = 'agent_78578578-5785-4785-8785-785785785785';
const OPERATION = { permission: { toolName: 'Bash', input: { command: 'git push' } } };

function routeTable() {
  const doc = readFileSync(path.join(root, 'docs', 'daemon-api.md'), 'utf8');
  const section = doc.slice(doc.indexOf('# Route authorization'));
  const rows = new Map();
  for (const match of section.matchAll(/^\| `([A-Z]+ \/[^`]+)` \| ([a-z-]+) \|/gm)) rows.set(match[1], match[2]);
  return rows;
}

test('every daemon route is classified in docs/daemon-api.md (#785)', () => {
  const source = readFileSync(path.join(root, 'agent-daemon.mjs'), 'utf8');
  const cases = [...source.matchAll(/case '((?:GET|POST|DELETE) \/v0\/[^']+)'/g)].map((match) => match[1]);
  const table = routeTable();
  assert.ok(cases.length > 30, 'the route switch was found');
  for (const route of cases) assert.ok(table.has(route), `${route} is missing from the route authorization table`);
  for (const route of table.keys()) {
    // Routes dispatched before the switch: vouch, the App and dream families, and /v1.
    if (route.includes('{') || route.includes(' /v1/') || ['POST /v0/vouch', 'GET /v0/identity/apps',
      'GET /v0/soul/dream', 'GET /v0/soul/dream/history'].includes(route)) continue;
    assert.ok(cases.includes(route), `${route} in the table is not a daemon route`);
  }
  const classes = new Set(table.values());
  assert.deepEqual([...classes].filter((value) => !['owner', 'owner-credential', 'bearer', 'binding', 'principal'].includes(value)), []);
});

async function daemon(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'route-auth-'));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction'),
    AGENT_BOT_PRINCIPALS_PATH: path.join(home, 'principals.json') };
  upsertSoul({ id: ID, name: 'route-auth', status: 'active', spacePath: home }, { file: env.AGENT_BOT_POPULATION_PATH });
  const asked = [];
  const refuse = (action) => {
    asked.push(action);
    throw Object.assign(new Error('the owner declined'), { code: 'owner-credential-required' });
  };
  const server = createDaemonServer({ env, home, config: {},
    ownerGate: async (action) => refuse(action),
    settingGate: async (action) => refuse(action),
    revisionPrincipal: async () => refuse('revision principal') });
  const controls = [];
  server.dream = { control: (request) => { controls.push(request); return { status: 'paused' }; }, status: () => ({}), history: () => ({}) };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const post = (route, body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { env, home, server, post, asked, controls };
}

test('a bearer-only caller is refused on every owner route and nothing changes (#785)', async (t) => {
  const f = await daemon(t);
  setSoulPaused(ID, true, { file: f.env.AGENT_BOT_POPULATION_PATH });
  const waiting = f.server.interaction.requestTurnApproval({ agentId: ID, operation: OPERATION, summary: 'push', tool: 'Bash' });
  waiting.catch(() => {});
  const [proposal] = f.server.interaction.listProposalsForOwner().proposals;
  const sandboxBefore = readSandboxStatus({ env: f.env, home: f.home });
  const soulBefore = showSoul(ID, { file: f.env.AGENT_BOT_POPULATION_PATH });
  const owner = {
    'POST /v0/approvals/decide': { proposalId: proposal.proposalId, decision: 'approve', digest: proposal.operationDigest },
    'POST /v0/sandbox': { enabled: true },
    'POST /v0/sandbox/override': { agentId: ID, override: 'unrestricted' },
    'POST /v0/soul/computer-use': { agentId: ID, enabled: true },
    'POST /v0/soul/resume': { agentId: ID },
    'POST /v0/soul/dream/register': { agentId: ID, schedule: 'PT24H' },
    'POST /v0/soul/dream/pause': { agentId: ID },
    'POST /v0/soul/dream/unschedule': { agentId: ID },
    'POST /v0/soul/dream/run-now': { agentId: ID },
    'POST /v0/soul/dream/cancel': { runId: '78578578-5785-4785-8785-785785785785' },
    'POST /v0/soul/dream/ack-notice': { agentId: ID, noticeId: `ntc_${'7'.repeat(24)}` },
    // The other App actions are refused earlier while the add-on is off;
    // they share this gate (tests/identity-apps.test.mjs).
    'POST /v0/identity/apps/addon': { name: 'github-identity', enabled: true },
  };
  const table = routeTable();
  for (const [route, body] of Object.entries(owner)) {
    const family = route.replace(/\/dream\/[a-z-]+$/, '/dream/{action}').replace(/\/apps\/[a-z-]+$/, '/apps/{action}');
    assert.equal(table.get(family), 'owner', `${family} is classified owner`);
    const before = f.asked.length;
    const res = await f.post(route.slice(5), body);
    // Older routes answer a refused gate with 409, newer ones with 403.
    assert.ok([403, 409].includes(res.status), `${route} refused a bearer-only caller (HTTP ${res.status})`);
    assert.equal(f.asked.length, before + 1, `${route} asked the owner exactly once`);
  }
  assert.equal(f.controls.length, 0, 'no dream control ran');
  assert.deepEqual(showSoul(ID, { file: f.env.AGENT_BOT_POPULATION_PATH }), soulBefore, 'the soul stays paused, computer use unchanged');
  assert.equal(soulBefore.paused, true);
  assert.deepEqual(readSandboxStatus({ env: f.env, home: f.home }), sandboxBefore);
  assert.deepEqual(f.server.interaction.listProposalsForOwner().proposals.map((row) => row.status), ['open']);

  // Revision writes take the owner's principal credential, never presence.
  for (const action of ['approve', 'reject', 'adopt', 'edit']) {
    assert.equal(table.get(`POST /v0/soul/revisions/${action}`), 'owner-credential');
    const target = ['approve', 'reject'].includes(action) ? { proposalId: 'p' } : { packagePath: f.home };
    const res = await f.post(`/v0/soul/revisions/${action}`, { agentId: ID, ...target, reason: 'r' });
    assert.equal(res.status, 403, `revision ${action} refused a bearer-only caller`);
    assert.equal((await res.json()).code, 'owner-credential-required');
  }
});

test('the owner resume asks for presence; a soul binding is refused before it is asked (#785)', async (t) => {
  const f = await daemon(t);
  setSoulPaused(ID, true, { file: f.env.AGENT_BOT_POPULATION_PATH });
  const bound = await f.post('/v0/soul/resume', { agentId: ID }, { 'x-agent-binding': 'anything' });
  assert.equal(bound.status, 403);
  assert.equal((await bound.json()).code, 'owner-credential-required');
  assert.deepEqual(f.asked, [], 'a soul binding never reaches the owner prompt');
  const refused = await f.post('/v0/soul/resume', { agentId: ID });
  assert.equal(refused.status, 403);
  assert.deepEqual(f.asked, [`soul resume ${ID}`]);
  const receipts = readFileSync(path.join(f.env.AGENT_BOT_INTERACTION_HOME, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(receipts.filter((row) => row.event === 'resume').map((row) => row.decision), ['owner-credential-required', 'owner-refused']);
  // Pause and stop only hold a soul back: no prompt.
  for (const action of ['pause', 'stop']) {
    assert.equal((await f.post(`/v0/soul/${action}`, { agentId: ID })).status, 200);
  }
  assert.equal(f.asked.length, 1);
});
