import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { adoptSoulPackage, decideSoulProposal, prepareRevisionEdit, revisionHistory, revisionPackagePath } from '../soul-revisions.mjs';
import { importSkill } from '../skill-library.mjs';
import { installRecordPath } from '../skill-install.mjs';
import { learningReceipts, proposeSkillLearning } from '../skill-learning.mjs';
import { soulSkillStatus } from '../skill-status.mjs';
import { SKILL_SEARCH_LIMITS, soulSkillSearch } from '../skill-search.mjs';
import { skillSearchAdapterSetting } from '../config.mjs';
import { readSoulPackageEntries } from '../soul-package.mjs';
import { main } from '../cli/soul-skill.mjs';

const put = (file, bytes, mode) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); if (mode) chmodSync(file, mode); };
const skill = '---\nname: demo\ndescription: A status fixture\n---\nSee [guide](references/guide.md).\n';
function fixture(t) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'skill-status-'));
  t.after(() => { const thaw = dir => { chmodSync(dir, 0o700); for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) thaw(path.join(dir, entry.name)); }; thaw(home); rmSync(home, { recursive: true, force: true }); });
  const env = { HOME: home, AGENT_BOT_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  const options = { home, env, stateDir: env.AGENT_BOT_STATE_HOME, file: env.AGENT_BOT_POPULATION_PATH, now: () => new Date('2026-10-10T12:00:00.000Z') };
  const directory = path.join(home, 'souls/example.soul');
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Example', description: 'Test', displaySeed: 'example', preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  put(path.join(directory, 'soul.json'), JSON.stringify(manifest)); put(path.join(directory, 'AGENTS.md'), 'Original\n');
  put(path.join(directory, 'policy.json'), JSON.stringify({ mode: 'ask' }));
  manifest.revision = computePackageRevision(directory); put(path.join(directory, 'soul.json'), JSON.stringify(manifest));
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: manifest.revision });
  adoptSoulPackage(id, directory, options);
  put(path.join(directory, '.soul-state/agent-id'), `${id}\n`);
  upsertSoul({ id, name: 'example', status: 'active', soulDir: directory, spacePath: path.join(home, 'space'), roles: ['test'], harness: 'codex', app: 'test-agent' }, { file: options.file });
  const source = path.join(home, 'source');
  put(path.join(source, 'SKILL.md'), skill); put(path.join(source, 'references/guide.md'), 'guide\n');
  put(path.join(source, 'scripts/run'), '#!/bin/sh\nexit 0\n', 0o755);
  const imported = importSkill(source, options);
  const owner = { ...options, markers: () => [], assertUser: () => {} };
  const run = async (argv, extra = owner) => {
    const out = [], err = [];
    const code = await main(argv, { ...extra, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
    return { code, out: out.join(''), err: err.join(''), json: out.length && extra.json !== false ? (() => { try { return JSON.parse(out.join('')); } catch { return null; } })() : null };
  };
  return { home, options, directory, id, imported, owner, run, source };
}

test('status rechecks installed skills against their records and names what it cannot check', async t => {
  const f = fixture(t);
  assert.equal((await f.run(['install', f.imported.id, '--soul', f.id])).code, 0);
  put(path.join(f.directory, 'skills/own/SKILL.md'), '---\nname: own\ndescription: Authored here\n---\n');
  let status = soulSkillStatus(f.id, f.options);
  assert.equal(status.agentId, f.id);
  assert.deepEqual(status.installs, [
    { name: 'demo', verification: 'verified', changes: { added: [], modified: [], removed: [] }, recorded: true },
    { name: 'own', verification: 'unrecorded', changes: null, recorded: false }]);
  assert.deepEqual(status.learning, []);
  assert.deepEqual(status.knowledge, { status: 'unknown', verification: 'no-capability-adapter', provisioned: false });
  chmodSync(path.join(f.directory, 'skills/demo/scripts/run'), 0o644);
  put(path.join(f.directory, 'skills/demo/notes.md'), 'mine\n');
  status = soulSkillStatus(f.id, f.options);
  assert.deepEqual(status.installs[0], { name: 'demo', verification: 'drifted', changes: { added: ['notes.md'], modified: ['scripts/run'], removed: [] }, recorded: true });
  rmSync(path.join(f.directory, 'skills/demo'), { recursive: true });
  status = soulSkillStatus(f.id, f.options);
  assert.deepEqual(status.installs[0], { name: 'demo', verification: 'missing', changes: null, recorded: true });
  assert.ok(readFileSync(path.join(f.directory, installRecordPath('demo'))), 'status writes and removes nothing');
});

test('status reports learning receipts as agent-reported and keeps going past a malformed one', async t => {
  const f = fixture(t), staged = prepareRevisionEdit(f.id, f.options);
  put(path.join(staged.staging, 'skills/demo/SKILL.md'), skill);
  const outcome = { schemaVersion: 1, parentRevision: staged.revision, source: { selection: 'accepted', digest: f.imported.accepted },
    pieces: [{ source: 'SKILL.md', status: 'completed', destination: 'skills/demo/SKILL.md', method: 'copied', reason: 'Useful entrypoint' },
      { source: 'scripts/run', status: 'skipped', reason: 'Not needed' }],
    knowledge: [{ capability: 'embedding', status: 'blocked', reason: 'No configured adapter', evidence: [] }] };
  const learned = await proposeSkillLearning(f.imported.id, f.id, staged.staging, outcome, { ...f.options, reason: 'Learn' });
  const approved = decideSoulProposal(f.id, learned.proposal.proposalId, 'approve', { ...f.options, reason: 'Reviewed' });
  const tree = revisionPackagePath(f.id, approved.revision, f.options);
  for (const part of ['skills', 'provenance']) cpSync(path.join(tree, part), path.join(f.directory, part), { recursive: true });
  const other = '00000000-0000-4000-8000-000000000000';
  put(path.join(f.directory, `provenance/skills/${other}/learning.json`), '{"schemaVersion":9}\n');
  const status = soulSkillStatus(f.id, f.options);
  assert.equal(status.learning.length, 2);
  assert.deepEqual(status.learning[0], { libraryId: other, status: 'invalid-receipt' });
  const receipt = status.learning[1];
  assert.equal(receipt.libraryId, f.imported.id);
  assert.equal(receipt.status, 'valid');
  assert.deepEqual(receipt.pieces, [
    { source: 'SKILL.md', status: 'completed', destination: 'skills/demo/SKILL.md', method: 'copied', verification: 'verified-in-revision' },
    { source: 'scripts/run', status: 'skipped', verification: 'not-adopted' }]);
  assert.deepEqual(receipt.knowledge, [{ capability: 'embedding', status: 'blocked', reason: 'No configured adapter', verification: 'agent-reported' }]);
  assert.deepEqual(status.installs, [{ name: 'demo', verification: 'unrecorded', changes: null, recorded: false }], 'a learned skill has no install record');
  // The same reader as learning history, over any package's entries.
  assert.equal(learningReceipts(readSoulPackageEntries(tree).entries, f.id)[0].pieces[0].verification, 'verified-in-revision');
  assert.equal(revisionHistory(f.id, f.options).length, 2);
});

test('status CLI: JSON and text, read-only authorization, usage', async t => {
  const f = fixture(t);
  const json = await f.run(['status', '--soul', f.id, '--json']);
  assert.equal(json.code, 0, json.err);
  assert.equal(json.json.agentId, f.id);
  assert.equal(typeof json.json.notCaptured, 'string', 'every report states what capture leaves out');
  const text = await f.run(['status', '--soul', f.id]);
  assert.equal(text.code, 0);
  assert.match(text.out, /\n {2}"installs": \[\]/);
  const soul = { ...f.options, markers: () => ['Agent ID'], assertSoulTarget: target => { if (target !== f.id) throw new Error('not yours'); } };
  assert.equal((await f.run(['status', '--soul', f.id, '--json'], soul)).code, 0);
  const refused = await f.run(['status', '--soul', 'agent_00000000-0000-4000-8000-000000000000', '--json'], soul);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.error.message, 'not yours');
  for (const argv of [['status'], ['status', '--soul'], ['status', f.id], ['status', '--soul', f.id, '--trash']]) {
    assert.equal((await f.run(argv)).code, 2, argv.join(' '));
  }
});

