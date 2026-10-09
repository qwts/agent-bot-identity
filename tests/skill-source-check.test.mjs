import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';
import { adoptSoulPackage, prepareRevisionEdit, proposeSoulRevision, decideSoulProposal, listSoulProposals, revisionHistory, revisionPackagePath } from '../soul-revisions.mjs';
import { importSkill } from '../skill-library.mjs';
import { proposeSkillLearning } from '../skill-learning.mjs';
import { checkSoulSkillSource, proposeSoulSkillCandidate } from '../skill-source-check.mjs';
import { main } from '../cli/soul-skill.mjs';
const put = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const origin = 'https://skills.example.com/demo/SKILL.md', guideUrl = 'https://skills.example.com/demo/guide.md';
const entry = '---\nname: demo\ndescription: Portable test\n---\n[Guide](guide.md)\n';
async function fixture(t, { local = false, legacy = false, receiptEdit = null } = {}) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'source-check-'));
  t.after(() => { const thaw = dir => { chmodSync(dir, 0o700); for (const item of readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) thaw(path.join(dir, item.name)); }; thaw(home); rmSync(home, { recursive: true, force: true }); });
  const directory = path.join(home, 'example.soul'), env = { HOME: home, AGENT_BOT_STATE_HOME: path.join(home, 'state'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  const requests = [], documents = new Map([[origin, entry], [guideUrl, 'Original guide\r\n']]);
  const options = { home, env, stateDir: env.AGENT_BOT_STATE_HOME, file: env.AGENT_BOT_POPULATION_PATH, now: () => new Date('2026-10-09T00:00:00.000Z'),
    resolve: async () => [{ address: '93.184.216.34', family: 4 }], requestImpl(url, _options, callback) {
      requests.push(url.href); const request = new EventEmitter();
      request.end = () => queueMicrotask(() => { const body = documents.get(url.href), response = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
        response.statusCode = body === undefined ? 404 : 200; response.headers = {}; callback(response); });
      return request;
    } };
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Fixture', description: 'Test', displaySeed: 'fixture', preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  put(path.join(directory, 'soul.json'), JSON.stringify(manifest)); put(path.join(directory, 'AGENTS.md'), 'Original definition\n');
  put(path.join(directory, 'policy.json'), JSON.stringify({ mode: 'ask' }));
  manifest.revision = computePackageRevision(directory); put(path.join(directory, 'soul.json'), JSON.stringify(manifest));
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: manifest.revision });
  adoptSoulPackage(id, directory, options); put(path.join(directory, '.soul-state/agent-id'), id);
  upsertSoul({ id, name: 'fixture', status: 'active', soulDir: directory, spacePath: home }, { file: options.file });
  const input = path.join(home, 'source'); put(path.join(input, 'SKILL.md'), entry); put(path.join(input, 'guide.md'), 'Original guide\r\n');
  const imported = await importSkill(local ? input : origin, options), prepared = prepareRevisionEdit(id, options);
  put(path.join(prepared.staging, 'skills/demo/SKILL.md'), entry);
  const outcome = { schemaVersion: 1, parentRevision: prepared.revision, source: { selection: 'accepted', digest: imported.accepted },
    pieces: [{ source: 'SKILL.md', status: 'completed', destination: 'skills/demo/SKILL.md', method: 'copied', reason: 'Useful' }], knowledge: [] };
  const learned = await proposeSkillLearning(imported.id, id, prepared.staging, outcome, { ...options, reason: 'Learn',
    ...((legacy || receiptEdit) ? { propose(id, tree, opts) { const file = path.join(tree, `provenance/skills/${imported.id}/learning.json`), value = JSON.parse(readFileSync(file));
      if (legacy) { value.schemaVersion = 1; delete value.source.provenance; }
      if (receiptEdit) receiptEdit(value); put(file, JSON.stringify(value)); return proposeSoulRevision(id, tree, opts); } } : {}) });
  const approved = decideSoulProposal(id, learned.proposal.proposalId, 'approve', { ...options, reason: 'Reviewed' });
  const acceptedTree = revisionPackagePath(id, approved.revision, options);
  cpSync(acceptedTree, directory, { recursive: true }); // live package follows the approved revision
  renameSync(path.dirname(imported.path), path.join(home, 'unavailable-library')); requests.length = 0;
  return { home, directory, id, options, imported, documents, requests, acceptedTree, revision: approved.revision,
    check: () => checkSoulSkillSource(imported.id, id, options) };
}

