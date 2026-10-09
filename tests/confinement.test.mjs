import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allowedRoots, checkWrite, confinementCheck, confinementCommand, confinementMode, confinementReport, setConfinementMode } from '../confinement.mjs';
import { registerSoulDir, showSoul, upsertSoul } from '../agent-population.mjs';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { computePackageRevision } from '../soul-package.mjs';
import { adoptSoulPackage, decideSoulProposal, editSoulRevision, proposeSoulRevision } from '../soul-revisions.mjs';
import { normalizeEnvelope, encodeContext } from '../hook-dialects.mjs';
import { runHooks } from '../agent-hook.mjs';
const id = 'agent_33333333-3333-4333-8333-333333333333';
function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'confinement-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: path.join(home, 'tmp'), AGENT_BOT_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json'), AGENT_BOT_CONFIG: path.join(home, 'config.json'), AGENT_BOT_ID: id };
  writeFileSync(env.AGENT_BOT_CONFIG, '{}');
  const opts = { env, home, cwd: home, file: env.AGENT_BOT_POPULATION_PATH, config: {} };
  const soul = path.join(env.AGENT_BOT_SOULS_HOME, 'test.soul');
  mkdirSync(path.join(soul, '.soul-state'), { recursive: true });
  writeFileSync(path.join(soul, '.soul-state', 'agent-id'), id);
  upsertSoul({ id, name: 'test', status: 'active', spacePath: path.join(home, 'space') }, opts);
  registerSoulDir(id, soul, opts);
  const envelope = (target, tool = 'Write', harness = 'claude', event = 'pre-tool-use') => normalizeEnvelope({ dialectKey: harness, event, payload: { cwd: home, tool_name: tool, tool_input: { file_path: target } } });
  return { home, soul, opts, envelope, log: path.join(soul, '.soul-state', 'confinement.log') };
}
const owner = async () => ({ method: 'consent' });
function adoptPolicy(home, policy, opts) {
  const stateDir = opts.env.AGENT_BOT_STATE_HOME;
  const revisionOpts = { ...opts, stateDir };
  mintAgentIdentity({ ...revisionOpts, idFactory: () => id, useGithub: false });
  const packagePath = path.join(home, 'approved.soul');
  mkdirSync(packagePath);
  const manifest = { formatVersion: 1, name: 'Test', description: 'Test soul', displaySeed: 'test',
    preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(path.join(packagePath, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(path.join(packagePath, 'AGENTS.md'), 'Instructions');
  writeFileSync(path.join(packagePath, 'policy.json'), JSON.stringify(policy));
  manifest.revision = computePackageRevision(packagePath);
  writeFileSync(path.join(packagePath, 'soul.json'), JSON.stringify(manifest));
  adoptSoulPackage(id, packagePath, revisionOpts);
  return { packagePath, revisionOpts };
}
test('real containment handles new files, prefix trap, symlink escapes and symlink/..', (t) => {
  const { home, soul, opts } = fixture(t);
  assert.equal(checkWrite(id, path.join(soul, 'new', 'file'), opts).inside, true);
  assert.equal(checkWrite(id, path.join(`${soul}other`, 'file'), opts).inside, false);
  const outside = path.join(home, 'outside'); mkdirSync(outside);
  symlinkSync(outside, path.join(soul, 'escape'));
  assert.equal(checkWrite(id, path.join(soul, 'escape', 'new'), opts).inside, false);
  assert.equal(checkWrite(id, `${soul}/escape/../new`, opts).path, path.join(home, 'new'));
  symlinkSync(path.join(outside, 'missing'), path.join(soul, 'dangling'));
  assert.throws(() => checkWrite(id, path.join(soul, 'dangling', 'new'), opts));
});
test('only census and fallback worktree links grant external roots; dangling links are ignored', async (t) => {
  const { home, soul, opts } = fixture(t);
  const external = path.join(home, 'external'); mkdirSync(external);
  mkdirSync(path.join(soul, 'worktrees')); symlinkSync(external, path.join(soul, 'worktrees', 'linked'));
  assert.equal(checkWrite(id, path.join(external, 'new'), opts).inside, false);
  // Census paths are canonicalized too, including the legacy singular field.
  const alias = path.join(home, 'checkout-alias'); symlinkSync(external, alias);
  upsertSoul({ ...showSoul(id, opts), worktrees: [alias] }, opts);
  assert.equal(checkWrite(id, path.join(external, 'new'), opts).inside, true);
  const legacy = path.join(home, 'legacy'); mkdirSync(legacy);
  upsertSoul({ ...showSoul(id, opts), worktree: legacy }, opts);
  symlinkSync(legacy, path.join(soul, 'worktrees', 'legacy'));
  assert.equal(checkWrite(id, path.join(legacy, 'new'), opts).inside, true);
  const fallback = path.join(opts.env.TMPDIR, 'agent-bot', id, 'checkout'); mkdirSync(fallback, { recursive: true });
  symlinkSync(fallback, path.join(soul, 'worktrees', 'fallback'));
  assert.equal(checkWrite(id, path.join(opts.env.TMPDIR, 'agent-bot', id, 'new'), opts).inside, true);
  assert.equal(checkWrite(id, path.join(fallback, 'new'), opts).inside, true);
  const local = path.join(soul, 'worktrees', 'local'); mkdirSync(local);
  assert.ok(allowedRoots(id, opts).includes(realpathSync(local)));
  symlinkSync(home, path.join(soul, 'worktrees', 'home'));
  symlinkSync(path.join(home, 'missing'), path.join(soul, 'worktrees', 'dangling'));
  assert.doesNotThrow(() => allowedRoots(id, opts));
  assert.equal(checkWrite(id, path.join(home, 'unauthorized'), opts).inside, false);
  await setConfinementMode(id, 'deny', { ...opts, gate: owner });
  assert.equal(confinementCheck({ harness: 'claude', event: 'pre-tool-use', tool_name: 'Write', file_path: path.join(home, 'unauthorized') }, opts).decision, 'deny');
});
test('a symlinked worktrees container cannot grant outside directories', (t) => {
  const { home, soul, opts } = fixture(t);
  mkdirSync(path.join(home, 'outside'));
  symlinkSync(home, path.join(soul, 'worktrees'));
  assert.equal(checkWrite(id, path.join(home, 'outside', 'new'), opts).inside, false);
});
test('a planted or foreign temp fallback grants nothing', (t) => {
  const { home, opts } = fixture(t);
  mkdirSync(path.join(home, 'outside'));
  mkdirSync(path.join(opts.env.TMPDIR, 'agent-bot'), { recursive: true });
  symlinkSync(path.join(home, 'outside'), path.join(opts.env.TMPDIR, 'agent-bot', id));
  assert.equal(checkWrite(id, path.join(home, 'outside', 'new'), opts).inside, false);
  rmSync(path.join(opts.env.TMPDIR, 'agent-bot', id));
  rmSync(path.join(opts.env.TMPDIR, 'agent-bot'), { recursive: true });
  symlinkSync(home, path.join(opts.env.TMPDIR, 'agent-bot'));
  mkdirSync(path.join(home, id));
  assert.equal(checkWrite(id, path.join(home, id, 'new'), opts).inside, false);
  rmSync(path.join(opts.env.TMPDIR, 'agent-bot'));
  mkdirSync(path.join(opts.env.TMPDIR, 'agent-bot', id), { recursive: true });
  assert.equal(checkWrite(id, path.join(opts.env.TMPDIR, 'agent-bot', id, 'new'), opts).inside, true);
  assert.equal(checkWrite(id, path.join(opts.env.TMPDIR, 'agent-bot', id, 'new'), { ...opts, uid: process.getuid() + 1 }).inside, false);
});
test('binding files are never territory, even inside the bound checkout', async (t) => {
  const { home, soul, opts, envelope } = fixture(t);
  const bound = path.join(home, 'bound'); mkdirSync(path.join(bound, '.git', 'agent-bindings'), { recursive: true });
  const bindingOpts = { ...opts, binding: { agentId: id }, boundCheckout: bound };
  assert.equal(checkWrite(id, path.join(bound, 'new'), bindingOpts).inside, true);
  for (const file of [path.join(bound, '.git', 'agent-binding.json'), path.join(bound, '.git', 'agent-bindings', `${id}.json`), path.join(soul, 'agent-binding.json')]) {
    assert.equal(checkWrite(id, file, bindingOpts).inside, false);
  }
  const custom = path.join(bound, 'custom-binding');
  assert.equal(checkWrite(id, custom, { ...bindingOpts, env: { ...opts.env, AGENT_BOT_BINDING: custom } }).inside, false);
  await setConfinementMode(id, 'deny', { ...opts, gate: owner });
  assert.equal(confinementCheck(envelope(path.join(soul, 'agent-binding.json')), opts).decision, 'deny');
});
test('bound checkout must match the recorded worktree when present', (t) => {
  const { home, opts } = fixture(t);
  const bound = path.join(home, 'bound'); mkdirSync(bound);
  assert.equal(checkWrite(id, path.join(bound, 'new'), { ...opts, binding: { agentId: id }, boundCheckout: bound }).inside, true);
  assert.equal(checkWrite(id, path.join(bound, 'new'), opts).inside, false);
  const alias = path.join(home, 'bound-alias'); symlinkSync(bound, alias);
  for (const worktree of [bound, alias]) assert.equal(checkWrite(id, path.join(bound, 'new'), { ...opts, binding: { agentId: id, worktree }, boundCheckout: bound }).inside, true);
  for (const worktree of [home, path.join(home, 'missing')]) assert.equal(checkWrite(id, path.join(bound, 'new'), { ...opts, binding: { agentId: id, worktree }, boundCheckout: bound }).inside, false);
  assert.equal(checkWrite(id, path.join(bound, 'new'), { ...opts, binding: { agentId: 'agent_44444444-4444-4444-8444-444444444444', worktree: bound }, boundCheckout: bound }).inside, false);
});
test('policy grants come only from the approved head, never the working policy or pending proposals', async (t) => {
  const { home, soul, opts } = fixture(t);
  const grant = path.join(home, 'grant');
  writeFileSync(path.join(soul, 'policy.json'), JSON.stringify({ confinement: { writablePaths: [grant] } }));
  assert.equal(checkWrite(id, path.join(grant, 'new'), opts).inside, false, 'unadopted soul has no grants');
  const { packagePath, revisionOpts } = adoptPolicy(home, { mode: 'ask', confinement: { writablePaths: [grant] } }, opts);
  assert.equal(checkWrite(id, path.join(grant, 'new'), opts).inside, true);
  const unreviewed = path.join(home, 'unreviewed');
  writeFileSync(path.join(soul, 'policy.json'), JSON.stringify({ confinement: { writablePaths: [unreviewed] } }));
  assert.equal(checkWrite(id, path.join(unreviewed, 'new'), opts).inside, false);
  assert.equal(checkWrite(id, path.join(grant, 'new'), opts).inside, true);
  writeFileSync(path.join(soul, 'policy.json'), '{malformed working copy');
  assert.equal(checkWrite(id, path.join(grant, 'new'), opts).inside, true);
  writeFileSync(path.join(packagePath, 'policy.json'), JSON.stringify({ mode: 'ask', confinement: { writablePaths: [unreviewed] } }));
  const proposal = proposeSoulRevision(id, packagePath, { ...revisionOpts, reason: 'Request grant' });
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.requiresUser, true);
  assert.equal(checkWrite(id, path.join(unreviewed, 'new'), opts).inside, false);
  decideSoulProposal(id, proposal.proposalId, 'approve', { ...revisionOpts, reason: 'Owner approved' });
  assert.equal(checkWrite(id, path.join(unreviewed, 'new'), opts).inside, true);
  assert.equal(checkWrite(id, path.join(grant, 'new'), opts).inside, false, 'superseded head grants no longer apply');
});
test('invalid grants in the approved head fail closed', async (t) => {
  const { home, opts } = fixture(t);
  const { packagePath, revisionOpts } = adoptPolicy(home, {}, opts);
  for (const invalid of ['relative', '~/grant', 42]) {
    writeFileSync(path.join(packagePath, 'policy.json'), JSON.stringify({ confinement: { writablePaths: [invalid] } }));
    await editSoulRevision(id, packagePath, { ...revisionOpts, reason: 'Invalid grant' });
    assert.throws(() => allowedRoots(id, opts), /absolute/);
  }
  writeFileSync(path.join(packagePath, 'policy.json'), JSON.stringify({ confinement: { writablePaths: home } }));
  await editSoulRevision(id, packagePath, { ...revisionOpts, reason: 'Invalid grants array' });
  assert.throws(() => allowedRoots(id, opts), /array/);
});
test('default warn logs metadata privately and allows, with Claude context', (t) => {
  const { home, soul, opts, envelope, log } = fixture(t);
  const result = confinementCheck(envelope(path.join(home, 'outside')), opts);
  assert.equal(confinementMode(id, opts), 'warn');
  assert.equal(result.decision, 'allow'); assert.match(result.context, /warning/);
  assert.match(encodeContext({ dialectKey: 'claude', event: 'pre-tool-use', contexts: [result.context] }).stdout, /additionalContext/);
  const row = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(Object.keys(row).sort(), ['agentId', 'harness', 'path', 'roots', 'tool', 'ts']);
  assert.equal(row.agentId, id); assert.equal(row.path, path.join(home, 'outside'));
  assert.equal(statSync(log).mode & 0o777, 0o600);
  confinementCheck(envelope(path.join(soul, 'new')), opts);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
});
test('deny refuses outside and check errors; off is silent', async (t) => {
  const { home, soul, opts, envelope, log } = fixture(t);
  await setConfinementMode(id, 'deny', { ...opts, gate: owner });
  assert.equal(statSync(path.join(opts.env.AGENT_BOT_STATE_HOME, 'confinement.json')).mode & 0o777, 0o600);
  assert.equal(confinementCheck(envelope(path.join(home, 'outside')), opts).decision, 'deny');
  assert.equal(confinementCheck(envelope(path.join(soul, 'new')), opts).decision, 'allow');
  symlinkSync(path.join(home, 'missing'), path.join(soul, 'dangling'));
  const denied = confinementCheck(envelope(path.join(soul, 'dangling', 'SECRET')), opts);
  assert.equal(denied.decision, 'deny'); assert.doesNotMatch(denied.reason, /SECRET/);
  await setConfinementMode(id, 'off', { ...opts, gate: owner });
  assert.deepEqual(confinementCheck(envelope(path.join(home, 'outside')), opts), { decision: 'allow' });
  assert.equal(existsSync(log), false);
});
test('warn check and logging errors allow without leaking file contents', (t) => {
  const { home, soul, opts, envelope, log } = fixture(t);
  mkdirSync(log);
  assert.deepEqual(confinementCheck(envelope(path.join(home, 'outside')), opts), { decision: 'allow' });
  writeFileSync(path.join(soul, 'policy.json'), '{SECRET');
  assert.deepEqual(confinementCheck(envelope(path.join(home, 'outside')), opts), { decision: 'allow' });
});
test('warn never follows a symlinked report file', (t) => {
  const { home, opts, envelope, log } = fixture(t);
  const elsewhere = path.join(home, 'private');
  writeFileSync(elsewhere, 'untouched');
  symlinkSync(elsewhere, log);
  assert.deepEqual(confinementCheck(envelope(path.join(home, 'outside')), opts), { decision: 'allow' });
  assert.equal(readFileSync(elsewhere, 'utf8'), 'untouched');
});
test('current binding allows its checkout root from a subdirectory in the real runner', async (t) => {
  const { home, opts } = fixture(t);
  const checkout = path.join(home, 'checkout');
  mkdirSync(path.join(checkout, 'subdir'), { recursive: true });
  execFileSync('git', ['init', '-q', checkout], { env: opts.env });
  const binding = path.join(home, 'binding.json');
  const record = { v: 1, agentId: id, worktree: checkout, parent: null, account: 'test', daemon: 'http://127.0.0.1:1234', secret: 's'.repeat(43) };
  writeFileSync(binding, JSON.stringify(record), { mode: 0o600 });
  const env = { ...opts.env, AGENT_BOT_ID: undefined, AGENT_BOT_BINDING: binding };
  const cwd = path.join(checkout, 'subdir');
  assert.equal(checkWrite(id, path.join(checkout, 'new'), { ...opts, env, cwd }).inside, true);
  await setConfinementMode(id, 'deny', { ...opts, gate: owner });
  const payload = { cwd, tool_name: 'Edit', tool_input: { path: '../new' } };
  assert.equal(runHooks({ dialectKey: 'claude', event: 'pre-tool-use', payload, dir: path.join(home, 'hooks'), env }).decision, 'allow');
  writeFileSync(binding, JSON.stringify({ ...record, worktree: home }), { mode: 0o600 });
  assert.equal(checkWrite(id, path.join(checkout, 'new'), { ...opts, env, cwd }).inside, false);
  assert.equal(runHooks({ dialectKey: 'claude', event: 'pre-tool-use', payload, dir: path.join(home, 'hooks'), env }).decision, 'deny');
});
test('no soul, reads, shell, MCP and post events stay silent', (t) => {
  const { home, opts, envelope, log } = fixture(t);
  assert.deepEqual(confinementCheck(envelope(path.join(home, 'outside')), { ...opts, env: { ...opts.env, AGENT_BOT_ID: undefined } }), { decision: 'allow' });
  for (const tool of ['Read', 'Bash', 'mcp__write']) assert.deepEqual(confinementCheck(envelope(path.join(home, 'outside'), tool), opts), { decision: 'allow' });
  assert.deepEqual(confinementCheck(envelope(path.join(home, 'outside'), 'Write', 'claude', 'post-tool-use'), opts), { decision: 'allow' });
  assert.equal(existsSync(log), false);
});
test('mode changes require owner gate before any state mutation', async (t) => {
  const { opts } = fixture(t);
  for (const mode of ['off', 'warn', 'deny']) await assert.rejects(setConfinementMode(id, mode, { ...opts, gate: async () => { throw new Error('refusing owner gate'); } }), /refusing/);
  assert.equal(existsSync(path.join(opts.env.AGENT_BOT_STATE_HOME, 'confinement.json')), false);
  await assert.rejects(setConfinementMode(id, 'off', opts), /owner only/);
});
test('report groups directory prefixes and handles malformed records; CLI supports JSON and principal forwarding', async (t) => {
  const { home, opts, envelope, log } = fixture(t);
  for (const target of ['other/a', 'other/b', 'else/c']) confinementCheck(envelope(path.join(home, target)), opts);
  writeFileSync(log, `${readFileSync(log, 'utf8')}bad json\n`, { mode: 0o600 });
  const report = confinementReport(id, opts);
  assert.equal(report.total, 3); assert.equal(report.invalid, 1);
  assert.equal(report.prefixes.find((row) => row.prefix === path.join(home, 'other')).count, 2);
  let output;
  await confinementCommand(['confinement-report', id, '--json'], { ...opts, write: (text) => { output = text; } });
  assert.deepEqual(JSON.parse(output), report);
  await confinementCommand(['confinement', id, 'off', '--principal-stdin'], { ...opts, readStdin: () => '{"principal":"presented"}', gate: async (_action, { principal }) => { assert.equal(principal.principal, 'presented'); }, write: () => {} });
  assert.equal(confinementMode(id, opts), 'off');
});
test('normalized notebook and other dialect file tools are covered; adapter duplicate is silent', (t) => {
  const { home, opts, envelope, log } = fixture(t);
  const notebook = normalizeEnvelope({ dialectKey: 'claude', event: 'pre-tool-use', payload: { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(home, 'book') } } });
  confinementCheck(notebook, opts);
  for (const harness of ['codex', 'cursor', 'copilot']) confinementCheck(envelope(path.join(home, harness), harness === 'copilot' ? 'create' : 'Edit', harness), opts);
  confinementCheck(envelope(path.join(home, 'legacy'), null, 'devin-desktop', 'pre-file-write'), opts);
  confinementCheck(envelope(path.join(home, 'duplicate'), 'Write', 'claude', 'pre-file-write'), opts);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 5);
});
test('built-in runs in the real chain and keeps external hook denials', async (t) => {
  const { home, opts, log } = fixture(t);
  const dir = path.join(home, 'hooks'); mkdirSync(path.join(dir, 'pre-tool-use'), { recursive: true });
  const payload = { cwd: home, tool_name: 'Write', tool_input: { file_path: path.join(home, 'outside'), content: 'SECRET' } };
  assert.equal(runHooks({ dialectKey: 'claude', event: 'pre-tool-use', payload, dir, env: opts.env }).decision, 'allow');
  assert.doesNotMatch(readFileSync(log, 'utf8'), /SECRET/);
  writeFileSync(path.join(dir, 'pre-tool-use', 'deny'), '#!/bin/sh\necho other-guard >&2\nexit 2\n', { mode: 0o700 });
  assert.match(runHooks({ dialectKey: 'claude', event: 'pre-tool-use', payload, dir, env: opts.env }).reason, /other-guard/);
  await setConfinementMode(id, 'deny', { ...opts, gate: owner });
  assert.match(runHooks({ dialectKey: 'claude', event: 'pre-tool-use', payload, dir, env: opts.env }).reason, /confinement/);
  const cli = spawnSync(process.execPath, ['agent-bot.mjs', 'soul', 'confinement-report', id, '--json'], { env: opts.env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).total, 2);
});


