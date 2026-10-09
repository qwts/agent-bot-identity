import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';
import { adoptSoulPackage, decideSoulProposal, prepareRevisionEdit, proposeSoulRevision, revisionHistory, revisionPackagePath } from '../soul-revisions.mjs';
import { importSkill, readSkillMaterial } from '../skill-library.mjs';
import { proposeSkillLearning, readLearningOutcome, skillLearningPacket } from '../skill-learning.mjs';
import { main } from '../cli/soul-skill.mjs';
const put = (file, bytes, mode) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); if (mode) chmodSync(file, mode); };
const skill = '---\nname: demo\ndescription: A learning fixture\n---\n[Guide](references/guide.md)\n';
function fixture(t, policy = { mode: 'ask' }) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'skill-learning-'));
  t.after(() => { const thaw = dir => { chmodSync(dir, 0o700); for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) thaw(path.join(dir, entry.name)); }; thaw(home); rmSync(home, { recursive: true, force: true }); });
  const env = { HOME: home, AGENT_BOT_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  const options = { home, env, stateDir: env.AGENT_BOT_STATE_HOME, file: env.AGENT_BOT_POPULATION_PATH, now: () => new Date('2026-10-09T00:00:00Z') };
  const directory = path.join(home, 'souls/example.soul');
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Example', description: 'Test', displaySeed: 'example', preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  put(path.join(directory, 'soul.json'), JSON.stringify(manifest)); put(path.join(directory, 'AGENTS.md'), 'Original\n');
  put(path.join(directory, 'policy.json'), JSON.stringify(policy));
  manifest.revision = computePackageRevision(directory); put(path.join(directory, 'soul.json'), JSON.stringify(manifest));
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: manifest.revision });
  adoptSoulPackage(id, directory, options);
  put(path.join(directory, '.soul-state/agent-id'), `${id}\n`);
  upsertSoul({ id, name: 'example', status: 'active', soulDir: directory, spacePath: path.join(home, 'space'), roles: ['test'], harness: 'codex', app: 'test-agent' }, { file: options.file });
  const source = path.join(home, 'source');
  put(path.join(source, 'SKILL.md'), skill); put(path.join(source, 'references/guide.md'), '[Nested](nested.md)\n');
  put(path.join(source, 'references/nested.md'), 'retained source\r\n');
  put(path.join(source, 'scripts/run'), '#!/bin/sh\nexit 99\n', 0o755);
  const imported = importSkill(source, options), staged = prepareRevisionEdit(id, options);
  put(path.join(staged.staging, 'skills/demo/SKILL.md'), skill);
  put(path.join(staged.staging, 'skills/demo/references/guide.md'), 'adapted guide\n');
  const outcome = { schemaVersion: 1, parentRevision: staged.revision, source: { selection: 'accepted', digest: imported.accepted },
    pieces: [{ source: 'SKILL.md', status: 'completed', destination: 'skills/demo/SKILL.md', method: 'copied', reason: 'Useful entrypoint' },
      { source: 'references/guide.md', status: 'completed', destination: 'skills/demo/references/guide.md', method: 'adapted', reason: 'Adapted for this soul' },
      { source: 'scripts/run', status: 'skipped', reason: 'Not needed' }],
    knowledge: [{ capability: 'embedding', status: 'blocked', reason: 'No configured adapter', evidence: [] }] };
  const learn = (value = outcome, extra = {}) => proposeSkillLearning(imported.id, id, staged.staging, value, { ...options, reason: 'Learn useful pieces', ...extra });
  return { home, options, directory, source, id, imported, staged, outcome, learn };
}

test('learn packet is read-only, separates untrusted sources, and reports absent capabilities honestly', t => {
  const f = fixture(t), before = readdirSync(path.join(f.directory, '.soul-state/tmp'));
  const packet = skillLearningPacket(f.imported.id, f.id, f.options);
  assert.equal(packet.contentTrust, 'untrusted-source-data');
  assert.equal(packet.accepted.digest, f.imported.accepted);
  assert.notEqual(packet.accepted.entrypoint, packet.local.entrypoint);
  assert.equal(packet.knowledge.status, 'unknown'); assert.equal(packet.knowledge.provisioned, false);
  assert.equal(packet.previousLearning.records.length, 0);
  assert.deepEqual(readdirSync(path.join(f.directory, '.soul-state/tmp')), before);
  assert.equal(revisionHistory(f.id, f.options).length, 1);
});