test('portable recheck survives library loss and preserves accepted bytes, history and the live definition', async t => {
  const f = await fixture(t), before = computePackageRevision(f.directory), result = await f.check();
  assert.equal(result.status, 'unchanged'); assert.equal(result.accepted, f.imported.accepted); assert.equal(result.candidate, result.accepted);
  assert.deepEqual(result.comparison.changes, { modified: [], removed: [], uncaptured: [], unchanged: ['SKILL.md', 'guide.md'], unbaselined: [] });
  assert.equal(result.comparison.basis, 'retained-accepted-files-only');
  assert.equal(readFileSync(path.join(result.staging, 'payload/guide.md'), 'utf8'), 'Original guide\r\n');
  assert.equal(JSON.parse(readFileSync(path.join(result.staging, 'manifest.json'))).manifest.digest, result.candidate);
  assert.equal(JSON.parse(readFileSync(path.join(result.staging, 'check.json'))).parentRevision, f.revision);
  assert.equal(validateSoulPackage(f.acceptedTree).revision, f.revision); assert.equal(computePackageRevision(f.directory), before);
  assert.equal(revisionHistory(f.id, f.options).length, 2);
  assert.deepEqual([result.acceptedChanged, result.livePackageChanged, result.universalRetrieval], [false, false, false]);
});

test('changed sources stage byte-exact candidates and distinguish unbaselined files from proven additions', async t => {
  const f = await fixture(t);
  f.documents.set(origin, entry.replace('[Guide](guide.md)', '[New](new.md)'));
  f.documents.set('https://skills.example.com/demo/new.md', 'New instructions\n');
  const result = await f.check();
  assert.equal(result.status, 'changed'); assert.notEqual(result.candidate, result.accepted);
  assert.deepEqual(result.comparison.changes, { modified: ['SKILL.md'], removed: ['guide.md'], uncaptured: [], unchanged: [], unbaselined: ['new.md'] });
  assert.match(result.comparison.textDiffs[0].text, /-\[Guide\]\(guide.md\)/);
  assert.match(result.comparison.textDiffs[0].text, /\+\[New\]\(new.md\)/);
  assert.equal(readFileSync(path.join(f.acceptedTree, `provenance/skills/${f.imported.id}/sources/${f.imported.accepted.slice(7)}/guide.md`), 'utf8'), 'Original guide\r\n');
  assert.equal(revisionHistory(f.id, f.options).length, 2);
});

test('root failure and incomplete dependency acquisition record unavailable without replacing accepted captures', async t => {
  const f = await fixture(t); f.documents.delete(origin);
  let result = await f.check();
  assert.equal(result.status, 'unavailable'); assert.equal(result.candidate, null);
  assert.equal(existsSync(path.join(result.staging, 'payload')), false);
  assert.equal(JSON.parse(readFileSync(path.join(result.staging, 'check.json'))).status, 'unavailable');
  f.documents.set(origin, entry); f.documents.delete(guideUrl);
  result = await f.check();
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'skill-capture-incomplete');
  assert.equal(result.coverage.acquisition, 'partial'); assert.ok(result.candidate);
  assert.deepEqual(result.comparison.changes, { modified: [], removed: [], uncaptured: ['guide.md'], unchanged: ['SKILL.md'], unbaselined: [] });
  assert.deepEqual(result.comparison.textDiffs, []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(result.staging, 'check.json'))).comparison, result.comparison);
  assert.equal(validateSoulPackage(f.acceptedTree).revision, f.revision);
});

test('legacy and local provenance report unavailable without inventing paths or fetching', async t => {
  for (const settings of [{ legacy: true }, { local: true }]) {
    const f = await fixture(t, settings), result = await f.check();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, settings.legacy ? 'skill-source-provenance-missing' : 'skill-local-source-not-portable');
    assert.deepEqual(f.requests, []); assert.equal(result.candidate, null);
  }
});

