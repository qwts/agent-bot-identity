#!/usr/bin/env node

// `agent-bot approvals list|approve|deny` (#85): the owner's view of the
// tool-permission requests daemon turns are waiting on. A soul's policy can
// answer a tool with `approval`; the turn then parks on an immutable proposal
// (agent-interaction.mjs) until the owner decides, it expires, or the turn
// ends. GeniusBar's approvals panel calls this command; the logic is here.
//
// Both refuse a caller that carries a soul marker: a soul must not see what
// its owner is being asked. A decision echoes the proposal's exact operation
// digest, so it can only land on the operation it names, and the daemon asks
// for the owner's presence before it lands (#438); this command does not ask
// a second time.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { daemonClient } from './agent-daemon.mjs';
import { shown } from './approval-action.mjs';
import { soulMarkers } from './owner-gate.mjs';

const USAGE = 'usage: agent-bot approvals list [--json] | approvals approve <proposalId> [--scope once|session] [--json] [--principal-stdin] | approvals deny <proposalId> [--json] [--principal-stdin]';

function refuseSoul({ env, cwd }) {
  const markers = soulMarkers({ env, cwd });
  if (markers.length) {
    throw Object.assign(new Error(`approvals are the owner's; this caller carries a soul marker (${markers.join(', ')})`),
      { code: 'not-owner' });
  }
}

export async function approvalsCommand(argv, {
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
  readStdin = () => readFileSync(0, 'utf8'),
  write = (text) => process.stdout.write(text),
  client = daemonClient({ env, home, cwd }),
} = {}) {
  const json = argv.includes('--json');
  const presented = argv.includes('--principal-stdin');
  const args = argv.filter((arg) => arg !== '--json' && arg !== '--principal-stdin');
  const scopeIndex = args.indexOf('--scope');
  let scope = 'once';
  if (scopeIndex !== -1) {
    scope = args[scopeIndex + 1];
    if (args[0] !== 'approve' || !['once', 'session'].includes(scope)) throw new Error(USAGE);
    args.splice(scopeIndex, 2);
  }
  const [action, target, ...rest] = args;
  const opts = { env, home };
  if (action === 'list') {
    if (target !== undefined || presented) throw new Error(USAGE);
    refuseSoul({ env, cwd });
    const { proposals } = await client.approvals();
    const rows = proposals.map((proposal) => ({ ...shown(proposal, opts), invocationId: proposal.invocationId ?? null, risk: proposal.risk ?? 'external' }));
    if (json) write(`${JSON.stringify({ approvals: rows })}\n`);
    else if (!rows.length) write('no approvals waiting\n');
    else for (const row of rows) write(`${row.proposalId} ${row.soul ?? row.agentId} ${row.tool ?? '-'} until ${row.expiresAt}: ${row.summary}\n`);
    return rows;
  }
  if ((action !== 'approve' && action !== 'deny') || !target || rest.length) throw new Error(USAGE);
  // The principal is read once, before anything else could consume stdin.
  let principal = null;
  if (presented) {
    try { principal = JSON.parse(readStdin()); }
    catch { throw new Error('--principal-stdin needs the principal credential as JSON on stdin'); }
  }
  refuseSoul({ env, cwd });
  // The proposal is read first: its digest is what the decision echoes.
  const { proposals } = await client.approvals();
  const proposal = proposals.find((row) => row.proposalId === target);
  if (!proposal) throw Object.assign(new Error(`${target} is not waiting on a decision`), { code: 'not-open' });
  const result = await client.decideApproval({
    proposalId: target, decision: action, ...(scopeIndex !== -1 ? { scope } : {}), digest: proposal.operationDigest, ...(principal ? { principal } : {}),
  });
  const decided = { ...shown(result.proposal, opts), invocationId: result.proposal.invocationId ?? null, risk: result.proposal.risk ?? 'external' };
  write(json ? `${JSON.stringify(decided)}\n` : `${decided.proposalId} ${decided.status}\n`);
  return decided;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  approvalsCommand(process.argv.slice(2)).catch((error) => {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'approvals-failed', message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot approvals: ${error.message}\n`);
    process.exitCode = 1;
  });
}