test('learning uses ask/approve revisions and retains source bytes, dependency closure and file evidence', async t => {
  const f = fixture(t), result = await f.learn();
  assert.equal(result.proposal.status, 'pending'); assert.equal(result.livePackageChanged, false);
  assert.equal(existsSync(path.join(f.directory, 'skills/demo')), false);
  assert.equal(existsSync(path.join(f.staged.staging, 'provenance')), false, 'caller staging is unchanged');
  assert.equal(revisionHistory(f.id, f.options).length, 1);
  const approved = decideSoulProposal(f.id, result.proposal.proposalId, 'approve', { ...f.options, reason: 'Reviewed' });
  const tree = revisionPackagePath(f.id, approved.revision, f.options), receipt = JSON.parse(readFileSync(path.join(tree, result.receipt)));
  assert.equal(validateSoulPackage(tree).revision, approved.revision);
  assert.equal(receipt.knowledge[0].verification, 'agent-reported');
  assert.equal(receipt.pieces[1].verification, 'bytes-recorded-adaptation-reported');
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(f.home));
  const capture = path.join(tree, `provenance/skills/${f.imported.id}/sources/${f.imported.accepted.slice(7)}`);
  assert.equal(readFileSync(path.join(capture, 'references/nested.md'), 'utf8'), 'retained source\r\n');
  assert.equal(existsSync(path.join(capture, 'scripts/run')), false, 'skipped script is not adopted');
  const packet = skillLearningPacket(f.imported.id, f.id, f.options);
  assert.equal(packet.previousLearning.records[0].pieces[0].verification, 'verified-in-revision');
  rmSync(f.source, { recursive: true });
  assert.equal(readFileSync(path.join(capture, 'SKILL.md'), 'utf8'), skill);
  assert.deepEqual(readdirSync(path.join(f.directory, '.soul-state/tmp')), [path.basename(f.staged.staging)]);
});

test('existing never/auto policy controls learning with no separate approval path', async t => {
  for (const [policy, expected] of [[{ mode: 'never' }, 'rejected'], [{ mode: 'auto', paths: ['**'] }, 'approved'], [{ mode: 'auto', paths: ['skills/**', 'skills'] }, 'pending']]) {
    const f = fixture(t, policy);
    assert.equal((await f.learn()).proposal.status, expected);
  }
});

test('stale source, bad copy/mode, missing evidence, and oversized or unsafe outcomes publish no proposal', async t => {
  const f = fixture(t);
  const bad = [
    { ...f.outcome, source: { selection: 'accepted', digest: `sha256:${'f'.repeat(64)}` } },
    { ...f.outcome, pieces: [{ ...f.outcome.pieces[1], method: 'copied' }] },
    { ...f.outcome, pieces: [{ ...f.outcome.pieces[0], destination: '../outside' }] },
    { ...f.outcome, pieces: Array(129).fill(f.outcome.pieces[0]) },
    { ...f.outcome, knowledge: [{ capability: 'search', status: 'reported-completed', reason: 'Claim', evidence: ['missing.json'] }] },
    { ...f.outcome, knowledge: [{ capability: 'search', status: 'completed', reason: 'Cannot assert', evidence: [] }] },
  ];
  for (const value of bad) await assert.rejects(f.learn(value));
  put(path.join(f.staged.staging, 'skills/demo/script'), '#!/bin/sh\nexit 99\n', 0o644);
  await assert.rejects(f.learn({ ...f.outcome, pieces: [{ source: 'scripts/run', destination: 'skills/demo/script', method: 'copied', status: 'completed', reason: 'Wrong mode' }] }), /executable mode/);
  assert.equal(revisionHistory(f.id, f.options).length, 1);
});

test('local adaptations keep both selected and accepted originals without mutating the library', async t => {
  const f = fixture(t);
  put(path.join(f.imported.path, 'references/guide.md'), 'local library adaptation\n');
  const local = readSkillMaterial(f.imported.id, { ...f.options, selection: 'local' });
  const result = await f.learn({ ...f.outcome, source: { selection: 'local', digest: local.digest } });
  const approved = decideSoulProposal(f.id, result.proposal.proposalId, 'approve', { ...f.options, reason: 'Reviewed' });
  const tree = revisionPackagePath(f.id, approved.revision, f.options);
  for (const [digest, expected] of [[local.digest, 'local library adaptation\n'], [f.imported.accepted, '[Nested](nested.md)\n']]) {
    assert.equal(readFileSync(path.join(tree, `provenance/skills/${f.imported.id}/sources/${digest.slice(7)}/references/guide.md`), 'utf8'), expected);
  }
  assert.equal(readFileSync(path.join(f.imported.path, 'references/guide.md'), 'utf8'), 'local library adaptation\n');
});

