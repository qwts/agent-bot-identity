#!/usr/bin/env node
// `agent-bot owner`: the command line over owner-statement.mjs (ADR-0753),
// with keyd's owner key record wired (owner-presence.mjs) for enroll and
// remove, the soul markers for sign, and owner-key audit receipts.
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from '../agent-principals.mjs';
import { soulMarkers } from '../owner-action.mjs';
import { keydAttestPins } from '../owner-presence.mjs';
import { ownerCommand } from '../owner-statement.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ownerCommand(process.argv.slice(2), {
    // Enrolment and removal change the trust roots: keyd shows the owner
    // the whole new key set and records it, or nothing changes (#753).
    attest: (pins, options) => keydAttestPins(pins, options),
    markers: ({ env, cwd }) => soulMarkers({ env, cwd }),
    receipt: (fields, options) => appendAuditReceipt(fields, options),
  }).then((result) => {
    if (result?.ok === false) process.exitCode = 1;
  }, (error) => {
    process.stderr.write(`agent-bot owner: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = error.code === 'owner-usage' ? 2 : 1;
  });
}
