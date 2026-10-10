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

import { daemonClient } from './daemon-client.mjs';
import { shown } from './approval-action.mjs';
import { soulMarkers } from './owner-gate.mjs';
import { extractToken } from './owner-statement.mjs';

const USAGE = 'usage: agent-bot approvals list [--json] | approvals approve <proposalId> [--scope once|session] [--statement TOKEN] [--json] [--principal-stdin] | approvals deny <proposalId> [--statement TOKEN] [--json] [--principal-stdin]';

// Wording from README.md, “Approving a soul's tool call”.
const HELP = `${USAGE}

Tool-permission requests souls are waiting on.

approve and deny echo the proposal's operation digest, so a decision lands
only on the operation it names, and refuse a caller with a soul marker.
Before any decision lands, the daemon asks for the owner's presence:
keyd's Touch ID or login-password prompt naming the soul and tool, or the
administrator dialog when keyd cannot ask. The daemon token alone never
decides, and a --principal-stdin credential is checked as well, not instead.

Where keyd cannot ask and an SSH security key is enrolled (agent-bot owner
enroll), the daemon answers with signed challenges instead of the dialog;
a software key never answers.
Sign one with \`agent-bot owner sign --challenge '<JSON>' --key PATH\` on a
trusted machine within ten minutes, then repeat the same decision with
--statement and the signed statement. A challenge answers only that decision,
once, and a daemon restart drops it.

Approval scope defaults to once, which also allows the same tool for the
rest of the current turn. --scope session allows the exact tool for that
soul across turns in the same harness session. Grants live only in daemon
memory and clear on a session change, soul stop, soul pause, or daemon
restart. Policy deny and computer-use off still win.

See README.md, “Approving a soul's tool call”.
`;

// One single-quoted shell word, so a challenge whose text has a quote still pastes.
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

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
  if (argv[0] === '--help' || argv[0] === '-h') {
    write(HELP);
    return 0;
  }
  const json = argv.includes('--json');
  const presented = argv.includes('--principal-stdin');
  const args = argv.filter((arg) => arg !== '--json' && arg !== '--principal-stdin');
  let statement = null;
  const statementIndex = args.indexOf('--statement');
  if (statementIndex !== -1) {
    // The bare token or the armored block `owner sign` prints.
    try { statement = extractToken(args[statementIndex + 1]); } catch { throw new Error(USAGE); }
    args.splice(statementIndex, 2);
  }
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
    if (target !== undefined || presented || statement) throw new Error(USAGE);
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
  let result;
  try {
    result = await client.decideApproval({
      proposalId: target, decision: action, ...(scopeIndex !== -1 ? { scope } : {}), digest: proposal.operationDigest,
      ...(principal ? { principal } : {}), ...(statement ? { statement } : {}),
    });
  } catch (error) {
    if (error.code !== 'owner-challenge-required' || !Array.isArray(error.challenges)) throw error;
    // Nothing was decided: show what to sign and how to answer.
    const again = `agent-bot approvals ${action} ${target}${scopeIndex !== -1 ? ` --scope ${scope}` : ''} --statement <signed token>`;
    if (json) write(`${JSON.stringify({ proposalId: target, status: 'owner-challenge-required', challenges: error.challenges, answer: again })}\n`);
    else {
      write(`${target}: owner presence is unavailable. Sign one challenge on a trusted machine within ten minutes:\n`);
      for (const { name, fingerprint, payload } of error.challenges) {
        write(`  key ${name} (${fingerprint}):\n    agent-bot owner sign --challenge ${shellQuote(JSON.stringify(payload))} --key PATH\n`);
      }
      write(`then answer with:\n  ${again}\n`);
    }
    return { proposalId: target, status: 'owner-challenge-required', challenges: error.challenges };
  }
  const decided = { ...shown(result.proposal, opts), invocationId: result.proposal.invocationId ?? null, risk: result.proposal.risk ?? 'external' };
  write(json ? `${JSON.stringify(decided)}\n` : `${decided.proposalId} ${decided.status}\n`);
  return decided;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  approvalsCommand(process.argv.slice(2)).then((result) => {
    // A challenge decided nothing, so it is not a success.
    if (result?.status === 'owner-challenge-required') process.exitCode = 2;
  }, (error) => {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'approvals-failed', message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot approvals: ${error.message}\n`);
    process.exitCode = 1;
  });
}