test('foreign, linked, nondefault and stale staging refuse; concurrent parent change is rejected', async t => {
  const f = fixture(t), other = fixture(t);
  await assert.rejects(proposeSkillLearning(f.imported.id, f.id, other.staged.staging, f.outcome, { ...f.options, reason: 'Wrong staging' }), /staging/);
  const alias = path.join(f.directory, '.soul-state/tmp/revision-00000000-0000-0000-0000-000000000000');
  symlinkSync(f.staged.staging, alias);
  await assert.rejects(proposeSkillLearning(f.imported.id, f.id, alias, f.outcome, { ...f.options, reason: 'Linked' }), /links/);
  rmSync(alias);
  await assert.rejects(f.learn({ ...f.outcome, parentRevision: `sha256:${'a'.repeat(64)}` }), /stale/);
  // The final expected-parent check happens inside the existing revision lock.
  await assert.rejects(f.learn(f.outcome, { propose: (id, tree, options) => {
    const p = proposeSoulRevision(id, f.staged.staging, { ...f.options, reason: 'Concurrent proposal' });
    decideSoulProposal(id, p.proposalId, 'approve', { ...f.options, reason: 'Concurrent approval' });
    return proposeSoulRevision(id, tree, options);
  } }), /stale/);
});

test('CLI checks own-soul authority before recording and bounds outcome input', async t => {
  const f = fixture(t), file = path.join(f.home, 'outcome.json');
  put(file, JSON.stringify(f.outcome));
  let stdout = '', stderr = '', checks = 0;
  const opts = { ...f.options, stdout: { write: x => { stdout += x; } }, stderr: { write: x => { stderr += x; } }, assertSoulTarget: () => { checks++; throw new Error('foreign soul'); } };
  const args = ['learn', f.imported.id, '--soul', f.id, '--package', f.staged.staging, '--outcome', file, '--reason', 'Learn', '--json'];
  assert.equal(await main(args, opts), 1); assert.equal(checks, 1); assert.match(stdout, /foreign soul/);
  stdout = '';
  assert.equal(await main(args, { ...opts, assertSoulTarget: id => { assert.equal(id, f.id); } }), 0);
  assert.equal(JSON.parse(stdout).proposal.status, 'pending');
  assert.equal(await main(['learn', f.imported.id, '--soul', f.id, '--outcome', file], opts), 2);
  put(file, ' '.repeat(256 * 1024 + 1)); assert.throws(() => readLearningOutcome(file), /256 KiB/);
  put(file, '{CANARY'); assert.throws(() => readLearningOutcome(file), error => !error.message.includes('CANARY'));
  assert.equal(stderr.includes('usage:'), true);
});

