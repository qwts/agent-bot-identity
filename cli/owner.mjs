#!/usr/bin/env node
// `agent-bot owner`: the command line over owner-statement.mjs (ADR-0753),
// with keyd's owner key record wired (owner-presence.mjs) for enroll and
// remove, keyd's statement store for sign and enroll, the soul markers, and
// owner-key audit receipts.
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { appendAuditReceipt } from '../identity-format.mjs';
import { soulMarkers } from '../owner-action.mjs';
import { attestedOwnerKeys, keydAttestPins, keydStatementStore } from '../owner-presence.mjs';
import { ownerCommand } from '../owner-statement.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ownerCommand(process.argv.slice(2), {
    // Enrolment and removal change the trust roots: keyd shows the owner
    // the whole new key set and records it, or nothing changes (#753).
    attest: (pins, options) => keydAttestPins(pins, options),
    // verify counts a signature as the owner's only when keyd vouches, for
    // this call, that the pins read are the set the owner approved (#753).
    attestPins: (pins, options) => attestedOwnerKeys(pins, options),
    // The keyd store: keyd shows the owner what they sign and signs it with
    // the owner statement key, for `owner sign --store keyd` and `owner
    // enroll --store keyd` (#753).
    keydStore: (options) => keydStatementStore(options),
    markers: ({ env, cwd }) => soulMarkers({ env, cwd }),
    receipt: (fields, options) => appendAuditReceipt(fields, options),
  }).then((result) => {
    if (result?.ok === false) process.exitCode = 1;
  }, (error) => {
    process.stderr.write(`agent-bot owner: ${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = error.code === 'owner-usage' ? 2 : 1;
  });
}