test('portable check CLI authorizes the soul before fetching or writing and refuses malformed grammar', async t => {
  const f = await fixture(t), args = ['check', f.imported.id, '--soul', f.id, '--json'];
  let stdout = '', stderr = '';
  const opts = { ...f.options, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, assertSoulTarget: () => { throw new Error('foreign soul'); } };
  assert.equal(await main(args, opts), 1); assert.match(stdout, /foreign soul/); assert.deepEqual(f.requests, []);
  stdout = '';
  assert.equal(await main(args, { ...opts, assertSoulTarget: id => assert.equal(id, f.id) }), 0);
  assert.equal(JSON.parse(stdout).status, 'unchanged');
  assert.equal(await main([...args, '--soul', f.id], opts), 2);
  assert.equal(await main(['check', f.imported.id, '--soul'], opts), 2); assert.match(stderr, /usage:/);
});

test('linked internal staging refuses before any remote acquisition', async t => {
  const f = await fixture(t), tmp = path.join(f.directory, '.soul-state/tmp'), other = path.join(f.home, 'other');
  renameSync(tmp, other); symlinkSync(other, tmp);
  await assert.rejects(f.check(), { code: 'skill-check-staging-invalid' }); assert.deepEqual(f.requests, []);
});


test('portable source readers refuse contradictory repository aliases and forged blob evidence before fetching', async t => {
  for (const [receiptEdit, message] of [
    [value => { value.source.repository = { provider: 'github', owner: 'another' }; }, /repository alias/],
    [value => { value.source.provenance.locations[0].gitBlob = 'f'.repeat(40); }, /repository blob/],
  ]) {
    const f = await fixture(t, { receiptEdit });
    await assert.rejects(f.check(), message); assert.deepEqual(f.requests, []);
  }
});

test('large text changes keep exact candidate bytes while bounding inline diffs', async t => {
  const f = await fixture(t), replacement = 'x'.repeat(70 * 1024) + '\n';
  f.documents.set(guideUrl, replacement);
  const result = await f.check();
  assert.equal(result.status, 'changed');
  assert.deepEqual(result.comparison.changes.modified, ['guide.md']);
  assert.deepEqual(result.comparison.textDiffs, [{ path: 'guide.md', text: null, reason: 'diff-limit' }]);
  assert.equal(readFileSync(path.join(result.staging, 'payload/guide.md'), 'utf8'), replacement);
});

async function reviewedCandidate(f) {
  f.documents.set(origin, entry.replace('[Guide](guide.md)', '[New](new.md)'));
  f.documents.set('https://skills.example.com/demo/new.md', 'New instructions\n');
  const checked = await f.check(), prepared = prepareRevisionEdit(f.id, f.options);
  rmSync(path.join(prepared.staging, 'skills/demo'), { recursive: true });
  for (const file of ['SKILL.md', 'new.md']) put(path.join(prepared.staging, 'skills/demo', file), readFileSync(path.join(checked.staging, 'payload', file)));
  const outcome = { schemaVersion: 1, parentRevision: prepared.revision, source: { selection: 'accepted', digest: checked.candidate },
    pieces: [{ source: 'SKILL.md', status: 'completed', destination: 'skills/demo/SKILL.md', method: 'copied', reason: 'Reviewed update' },
      { source: 'new.md', status: 'completed', destination: 'skills/demo/new.md', method: 'copied', reason: 'Reviewed update' }], knowledge: [] };
  f.requests.length = 0;
  return { checked, prepared, outcome, apply: (value = outcome, extra = {}) => proposeSoulSkillCandidate(f.imported.id, f.id, prepared.staging, value, { ...f.options, reason: 'Apply reviewed source', candidate: checked.candidate, ...extra }) };
}

