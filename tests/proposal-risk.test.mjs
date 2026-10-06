import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProposal, getProposal } from '../agent-jobs.mjs';

test('proposal risk validates new and stored records and defaults legacy records to external', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'proposal-risk-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const opts = { home, env: { HOME: home, AGENT_BOT_INTERACTION_HOME: path.join(home, 'interaction') } };
  const fields = { agentId: 'agent_11111111-1111-4111-8111-111111111111', operationDigest: 'a'.repeat(64), summary: 'read' };
  for (const risk of ['safe', 'destructive', 'external']) {
    const proposal = createProposal({ ...fields, risk }, opts);
    assert.equal(getProposal(proposal.proposalId, opts).risk, risk);
  }
  for (const risk of [null, '', 'unknown', 'SAFE', 42]) {
    assert.throws(() => createProposal({ ...fields, risk }, opts), /invalid proposal risk/);
  }
  const legacy = createProposal(fields, opts);
  const file = path.join(opts.env.AGENT_BOT_INTERACTION_HOME, 'proposals.json');
  const document = JSON.parse(readFileSync(file, 'utf8'));
  delete document.proposals[legacy.proposalId].risk;
  writeFileSync(file, JSON.stringify(document));
  assert.equal(getProposal(legacy.proposalId, opts).risk, 'external');
  document.proposals[legacy.proposalId].risk = 'invalid';
  writeFileSync(file, JSON.stringify(document));
  assert.throws(() => getProposal(legacy.proposalId, opts), /invalid proposal risk/);
});
