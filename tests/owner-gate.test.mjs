import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { auditFile } from '../agent-principals.mjs';
import { assertOwnerAction, confirmOwnerPresence, consentOwner, soulMarkers, verifyPrincipalOwner } from '../owner-action.mjs';
import { computePackageRevision } from '../soul-package.mjs';
import { adoptSoulPackage, listSoulProposals, proposeSoulRevision, revisionCommand, revisionHistory } from '../soul-revisions.mjs';
import { fileURLToPath } from 'node:url';

const PRINCIPAL = 'principal_12345678-1234-4123-8123-123456789abc';
const SECRET = 'f'.repeat(64);
const BROKER_UID = process.getuid() + 1;
const owner = (extra = {}) => ({ principal: PRINCIPAL, secret: SECRET, brokerUid: BROKER_UID, mode: 'group', ...extra });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'owner-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packagePath = join(root, 'example.soul');
  mkdirSync(packagePath);
  const manifest = { formatVersion: 1, name: 'Test', description: 'Test soul', displaySeed: 'test',
    preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(join(packagePath, 'AGENTS.md'), 'Initial\n');
  manifest.revision = computePackageRevision(packagePath);
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  const env = { PATH: process.env.PATH, HOME: root, AGENT_BOT_CONFIG: join(root, 'no-config.json') };
  const options = { env, home: root, cwd: root, stateDir: join(root, 'state'), now: () => new Date('2026-10-02T12:00:00Z') };
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: computePackageRevision(packagePath) });
  adoptSoulPackage(id, packagePath, { ...options, reason: 'Start' });
  writeFileSync(join(packagePath, 'AGENTS.md'), 'Proposed\n');
  const proposal = proposeSoulRevision(id, packagePath, { ...options, reason: 'Improve' });
  return { root, id, packagePath, options, proposal };
}

// A broker stand-in: records each request and answers like `health`.
function fakeBroker({ fail = null } = {}) {
  const calls = [];
  return { calls, clientFactory: (options) => ({ async request(fields) {
    calls.push({ options, fields });
    if (fail) throw Object.assign(new Error(fail.message), { code: fail.code });
    return { uptimeMs: 1 };
  } }) };
}

// The owner gate as the CLI wires it, with every seam injected.
const gate = (seams) => (action, { principal }) => assertOwnerAction(action, { principal, ...seams });

test('a soul with its markers unset is still refused when the principal does not verify', async (t) => {
  const f = fixture(t);
  const broker = fakeBroker({ fail: { code: 'unauthenticated', message: 'this principal is not paired with the broker' } });
  const assertUser = gate({ markers: () => [], consent: () => assert.fail('a presented principal never falls back to the dialog'),
    verifyPrincipal: (credential) => verifyPrincipalOwner(credential, { paths: { socket: '/nonexistent' }, clientFactory: broker.clientFactory }) });
  await assert.rejects(revisionCommand(['approve', f.id, f.proposal.proposalId, 'Mine now'],
    { ...f.options, assertUser, principal: owner({ secret: 'b'.repeat(64) }) }),
  (error) => error.code === 'owner-credential-required' && /did not accept the owner principal/.test(error.message)
    && !error.message.includes('b'.repeat(64)));
  assert.equal(broker.calls.length, 1);
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'pending');
  assert.equal(revisionHistory(f.id, f.options).length, 1);
});

test('a soul with its markers unset is refused when the consent dialog is cancelled', async (t) => {
  const f = fixture(t);
  const cancelled = () => { const e = new Error('execution error: User canceled. (-128)'); e.stderr = 'User canceled. (-128)'; throw e; };
  const assertUser = gate({ markers: () => [], consent: (action) => consentOwner(action, { platform: 'darwin', run: cancelled }) });
  for (const args of [['approve', f.id, f.proposal.proposalId, 'r'], ['reject', f.id, f.proposal.proposalId, 'r'],
    ['edit', f.id, f.packagePath, 'r'], ['adopt', f.id, f.packagePath, 'r']]) {
    await assert.rejects(revisionCommand(args, { ...f.options, assertUser }), /owner approval was cancelled — nothing was changed/);
  }
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'pending');
  assert.equal(revisionHistory(f.id, f.options).length, 1);
});

