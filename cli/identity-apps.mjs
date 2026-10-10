#!/usr/bin/env node
// `agent-bot identity apps|app|addon`: the command line over identity-apps.mjs,
// with the owner gate wired (owner-action.mjs) so --principal-stdin is checked
// against the broker and prompts name each soul, and the census wired
// (identity-app-souls.mjs) so Apps are checked against each soul (#645).
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { identityAppFailure, identityAppsCommand } from '../identity-apps.mjs';
import { identityAppSouls } from '../identity-app-souls.mjs';
import { assertOwnerAction } from '../owner-action.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  identityAppsCommand(process.argv.slice(2), { assertOwner: assertOwnerAction, souls: identityAppSouls }).catch((error) => {
    const failure = identityAppFailure(error);
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`${failure.code}: ${failure.message}\n`);
    process.exitCode = 1;
  });
}