test('search reports the missing adapter plainly, after checking the caller, the soul and the query', async t => {
  const f = fixture(t);
  assert.throws(() => soulSkillSearch(f.id, 'deploy steps', f.options), { code: 'skill-search-no-adapter' });
  const before = readSoulPackageEntries(f.directory).manifest.revision;
  const json = await f.run(['search', '--soul', f.id, 'deploy steps', '--json']);
  assert.equal(json.code, 1);
  assert.equal(json.json.error.code, 'skill-search-no-adapter');
  assert.match(json.json.error.message, /no knowledge search adapter is configured/);
  assert.equal(Object.keys(json.json).join(), 'error', 'no results, citations or service state are reported');
  const text = await f.run(['search', '--soul', f.id, 'deploy steps']);
  assert.equal(text.code, 1);
  assert.equal(text.out, '');
  assert.match(text.err, /skill-search-no-adapter/);
  assert.equal(readSoulPackageEntries(f.directory).manifest.revision, before, 'search writes nothing');
  for (const query of ['', '   ', 'a\0b', 'x'.repeat(SKILL_SEARCH_LIMITS.queryBytes + 1)]) {
    assert.throws(() => soulSkillSearch(f.id, query, f.options), { code: 'skill-search-query-invalid' }, JSON.stringify(query.slice(0, 8)));
  }
  assert.throws(() => soulSkillSearch(f.id, 'x'.repeat(SKILL_SEARCH_LIMITS.queryBytes), f.options), { code: 'skill-search-no-adapter' });
  const unknown = 'agent_00000000-0000-4000-8000-000000000000';
  assert.throws(() => soulSkillSearch(unknown, 'deploy steps', f.options), error => error.code !== 'skill-search-no-adapter');
  const soul = { ...f.options, markers: () => ['Agent ID'], assertSoulTarget: target => { if (target !== f.id) throw new Error('not yours'); } };
  assert.equal((await f.run(['search', '--soul', f.id, 'q', '--json'], soul)).json.error.code, 'skill-search-no-adapter');
  const refused = await f.run(['search', '--soul', unknown, 'q', '--json'], soul);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.error.message, 'not yours');
  for (const argv of [['search'], ['search', '--soul', f.id], ['search', f.id, 'q'], ['search', '--soul', f.id, '--trash'], ['search', '--soul', f.id, 'q', 'extra']]) {
    assert.equal((await f.run(argv)).code, 2, argv.join(' '));
  }
});