test('the owner is accepted through the principal and the record names the principal, never the secret', async (t) => {
  const f = fixture(t);
  const broker = fakeBroker();
  const assertUser = gate({ markers: () => [], consent: () => assert.fail('principal path must not raise the dialog'),
    verifyPrincipal: (credential) => verifyPrincipalOwner(credential, { paths: { socket: '/broker.sock' }, clientFactory: broker.clientFactory }) });
  const record = await revisionCommand(['approve', f.id, f.proposal.proposalId, 'Reviewed'], { ...f.options, assertUser, principal: owner() });
  assert.deepEqual(record.authorization, { method: 'principal', principal: PRINCIPAL });
  assert.equal(record.approvedBy, 'user');
  assert.deepEqual(broker.calls[0].fields, { op: 'health', auth: { principal: PRINCIPAL, secret: SECRET } });
  assert.deepEqual(broker.calls[0].options, { socketPath: '/broker.sock', brokerUid: BROKER_UID, mode: 'group' });
  const journal = join(f.options.stateDir, 'soul-revisions', f.id);
  for (const name of readdirSync(journal).filter((n) => n.endsWith('.json'))) {
    assert.ok(!readFileSync(join(journal, name), 'utf8').includes(SECRET), `${name} must not hold the secret`);
  }
});

test('the owner is accepted through the consent dialog, which names the action', async (t) => {
  const f = fixture(t);
  const prompts = [];
  const granted = (argv) => { prompts.push(argv.at(-1)); return ''; };
  const assertUser = gate({ markers: () => [], verifyPrincipal: () => assert.fail('no principal was presented'),
    consent: (action) => consentOwner(action, { platform: 'darwin', run: granted }) });
  const rejected = await revisionCommand(['reject', f.id, f.proposal.proposalId, 'Not now'], { ...f.options, assertUser });
  assert.deepEqual(rejected.authorization, { method: 'consent' });
  assert.match(prompts[0], new RegExp(`soul revision reject ${f.id}`));
  await assert.rejects(consentOwner('x', { platform: 'linux', run: granted }), /refusing on this platform/);
});

