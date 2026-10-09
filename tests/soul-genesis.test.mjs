import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveSoulId, spawnNonce } from '../soul-genesis.mjs';
import { computePackageRevision } from '../soul-package.mjs';
import { mintAgentIdentity, readAgentIdentity, recordAgentPackageRevision, ensureAgentIdentity,
  bindAgentLineage, validateIdentity, isAgentId, validateAgentId } from '../agent-identity.mjs';
import { scanTranscriptStores } from '../agent-backfill.mjs';

const revision = `sha256:${'0'.repeat(64)}`;
const nonce = '0'.repeat(64);
const parent = 'agent_11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-genesis-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packagePath = path.join(root, 'test.soul');
  mkdirSync(packagePath);
  writeFileSync(path.join(packagePath, 'soul.json'), JSON.stringify({ formatVersion: 1,
    name: 'Test', description: 'Test soul', displaySeed: 'test', preferredHarnesses: [], revision, parentRevision: null }));
  writeFileSync(path.join(packagePath, 'AGENTS.md'), 'Test instructions\n');
  // Spread into mintAgentIdentity: the revision is read at spread time, as
  // identity used to compute it at mint; the path itself is not a mint option.
  const f = { stateDir: path.join(root, 'identities'), appSlug: 'test-agent', root,
    get packageRevision() { return computePackageRevision(packagePath); } };
  return Object.defineProperty(f, 'packagePath', { value: packagePath, enumerable: false });
}

test('fixed SHA-256 canonical JSON UUIDv8 vectors', () => {
  assert.equal(deriveSoulId({ revision, nonce }), 'agent_9e735fcf-1896-80dc-9127-6faeead67aed');
  assert.equal(deriveSoulId({ revision, parentSoul: parent, nonce }), 'agent_1df13176-d371-8e3e-850a-0d804b179893');
  const id = deriveSoulId({ revision, nonce });
  for (const inputs of [{ revision: `sha256:${'1'.repeat(64)}`, nonce },
    { revision, nonce: '1'.repeat(64) }, { revision, nonce, parentSoul: parent }]) {
    assert.notEqual(deriveSoulId(inputs), id);
  }
  assert.match(spawnNonce(), /^[0-9a-f]{64}$/);
  for (const inputs of [{ revision: 'bad', nonce }, { revision, nonce: 'bad' },
    { revision, nonce: nonce + '\n' }, { revision: revision + '\n', nonce },
    { revision, nonce, parentSoul: 'bad' }]) assert.throws(() => deriveSoulId(inputs));
});

test('packaged mint uses actual starting revision and parent; nonce is private', (t) => {
  const f = fixture(t);
  const row = mintAgentIdentity({ ...f, parentId: parent, nonceFactory: () => nonce,
    idFactory: () => { throw new Error('must not mint random ID'); } });
  const genesis = { revision: computePackageRevision(f.packagePath), parentSoul: parent };
  assert.equal(row.id, deriveSoulId({ ...genesis, nonce }));
  assert.deepEqual(row.genesis, genesis);
  assert.deepEqual(readAgentIdentity(row.id, f), row);
  assert.equal(readFileSync(path.join(f.stateDir, `${row.id}.json`), 'utf8').includes(nonce), false);
  assert.notEqual(mintAgentIdentity(f).id, mintAgentIdentity(f).id);
  assert.deepEqual(validateIdentity(row), []);
  assert.ok(validateIdentity({ ...row, genesis: { ...genesis, revision: 'invalid' } }).length);
  assert.ok(validateIdentity({ ...row, genesis: { ...genesis, parentSoul: 'invalid' } }).length);
  assert.ok(validateIdentity({ ...row, genesis: { ...genesis, nonce } }).length);
  assert.ok(validateIdentity({ ...row, id: parent }).length);
});

test('collision retries with a fresh nonce and fails closed when exhausted', (t) => {
  const f = fixture(t);
  mintAgentIdentity({ ...f, nonceFactory: () => nonce });
  let calls = 0;
  const next = mintAgentIdentity({ ...f, nonceFactory: () => calls++ === 0 ? nonce : '1'.repeat(64) });
  assert.equal(calls, 2);
  assert.equal(next.id, deriveSoulId({ revision: computePackageRevision(f.packagePath), nonce: '1'.repeat(64) }));
  assert.throws(() => mintAgentIdentity({ ...f, nonceFactory: () => nonce }), /unique Agent ID/);
  assert.throws(() => mintAgentIdentity({ ...f, packageRevision: 'sha256:missing' }), /genesis revision/);
  assert.throws(() => mintAgentIdentity({ ...f, packagePath: f.packagePath }), /takes packageRevision, not packagePath/);
});

