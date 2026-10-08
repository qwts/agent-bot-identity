#!/usr/bin/env node
// `agent-bot soul env history`: the soul's history mirror as a read (#583
// follow-up 9, ADR-0583 decision 9; GeniusBar#268's Memory tab). The
// mirror under `<soul>/.soul-state/runs/` is facts only (ids, kinds,
// times, harness, outcome, a revision's reason; never a prompt, an output
// or a secret), so listing it is read-only, needs no gate and leaves no
// receipt: a host renders the soul's past turns without reading soul files
// itself (logic in the CLI, the app is glue). Records come newest first,
// at most `--limit` per file, from a bounded window of each file.
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { populationFile, showSoul, showSoulByName, soulDirectory } from './agent-population.mjs';
import { HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX, readSoulHistory } from './soul-history.mjs';

export const HISTORY_SCHEMA_VERSION = 1;
const USAGE = 'usage: agent-bot soul env history <agentId|name> [--json] [--limit N]';
const cleanLine = (value) => String(value ?? '-').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

function fail(code, message, { action = null } = {}) {
  throw Object.assign(new Error(message), { code, action });
}

function lstat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return null; throw error; }
}

function resolveSoul(id, options) {
  const file = options.file ?? populationFile(options);
  try { return typeof id === 'string' && id.startsWith('agent_') ? showSoul(id, { file }) : showSoulByName(id, { file }); }
  catch (error) {
    if (/no population record|id must be a valid Agent ID|no soul named|souls named/.test(error.message)) fail('soul-not-found', 'Soul not found.');
    throw error;
  }
}

// The registered folder, or where it would be: a read never provisions.
function soulRoot(soul, options) {
  const registered = typeof soul.soulDir === 'string' && lstat(soul.soulDir)?.isDirectory() ? soul.soulDir : null;
  return registered ?? soulDirectory(soul.id, { ...options, readOnly: true });
}

export function formatHistory(result) {
  const count = (group) => `${group.listed} of ${group.total ?? '-'}`;
  const lines = [`agentId: ${result.agentId}`, `soulDir: ${cleanLine(result.soulDir)}`, `mirror: ${cleanLine(result.mirror)}`, `turns: ${count(result.turns)}`,
    ...result.turns.records.map((turn) => [turn.startedAt, turn.kind, turn.harness, turn.outcome, turn.id].map(cleanLine).join('  ')),
    `revisions: ${count(result.revisions)}`,
    ...result.revisions.records.map((revision) => `${cleanLine(revision.at)}  ${cleanLine(revision.id)}  (${cleanLine(revision.parent)})  ${cleanLine(revision.reason)}`)];
  return `${lines.join('\n')}\n`;
}

/**
 * `agent-bot soul env history <soul> [--json] [--limit N]`. Prints
 * `{ schemaVersion, agentId, soulDir, mirror, mirrored, turns, revisions }`
 * with each group `{ total, listed, limit, skipped, truncated, records[] }`
 * newest first (readSoulHistory). `--limit` is 1..HISTORY_LIMIT_MAX,
 * default HISTORY_LIMIT_DEFAULT; anything else is a usage error. An
 * unknown soul is `soul-not-found`; a soul without a mirror lists nothing
 * with `mirrored: false` rather than failing, since a life may not have
 * started yet.
 */
export function soulEnvHistoryCommand(argv, { write = (value) => process.stdout.write(value), env = process.env, home = env.HOME ?? homedir(), ...rest } = {}) {
  let id = null, json = false, limit = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--limit' && limit === null && typeof argv[i + 1] === 'string') {
      // Digits only, within the bound: a host that asks for more pages instead.
      if (!/^\d{1,3}$/.test(argv[i + 1]) || Number(argv[i + 1]) < 1 || Number(argv[i + 1]) > HISTORY_LIMIT_MAX) throw new Error(USAGE);
      limit = Number(argv[i + 1]);
      i += 1;
    } else if (!arg.startsWith('-') && id === null) id = arg;
    else throw new Error(USAGE);
  }
  if (!id) throw new Error(USAGE);
  const options = { env, home, ...rest };
  const soul = resolveSoul(id, options);
  const soulDir = soulRoot(soul, options);
  const result = { schemaVersion: HISTORY_SCHEMA_VERSION, agentId: soul.id, soulDir, ...readSoulHistory(soulDir, { limit: limit ?? HISTORY_LIMIT_DEFAULT }) };
  write(json ? `${JSON.stringify(result)}\n` : formatHistory(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { soulEnvHistoryCommand(process.argv.slice(2)); }
  catch (error) {
    const failure = { code: error.code ?? 'soul-env-history-failed', message: error.message, action: error.action ?? null };
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`agent-bot soul env history: ${failure.code}: ${failure.message}${failure.action ? `\n  -> ${failure.action}` : ''}\n`);
    process.exitCode = 1;
  }
}
