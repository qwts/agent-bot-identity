import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { interpretDreamReport, validateDreamOutcome, dreamOutcomeDigest, DREAM_OUTCOME_LIMITS } from '../skill-dream-outcomes.mjs';
import { captureDreamInputs, dreamInputMetadata } from '../skill-dream-inputs.mjs';
import { verifyDreamRevisionEvidence } from '../skill-dream-evidence.mjs';
import { computePackageRevision, PACKAGE_IGNORE_LIST } from '../soul-package.mjs';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { adoptSoulPackage, proposeSoulRevision } from '../soul-revisions.mjs';

const HASH = `sha256:${'a'.repeat(64)}`, DIGEST = `sha256:${'b'.repeat(64)}`;
const run = { runId: '12345678-1234-4234-8234-123456789abc', agentId: 'agent_12345678-1234-4234-8234-123456789abc', startedAt: '2026-10-09T11:00:00.000Z' };
const endedAt = '2026-10-09T13:00:00.000Z';
const inputs = { schemaVersion: 1, revision: HASH, sources: [{ path: 'AGENTS.md', kind: 'context', digest: DIGEST, size: 5, excerptBytes: 5, truncated: false }],
  coverage: { definition: 'supported', memory: 'unsupported', conversations: 'unsupported', eligible: 1, selected: 1, suppliedBytes: 5, skippedBinary: 0, remaining: 0 }, nextCursor: null };
const item = () => ({ path: 'AGENTS.md', digest: DIGEST, outcome: 'completed', reason: 'no-change', evidence: null });
const report = (items = [item()]) => ({ schemaVersion: 1, runId: run.runId, startingRevision: HASH, items });
const interpret = (reply, extra = {}) => interpretDreamReport({ reply, run, inputs, endedAt, ...extra });

test('reports are source-bound assertions, and source digests or external receipts do not prove processing', () => {
  for (const evidence of [null, { digest: DIGEST }, { adapter: 'search', receipt: 'opaque-receipt' }]) {
    const outcome = interpret(JSON.stringify(report([{ ...item(), evidence }])));
    assert.equal(outcome.report.status, 'structured'); assert.equal(outcome.unreported, 0);
    assert.equal(outcome.processingCoverage, 'unverified'); assert.equal(outcome.items[0].verification.claim, 'agent-reported');
    assert.equal(outcome.items[0].verification.attribution, 'not-established');
    assert.equal(outcome.items[0].verification.evidence, evidence?.digest ? 'source-identity' : 'agent-reported');
    if (evidence?.adapter) assert.equal(outcome.items[0].verification.reason, 'adapter-unavailable');
    assert.equal(dreamOutcomeDigest(outcome), dreamOutcomeDigest(Object.fromEntries(Object.entries(outcome).reverse())));
  }
  const missing = interpret(JSON.stringify(report([])));
  assert.equal(missing.unreported, 1); assert.deepEqual(missing.items, []);
  const bad = interpret(JSON.stringify(report())); bad.items[0].verification.claim = 'runtime-verified';
  assert.throws(() => validateDreamOutcome(bad), { code: 'dream-outcome-invalid' });
});

test('wrong runs, revisions, sources, duplicates and excess fields cannot become outcomes', () => {
  for (const mutate of [
    value => { value.runId = '00000000-0000-4000-8000-000000000000'; },
    value => { value.startingRevision = DIGEST; },
    value => { value.items[0].path = '../outside'; },
    value => { value.items[0].path = 'skills/not-supplied.md'; },
    value => { value.items[0].digest = HASH; },
    value => { value.items[0].reason = 'unbounded prose, not a reason code'; },
    value => { value.items[0].outcome = 'verified'; },
    value => { value.items[0].evidence = { digest: HASH }; },
    value => { value.items[0].evidence = { url: 'https://example.invalid' }; },
    value => { value.items.push(value.items[0]); },
    value => { value.instruction = 'IGNORE_HOST_CANARY'; },
  ]) {
    const value = report(); mutate(value);
    const outcome = interpret(JSON.stringify(value));
    assert.equal(outcome.report.status, 'invalid'); assert.deepEqual(outcome.items, []); assert.equal(outcome.unreported, 1);
  }
});