// Edits the live package and records the new bytes as its declared revision.
function rewrite(f, files) {
  for (const [file, bytes] of Object.entries(files)) {
    if (bytes === null) rmSync(path.join(f.directory, file), { recursive: true, force: true });
    else put(path.join(f.directory, file), bytes);
  }
  const manifest = JSON.parse(readFileSync(path.join(f.directory, 'soul.json'), 'utf8'));
  manifest.revision = computePackageRevision(f.directory);
  put(path.join(f.directory, 'soul.json'), JSON.stringify(manifest));
  return manifest.revision;
}

test('local-text search cites the soul revision, path, file digest and line of each sourced match', async t => {
  const f = fixture(t), local = { ...f.options, config: { settings: { skillSearchAdapter: 'local-text' } } };
  const deploy = '---\nname: deploy\ndescription: Shipping notes\n---\nRun the Deploy script first.\nThen deploy again.\n';
  const revision = rewrite(f, { 'AGENTS.md': 'Always run the DEPLOY script with care.\n', 'skills/deploy/SKILL.md': deploy,
    'skills/deploy/blob.bin': Buffer.from([0, 1, 2]), 'policy.json': JSON.stringify({ mode: 'ask', note: 'deploy script' }),
    '.soul-state/notes.md': 'deploy script in private state\n' });
  const found = soulSkillSearch(f.id, 'deploy  Script', local);
  const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.deepEqual(found, { agentId: f.id, adapter: 'local-text', revision, verification: 'verified', query: 'deploy  Script', truncated: false,
    results: [
      { path: 'AGENTS.md', digest: sha('Always run the DEPLOY script with care.\n'), line: 1, text: 'Always run the DEPLOY script with care.', relationship: 'sourced' },
      { path: 'skills/deploy/SKILL.md', digest: sha(deploy), line: 5, text: 'Run the Deploy script first.', relationship: 'sourced' }],
    coverage: { eligible: 3, searched: 2, skippedBinary: 1 } }, 'manifest, policy and private state are not searched');
  // A removed file is not in the revision, so it is never cited.
  rewrite(f, { 'skills/deploy': null });
  assert.deepEqual(soulSkillSearch(f.id, 'deploy script', local).results.map(result => result.path), ['AGENTS.md']);
  // Bytes that are not the declared revision cannot be cited.
  put(path.join(f.directory, 'AGENTS.md'), 'changed deploy script\n');
  assert.throws(() => soulSkillSearch(f.id, 'deploy', local), { code: 'skill-search-drift' });
  rewrite(f, { 'AGENTS.md': `${'match line\n'.repeat(SKILL_SEARCH_LIMITS.results + 5)}${'x'.repeat(500)} match\n` });
  const many = soulSkillSearch(f.id, 'match', local);
  assert.equal(many.results.length, SKILL_SEARCH_LIMITS.results);
  assert.equal(many.truncated, true);
  rewrite(f, { 'AGENTS.md': `${'é'.repeat(500)} match\n` });
  assert.equal(Array.from(soulSkillSearch(f.id, 'match', local).results[0].text).length, SKILL_SEARCH_LIMITS.lineChars + 1, 'long lines are cut on a character');
  assert.throws(() => soulSkillSearch(f.id, Array.from({ length: SKILL_SEARCH_LIMITS.terms + 1 }, (_, i) => `w${i}`).join(' '), local), { code: 'skill-search-query-invalid' });
  const json = await f.run(['search', '--soul', f.id, 'match', '--json'], { ...f.owner, config: local.config });
  assert.equal(json.code, 0, json.err);
  assert.equal(json.json.results[0].path, 'AGENTS.md');
  assert.equal(typeof json.json.notCaptured, 'string');
});

test('skillSearchAdapter is a host setting: unset is none, only known adapters load', () => {
  assert.equal(skillSearchAdapterSetting({}), null);
  assert.equal(skillSearchAdapterSetting({ settings: { skillSearchAdapter: 'local-text' } }), 'local-text');
  for (const value of ['vector', '', null, 1]) {
    assert.throws(() => skillSearchAdapterSetting({ settings: { skillSearchAdapter: value } }), /invalid settings\.skillSearchAdapter/);
  }
});

test('a config file selects the adapter for the CLI', async t => {
  const f = fixture(t);
  put(path.join(f.home, '.config/agent-bot/config.json'), JSON.stringify({ settings: { skillSearchAdapter: 'local-text' } }));
  const found = await f.run(['search', '--soul', f.id, 'original', '--json']);
  assert.equal(found.code, 0, found.err);
  assert.equal(found.json.results[0].text, 'Original');
});