test('unmanaged provenance conflicts refuse and repeated learning retains prior versions without growing the current capture set', async t => {
  const f = fixture(t), base = path.join(f.staged.staging, `provenance/skills/${f.imported.id}`);
  put(path.join(base, 'unmanaged.txt'), 'keep');
  await assert.rejects(f.learn(), /unmanaged/);
  assert.equal(readFileSync(path.join(base, 'unmanaged.txt'), 'utf8'), 'keep');
  rmSync(path.join(f.staged.staging, 'provenance'), { recursive: true });
  const first = await f.learn();
  const approved = decideSoulProposal(f.id, first.proposal.proposalId, 'approve', { ...f.options, reason: 'First' });
  const oldTree = revisionPackagePath(f.id, approved.revision, f.options);
  // Model a prepared working copy of the newly accepted revision without
  // changing any real user's soul. The production workflow uses revision apply.
  const { cpSync } = await import('node:fs');
  cpSync(oldTree, f.directory, { recursive: true });
  const next = prepareRevisionEdit(f.id, f.options);
  const single = { ...f.outcome, parentRevision: approved.revision, pieces: [{ ...f.outcome.pieces[2], status: 'completed', destination: 'skills/demo/scripts/run', method: 'copied' }] };
  put(path.join(next.staging, 'skills/demo/scripts/run'), '#!/bin/sh\nexit 99\n', 0o755);
  for (const extra of ['notes.md', `sources/${'f'.repeat(64)}/stale.md`]) {
    const file = path.join(next.staging, `provenance/skills/${f.imported.id}`, extra);
    put(file, 'unmanaged material');
    await assert.rejects(proposeSkillLearning(f.imported.id, f.id, next.staging, single, { ...f.options, reason: 'Keep extra material' }), /unmanaged/);
    assert.equal(readFileSync(file, 'utf8'), 'unmanaged material');
    rmSync(file);
    if (extra.startsWith('sources/')) rmSync(path.dirname(file), { recursive: true });
  }
  const result = await proposeSkillLearning(f.imported.id, f.id, next.staging, single, { ...f.options, reason: 'Learn script now' });
  const second = decideSoulProposal(f.id, result.proposal.proposalId, 'approve', { ...f.options, reason: 'Second' });
  const tree = revisionPackagePath(f.id, second.revision, f.options), source = `provenance/skills/${f.imported.id}/sources/${f.imported.accepted.slice(7)}`;
  assert.equal(existsSync(path.join(tree, source, 'SKILL.md')), false);
  assert.equal(existsSync(path.join(oldTree, source, 'SKILL.md')), true);
  assert.equal(readFileSync(path.join(tree, source, 'scripts/run'), 'utf8'), '#!/bin/sh\nexit 99\n');
  const packet = skillLearningPacket(f.imported.id, f.id, f.options);
  assert.equal(packet.previousLearning.records.length, 2);
  assert.equal(packet.previousLearning.truncated, false);
});


test('default prepare staging works through a soul directory alias while linked staging still refuses', async t => {
  const f = fixture(t), alias = path.join(f.home, 'soul-alias');
  symlinkSync(path.dirname(f.directory), alias);
  const aliasedSoul = path.join(alias, path.basename(f.directory));
  upsertSoul({ id: f.id, name: 'example', status: 'active', soulDir: aliasedSoul, spacePath: path.join(f.home, 'space'), roles: ['test'], harness: 'codex', app: 'test-agent' }, { file: f.options.file });
  const staged = prepareRevisionEdit(f.id, f.options);
  assert.equal(staged.staging.startsWith(alias), true);
  put(path.join(staged.staging, 'skills/demo/SKILL.md'), skill);
  const outcome = { ...f.outcome, pieces: [f.outcome.pieces[0]] };
  assert.equal((await proposeSkillLearning(f.imported.id, f.id, staged.staging, outcome, { ...f.options, reason: 'Learn through alias' })).proposal.status, 'pending');
});

test('malformed historical receipts are reported without suppressing later valid learning', async t => {
  const f = fixture(t, { mode: 'auto', paths: ['**'] });
  const receipt = `provenance/skills/${f.imported.id}/learning.json`;
  put(path.join(f.staged.staging, receipt), '{broken');
  const bad = proposeSoulRevision(f.id, f.staged.staging, { ...f.options, reason: 'Owner imported malformed receipt' });
  assert.equal(bad.status, 'approved');
  let packet = skillLearningPacket(f.imported.id, f.id, f.options);
  assert.deepEqual(packet.previousLearning.records, [{ revision: bad.revision, status: 'invalid-receipt' }]);
  // A new accepted package with a valid receipt must remain readable too.
  const { cpSync } = await import('node:fs');
  cpSync(revisionPackagePath(f.id, bad.revision, f.options), f.directory, { recursive: true });
  const next = prepareRevisionEdit(f.id, f.options);
  await assert.rejects(proposeSkillLearning(f.imported.id, f.id, next.staging, { ...f.outcome, parentRevision: bad.revision }, { ...f.options, reason: 'Invalid current provenance' }), /receipt is invalid/);
  rmSync(path.join(next.staging, 'provenance'), { recursive: true });
  const learned = await proposeSkillLearning(f.imported.id, f.id, next.staging, { ...f.outcome, parentRevision: bad.revision }, { ...f.options, reason: 'Learn after owner repairs candidate' });
  packet = skillLearningPacket(f.imported.id, f.id, f.options);
  assert.equal(packet.parentRevision, learned.proposal.revision);
  assert.equal(packet.previousLearning.records[0].pieces[0].verification, 'verified-in-revision');
  assert.deepEqual(packet.previousLearning.records[1], { revision: bad.revision, status: 'invalid-receipt' });
});
