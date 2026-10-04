#!/usr/bin/env node

// `agent-bot approvals list|approve|deny` (#85): the owner's view of the
// tool-permission requests daemon turns are waiting on. A soul's policy can
// answer a tool with `approval`; the turn then parks on an immutable proposal
// (agent-interaction.mjs) until the owner decides, it expires, or the turn
// ends. GeniusBar's approvals panel calls this command; the logic is here.
//
// Listing refuses a caller that carries a soul marker: a soul must not see
// what its owner is being asked. Deciding goes through the owner gate (the
// same one every owner-only change uses) and echoes the proposal's exact
// operation digest, so a decision can only land on the operation it names.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { daemonClient } from './agent-daemon.mjs';
import { populationFile, showSoul, soulDirectory, soulShownName } from './agent-population.mjs';
import { assertOwnerAction, soulMarkers } from './owner-gate.mjs';

const USAGE = 'usage: agent-bot approvals list [--json] | approvals approve|deny <proposalId> [--json] [--principal-stdin]';

function soulName(agentId, { env, home }) {
  const file = populationFile({ env, home });
  try {
    const soul = showSoul(agentId, { file });
    let directory = null;
    try { directory = soulDirectory(agentId, { file, env, home }); } catch { /* no soul directory */ }
    return soulShownName(soul, directory);
  } catch {
    return null;
  }
}

function shown(proposal, opts) {
  return {
    proposalId: proposal.proposalId,
    agentId: proposal.agentId,
    soul: proposal.agentId ? soulName(proposal.agentId, opts) : null,
    tool: proposal.tool ?? null,
    summary: proposal.summary,
    operationDigest: proposal.operationDigest,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    status: proposal.status,
  };
}

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
  gate = (action, { principal }) => assertOwnerAction(action, { principal, env, cwd }),
  client = daemonClient({ env, home, cwd }),
} = {}) {
  const json = argv.includes('--json');
  const presented = argv.includes('--principal-stdin');
  const [action, target, ...rest] = argv.filter((arg) => arg !== '--json' && arg !== '--principal-stdin');
  const opts = { env, home };
  if (action === 'list') {
    if (target !== undefined || presented) throw new Error(USAGE);
    refuseSoul({ env, cwd });
    const { proposals } = await client.approvals();
    const rows = proposals.map((proposal) => shown(proposal, opts));
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
  // The proposal is read before the gate so the owner is asked about the
  // exact soul and tool, and its digest is what the decision echoes.
  const { proposals } = await client.approvals();
  const proposal = proposals.find((row) => row.proposalId === target);
  if (!proposal) throw Object.assign(new Error(`${target} is not waiting on a decision`), { code: 'not-open' });
  const row = shown(proposal, opts);
  const who = row.soul ? `${row.soul} (${row.agentId})` : row.agentId;
  const about = row.summary.length > 160 ? `${row.summary.slice(0, 157)}...` : row.summary;
  await gate(`${action} ${row.tool ?? 'a tool'} for ${who}: ${about}`, { principal });
  const result = await client.decideApproval({ proposalId: target, decision: action, digest: proposal.operationDigest });
  const decided = shown(result.proposal, opts);
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
