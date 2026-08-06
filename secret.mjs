#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createSecretProviderRegistry, getSecret } from './secret-store.mjs';
import { protonPassAdapter } from './secret-providers/proton-pass.mjs';

export const BUILTIN_SECRET_PROVIDERS = Object.freeze([protonPassAdapter]);

export function secretHelpText() {
  return `Usage: agent-bot secret get --provider <id> --collection <name> --item <title> --field <name> --reason <text>\n\n` +
    `Reads one password or API-key field from an already-authorized secure store.\n` +
    `The reason is sent to providers that audit agent access.\n` +
    `Success writes only the exact field value to stdout, without a trailing newline.\n`;
}

export function parseSecretArgs(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { kind: 'help' };
  const [operation, ...tokens] = argv;
  if (operation !== 'get') throw new Error('unsupported secret operation');
  if (tokens.length === 1 && (tokens[0] === '--help' || tokens[0] === '-h')) return { kind: 'help' };
  const flags = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error('unexpected positional argument');
    const name = token.slice(2);
    if (!['provider', 'collection', 'item', 'field', 'reason'].includes(name)) {
      throw new Error('unknown option');
    }
    if (flags.has(name)) throw new Error('duplicate option');
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    flags.set(name, value);
    index += 1;
  }
  return {
    kind: 'get',
    provider: flags.get('provider'),
    collection: flags.get('collection'),
    item: flags.get('item'),
    field: flags.get('field'),
    reason: flags.get('reason'),
  };
}

function hasAgentConfiguration(config) {
  const apps = config?.apps;
  return (typeof config?.prefix === 'string' && config.prefix.length > 0)
    || (apps && typeof apps === 'object' && !Array.isArray(apps)
      && Object.values(apps).some((slug) => typeof slug === 'string' && slug.length > 0));
}

export function main(argv = process.argv.slice(2), {
  registry = createSecretProviderRegistry(BUILTIN_SECRET_PROVIDERS),
  stdout = process.stdout,
  config = loadConfig(),
} = {}) {
  const parsed = parseSecretArgs(argv);
  if (parsed.kind === 'help') {
    stdout.write(secretHelpText());
    return 0;
  }
  if (!hasAgentConfiguration(config)) {
    throw new Error('agent-bot configuration is required for secret retrieval');
  }
  stdout.write(getSecret(parsed, { registry }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`secret: ${error.message}\n`);
    process.exitCode = 1;
  }
}
