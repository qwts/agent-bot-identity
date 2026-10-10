// `agent-bot sop policy show|activate|deactivate` and the offline launch
// check the daemon wires into its launch handler (#677).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { assertSopGitCommand, checkSopLaunchPolicy, createRunGit, main, policyStateFile, readSopPolicyState } from '../sop.mjs';
import { sopPolicyCheck } from '../readiness.mjs';
import { sopLaunchPolicy } from '../agent-daemon.mjs';
import { createLaunchHandler } from '../daemon-launch.mjs';

const runLocal = createRunGit({ allowProtocols: 'file' });
const rule = (id, harnesses) => ({ id, event: 'before-launch', decision: 'deny', when: { harnesses }, reason: `No ${harnesses.join(', ')} launches here.` });
const policyText = (rules) => `${JSON.stringify({ schemaVersion: 1, rules })}\n`;

function git(dir, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// A real SOP repository on a branch, read through the pinned git boundary.
function fixture(t, policy = policyText([rule('no-codex', ['codex'])])) {
  const home = mkdtempSync(join(tmpdir(), 'sop-policy-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const src = join(home, 'src');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  const commitFile = (name, text, message) => {
    writeFileSync(join(src, name), text);
    git(src, 'add', '.');
    git(src, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', message);
    return git(src, 'rev-parse', 'HEAD');
  };
  const first = policy === null ? commitFile('guide.md', 'guide\n', 'docs') : commitFile('policy-hooks.json', policy, 'policy');
  const bare = join(home, 'bare.git');
  git(home, 'clone', '--bare', '-q', src, bare);
  const advance = (text) => {
    const commit = commitFile('policy-hooks.json', text, 'advance');
    git(src, 'push', '-q', bare, 'main');
    return commit;
  };
  const userPath = join(home, '.config', 'agent-sop', 'config.toml');
  mkdirSync(join(userPath, '..'), { recursive: true });
  const select = (ref = 'main') => writeFileSync(userPath, `schema_version = 1\n[repos]\norg = "local/org@${first}"\nsop = "local/sop@${ref}"\n`);
  select();
  const calls = [];
  const options = {
    home, env: {}, stateDir: join(home, 'state'), account: 'owner',
    remoteUrl: () => bare,
    readOrgText: () => JSON.stringify({
      schema_version: 1, organization: { id: 'local', account: 'local', profile: 'profile.json' },
      sources: { sop: { repo: 'local/sop', ref: first, entry: 'guide.md', summary: 'Docs' } }, capabilities: {},
    }),
    runGit: (args) => { assertSopGitCommand(args); calls.push(args); return runLocal(args); },
    now: () => new Date('2026-10-09T12:00:00.000Z'),
  };
  return { home, first, advance, select, calls, options };
}

async function cli(argv, options) {
  let out = '', err = '';
  const code = await main(argv, { ...options, writeStdout: (text) => { out += text; }, writeStderr: (text) => { err += text; } });
  return { code, out, err };
}

const approve = (seen) => async (action, { principal }) => { seen.push({ action, principal }); return { method: 'presence', via: 'agent-bot-keyd' }; };
const offline = (options) => ({ ...options, runGit: () => assert.fail('the launch check is offline') });

test('the owner activates the SOP policy at its resolved commit; launches read it offline and a moving branch does not change it', async (t) => {
  const f = fixture(t);
  const seen = [];
  const activated = await cli(['policy', 'activate'], { ...f.options, assertOwner: approve(seen) });
  assert.equal(activated.code, 0, activated.err);
  assert.deepEqual(seen, [{ action: `sop policy activate local/sop@${f.first}`, principal: null }], 'the owner approves the concrete commit');
  assert.ok(f.calls.some((args) => args.at(-1) === 'FETCH_HEAD:policy-hooks.json'));
  assert.match(activated.out, new RegExp(`^SOP policy active: local/sop@${f.first}\n`));
  assert.match(activated.out, /no-codex: before-launch deny codex: No codex launches here\./);
  assert.match(activated.out, /Covers before-launch: package launch, relaunch, team start\.\nNot covered: wake\/resume/);

  const marker = JSON.parse(readFileSync(policyStateFile(f.options), 'utf8'));
  assert.equal(statSync(policyStateFile(f.options)).mode & 0o777, 0o600);
  assert.deepEqual({ active: marker.active, sop: marker.sop, account: marker.account, authorization: marker.authorization, changedAt: marker.changedAt },
    { active: true, sop: { repository: 'local/sop', commit: f.first }, account: 'owner', authorization: 'presence', changedAt: '2026-10-09T12:00:00.000Z' });
  assert.ok(!JSON.stringify(marker).includes('principal'), 'no principal material is recorded');

  const denied = checkSopLaunchPolicy('codex', offline(f.options));
  assert.equal(denied.code, 'policy-denied');
  assert.equal(denied.ruleId, 'no-codex');
  assert.match(denied.message, new RegExp(`no-codex \\(local/sop@${f.first.slice(0, 12)}\\) denies launching on codex`));
  assert.equal(checkSopLaunchPolicy('claude', offline(f.options)), null, 'no match continues to the product checks');

  // The branch advances upstream: the activated commit stays pinned until the owner reactivates.
  const second = f.advance(policyText([rule('no-claude', ['claude'])]));
  assert.equal(checkSopLaunchPolicy('claude', offline(f.options)), null);
  assert.equal(readSopPolicyState(offline(f.options)).sop.commit, f.first);
  assert.equal((await cli(['policy', 'activate'], { ...f.options, assertOwner: approve(seen) })).code, 0);
  assert.equal(readSopPolicyState(f.options).sop.commit, second);
  assert.equal(checkSopLaunchPolicy('claude', f.options).ruleId, 'no-claude');
  assert.equal(checkSopLaunchPolicy('codex', f.options), null);

  const json = JSON.parse((await cli(['policy', 'show', '--json'], offline(f.options))).out);
  assert.equal(json.state, 'active');
  assert.match(json.coverage.notCovered, /wake\/resume/);
});

test('a refused owner gate activates or deactivates nothing', async (t) => {
  const f = fixture(t);
  const refuse = async () => { throw Object.assign(new Error('sop policy activate is owner only; this caller has a soul\'s Agent ID'), { code: 'owner-credential-required' }); };
  const refused = await cli(['policy', 'activate'], { ...f.options, assertOwner: refuse });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /owner only/);
  assert.equal(existsSync(policyStateFile(f.options)), false);
  assert.equal(readSopPolicyState(f.options).state, 'none');
  assert.equal(checkSopLaunchPolicy('codex', f.options), null);

  assert.equal((await cli(['policy', 'activate'], { ...f.options, assertOwner: approve([]) })).code, 0);
  const before = readFileSync(policyStateFile(f.options), 'utf8');
  assert.equal((await cli(['policy', 'deactivate'], { ...f.options, assertOwner: refuse })).code, 1);
  assert.equal(readFileSync(policyStateFile(f.options), 'utf8'), before);
  assert.equal(checkSopLaunchPolicy('codex', f.options).code, 'policy-denied');

  // A principal on stdin is handed to the gate, never written anywhere.
  const seen = [];
  const principal = { principalId: 'principal_x', secret: 'not-recorded' };
  const off = await cli(['policy', 'deactivate', '--principal-stdin'], { ...f.options, readStdin: () => JSON.stringify(principal), assertOwner: approve(seen) });
  assert.equal(off.code, 0, off.err);
  assert.deepEqual(seen, [{ action: 'sop policy deactivate', principal }]);
  const marker = readFileSync(policyStateFile(f.options), 'utf8');
  assert.ok(!marker.includes('not-recorded'));
  assert.equal(JSON.parse(marker).active, false, 'the deactivation is kept as a receipt');
  assert.equal(readSopPolicyState(f.options).state, 'inactive');
  assert.equal(checkSopLaunchPolicy('codex', f.options), null);
});

test('an active marker that cannot be honoured is unavailable, never off', async (t) => {
  const f = fixture(t);
  assert.equal((await cli(['policy', 'activate'], { ...f.options, assertOwner: approve([]) })).code, 0);
  const records = join(f.options.stateDir, 'sop-policy', 'records');
  const [record] = readdirSync(records);

  // A changed local selection requires reactivation.
  f.select(f.first);
  assert.equal(checkSopLaunchPolicy('claude', f.options).code, 'policy-unavailable');
  assert.match(readSopPolicyState(f.options).message, /selection changed.*agent-bot sop policy activate/);
  f.select();
  assert.equal(checkSopLaunchPolicy('claude', f.options), null);

  // Tampered or missing payload behind an active marker.
  writeFileSync(join(records, record), JSON.stringify({ schemaVersion: 1, digest: record.slice(0, 64), policy: policyText([]) }));
  assert.equal(checkSopLaunchPolicy('codex', f.options).code, 'policy-unavailable');
  rmSync(join(records, record));
  assert.equal(checkSopLaunchPolicy('codex', f.options).code, 'policy-unavailable');
  const shown = await cli(['policy', 'show'], f.options);
  assert.equal(shown.code, 1);
  assert.match(shown.out, /record is missing.*deactivate/);

  // Another account's marker, and a corrupt marker.
  assert.equal(checkSopLaunchPolicy('codex', { ...f.options, account: 'someone-else' }).code, 'policy-unavailable');
  writeFileSync(policyStateFile(f.options), '{');
  assert.equal(checkSopLaunchPolicy('codex', f.options).code, 'policy-unavailable');
});

test('activation refuses a commit without the policy file or with an unsupported event, keeping the previous state', async (t) => {
  const f = fixture(t, null);
  const missing = await cli(['policy', 'activate'], { ...f.options, assertOwner: () => assert.fail('nothing to approve') });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /has no policy-hooks\.json; nothing was activated/);
  assert.equal(readSopPolicyState(f.options).state, 'none');

  f.advance(policyText([rule('no-codex', ['codex'])]));
  assert.equal((await cli(['policy', 'activate'], { ...f.options, assertOwner: approve([]) })).code, 0);
  const before = readFileSync(policyStateFile(f.options), 'utf8');
  f.advance(policyText([{ ...rule('push', ['codex']), event: 'before-push' }]));
  const unsupported = await cli(['policy', 'activate'], { ...f.options, assertOwner: () => assert.fail('nothing to approve') });
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.err, /supports only before-launch/);
  assert.equal(readFileSync(policyStateFile(f.options), 'utf8'), before);
});

