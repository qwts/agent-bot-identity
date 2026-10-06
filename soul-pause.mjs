#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { soulControlCommand } from './soul-stop.mjs';

export const soulPauseCommand = (argv, options) => soulControlCommand('pause', argv, options);
export const soulResumeCommand = (argv, options) => soulControlCommand('resume', argv, options);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, ...argv] = process.argv.slice(2);
  const command = { pause: soulPauseCommand, resume: soulResumeCommand }[action];
  Promise.resolve().then(() => {
    if (!command) throw new Error('usage: agent-bot soul pause|resume <agentId|name> [--json]');
    return command(argv);
  }).catch((error) => {
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? `soul-${action}-failed`, message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot soul ${action}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
