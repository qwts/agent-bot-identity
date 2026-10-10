#!/usr/bin/env node
// `agent-bot mint-token`: the command line over mint-token.mjs. It lives in
// cli because it owns the documented stdout format (cli/mint-output.mjs);
// mint-token.mjs keeps the library every other module imports (#645).
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readBinding } from '../agent-binding.mjs';
import { appendAuditReceipt } from '../agent-principals.mjs';
import { mintForCaller } from '../git-credential-bot.mjs';
import { MINT_USAGE, parseMintArgs, selectionReason } from '../mint-token.mjs';
import { explicitAppArg, ownerApprovalRequired, requireOwnerApproval } from '../owner-approval.mjs';
import { formatMintGrant } from './mint-output.mjs';

async function main() {
  const options = parseMintArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(MINT_USAGE);
    return;
  }
  // An unmarked explicit mint in the owner's account is a credential release
  // with no stated identity — it carries the owner-approval ceremony. Stated
  // identities (pin, GH_AGENT_APP, harness markers, agent account) mint as
  // before. A bound checkout is mintForCaller's to decide (#775): the soul's
  // own App through the daemon, anything else through the owner gate.
  let bound;
  try { bound = readBinding() !== null; } catch { bound = true; }
  const approvalRequired = !bound && ownerApprovalRequired({ argv: process.argv });
  if (approvalRequired) {
    const slug = explicitAppArg(process.argv);
    try {
      requireOwnerApproval({
        prompt: `Approve a GitHub App installation token for ${slug}[bot] — mint-token was run in the owner's account with no stated agent identity.`,
      });
    } catch (error) {
      operatorReceipt({ decision: 'denied', appSlug: slug, reason: 'owner-approval-refused' });
      throw error;
    }
  }
  let selection = null;
  let grant;
  try {
    grant = await mintForCaller({
      slug: options.app, permissions: options.permissions, selected: (chosen) => { selection = chosen; },
    });
  } catch (error) {
    operatorReceipt({ decision: 'failed', appSlug: selection?.appSlug, reason: selection ? 'mint-failed' : 'no-app-selected' });
    throw error;
  }
  // An owner-approved mint says so; otherwise the reason is the selector.
  operatorReceipt({
    decision: 'granted',
    appSlug: selection?.appSlug,
    reason: approvalRequired ? 'owner-approved' : (selection?.reason ?? selectionReason()),
  });
  process.stdout.write(formatMintGrant(grant, { json: options.json }));
}

// Operator mints leave a secret-free receipt in the same audit stream as the
// daemon's /v0/credential mints (#107): which App, the outcome, and a fixed
// reason code — never the token, the key, or an error's text. Writing it is
// best effort: a receipt that cannot be written warns and never changes
// whether a token is released.
function operatorReceipt({ decision, appSlug = null, reason }) {
  try {
    appendAuditReceipt({ event: 'credential-mint', operation: 'mint-token', decision, appSlug: appSlug ?? null, reason });
  } catch (error) {
    console.error(`mint-token: could not write the mint receipt: ${error.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`mint-token: ${err.message}`);
    process.exit(1);
  });
}