test('sop policy takes only the user selection and its own flags', async () => {
  for (const argv of [['policy'], ['policy', 'refresh'], ['policy', 'show', '--principal-stdin'], ['policy', 'activate', '--soul', 'x'],
    ['policy', 'activate', '--config', '/tmp/x'], ['policy', 'activate', '--json', '--json']]) {
    const result = await cli(argv, {});
    assert.equal(result.code, 2, argv.join(' '));
  }
});

test('the marker and record are read safely and validated completely before enforcement turns off', async (t) => {
  const f = fixture(t);
  const file = policyStateFile(f.options);
  const records = join(f.options.stateDir, 'sop-policy', 'records');

  // An interrupted first activation (record published, marker never swapped) is not "never configured".
  mkdirSync(records, { recursive: true });
  assert.equal(checkSopLaunchPolicy('codex', f.options).code, 'policy-unavailable');
  assert.match(readSopPolicyState(f.options).message, /interrupted activation/);
  rmSync(join(f.options.stateDir, 'sop-policy'), { recursive: true });
  assert.equal(readSopPolicyState(f.options).state, 'none');

  assert.equal((await cli(['policy', 'activate'], { ...f.options, assertOwner: approve([]) })).code, 0);
  const marker = JSON.parse(readFileSync(file, 'utf8'));
  const [record] = readdirSync(records);
  const envelope = JSON.parse(readFileSync(join(records, record), 'utf8'));

  // A partial or inconsistent deactivation never turns the policy off.
  for (const forged of [{ schemaVersion: 1, active: false, changedAt: 'x' },
    { ...marker, active: false }, { ...marker, active: false, digest: null, org: null, sop: null, selection: null, account: 'someone-else' }]) {
    writeFileSync(file, JSON.stringify(forged));
    assert.equal(readSopPolicyState(f.options).state, 'unavailable', JSON.stringify(forged));
  }
  writeFileSync(file, JSON.stringify(marker));
  assert.equal(readSopPolicyState(f.options).state, 'active');

  // The record envelope's schema and fields are checked before the policy is parsed.
  for (const forged of [{ ...envelope, schemaVersion: 2 }, { digest: envelope.digest, policy: envelope.policy }, { ...envelope, run: 'x' }]) {
    writeFileSync(join(records, record), JSON.stringify(forged));
    assert.match(readSopPolicyState(f.options).message, /unsupported format/);
  }
  writeFileSync(join(records, record), JSON.stringify(envelope));

  // A FIFO never blocks the launch path, and an oversized file is not read.
  rmSync(file);
  assert.equal(spawnSync('mkfifo', [file]).status, 0);
  assert.equal(checkSopLaunchPolicy('codex', f.options).code, 'policy-unavailable');
  rmSync(file);
  writeFileSync(file, ' '.repeat(32 * 1024));
  assert.equal(checkSopLaunchPolicy('codex', f.options).code, 'policy-unavailable');
});

