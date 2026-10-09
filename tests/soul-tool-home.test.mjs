import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { populationFile, upsertSoul } from '../agent-population.mjs';
import { auditFile } from '../agent-principals.mjs';
import { ownerActionSummary } from '../owner-gate.mjs';
import { readToolHomeRecord, setToolHomeChoice } from '../soul-tool-home-record.mjs';
import { soulToolHomeCommand } from '../soul-tool-home.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER = 'agent_22222222-2222-4222-8222-222222222222';
const AT = '2026-10-09T12:00:00.000Z';
const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'soul-tool-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH, XDG_STATE_HOME: path.join(home, 'state'),
    AGENT_BOT_CONFIG: path.join(home, 'config.json'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'),
    AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), GIT_CONFIG_COUNT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  const soulDir = path.join(home, 'souls', 'bill.soul');
  mkdirSync(path.join(soulDir, '.soul-state'), { recursive: true });
  const file = populationFile({ env, home });
  upsertSoul({ id: ID, name: 'bill', displayName: 'Bill - Starter', status: 'active', soulDir, spacePath: home }, { file });
  upsertSoul({ id: OTHER, name: 'ann', status: 'active', spacePath: home }, { file });
  const out = [], gates = [], asks = [];
  // The soul marker check is injected; `markers` decides who the caller is.
  const run = (argv, { markers = [], caller = env, approve = true, stdin = '' } = {}) => soulToolHomeCommand(argv, {
    env: caller, home, cwd: home, now: () => new Date(AT), write: (text) => out.push(text),
    markers: () => markers, readStdin: () => stdin,
    ownerGate: async (action, input) => { gates.push({ action, principal: input.principal });
      if (!approve) throw new Error('the owner said no'); return { method: 'presence' }; },
    askOwner: async (action) => { asks.push(action); if (!approve) throw new Error('the owner said no'); return { method: 'presence' }; },
  });
  const receipts = () => existsSync(auditFile({ env, home })) ? readFileSync(auditFile({ env, home }), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { home, env, soulDir, run, out, gates, asks, receipts };
}

test('with no choice it shows the recorded choice, unset for a soul without a record', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.run(['codex', '--soul', ID, '--json']), { agentId: ID, harness: 'codex', choice: null, changed: false });
  setToolHomeChoice(f.soulDir, 'codex', 'global');
  assert.equal((await f.run(['codex', '--soul', 'bill'])).choice, 'global');
  assert.equal(f.out.at(-1), 'codex: global\n');
  assert.deepEqual(f.gates, []);
  assert.deepEqual(f.receipts(), []);
});

test('the owner sets soul without a prompt and global through the owner gate, each with a receipt', async (t) => {
  const f = fixture(t);
  const kept = await f.run(['codex', 'soul', '--soul', ID]);
  assert.equal(kept.choice, 'soul');
  assert.equal(kept.authorization, 'none');
  assert.deepEqual(f.gates, []);
  const global = await f.run(['codex', 'global', '--soul', ID, '--json']);
  assert.equal(global.choice, 'global');
  assert.equal(global.previous, 'soul');
  assert.equal(global.caller, 'owner');
  assert.deepEqual(f.gates, [{ action: `soul tool-home ${ID} codex global`, principal: null }]);
  assert.deepEqual(readToolHomeRecord(f.soulDir).harnesses, { codex: 'global' });
  assert.deepEqual(f.receipts().map(({ event, agentId, decision, detail }) => ({ event, agentId, decision, detail })), [
    { event: 'tool-home', agentId: ID, decision: 'soul', detail: 'codex: unset -> soul by owner (none)' },
    { event: 'tool-home', agentId: ID, decision: 'global', detail: 'codex: soul -> global by owner (presence)' },
  ]);
});

test('a presented principal reaches the owner gate', async (t) => {
  const f = fixture(t);
  await f.run(['codex', 'global', '--soul', ID, '--principal-stdin'], { stdin: '{"principal":"owner"}' });
  assert.deepEqual(f.gates[0].principal, { principal: 'owner' });
});