test('truncated valid JSON, oversized text and malformed reports retain only bounded unverified display data', () => {
  const truncated = interpret(JSON.stringify(report()), { replyTruncated: true });
  assert.equal(truncated.report.status, 'truncated'); assert.deepEqual(truncated.items, []);
  const oversized = interpret('\u0000'.repeat(DREAM_OUTCOME_LIMITS.bytes + 1));
  assert.equal(oversized.report.status, 'oversized'); assert.equal(oversized.report.textTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.report.text)) <= DREAM_OUTCOME_LIMITS.textBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= DREAM_OUTCOME_LIMITS.bytes);
  const prose = interpret('UNTRUSTED_CANARY: I reviewed everything.');
  assert.equal(prose.report.status, 'unstructured'); assert.deepEqual(prose.items, []);
  assert.match(prose.report.text, /UNTRUSTED_CANARY/);
  assert.equal(interpret('', { executionFailed: true }).report.status, 'execution-failed');
});

test('artifact checking is bounded and cached by reference, while checker failures remain unverified', () => {
  const many = structuredClone(inputs);
  many.sources = Array.from({ length: 6 }, (_, i) => ({ ...inputs.sources[0], path: `skills/example/${i}.md`, kind: 'skill' }));
  Object.assign(many.coverage, { eligible: 6, selected: 6, suppliedBytes: 30 });
  const items = many.sources.map((source, i) => ({ ...item(), path: source.path, evidence: { revision: `sha256:${String(i).repeat(64)}` } }));
  let calls = 0;
  const failed = interpret(JSON.stringify(report(items)), { inputs: many, verifyRevisionEvidence() { calls++; throw new Error('SECRET_PROVIDER_CANARY'); } });
  assert.equal(calls, 4); assert.equal(failed.items[4].verification.reason, 'evidence-limit');
  assert.equal(failed.items[0].verification.reason, 'evidence-unavailable'); assert.equal(JSON.stringify(failed).includes('CANARY'), false);
  calls = 0;
  items.forEach(value => { value.evidence = { revision: HASH }; });
  interpret(JSON.stringify(report(items)), { inputs: many, verifyRevisionEvidence() { calls++; return null; } });
  assert.equal(calls, 1);
});

test('real revision evidence verifies a changed source without promoting the claim or another source', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'dream-outcome-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const soul = path.join(root, 'example.soul'); mkdirSync(soul);
  const manifest = { formatVersion: 2, ignore: PACKAGE_IGNORE_LIST, name: 'Outcome fixture', description: 'Fixture', displaySeed: 'fixture',
    preferredHarnesses: ['codex'], revision: HASH, parentRevision: null, template: false };
  const put = (name, text) => writeFileSync(path.join(soul, name), text);
  put('AGENTS.md', 'before'); put('soul.md', 'unchanged'); put('soul.json', JSON.stringify(manifest));
  manifest.revision = computePackageRevision(soul); put('soul.json', JSON.stringify(manifest));
  const options = { env: { HOME: root }, home: root, stateDir: path.join(root, 'state'), now: () => new Date('2026-10-09T12:00:00Z'), log() {} };
  const identity = mintAgentIdentity({ ...options, appSlug: 'test-agent', packageRevision: manifest.revision });
  adoptSoulPackage(identity.id, soul, options);
  const captured = dreamInputMetadata(captureDreamInputs(soul));
  put('AGENTS.md', 'after');
  const proposal = proposeSoulRevision(identity.id, soul, { ...options, reason: 'Refine definition' });
  const reply = JSON.stringify({ schemaVersion: 1, runId: run.runId, startingRevision: captured.revision,
    items: captured.sources.map(source => ({ ...item(), path: source.path, digest: source.digest, evidence: { proposalId: proposal.proposalId } })) });
  const result = interpretDreamReport({ reply, run: { ...run, agentId: identity.id }, inputs: captured, endedAt,
    verifyRevisionEvidence: request => verifyDreamRevisionEvidence({ ...request, stateDir: options.stateDir }) });
  assert.equal(result.report.status, 'structured');
  const [changed, unchanged] = result.items;
  assert.equal(changed.verification.evidence, 'verified-change'); assert.equal(changed.verification.proposalStatus, 'pending');
  assert.equal(changed.verification.artifactRevision, proposal.revision); assert.equal(changed.verification.claim, 'agent-reported');
  assert.equal(unchanged.verification.evidence, 'not-verified'); assert.equal(result.processingCoverage, 'unverified');
});
