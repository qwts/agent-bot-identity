#!/usr/bin/env node
// `agent-bot soul env export` and `soul env import`: the process entry. The
// commands live in soul-env-export.mjs; the soul's interaction records
// (#583) are in the daemon's store, which the soul module may not import,
// so this entry composes the two and hands the store's export and merge in.
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { mergeSoulInteraction, readSoulInteraction, soulInteractionExport } from '../agent-jobs.mjs';
import { TRANSFER_USAGE, soulEnvExportCommand, soulEnvImportCommand } from '../soul-env-export.mjs';

export const SOUL_INTERACTION = Object.freeze({ collect: soulInteractionExport, read: readSoulInteraction, merge: mergeSoulInteraction });

export function soulEnvTransfer(verb, args, options = {}) {
  const command = verb === 'export' ? soulEnvExportCommand : verb === 'import' ? soulEnvImportCommand : null;
  if (!command) return Promise.reject(new Error(TRANSFER_USAGE));
  return command(args, { interaction: SOUL_INTERACTION, ...options });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [verb, ...args] = process.argv.slice(2);
  soulEnvTransfer(verb, args).catch((error) => {
    const failure = { code: error.code ?? `soul-env-${verb === 'import' ? 'import' : 'export'}-failed`, message: error.message, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul env ${verb ?? 'export'}: ${failure.code}: ${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  });
}