test('revision-chain port preserves genesis and ID, records every move including undo', async (t) => {
  const f = fixture(t);
  const row = mintAgentIdentity(f);
  const chain = [];
  const appendRevision = async (entry) => { chain.push(entry); };
  await recordAgentPackageRevision(row.id, computePackageRevision(f.packagePath), { ...f, appendRevision });
  writeFileSync(path.join(f.packagePath, 'AGENTS.md'), 'New instructions\n');
  const updated = await recordAgentPackageRevision(row.id, computePackageRevision(f.packagePath), { ...f, appendRevision });
  writeFileSync(path.join(f.packagePath, 'AGENTS.md'), 'Test instructions\n');
  await recordAgentPackageRevision(row.id, computePackageRevision(f.packagePath), { ...f, appendRevision });
  assert.deepEqual(updated, row);
  assert.deepEqual(chain.map((e) => e.agentId), [row.id, row.id, row.id]);
  assert.equal(chain[0].revision, row.genesis.revision);
  assert.notEqual(chain[1].revision, row.genesis.revision);
  assert.equal(chain[2].revision, row.genesis.revision);
  assert.deepEqual(readAgentIdentity(row.id, f), row);
  assert.deepEqual(bindAgentLineage(row.id, parent, f).genesis, row.genesis);
  await assert.rejects(recordAgentPackageRevision(row.id, computePackageRevision(f.packagePath), f), /chain writer/);
  await assert.rejects(recordAgentPackageRevision(row.id, computePackageRevision(f.packagePath), { ...f,
    appendRevision: async () => { throw new Error('storage failure'); } }), /storage failure/);
  writeFileSync(path.join(f.stateDir, `${row.id}.json`), JSON.stringify({ ...row, status: 'retired' }));
  await assert.rejects(recordAgentPackageRevision(row.id, computePackageRevision(f.packagePath), { ...f, appendRevision }), /retired/);
  assert.equal(chain.length, 3);
});

test('legacy rows normalize to no genesis and adopt packages without changing ID', async (t) => {
  const f = fixture(t);
  const row = mintAgentIdentity({ ...f, packageRevision: null });
  assert.equal(row.genesis, null);
  delete row.genesis;
  writeFileSync(path.join(f.stateDir, `${row.id}.json`), JSON.stringify(row));
  assert.deepEqual(validateIdentity(row), []);
  assert.equal(readAgentIdentity(row.id, f).genesis, null);
  const entries = [];
  const adopted = await recordAgentPackageRevision(row.id, computePackageRevision(f.packagePath), { ...f, appendRevision: (e) => entries.push(e) });
  assert.equal(adopted.id, row.id);
  assert.equal(adopted.genesis, null);
  assert.equal(entries[0].genesis, null);
  const bound = bindAgentLineage(row.id, parent, f);
  assert.equal(bound.genesis, null);
  assert.equal(JSON.parse(readFileSync(path.join(f.stateDir, `${row.id}.json`))).genesis, null);
});

test('all Agent ID regex parsers accept derived UUIDv8, including transcript scan and registry reuse', (t) => {
  const f = fixture(t);
  const row = mintAgentIdentity({ ...f, transcript: { provider: 'test', id: 'thread' } });
  assert.equal(isAgentId(row.id), true);
  assert.equal(validateAgentId(row.id), row.id);
  assert.equal(ensureAgentIdentity({ ...f, transcript: row.transcript }).id, row.id);
  const store = path.join(f.root, 'transcripts');
  mkdirSync(store);
  writeFileSync(path.join(store, `${parent.slice(6)}.jsonl`), JSON.stringify({ text: row.id }));
  const { sightings } = scanTranscriptStores([{ provider: 'claude', root: store }]);
  assert.equal(sightings.has(row.id), true);
});

test('genesis hashes the one shared canonical JSON that soul-package re-exports (#645)', async () => {
  const shared = await import('../canonical-json.mjs');
  const pkg = await import('../soul-package.mjs');
  assert.equal(pkg.canonicalJson, shared.canonicalJson);
  assert.equal(shared.canonicalJson({ b: [1, { d: null, c: 'x' }], a: true }), '{"a":true,"b":[1,{"c":"x","d":null}]}');
});