test('a bound soul is refused even when the principal and the dialog would pass', async (t) => {
  const f = fixture(t);
  const pass = { verifyPrincipal: async () => ({ method: 'principal', principal: PRINCIPAL }), consent: async () => ({ method: 'consent' }) };
  const config = join(f.root, 'no-config.json');
  const base = { PATH: process.env.PATH, HOME: f.root, AGENT_BOT_CONFIG: config };
  // The Agent ID or binding in the environment.
  for (const env of [{ ...base, AGENT_BOT_ID: f.id }, { ...base, QWTS_AGENT_ID: f.id }, { ...base, AGENT_BOT_BINDING: join(f.root, 'binding.json') }]) {
    const assertUser = (action, { principal }) => assertOwnerAction(action, { principal, env, cwd: f.root, ...pass });
    await assert.rejects(revisionCommand(['approve', f.id, f.proposal.proposalId, 'r'], { ...f.options, assertUser, principal: owner() }), /owner only/);
    await assert.rejects(revisionCommand(['approve', f.id, f.proposal.proposalId, 'r'], { ...f.options, assertUser }), /owner only/);
  }
  // The Agent ID in the worktree, with the environment clean.
  const worktree = join(f.root, 'worktree');
  mkdirSync(worktree);
  const git = (...args) => execFileSync('git', args, { cwd: worktree, env: base, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'agentBot.agentId', f.id);
  assert.deepEqual(soulMarkers({ env: base, cwd: worktree }), ['Agent ID']);
  await assert.rejects(assertOwnerAction('soul revision approve', { env: base, cwd: worktree, principal: owner(), ...pass }), /owner only; this caller has a soul's Agent ID/);
  // An App identity.
  assert.ok(soulMarkers({ env: { ...base, GH_AGENT_APP: 'unknown-app' }, cwd: f.root }).some((m) => m.startsWith('App identity')));
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'pending');
});

test('principal proof needs a broker in another account and a well-formed credential', async () => {
  const broker = fakeBroker();
  const verify = (credential) => verifyPrincipalOwner(credential, { paths: { socket: '/s' }, clientFactory: broker.clientFactory });
  await assert.rejects(verify(owner({ brokerUid: process.getuid() })), /broker in this account cannot vouch/);
  await assert.rejects(verify(owner({ mode: 'single-account' })), /broker in this account cannot vouch/);
  for (const bad of [null, owner({ principal: 'agent_x' }), owner({ secret: '' }), owner({ brokerUid: -1 })]) {
    await assert.rejects(verify(bad), /principal credential is invalid/);
  }
  assert.equal(broker.calls.length, 0);
});

test('the CLI reads a presented principal from stdin and refuses an own-account broker without a dialog', (t) => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
  const env = { PATH: process.env.PATH, HOME: f.root, AGENT_BOT_CONFIG: join(f.root, 'no-config.json'), AGENT_BOT_STATE_HOME: f.options.stateDir };
  const run = (input) => spawnSync(process.execPath, [cli, 'soul', 'revision', 'approve', '--principal-stdin', f.id, f.proposal.proposalId, 'r'],
    { encoding: 'utf8', env, cwd: f.root, input });
  let result = run(JSON.stringify(owner({ brokerUid: process.getuid() })));
  assert.equal(result.status, 1); assert.match(result.stderr, /broker in this account cannot vouch/);
  assert.ok(!result.stderr.includes(SECRET));
  result = run('not json');
  assert.equal(result.status, 1); assert.match(result.stderr, /--principal-stdin needs the principal credential/);
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'pending');
});

test('a decision on a soul tool request asks for presence even when a principal verifies (#438)', async () => {
  const broker = fakeBroker();
  const asked = [];
  const verifyPrincipal = (credential) => verifyPrincipalOwner(credential, { paths: { socket: '/broker.sock' }, clientFactory: broker.clientFactory });
  const consent = async (action) => { asked.push(action); return { method: 'presence', via: 'agent-bot-keyd' }; };
  assert.deepEqual(await confirmOwnerPresence('approve Bash for Bill', { principal: owner(), verifyPrincipal, consent }),
    { method: 'presence', via: 'agent-bot-keyd', principal: PRINCIPAL });
  assert.deepEqual(await confirmOwnerPresence('deny Bash for Bill', { verifyPrincipal, consent }),
    { method: 'presence', via: 'agent-bot-keyd' });
  assert.deepEqual(asked, ['approve Bash for Bill', 'deny Bash for Bill']);
  assert.equal(broker.calls.length, 1);

  // A principal that does not verify refuses before anyone is asked; a
  // refused presence refuses even with a verified principal.
  await assert.rejects(confirmOwnerPresence('approve Bash for Bill', { principal: owner({ brokerUid: process.getuid() }), verifyPrincipal, consent }),
    /cannot vouch/);
  assert.equal(asked.length, 2);
  await assert.rejects(confirmOwnerPresence('approve Bash for Bill', {
    principal: owner(), verifyPrincipal, consent: async () => { throw new Error('approve Bash for Bill was not approved: cancelled'); },
  }), /not approved/);
});