test('doctor reports the SOP policy state read-only: none, active at its pinned commit, unavailable, deactivated', async (t) => {
  const f = fixture(t);
  const doctor = () => sopPolicyCheck({ home: f.home, env: {}, read: (o) => readSopPolicyState(offline({ ...f.options, ...o })) });
  const none = doctor();
  assert.deepEqual([none.status, none.evidence], ['ready', { state: 'none' }]);
  assert.equal(existsSync(join(f.home, 'state', 'sop-policy')), false, 'doctor writes nothing');

  assert.equal((await cli(['policy', 'activate'], { ...f.options, assertOwner: approve([]) })).code, 0);
  const active = doctor();
  assert.equal(active.status, 'ready');
  assert.equal(active.message, `SOP policy active: local/sop@${f.first} (1 rule)`);
  assert.deepEqual({ state: active.evidence.state, sop: active.evidence.sop, rules: active.evidence.rules },
    { state: 'active', sop: { repository: 'local/sop', commit: f.first }, rules: 1 });

  const marker = readFileSync(policyStateFile(f.options), 'utf8');
  writeFileSync(policyStateFile(f.options), '{ corrupt');
  const unavailable = doctor();
  assert.deepEqual([unavailable.status, unavailable.code, unavailable.evidence.state], ['warning', 'sop-policy-unavailable', 'unavailable']);
  assert.match(unavailable.action, /agent-bot sop policy (activate|deactivate)/);
  assert.equal(readFileSync(policyStateFile(f.options), 'utf8'), '{ corrupt', 'doctor never repairs the marker');
  writeFileSync(policyStateFile(f.options), marker);

  assert.equal((await cli(['policy', 'deactivate'], { ...f.options, assertOwner: approve([]) })).code, 0);
  const inactive = doctor();
  assert.deepEqual([inactive.status, inactive.evidence.state], ['ready', 'inactive']);
  assert.match(inactive.message, /deactivated by the owner at 2026-10-09T12:00:00\.000Z/);
});

