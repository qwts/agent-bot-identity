// A waiting proposal as the owner sees it (#85), and the owner-gate action
// that deciding it asks about (#438). Shared by `agent-bot approvals` and the
// daemon's decide routes, so the prompt names the same soul and tool the
// approvals list shows.

import { populationFile, showSoul, soulDirectory, soulShownName } from './agent-population.mjs';

const MAX_ABOUT = 160;

export function soulName(agentId, { env, home }) {
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

export function shown(proposal, opts) {
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

// `approve Bash for Bill (agent_…): git push`, the summary clipped so the
// prompt stays readable.
export function approvalAction(row, decision) {
  const who = row.soul ? `${row.soul} (${row.agentId})` : row.agentId;
  const about = row.summary.length > MAX_ABOUT ? `${row.summary.slice(0, MAX_ABOUT - 3)}...` : row.summary;
  return `${decision} ${row.tool ?? 'a tool'} for ${who}: ${about}`;
}