test('skill library metadata stays outside soul write territory even with confinement off', async t => {
  const f = fixture(t), library = path.join(f.soul, 'library');
  f.opts.env.AGENT_BOT_SKILLS_HOME = library;
  const uuid = '11111111-1111-4111-8111-111111111111';
  const record = path.join(library, uuid);
  mkdirSync(record, { recursive: true });
  const alias = path.join(f.soul, 'library-alias'); symlinkSync(library, alias);
  await setConfinementMode(id, 'off', { ...f.opts, gate: owner });
  for (const root of [library, alias]) for (const relative of ['', uuid, `${uuid}/manifest.json`, `${uuid}/.snapshots/digest/payload/SKILL.md`, `${uuid}/.checks/result.json`, `${uuid}/.updates/update/previous/SKILL.md`, `${uuid}/.pending-update.json`]) {
    const target = path.join(root, relative);
    assert.equal(checkWrite(id, target, f.opts).inside, false);
    assert.equal(confinementCheck(f.envelope(target), f.opts).decision, 'deny');
  }
  const payload = path.join(record, 'demo/SKILL.md');
  assert.equal(checkWrite(id, payload, f.opts).inside, true);
  assert.equal(confinementCheck(f.envelope(payload), f.opts).decision, 'allow');
});


test('invalid skill root keeps normal confinement and still protects default metadata', async t => {
  const f = fixture(t), file = path.join(f.soul, 'notes.md');
  const metadata = path.join(f.home, '.agent-bot/skills/11111111-1111-4111-8111-111111111111/manifest.json');
  await setConfinementMode(id, 'off', { ...f.opts, gate: owner });
  for (const value of ['relative/dir', '', '~/skills']) {
    f.opts.env.AGENT_BOT_SKILLS_HOME = value;
    assert.equal(checkWrite(id, file, f.opts).inside, true);
    assert.equal(confinementCheck(f.envelope(file), f.opts).decision, 'allow');
    assert.equal(checkWrite(id, metadata, f.opts).inside, false);
    assert.equal(confinementCheck(f.envelope(metadata), f.opts).decision, 'deny');
  }
  await setConfinementMode(id, 'deny', { ...f.opts, gate: owner });
  assert.equal(confinementCheck(f.envelope(file), f.opts).decision, 'allow');
  assert.equal(confinementCheck(f.envelope(path.join(f.home, 'outside.md')), f.opts).decision, 'deny');
});