// The port runDaemon hands its launch handler, over the real state the owner
// activated: the daemon's own env and home, no git, and real audit receipts.
test('the daemon\'s launch policy port reads the activated policy, asks the owner to override and receipts each outcome', async (t) => {
  const f = fixture(t);
  const env = { AGENT_BOT_STATE_HOME: join(f.home, 'state'), AGENT_BOT_INTERACTION_HOME: join(f.home, 'interaction') };
  const options = { ...f.options, env, account: userInfo().username };
  const asked = [];
  const port = sopLaunchPolicy({ env, home: f.home, now: () => new Date('2026-10-09T13:00:00.000Z'),
    confirm: async (action, context) => { asked.push({ action, env: context.env }); throw new Error('declined'); } });
  assert.equal(port.check({ harness: 'codex' }), null, 'never configured: no policy work');

  assert.equal((await cli(['policy', 'activate'], { ...options, assertOwner: approve([]) })).code, 0);
  const denied = port.check({ harness: 'codex' });
  assert.equal(denied.code, 'policy-denied');
  assert.equal(denied.ruleId, 'no-codex');
  assert.equal(port.check({ harness: 'claude' }), null);
  await assert.rejects(port.override(denied, { harness: 'codex' }), /declined/);
  assert.deepEqual(asked, [{ action: 'launch on codex although SOP policy rule no-codex denies it', env }]);
  port.receipt({ agentId: null, decision: 'override-declined', detail: 'rule no-codex' });
  const audit = readFileSync(join(f.home, 'interaction', 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(audit.map(({ event, operation, decision }) => ({ event, operation, decision })),
    [{ event: 'sop-policy', operation: 'launch', decision: 'override-declined' }]);

  // The real handler with this port: a declined override launches nothing.
  const side = { identities: 0, spawn: 0, provision: 0, executor: 0 };
  const reports = [];
  const handler = createLaunchHandler({ file: join(f.home, 'launch-requests.json'),
    identities: () => { side.identities++; return { id: 'agent_11111111-1111-4111-8111-111111111111', harness: 'codex' }; },
    spawnPackage: () => { side.spawn++; return null; }, lookupBinding: () => null,
    provisionHome: () => { side.provision++; return null; }, executorFor: () => { side.executor++; return async () => {}; }, policy: port });
  await handler({ event: 'launch', requestId: 'r1', principal: 'p1', account: 'worker', package: '/pkg', harness: 'codex', name: 'Helper' },
    { account: 'worker', report: async (row) => { reports.push(row); } });
  assert.deepEqual(side, { identities: 0, spawn: 0, provision: 0, executor: 0 });
  assert.equal(reports[0].code, 'policy-denied');
  assert.equal(asked.length, 2);

  // A marker it cannot honour is unavailable, and the owner is asked about that instead.
  rmSync(policyStateFile(options));
  const unavailable = port.check({ harness: 'claude' });
  assert.equal(unavailable.code, 'policy-unavailable');
  await assert.rejects(port.override(unavailable, { harness: 'claude' }), /declined/);
  assert.equal(asked.at(-1).action, 'launch on claude although the active SOP policy is unavailable');
});

// runDaemon builds one launch handler, and every launch route reaches it:
// the broker's principal launches and relaunches (comms) and a soul's team
// start (teamStarter -> onLaunch). That handler holds the policy port.
test('runDaemon composes its only launch handler with the SOP launch policy port', () => {
  const source = readFileSync(new URL('../agent-daemon.mjs', import.meta.url), 'utf8');
  const handlers = [...source.matchAll(/createLaunchHandler\(\{/g)];
  assert.equal(handlers.length, 1, 'one launch handler');
  const body = source.slice(handlers[0].index, source.indexOf('\n  });', handlers[0].index));
  assert.match(body, /\n    policy: sopLaunchPolicy\(\{ env, home, now \}\),\n/);
  assert.match(source, /onLaunch\(request, \{ account, parent,/, 'a team start goes through the same handler');
});
