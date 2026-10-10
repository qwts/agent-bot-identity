#!/usr/bin/env node
// `agent-bot principal`: the command line over agent-principals.mjs, with the
// owner gate wired (owner-action.mjs) so --principal-stdin is checked against
// the broker and prompts name each soul (#645, #779).
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { principalCommand } from '../agent-principals.mjs';
import { assertOwnerAction } from '../owner-action.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principalCommand(process.argv.slice(2), {
    gate: (action, { principal }) => assertOwnerAction(action, { principal }),
  }).catch((error) => {
    process.stderr.write(`agent-principals: ${error.message}\n`);
    process.exit(1);
  });
}