test('a reviewed portable candidate is refetched and proposed through the soul revision policy', async t => {
  const f = await fixture(t), r = await reviewedCandidate(f), before = computePackageRevision(f.directory);
  const result = await r.apply();
  assert.equal(result.proposal.status, 'pending'); assert.equal(result.livePackageChanged, false);
  assert.ok(f.requests.includes(origin), 'source is fetched again rather than read from soul staging');
  assert.equal(computePackageRevision(f.directory), before); assert.equal(revisionHistory(f.id, f.options).length, 2);
  const approved = decideSoulProposal(f.id, result.proposal.proposalId, 'approve', { ...f.options, reason: 'Reviewed' });
  const tree = revisionPackagePath(f.id, approved.revision, f.options), receipt = JSON.parse(readFileSync(path.join(tree, result.receipt)));
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.source.acceptedDigest, r.checked.candidate);
  assert.equal(receipt.source.provenance.digest, r.checked.candidate); assert.equal(receipt.source.provenance.source.url, origin);
  assert.equal(readFileSync(path.join(tree, `provenance/skills/${f.imported.id}/sources/${r.checked.candidate.slice(7)}/new.md`), 'utf8'), 'New instructions\n');
  assert.equal(existsSync(path.join(tree, `provenance/skills/${f.imported.id}/sources/${f.imported.accepted.slice(7)}`)), false, 'prior set stays in the prior revision');
  assert.equal(readFileSync(path.join(f.acceptedTree, `provenance/skills/${f.imported.id}/sources/${f.imported.accepted.slice(7)}/guide.md`), 'utf8'), 'Original guide\r\n');
  const again = await f.check();
  assert.equal(again.status, 'unchanged'); assert.equal(again.accepted, r.checked.candidate);
});

test('candidate application refuses drift, incomplete capture and mismatched outcomes without proposing', async t => {
  const f = await fixture(t), r = await reviewedCandidate(f);
  await assert.rejects(r.apply({ ...r.outcome, source: { selection: 'local', digest: r.checked.candidate } }), { code: 'skill-candidate-invalid' });
  await assert.rejects(r.apply({ ...r.outcome, source: { selection: 'accepted', digest: f.imported.accepted } }), { code: 'skill-candidate-invalid' });
  await assert.rejects(r.apply(r.outcome, { candidate: 'sha256:short' }), { code: 'skill-candidate-invalid' });
  assert.deepEqual(f.requests, []);
  f.documents.set('https://skills.example.com/demo/new.md', 'Changed after review\n');
  await assert.rejects(r.apply(), { code: 'skill-source-changed' });
  f.documents.delete('https://skills.example.com/demo/new.md');
  await assert.rejects(r.apply(), { code: 'skill-capture-incomplete' });
  await assert.rejects(r.apply({ ...r.outcome, parentRevision: `sha256:${'a'.repeat(64)}` }), /stale/);
  assert.equal(revisionHistory(f.id, f.options).length, 2);
  assert.equal(listSoulProposals(f.id, f.options).length, 1, 'only the original learning proposal exists');
});

test('candidate application never fetches for local or legacy receipts', async t => {
  for (const settings of [{ legacy: true }, { local: true }]) {
    const f = await fixture(t, settings), prepared = prepareRevisionEdit(f.id, f.options), candidate = `sha256:${'b'.repeat(64)}`;
    const outcome = { schemaVersion: 1, parentRevision: prepared.revision, source: { selection: 'accepted', digest: candidate },
      pieces: [{ source: 'SKILL.md', status: 'skipped', reason: 'Nothing to apply' }], knowledge: [] };
    await assert.rejects(proposeSoulSkillCandidate(f.imported.id, f.id, prepared.staging, outcome, { ...f.options, reason: 'Apply', candidate }),
      { code: settings.legacy ? 'skill-source-provenance-missing' : 'skill-local-source-not-portable' });
    assert.deepEqual(f.requests, []);
  }
});

test('learn --candidate CLI authorizes before fetching and needs the recording flags', async t => {
  const f = await fixture(t), r = await reviewedCandidate(f), outcomeFile = path.join(f.home, 'outcome.json');
  writeFileSync(outcomeFile, JSON.stringify(r.outcome));
  const args = ['learn', f.imported.id, '--soul', f.id, '--candidate', r.checked.candidate, '--package', r.prepared.staging, '--outcome', outcomeFile, '--reason', 'Apply reviewed source', '--json'];
  let stdout = '', stderr = '';
  const opts = { ...f.options, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } }, assertSoulTarget: () => { throw new Error('foreign soul'); } };
  assert.equal(await main(args, opts), 1); assert.match(stdout, /foreign soul/); assert.deepEqual(f.requests, []);
  assert.equal(await main(['learn', f.imported.id, '--soul', f.id, '--candidate', r.checked.candidate], opts), 2); assert.match(stderr, /usage:/);
  stdout = '';
  assert.equal(await main(args, { ...opts, assertSoulTarget: id => assert.equal(id, f.id) }), 0);
  assert.equal(JSON.parse(stdout).proposal.status, 'pending');
});
