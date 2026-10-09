#!/usr/bin/env node
// `agent-bot mint-token`: the command line over mint-token.mjs. It lives in
// cli because it owns the documented stdout format (cli/mint-output.mjs);
// mint-token.mjs keeps the library every other module imports (#645).
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { MINT_USAGE, mint, parseMintArgs } from '../mint-token.mjs';
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
  // before.
  if (ownerApprovalRequired({ argv: process.argv })) {
    const slug = explicitAppArg(process.argv);
    requireOwnerApproval({
      prompt: `Approve a GitHub App installation token for ${slug}[bot] — mint-token was run in the owner's account with no stated agent identity.`,
    });
  }
  const grant = await mint({ permissions: options.permissions });
  process.stdout.write(formatMintGrant(grant, { json: options.json }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`mint-token: ${err.message}`);
    process.exit(1);
  });
}