test('a worktree binding refuses every owner revision action with stripped env, before any owner proof', async (t) => {
  const f = fixture(t);
  const env = f.options.env;
  const worktree = join(f.root, 'bound');
  mkdirSync(worktree);
  execFileSync('git', ['init', '-q', worktree], { env, stdio: 'ignore' });
  writeFileSync(join(worktree, '.git', 'agent-binding.json'), JSON.stringify({
    v: 1, secret: 's'.repeat(43), account: 'test', daemon: 'http://127.0.0.1:1', agentId: f.id, parent: null,
  }), { mode: 0o600 });
  assert.deepEqual(soulMarkers({ env, cwd: worktree }), ['agent binding']);
  const assertUser = (action, { principal }) => assertOwnerAction(action, {
    env, cwd: worktree, principal,
    verifyPrincipal: () => assert.fail('binding must refuse before principal verification'),
    consent: () => assert.fail('binding must refuse before consent'),
  });
  for (const command of ['approve', 'reject', 'adopt', 'edit']) {
    await assert.rejects(revisionCommand([command, f.id, f.proposal.proposalId, 'Review'], {
      ...f.options, principal: owner(), assertUser,
    }), { code: 'owner-credential-required' });
  }
  const audit = readFileSync(auditFile(f.options), 'utf8');
  const receipts = audit.trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 4);
  assert.ok(receipts.every((r) => r.agentId === f.id && r.decision === 'owner-credential-required'));
  assert.ok(!audit.includes(SECRET) && !audit.includes('s'.repeat(43)));
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'pending');
});

test('unmarked CLI without a credential refuses noninteractive consent and audits without touching keychain', (t) => {
  const f = fixture(t);
  for (const command of ['approve', 'reject', 'adopt', 'edit']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../soul-revisions.mjs', import.meta.url)),
      command, f.id, f.proposal.proposalId, 'Review'], {
      cwd: f.root, env: { ...f.options.env, AGENT_BOT_STATE_HOME: f.options.stateDir }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /owner-credential-required: owner consent requires an interactive terminal/);
  }
  assert.equal(readFileSync(auditFile(f.options), 'utf8').trim().split('\n').length, 4);
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'pending');
});

test('revision edit accepts keyd presence without a terminal and records the proof', async (t) => {
  const f = fixture(t);
  assert.ok(!process.stdin.isTTY && !process.stderr.isTTY);
  const authorization = { method: 'presence', via: 'agent-bot-keyd' };
  const calls = [];
  const record = await revisionCommand(['edit', f.id, f.packagePath, 'Customize', '--json'], {
    ...f.options, presence: async (summary, { env }) => {
      calls.push(summary);
      assert.equal(env.HOME, f.root);
      return authorization;
    },
  });
  assert.deepEqual(record.authorization, authorization);
  assert.deepEqual(revisionHistory(f.id, f.options).at(-1).authorization, authorization);
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(f.id));
});

test('revision edit treats keyd refusal as final, without reaching the terminal-only dialog fallback', async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(revisionCommand(['edit', f.id, f.packagePath, 'Customize'], {
    ...f.options, presence: async () => {
      calls++;
      throw Object.assign(new Error('Touch ID cancelled'), { code: 'owner-declined' });
    },
  }), (error) => error.code === 'owner-credential-required' && /not approved: Touch ID cancelled/.test(error.message)
    && !/interactive terminal/.test(error.message));
  assert.equal(calls, 1);
  assert.equal(revisionHistory(f.id, f.options).length, 1);
});

test('broker errors cannot reflect a credential into owner errors or audit', async (t) => {
  const f = fixture(t);
  const broker = fakeBroker({ fail: { code: SECRET, message: SECRET } });
  await assert.rejects(revisionCommand(['approve', f.id, f.proposal.proposalId, 'Review'], {
    ...f.options, principal: owner(), assertUser: gate({ markers: () => [],
      verifyPrincipal: (credential) => verifyPrincipalOwner(credential, { clientFactory: broker.clientFactory }),
    }),
  }), (error) => error.code === 'owner-credential-required' && !error.message.includes(SECRET));
  assert.ok(!readFileSync(auditFile(f.options), 'utf8').includes(SECRET));
});
