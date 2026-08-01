#!/usr/bin/env node

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentBotArgs } from './cli/parse.mjs';
import { dispatchAgentBot } from './cli/dispatch.mjs';
import { formatCliError, helpText } from './cli/output.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function packageVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

export function main(argv = process.argv.slice(2)) {
  const parsed = parseAgentBotArgs(argv);
  if (parsed.kind === 'help') {
    process.stdout.write(helpText());
    return 0;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  return dispatchAgentBot(parsed);
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(formatCliError(error));
  process.exitCode = 1;
}
