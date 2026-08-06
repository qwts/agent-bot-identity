#!/usr/bin/env node

// Workstation-local census of Agent souls. Identity JSON remains provenance;
// this index answers population questions without teaching every consumer to
// scan identity records and Agent Spaces independently.

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateAgentId, withLock } from './agent-identity.mjs';

const SCHEMA_VERSION = 1;
const APP_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function printableText(name, value, { max = 512, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw new Error(`${name} is required`);
  }
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be printable text no longer than ${max} characters`);
  }
  return value;
}

function agentId(value, name = 'id') {
  try {
    return validateAgentId(value);
  } catch {
    throw new Error(`${name} must be a valid Agent ID`);
  }
}

function appSlug(value) {
  const slug = printableText('appSlug', value, { max: 100 });
  if (!APP_PATTERN.test(slug)) throw new Error('appSlug must be a GitHub App slug');
  return slug;
}

function canonicalTimestamp(name, value) {
  const text = printableText(name, value, { max: 40 });
  let normalized;
  try {
    normalized = new Date(text).toISOString();
  } catch {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  if (normalized !== text) throw new Error(`${name} must be a canonical ISO timestamp`);
  return text;
}

function transcriptLocator(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('transcriptLocator must be an object or null');
  }
  return {
    provider: printableText('transcriptLocator.provider', value.provider, { max: 80 }),
    id: printableText('transcriptLocator.id', value.id),
  };
}

function normalizeSoul(record, { defaultLastSeen = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('population record must be an object');
  }
  const root = printableText('spacePath', record.spacePath, { max: 4096 });
  if (!path.isAbsolute(root)) throw new Error('spacePath must be absolute');
  return {
    id: agentId(record.id),
    appSlug: appSlug(record.appSlug),
    parentId: record.parentId ? agentId(record.parentId, 'parentId') : null,
    status: printableText('status', record.status, { max: 80 }),
    spacePath: root,
    transcriptLocator: transcriptLocator(record.transcriptLocator),
    lastSeen: canonicalTimestamp('lastSeen', record.lastSeen ?? defaultLastSeen),
  };
}

export function populationFile({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_POPULATION_PATH) return path.resolve(env.AGENT_BOT_POPULATION_PATH);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'population.json');
}

function emptyDocument() {
  return { schemaVersion: SCHEMA_VERSION, souls: Object.create(null) };
}

function readDocument(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyDocument();
    throw new Error('population store could not be read');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON parser errors may quote store contents. The census must never turn
    // corruption into a secret-bearing diagnostic.
    throw new Error('population store is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('population store must be an object');
  }
  if (!Number.isSafeInteger(parsed.schemaVersion) || parsed.schemaVersion < SCHEMA_VERSION) {
    throw new Error('population store has an invalid schemaVersion');
  }
  if (!parsed.souls || typeof parsed.souls !== 'object' || Array.isArray(parsed.souls)) {
    throw new Error('population store souls must be an object');
  }

  const souls = Object.create(null);
  for (const [key, value] of Object.entries(parsed.souls)) {
    const soul = normalizeSoul(value);
    if (key !== soul.id) throw new Error('population store key does not match its Agent ID');
    souls[soul.id] = soul;
  }
  return { schemaVersion: parsed.schemaVersion, souls };
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    /* POSIX modes are best-effort on other platforms. */
  }
}

function writeDocument(file, souls) {
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const document = { schemaVersion: SCHEMA_VERSION, souls };
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function upsertSoul(
  record,
  { file = populationFile(), now = () => new Date() } = {},
) {
  const candidate = normalizeSoul(record, { defaultLastSeen: now().toISOString() });
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'population store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) {
      throw new Error('population store uses a future schemaVersion; refusing to rewrite it');
    }
    const existing = current.souls[candidate.id];
    if (existing && JSON.stringify(existing) === JSON.stringify(candidate)) return existing;
    const souls = { ...current.souls, [candidate.id]: candidate };
    writeDocument(file, souls);
    return candidate;
  });
}

function filterValue(name, value, { app = false } = {}) {
  if (value === undefined || value === null) return null;
  return app ? appSlug(value) : printableText(name, value, { max: 80 });
}

export function listSouls({
  status = null,
  app = null,
  file = populationFile(),
} = {}) {
  const wantedStatus = filterValue('status', status);
  const wantedApp = filterValue('app', app, { app: true });
  const records = Object.values(readDocument(file).souls)
    .filter((record) => wantedStatus === null || record.status === wantedStatus)
    .filter((record) => wantedApp === null || record.appSlug === wantedApp);
  records.sort((left, right) => left.id.localeCompare(right.id));
  return records;
}

export function showSoul(id, { file = populationFile() } = {}) {
  const target = agentId(id);
  const soul = readDocument(file).souls[target];
  if (!soul) throw new Error(`no population record for ${target}`);
  return soul;
}

function parseCli(argv) {
  const [command = 'list', ...tokens] = argv.slice(2);
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    if (token === '--json') {
      flags.set('json', true);
      continue;
    }
    if (!['--status', '--app'].includes(token)) throw new Error(`unknown option: ${token}`);
    const value = tokens[++index];
    if (!value) throw new Error(`${token} requires a value`);
    flags.set(token.slice(2), value);
  }
  return { command, positional, flags };
}

function formatPopulation(records) {
  const lines = ['ID\tAPP\tSTATUS\tPARENT\tLAST SEEN\tSPACE\tTRANSCRIPT'];
  for (const record of records) {
    const transcript = record.transcriptLocator
      ? `${record.transcriptLocator.provider}:${record.transcriptLocator.id}`
      : '-';
    lines.push([
      record.id,
      record.appSlug,
      record.status,
      record.parentId ?? '-',
      record.lastSeen,
      record.spacePath,
      transcript,
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseCli(process.argv);
  switch (args.command) {
    case 'list': {
      if (args.positional.length > 0) throw new Error('population list does not accept Agent IDs');
      const records = listSouls({ status: args.flags.get('status'), app: args.flags.get('app') });
      if (args.flags.has('json')) process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
      else process.stdout.write(formatPopulation(records));
      break;
    }
    case 'show': {
      if (args.flags.has('status') || args.flags.has('app')) {
        throw new Error('population show does not accept filters');
      }
      if (args.positional.length !== 1) throw new Error('population show requires one Agent ID');
      let soul;
      try {
        soul = showSoul(args.positional[0]);
      } catch (error) {
        if (error.message.startsWith('id must be')) throw new Error('invalid Agent ID in this context');
        throw error;
      }
      process.stdout.write(`${JSON.stringify(soul, null, 2)}\n`);
      break;
    }
    default:
      throw new Error(
        'usage: agent-bot population list [--status <status>] [--app <slug>] [--json]\n' +
          '       agent-bot population show <agent-id> [--json]',
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-population: ${error.message}\n`);
    process.exit(1);
  });
}
