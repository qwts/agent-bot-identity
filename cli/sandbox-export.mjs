#!/usr/bin/env node
// `agent-bot sandbox export`: the process entry (#750). The command lives in
// sandbox-export.mjs; a soul's archive is `soul env export`'s, with the
// soul's interaction records from the daemon's store, which only this entry
// may compose in. The category's owner gate has already been passed when a
// soul is exported, so the soul export asks no second one.
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { sandboxExportCommand } from '../sandbox-export.mjs';
import { soulEnvTransfer } from './soul-env-transfer.mjs';

export const exportSoulForSandbox = (agentId, target) => soulEnvTransfer('export', [agentId, '--to', target], { gate: async () => {}, write: () => {} });

export function sandboxExport(args, options = {}) {
  return sandboxExportCommand(args, { exportSoul: exportSoulForSandbox, ...options });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sandboxExport(process.argv.slice(2)).catch((error) => {
    const failure = { code: error.code ?? 'sandbox-export-failed', message: error.message, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot sandbox export: ${failure.code === 'usage' ? '' : `${failure.code}: `}${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  });
}
