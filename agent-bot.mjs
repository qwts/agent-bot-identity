#!/usr/bin/env node

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentBotArgs } from './cli/parse.mjs';
import { dispatchAgentBot } from './cli/dispatch.mjs';
import { formatCliError, helpText } from './cli/output.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function packageVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

/**
 * A host's bundled tools first on this process's own PATH, not only on the
 * souls' (soulEnvironment): GeniusBar names its agent-comms and its git in
 * AGENT_BOT_TOOL_PATH (GeniusBar#102), and the daemon and the CLI run git
 * themselves for worktrees, so on a Mac without the Command Line Tools they
 * would otherwise find only /usr/bin/git's stub. Returns the PATH it set.
 */
export function hostToolsFirst(env = process.env) {
  const tools = env.AGENT_BOT_TOOL_PATH;
  if (!tools || !isAbsolute(tools)) return env.PATH;
  const rest = (env.PATH ?? '').split(delimiter).filter((dir) => dir && dir !== tools);
  env.PATH = [tools, ...rest].join(delimiter);
  return env.PATH;
}

export function main(argv = process.argv.slice(2)) {
  hostToolsFirst();
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
