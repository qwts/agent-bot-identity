#!/usr/bin/env node
// `agent-bot identity migrate-credentials`: the command line over
// soul-credentials.mjs, with the owner gate wired (owner-action.mjs) so
// --principal-stdin is checked against the broker and prompts name each
// soul (#645).
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { migrateCredentialsCommand } from '../soul-credentials.mjs';
import { assertOwnerAction } from '../owner-action.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateCredentialsCommand(process.argv.slice(2), { assertOwner: assertOwnerAction }).then((report) => {
    if (report.souls.some((row) => row.status === 'failed') || report.apps.some((row) => row.metadata.status === 'failed')) process.exitCode = 1;
  }).catch((error) => {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'migrate-credentials-failed', message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot identity migrate-credentials: ${error.message}\n`);
    process.exitCode = 1;
  });
}
