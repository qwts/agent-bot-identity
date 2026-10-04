import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAgentIdentity } from '../agent-identity.mjs';
import { showSoul } from '../agent-population.mjs';
import { createDaemonServer, recordedWorktree } from '../agent-daemon.mjs';
import { appendAuditReceipt, auditFile } from '../agent-principals.mjs';
import { createColdWaker } from '../cold-wake.mjs';
import { bundledStarter, joinSoul, parseJoinArgs, WORKSPACE_NAME } from '../soul-join.mjs';
import { PACKAGE_IGNORE_LIST, computePackageRevision } from '../soul-package.mjs';
import { createWebhookWaker } from '../wake-webhook.mjs';

const FAKE_COMMS = fileURLToPath(new URL('./fixtures/fake-agent-comms.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));

// A scratch account: its own HOME, census, identities, spaces and souls, a
// fake agent-comms on PATH, and no GitHub App anywhere.
function account(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'soul-join-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const shim = path.join(bin, 'agent-comms');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_COMMS}" "$@"\n`);
  chmodSync(shim, 0o755);
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    AGENT_BOT_STATE_HOME: path.join(root, 'identities'),
    AGENT_BOT_POPULATION_PATH: path.join(root, 'population.json'),
    AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
    AGENT_BOT_SOULS_HOME: path.join(root, 'souls'),
    AGENT_BOT_DAEMON_PREFERENCE: 'off',
    FAKE_COMMS_BROKER: path.join(root, 'broker.json'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GH_AGENT_APP: '',
  };
  for (const key of ['QWTS_AGENT_ID', 'AGENT_BOT_ID', 'AGENT_BOT_BINDING', 'AGENT_BOT_STARTER_TEMPLATE', 'AGENT_BOT_TOOL_PATH']) delete env[key];
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  return { root, env, home: root, outside, broker: () => JSON.parse(readFileSync(env.FAKE_COMMS_BROKER, 'utf8')) };
}

// A real daemon on loopback; its client is the one `join` uses to bind.
async function startDaemon(t, a) {
  const server = createDaemonServer({ env: a.env, home: a.home, config: {} });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = {
    async bind(body) {
      const response = await fetch(`${url}/v0/bind`, { method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message ?? `bind failed: ${response.status}`);
      return result;
    },
  };
  return { server, client };
}

const comms = (a, cwd, args, extra = {}) => JSON.parse(execFileSync('agent-comms', args, { cwd, env: { ...a.env, ...extra }, encoding: 'utf8' }));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function starter(root) {
  const template = path.join(root, 'Starter.soul');
  mkdirSync(template);
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Starter', description: 'Starter', displaySeed: 'starter',
    template: true, preferredHarnesses: ['claude'], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(path.join(template, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(path.join(template, 'AGENTS.md'), 'Starter instructions\n');
  manifest.revision = computePackageRevision(template);
  writeFileSync(path.join(template, 'soul.json'), JSON.stringify(manifest));
  return template;
}

// A Starter that pins the Claude adapter, as GeniusBar's bundled one does,
// and an install that fakes npm: an ACP wake installs it (#417), and an
// adapter row never falls back to npx (#418).
function pinnedStarter(root) {
  const template = starter(root);
  writeFileSync(path.join(template, 'package.json'), JSON.stringify({ name: 'starter-soul', private: true, dependencies: { '@zed-industries/claude-code-acp': '0.16.2' } }));
  writeFileSync(path.join(template, 'package-lock.json'), JSON.stringify({ name: 'starter-soul', lockfileVersion: 3, packages: {} }));
  const installHarness = async (agentId, source, options) => {
    const { installSoulHarnesses } = await import('../soul-home.mjs');
    return installSoulHarnesses(agentId, source, { ...options, install: async (dir) => {
      mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(path.join(dir, 'node_modules', '.bin', 'claude-code-acp'), '');
    } });
  };
  return { template, installHarness };
}

test('join with no GitHub App and no checkout: new soul, its own workspace pinned, recorded, bindable and joined', async (t) => {
  const a = account(t);
  const joined = await joinSoul({ name: 'dudles', harness: 'grokbot', template: null, cwd: a.outside, env: a.env, home: a.home, config: {} });
  assert.equal(joined.created, true);
  assert.equal(joined.address, `test/${joined.agentId}`);
  assert.equal(joined.worktree, path.join(joined.soulDir, 'worktrees', WORKSPACE_NAME));
  assert.equal(joined.bind, 'bind token minted');
  // No App anywhere: the identity carries no GitHub record.
  assert.equal(readAgentIdentity(joined.agentId, { stateDir: a.env.AGENT_BOT_STATE_HOME }).github ?? null, null);
  // The pin is the setup-worktree pin, and a plain agent-comms resolves it.
  assert.equal(git(joined.worktree, 'config', '--worktree', '--get', 'agentBot.agentId'), joined.agentId);
  assert.deepEqual(a.broker().joined[joined.agentId], { name: 'dudles', harness: 'grokbot' });
  // The census records the checkout, so cold wake finds it.
  assert.equal(showSoul(joined.agentId, { file: a.env.AGENT_BOT_POPULATION_PATH }).worktree, joined.worktree);
  // The census name is the one every command shows (#429).
  assert.equal(showSoul(joined.agentId, { file: a.env.AGENT_BOT_POPULATION_PATH }).displayName, 'dudles');
  assert.deepEqual(recordedWorktree(joined.agentId, { env: a.env, home: a.home }), { agentId: joined.agentId, worktree: joined.worktree, file: null });
  // The soul folder itself never becomes a repository.
  assert.equal(existsSync(path.join(joined.soulDir, '.git')), false);

  // Joining again from that checkout reuses the soul.
  const again = await joinSoul({ name: 'dudles', harness: 'grokbot', template: null, cwd: joined.worktree, env: a.env, home: a.home, config: {} });
  assert.equal(again.agentId, joined.agentId);
  assert.equal(again.created, false);
  assert.equal(again.bind, 'bind token minted');
});

test('a joined checkout with no GitHub App binds through the MCP bind flow as the joined soul', async (t) => {
  const a = account(t);
  const joined = await joinSoul({ name: 'dudles', harness: 'grokbot', template: null, cwd: a.outside, env: a.env, home: a.home, config: {} });
  const gitDir = git(joined.worktree, 'rev-parse', '--absolute-git-dir');
  const token = JSON.parse(readFileSync(path.join(gitDir, 'agent-bind-token.json'), 'utf8'));
  assert.equal(token.agentId, joined.agentId);
  const server = createDaemonServer({ env: a.env, home: a.home, config: {} });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v0/bind`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ gitDir, token: token.token, transcript: { provider: 'custom', id: 'grok-thread' } }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const bound = await response.json();
  assert.equal(bound.agentId, joined.agentId);
  assert.equal(bound.soul.appSlug, null);
});

test('join in an existing checkout pins that checkout; a template makes the soul; a checkout pinned to another soul is refused', async (t) => {
  const a = account(t);
  const repo = path.join(a.root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  const joined = await joinSoul({ name: 'bill', harness: 'claude', template: starter(a.root), cwd: repo, env: a.env, home: a.home, config: {} });
  assert.equal(joined.worktree, repo);
  assert.equal(path.basename(joined.soulDir), 'bill - Starter.soul');
  assert.equal(readFileSync(path.join(joined.soulDir, 'AGENTS.md'), 'utf8'), 'Starter instructions\n');
  assert.equal(git(repo, 'config', '--get', 'agentBot.agentId'), joined.agentId);
  const other = await joinSoul({ name: 'ted', harness: 'codex', template: null, cwd: a.outside, env: a.env, home: a.home, config: {} });
  await assert.rejects(
    joinSoul({ name: 'ted', harness: 'codex', soul: other.agentId, cwd: repo, env: a.env, home: a.home, config: {} }),
    /already pinned to/,
  );
});

test('join → send → webhook wake → reply, end to end with no GitHub App', async (t) => {
  const a = account(t);
  const dudles = await joinSoul({ name: 'dudles', harness: 'grokbot', template: null, cwd: a.outside, env: a.env, home: a.home, config: {} });
  // A second join from the same folder outside any checkout is a second soul.
  const claude = await joinSoul({ name: 'claude', harness: 'claude', template: null, cwd: a.outside, env: a.env, home: a.home, config: {} });
  assert.notEqual(claude.agentId, dudles.agentId);

  const sent = comms(a, claude.worktree, ['send', `test/${dudles.agentId}`, '--body', 'ping']);

  // The routine: called by the webhook, it reads its inbox in the checkout
  // the ask names, with no environment variable, and answers the sender.
  const asks = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      asks.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
      const worktree = /In the directory (.+?) \(/.exec(JSON.parse(body).ask)?.[1];
      const { messages } = comms(a, worktree, ['inbox', 'read']);
      for (const message of messages) {
        comms(a, worktree, ['send', `${message.from.account}/${message.from.agentId}`, '--body', 'pong', '--reply-to', message.id]);
        comms(a, worktree, ['inbox', 'ack', message.id]);
      }
      response.writeHead(200).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const receipts = [];
  const coldWake = createColdWaker({
    executor: () => { throw new Error('a webhook soul runs no turn'); },
    settings: { [dudles.agentId]: { lane: 'webhook' } },
    lookupBinding: async (agentId) => recordedWorktree(agentId, { env: a.env, home: a.home }),
    identities: async () => ({}),
    receipt: (r) => receipts.push(r),
    webhook: createWebhookWaker({ read: () => ({ url: `http://127.0.0.1:${server.address().port}/hook`, key: 'test-key' }) }),
  });
  const wake = await coldWake({ agentId: dudles.agentId, count: 1, messageIds: [sent.messageId] });
  assert.deepEqual(wake, { outcome: 'cold', detail: 'webhook accepted' });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].authorization, 'Bearer test-key');
  assert.ok(!JSON.stringify(asks[0].body).includes('ping'), 'the wake carries no message content');
  const reply = a.broker().messages.find((m) => m.to === claude.agentId);
  assert.equal(reply.body, 'pong');
  assert.equal(reply.replyTo, sent.messageId);
  assert.equal(reply.from.agentId, dudles.agentId);
  assert.deepEqual(receipts.map((r) => r.decision), ['webhook']);
});

test('a failed wake records why in the audit receipt, never a URL', async (t) => {
  const a = account(t);
  const receipts = [];
  const coldWake = createColdWaker({
    executor: () => { throw new Error('unused'); },
    settings: { agent_11111111_1111: { lane: 'webhook' } },
    lookupBinding: async () => null,
    identities: async () => ({}),
    receipt: (r) => receipts.push(r),
    webhook: async () => ({ status: 200 }),
  });
  await coldWake({ agentId: 'agent_11111111_1111', count: 1, messageIds: [] });
  assert.equal(receipts[0].detail, 'soul binding is unavailable');
  const id = 'agent_3a005b6d-87a7-42c0-82a1-f946c045ce9b';
  const receipt = appendAuditReceipt({ event: 'cold-wake', agentId: id, decision: 'failed', detail: 'webhook https://hooks.example/abc?key=secret could not be reached' }, { env: a.env, home: a.home });
  assert.equal(receipt.detail, 'webhook <url> could not be reached');
  assert.ok(!readFileSync(auditFile({ env: a.env, home: a.home }), 'utf8').includes('secret'));
});

test('agent-bot join parses its flags; the CLI prints JSON; setup-worktree run by name says why it did nothing', async (t) => {
  assert.deepEqual(parseJoinArgs(['--name', 'n', '--harness', 'codex', '--json']), { json: true, principalStdin: false, name: 'n', harness: 'codex' });
  assert.deepEqual(parseJoinArgs(['--name', 'n', '--harness', 'codex', '--wake', 'resume:workspace', '--principal-stdin']),
    { json: false, principalStdin: true, name: 'n', harness: 'codex', wake: 'resume:workspace' });
  assert.throws(() => parseJoinArgs(['--name', 'n', '--harness', 'codex', '--wake', 'always']), /usage/);
  assert.throws(() => parseJoinArgs(['--name', 'n', '--harness', 'codex', '--principal-stdin']), /only for --wake/);
  assert.throws(() => parseJoinArgs(['--name', 'n']), /usage: agent-bot join/);
  assert.throws(() => parseJoinArgs(['--name', 'n', '--harness', 'codex', '--bogus', 'x']), /usage/);
  assert.equal(bundledStarter({ env: {}, root: '/nowhere/components/agent-bot' }), null);
  assert.equal(bundledStarter({ env: { AGENT_BOT_STARTER_TEMPLATE: '/t/starter.soul' } }), '/t/starter.soul');

  const a = account(t);
  const run = spawnSync(process.execPath, [CLI, 'join', '--name', 'dudles', '--harness', 'grokbot', '--json'], { cwd: a.outside, env: a.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.address, `test/${result.agentId}`);
  assert.equal(result.wake, 'off', 'join says when the soul will not wake');

  // The owner's account: the GitHub add-on is on, and this checkout states no App.
  const config = path.join(a.root, 'agent-bot-config.json');
  writeFileSync(config, JSON.stringify({ features: { 'github-identity': true } }));
  const env = { ...a.env, AGENT_BOT_CONFIG: config };
  const repo = path.join(a.root, 'human-checkout');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  const named = spawnSync(process.execPath, [CLI, 'setup-worktree'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(named.status, 0);
  assert.match(named.stderr, /agent-bot join --name NAME --harness HARNESS/);
  // A git hook runs the module directly and stays quiet.
  const hook = spawnSync(process.execPath, [fileURLToPath(new URL('../setup-worktree.mjs', import.meta.url))], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(hook.status, 0);
  assert.equal(hook.stderr, '');
});

test('join --wake asks the owner first, then sets the wake; a refusal or an unresumable harness changes nothing (#410)', async (t) => {
  const a = account(t);
  const base = { harness: 'codex', template: null, cwd: a.outside, env: a.env, home: a.home, config: {} };
  const asked = [];
  const joined = await joinSoul({ ...base, name: 'scout', wake: 'resume:workspace', principal: { principal: 'p' },
    gate: async (action, { principal }) => { asked.push({ action, principal }); return { method: 'principal' }; } });
  assert.deepEqual(asked, [{ action: 'create a new soul scout and wake it on new messages (resume:workspace)', principal: { principal: 'p' } }]);
  assert.equal(joined.wake, 'resume workspace');
  assert.equal(joined.authorization, 'principal');
  const settings = JSON.parse(readFileSync(path.join(a.env.XDG_STATE_HOME, 'agent-bot', 'cold-wake.json'), 'utf8')).settings;
  assert.deepEqual(settings[joined.agentId], { lane: 'resume', policy: 'workspace' });

  // A Claude session cannot be resumed; it wakes through an ACP turn, which
  // needs a daemon binding (#417).
  const daemon = await startDaemon(t, a);
  const pinned = pinnedStarter(a.root);
  const acp = await joinSoul({ ...base, env: { ...a.env, AGENT_BOT_STARTER_TEMPLATE: pinned.template }, installHarness: pinned.installHarness,
    name: 'claude-one', harness: 'claude', wake: 'acp', daemon: daemon.client, gate: async () => ({ method: 'consent' }) });
  assert.equal(acp.wake, 'on');
  assert.equal(acp.bind, 'bound');
  assert.equal(acp.authorization, 'consent');
  // Without a daemon to bind it, an ACP wake is refused rather than reported on.
  await assert.rejects(joinSoul({ ...base, name: 'claude-unbound', harness: 'claude', wake: 'acp', gate: async () => ({ method: 'consent' }),
    daemon: { bind: async () => { throw new Error('connect ECONNREFUSED'); } } }), /--wake acp needs the agent-bot daemon to bind this checkout/);

  // Reusing a soul: the consent names it, and its stored harness decides.
  const reasked = [];
  const reused = await joinSoul({ ...base, name: 'someone-else', soul: joined.agentId, cwd: a.outside, wake: 'resume:read-only',
    gate: async (action) => { reasked.push(action); return { method: 'consent' }; } }).catch((error) => error);
  assert.ok(!(reused instanceof Error), reused?.message);
  // The census name it joined as (#429), not the generated handle.
  assert.deepEqual(reasked, [`wake the existing soul scout (${joined.agentId}) on new messages (resume:read-only)`]);
  assert.ok(!reasked[0].includes('someone-else'), 'the caller-supplied name does not stand in for the target');
  await assert.rejects(joinSoul({ ...base, harness: 'opencode', name: 'scout', soul: acp.agentId, cwd: a.outside, wake: 'resume:workspace',
    gate: async () => assert.fail('not asked') }), new RegExp(`${acp.agentId} runs claude; join it with --harness claude`));

  const souls = () => JSON.parse(readFileSync(a.env.AGENT_BOT_POPULATION_PATH, 'utf8')).souls;
  const before = Object.keys(souls()).length;
  await assert.rejects(joinSoul({ ...base, name: 'refused', wake: 'acp', gate: async () => { throw new Error('the owner said no'); } }), /the owner said no/);
  await assert.rejects(joinSoul({ ...base, name: 'claude-two', harness: 'claude', wake: 'resume:read-only', gate: async () => assert.fail('not asked') }),
    /claude sessions cannot be resumed/);
  await assert.rejects(joinSoul({ ...base, name: 'bad', wake: 'sometimes', gate: async () => assert.fail('not asked') }), /--wake must be one of/);
  assert.equal(Object.keys(souls()).length, before, 'nothing was created');
});

test('join --wake acp binds the checkout, so a new message wakes a joined Claude soul through an ACP turn (#417)', async (t) => {
  const a = account(t);
  const daemon = await startDaemon(t, a);
  // No package pins the adapter, and an adapter row never falls back to npx
  // (#418), so the wake is refused rather than reported on.
  await assert.rejects(joinSoul({ name: 'unpinned', harness: 'claude', template: null, cwd: a.outside,
    env: { ...a.env, AGENT_BOT_STARTER_TEMPLATE: path.join(a.root, 'no-starter') }, home: a.home, config: {},
    wake: 'acp', daemon: daemon.client, gate: async () => ({ method: 'consent' }) }),
  /--wake acp needs the claude adapter @zed-industries\/claude-code-acp@0\.16\.2/);
  const pinned = pinnedStarter(a.root);
  const joined = await joinSoul({ name: 'r8joiner', harness: 'claude', template: null, cwd: a.outside, env: { ...a.env, AGENT_BOT_STARTER_TEMPLATE: pinned.template },
    home: a.home, config: {}, wake: 'acp', daemon: daemon.client, gate: async () => ({ method: 'consent' }), installHarness: pinned.installHarness });
  assert.equal(joined.bind, 'bound');
  assert.equal(joined.adapter, 'installed');
  const binding = daemon.server.bindings.findAgent(joined.agentId);
  assert.equal(binding?.worktree, joined.worktree);
  assert.ok(binding?.file, 'the daemon binding has a file for the ACP turn');
  // The soul keeps its own harness and gains no GitHub App.
  assert.equal(readAgentIdentity(joined.agentId, { stateDir: a.env.AGENT_BOT_STATE_HOME }).harness, 'claude');

  const turns = [];
  const receipts = [];
  const coldWake = createColdWaker({
    executor: async (turn) => { turns.push(turn); return { stopReason: 'end_turn' }; },
    settings: JSON.parse(readFileSync(path.join(a.env.XDG_STATE_HOME, 'agent-bot', 'cold-wake.json'), 'utf8')).settings,
    lookupBinding: async (agentId) => daemon.server.bindings.findAgent(agentId) ?? recordedWorktree(agentId, { env: a.env, home: a.home }),
    identities: async (agentId) => readAgentIdentity(agentId, { stateDir: a.env.AGENT_BOT_STATE_HOME }),
    receipt: (r) => receipts.push(r),
  });
  const wake = await coldWake({ agentId: joined.agentId, count: 1, messageIds: ['msg_1'] });
  assert.notEqual(wake.outcome, 'failed', wake.detail);
  await coldWake.idle?.();
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].wake, { lane: 'acp' });
  assert.equal(turns[0].invocation.harness, 'claude');
  assert.equal(turns[0].invocation.cwd, joined.worktree);
  assert.equal(turns[0].env.AGENT_BOT_BINDING, binding.file);
  assert.ok(!receipts.some((r) => r.decision === 'failed'), JSON.stringify(receipts));
});

test('join --wake turns the wake on before agent-comms registers the soul, and puts it back when registration fails', async (t) => {
  const a = account(t);
  const settings = () => { try { return JSON.parse(readFileSync(path.join(a.env.XDG_STATE_HOME, 'agent-bot', 'cold-wake.json'), 'utf8')).settings; } catch { return {}; } };
  const base = { harness: 'codex', template: null, cwd: a.outside, env: a.env, home: a.home, config: {}, gate: async () => ({ method: 'consent' }) };
  // A message delivered during registration finds the wake already on.
  const seen = [];
  const joined = await joinSoul({ ...base, name: 'early', wake: 'resume:workspace',
    comms: async ({ agentId }) => { seen.push(settings()[agentId]); return `test/${agentId}`; } });
  assert.deepEqual(seen, [{ lane: 'resume', policy: 'workspace' }]);
  assert.equal(joined.wake, 'resume workspace');

  // A failed registration restores the previous setting.
  await assert.rejects(joinSoul({ ...base, name: 'early', soul: joined.agentId, wake: 'resume:read-only',
    comms: async () => { throw new Error('agent-comms join failed: broker down'); } }), /broker down/);
  assert.deepEqual(settings()[joined.agentId], { lane: 'resume', policy: 'workspace' });
  const fresh = await joinSoul({ ...base, name: 'never', wake: 'resume:workspace',
    comms: async () => { throw new Error('agent-comms join failed: broker down'); } }).catch((error) => error);
  assert.match(fresh.message, /broker down/);
  assert.ok(!Object.values(settings()).some((value, index) => Object.keys(settings())[index] !== joined.agentId && value !== false && value !== undefined),
    'a soul whose registration failed is left with its wake off');
});

test('join --wake acp installs the pinned adapter in the soul\'s own harness directory, never in the checkout (#417)', async (t) => {
  const a = account(t);
  const daemon = await startDaemon(t, a);
  // The Starter template pins the Claude adapter, as GeniusBar's bundled one does.
  const template = starter(a.root);
  writeFileSync(path.join(template, 'package.json'), JSON.stringify({ name: 'starter-soul', private: true, dependencies: { '@zed-industries/claude-code-acp': '0.16.2' } }));
  writeFileSync(path.join(template, 'package-lock.json'), JSON.stringify({ name: 'starter-soul', lockfileVersion: 3, packages: {} }));
  const repo = path.join(a.root, 'someone-elses-repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  const installs = [];
  const joined = await joinSoul({ name: 'claude-joiner', harness: 'claude', template: null, cwd: repo, env: { ...a.env, AGENT_BOT_STARTER_TEMPLATE: template },
    home: a.home, config: {}, wake: 'acp', daemon: daemon.client, gate: async () => ({ method: 'consent' }),
    installHarness: async (agentId, source, options) => {
      installs.push(source);
      const { installSoulHarnesses } = await import('../soul-home.mjs');
      return installSoulHarnesses(agentId, source, { ...options, install: async (dir) => {
        mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(path.join(dir, 'node_modules', '.bin', 'claude-code-acp'), '');
      } });
    } });
  assert.equal(joined.adapter, 'installed');
  assert.deepEqual(installs, [template]);
  const harnesses = path.join(joined.soulDir, '.soul-state', 'harnesses');
  assert.ok(existsSync(path.join(harnesses, 'node_modules', '.bin', 'claude-code-acp')));
  assert.equal(existsSync(path.join(repo, 'node_modules')), false, 'the checkout is left alone');
  assert.equal(existsSync(path.join(repo, 'package.json')), false);

  // Joining again finds the install and does not repeat it.
  const again = await joinSoul({ name: 'claude-joiner', harness: 'claude', template: null, cwd: repo, env: { ...a.env, AGENT_BOT_STARTER_TEMPLATE: template },
    home: a.home, config: {}, wake: 'acp', daemon: daemon.client, gate: async () => ({ method: 'consent' }), installHarness: async () => assert.fail('not reinstalled') });
  assert.equal(again.adapter, 'installed');
  // A harness with no ACP lane is refused before the owner is asked.
  await assert.rejects(joinSoul({ name: 'g', harness: 'grokbot', template: null, cwd: a.outside, env: a.env, home: a.home, config: {}, wake: 'acp',
    gate: async () => assert.fail('not asked') }), /grokbot has no ACP lane/);
});
