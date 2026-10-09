import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonServer } from '../agent-daemon.mjs';
import { mintAgentIdentity, stateDirectory } from '../agent-identity.mjs';
import { auditFile } from '../agent-principals.mjs';
import { PROOF_HEADER } from '../binding-proof.mjs';
import { verifyPrincipalOwner } from '../owner-gate.mjs';
import { computePackageRevision } from '../soul-package.mjs';
import { adoptSoulPackage, listSoulProposals, proposeSoulRevision, revisionHistory } from '../soul-revisions.mjs';

const principal = { principal: 'principal_12345678-1234-4123-8123-123456789abc', secret: 'p'.repeat(64),
  brokerUid: process.getuid() + 1, mode: 'group' };

async function fixture(t, { realVerifier = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'revision-daemon-'));
  const env = { HOME: root, PATH: process.env.PATH, AGENT_BOT_CONFIG: join(root, 'config.json'),
    AGENT_COMMS_SHARED_DIR: join(root, 'no-broker') };
  const options = { env, home: root, stateDir: stateDirectory({ env, home: root }) };
  const packagePath = join(root, 'example.soul');
  mkdirSync(packagePath);
  const manifest = { formatVersion: 1, name: 'Test', description: 'Test soul', displaySeed: 'test',
    preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null };
  writeFileSync(join(packagePath, 'AGENTS.md'), 'Initial');
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  manifest.revision = computePackageRevision(packagePath);
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: computePackageRevision(packagePath) });
  const calls = [];
  const revisionPrincipal = (credential) => verifyPrincipalOwner(credential, { env,
    clientFactory: () => ({ request: async (request) => {
      calls.push(request);
      if (request.auth.secret !== principal.secret) throw new Error(request.auth.secret);
      return { uptimeMs: 1 };
    } }),
  });
  const server = createDaemonServer({ env, home: root, config: {}, ...(realVerifier ? {} : { revisionPrincipal }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (route, { body, headers = {}, token = server.token } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v0/soul/revisions${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json', ...headers,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const pending = () => {
    adoptSoulPackage(id, packagePath, options);
    writeFileSync(join(packagePath, 'AGENTS.md'), 'Proposed');
    return proposeSoulRevision(id, packagePath, { ...options, reason: 'Improve' });
  };
  return { root, id, options, packagePath, calls, call, pending };
}

test('daemon principal path adopts, edits, lists pending revisions, approves and rejects', async (t) => {
  const f = await fixture(t);
  const body = { agentId: f.id, packagePath: f.packagePath, reason: 'Reviewed', principal };
  let result = await f.call('/adopt', { body });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.record.authorization, { method: 'principal', principal: principal.principal });
  writeFileSync(join(f.packagePath, 'AGENTS.md'), 'Owner edit');
  result = await f.call('/edit', { body: { ...body, expectedParent: result.body.record.revision } });
  assert.equal(result.status, 200);
  const stale = await f.call('/edit', { body: { ...body, expectedParent: `sha256:${'0'.repeat(64)}` } });
  assert.equal(stale.status, 409);
  const propose = () => proposeSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'Proposed' });
  let proposal = propose();
  result = await f.call(`?agentId=${f.id}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.proposals.length, 1);
  assert.equal(result.body.proposals[0].proposalId, proposal.proposalId);
  assert.ok(!JSON.stringify(result).includes(principal.secret));
  assert.ok(!JSON.stringify(result).includes(f.root));
  result = await f.call('/approve', { body: { ...body, proposalId: proposal.proposalId } });
  assert.equal(result.status, 200);
  assert.equal(result.body.record.approval, 'user');
  assert.deepEqual(result.body.record.authorization, { method: 'principal', principal: principal.principal });
  proposal = propose();
  result = await f.call('/reject', { body: { ...body, proposalId: proposal.proposalId } });
  assert.equal(result.status, 200);
  assert.deepEqual((await f.call(`?agentId=${f.id}`)).body.proposals, []);
  assert.equal(revisionHistory(f.id, f.options).length, 3);
  assert.equal(f.calls.length, 5);
  for (const request of f.calls) assert.deepEqual(request, { op: 'health', auth: { principal: principal.principal, secret: principal.secret } });
});

test('every daemon revision mutation refuses and audits bearer alone, bad principal, and all binding headers', async (t) => {
  const f = await fixture(t);
  const proposal = f.pending();
  let count = 0;
  for (const action of ['approve', 'reject', 'adopt', 'edit']) {
    const body = { agentId: f.id, proposalId: proposal.proposalId, packagePath: f.packagePath, reason: 'Review' };
    const cases = [
      { body },
      { body: { ...body, principal: { ...principal, secret: 'bad-secret' } } },
      { body: { ...body, principal: { ...principal, principal: f.id } } },
      { body: { ...body, principal: { ...principal, brokerUid: process.getuid() } } },
      ...['x-agent-binding', PROOF_HEADER].flatMap((header) => [
        { body: { ...body, principal }, headers: { [header]: 'soul-binding' } },
        { body: { ...body, principal }, headers: { [header]: '' }, token: null },
      ]),
    ];
    for (const input of cases) {
      const result = await f.call(`/${action}`, input);
      assert.equal(result.status, 403);
      assert.equal(result.body.code, 'owner-credential-required');
      assert.ok(!JSON.stringify(result).includes('bad-secret'));
      count++;
    }
  }
  assert.equal(f.calls.length, 4, 'only malformed secrets reach the broker; binding requests never do');
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'pending');
  assert.equal(revisionHistory(f.id, f.options).length, 1);
  const audit = readFileSync(auditFile(f.options), 'utf8');
  const receipts = audit.trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, count);
  assert.ok(receipts.every((r) => r.event === 'soul-revision' && r.decision === 'owner-credential-required'));
  for (const secret of [principal.secret, 'bad-secret', 'soul-binding']) assert.ok(!audit.includes(secret));
});

test('daemon ceremony is an unavailable contract, never implicit consent or a GUI prompt', async (t) => {
  const f = await fixture(t);
  const proposal = f.pending();
  for (const action of ['approve', 'reject', 'adopt', 'edit']) {
    const result = await f.call(`/${action}`, { body: { agentId: f.id, proposalId: proposal.proposalId,
      packagePath: f.packagePath, reason: 'Review', consent: true, yes: true } });
    assert.equal(result.status, 501);
    assert.equal(result.body.code, 'owner-consent-unavailable');
  }
  assert.equal(f.calls.length, 0);
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'pending');
  assert.equal(readFileSync(auditFile(f.options), 'utf8').trim().split('\n').length, 4);
});

test('daemon default verifier fails closed without a broker; bearer and request validation remain enforced', async (t) => {
  const f = await fixture(t, { realVerifier: true });
  const proposal = f.pending();
  const body = { agentId: f.id, proposalId: proposal.proposalId, reason: 'Review', principal };
  assert.equal((await f.call(`?agentId=${f.id}`, { token: null })).status, 401);
  assert.equal((await f.call('/approve', { body, token: null })).status, 401);
  assert.equal((await f.call('?agentId=invalid')).status, 400);
  assert.equal((await f.call('/approve', { body: { ...body, reason: '' } })).status, 400);
  assert.equal((await f.call('/approve', { body: { ...body, consent: true } })).status, 400);
  const result = await f.call('/approve', { body });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'owner-credential-required');
  assert.ok(!JSON.stringify(result).includes(principal.secret));
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'pending');
});