test('a soul changes its own tool home; global asks the owner, and a refusal changes nothing', async (t) => {
  const f = fixture(t);
  const soul = { ...f.env, AGENT_BOT_ID: ID };
  assert.equal((await f.run(['codex', 'soul', '--soul', ID], { markers: ['Agent ID'], caller: soul })).caller, 'soul');
  assert.deepEqual(f.asks, []);
  await assert.rejects(f.run(['codex', 'global', '--soul', ID], { markers: ['Agent ID'], caller: soul, approve: false }),
    { code: 'tool-home-owner-not-approved' });
  assert.deepEqual(f.asks, [`soul tool-home ${ID} codex global`]);
  assert.deepEqual(readToolHomeRecord(f.soulDir).harnesses, { codex: 'soul' });
  assert.equal(f.receipts().length, 1);
  const approved = await f.run(['codex', 'global', '--soul', ID], { markers: ['Agent ID'], caller: soul });
  assert.equal(approved.authorization, 'presence');
  assert.deepEqual(readToolHomeRecord(f.soulDir).harnesses, { codex: 'global' });
  assert.deepEqual(f.gates, [], 'a soul never goes through the owner-only gate');
});

test('a soul cannot change another soul, or one it cannot name, and cannot present the owner principal', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(['codex', 'soul', '--soul', ID], { markers: ['Agent ID'], caller: { ...f.env, AGENT_BOT_ID: OTHER } }),
    { code: 'tool-home-not-own-soul' });
  await assert.rejects(f.run(['codex', 'soul', '--soul', ID], { markers: ['App identity'] }), { code: 'tool-home-not-own-soul' });
  await assert.rejects(f.run(['codex', 'global', '--soul', ID, '--principal-stdin'], { markers: ['Agent ID'], caller: { ...f.env, AGENT_BOT_ID: ID }, stdin: '{}' }),
    { code: 'tool-home-principal-not-accepted' });
  assert.equal(readToolHomeRecord(f.soulDir), null);
  assert.deepEqual([...f.gates, ...f.asks], []);
  assert.deepEqual(f.receipts(), []);
});

test('setting the recorded choice again is a no-op without a prompt or receipt', async (t) => {
  const f = fixture(t);
  setToolHomeChoice(f.soulDir, 'codex', 'global');
  assert.equal((await f.run(['codex', 'global', '--soul', ID])).changed, false);
  assert.deepEqual(f.gates, []);
  assert.deepEqual(f.receipts(), []);
});

test('bad input is refused with a code before anything is asked or written', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(['codex', 'sometimes', '--soul', ID]), { code: 'usage' });
  await assert.rejects(f.run(['codex', 'soul']), { code: 'usage' });
  await assert.rejects(f.run(['codex', '--soul', ID, '--principal-stdin']), { code: 'usage' });
  await assert.rejects(f.run(['kiro', 'soul', '--soul', ID]), { code: 'tool-home-unsupported' });
  await assert.rejects(f.run(['nope', 'soul', '--soul', ID]), { code: 'tool-home-unsupported' });
  await assert.rejects(f.run(['codex', 'soul', '--soul', 'nobody']), { code: 'soul-not-found' });
  assert.deepEqual([...f.gates, ...f.asks], []);
  assert.equal(readToolHomeRecord(f.soulDir), null);
});

test('the owner prompt names the soul and what global gives it', () => {
  const souls = [{ id: ID, displayName: 'Bill - Starter' }];
  assert.equal(ownerActionSummary(`soul tool-home ${ID} codex global`, { souls }),
    `let Bill - Starter (${ID}) use this Mac's shared codex sign-in and sessions instead of its own`);
});

test('agent-bot soul tool-home is wired through the CLI', async (t) => {
  const f = fixture(t);
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'soul', 'tool-home', 'codex', '--soul', ID, '--json'], { env: f.env, cwd: f.home });
  assert.deepEqual(JSON.parse(stdout), { agentId: ID, harness: 'codex', choice: null, changed: false });
});
