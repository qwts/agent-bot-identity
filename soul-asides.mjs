#!/usr/bin/env node

// Asides (#404): the agent-comms messages that actually entered, or left, a
// soul's context, recorded so a control surface can show "A said to B" and
// "B answered" inside each soul's conversation, the same on a team or off it.
//
// An aside is written only where the daemon knows the message reached a
// session or came out of one:
//
//   - `relay-prompt`: a cold-wake relay turn's woken message, recorded when
//     the harness session for that turn exists (the prompt goes into it).
//   - `thread-context`: the earlier thread messages (#393) that prompt
//     carried; `reshown` marks them so a client never counts them as new.
//   - `send_message` / `start_soul`: a soul's own sends, from the reach
//     server that made them.
//   - `final-reply`: the reply the relay sent from a turn's final answer.
//
// Messages that only reached a mailbox, were acked without a turn, or that a
// soul read itself with `agent-comms inbox read` (a batch wake or a live
// session) leave no aside here: the daemon cannot see what entered those
// contexts. A turn's final answer of NO_REPLY sends nothing, so it is never
// recorded; a real message whose body happens to be NO_REPLY is.
//
// Asides are daemon state like the thread journal: 0700 directory, 0600
// files, bounded, and read only by the owner (`agent-bot soul asides`, which
// refuses a caller carrying a soul marker) or a principal allowed to observe
// the soul (GET /v1/souls/<id>/asides).

import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { isAgentId, stateDirectory, validateAgentId, withLock } from './agent-identity.mjs';
import { listSouls, populationFile, showSoul, showSoulByName } from './agent-population.mjs';
import { NO_REPLY, clip } from './soul-threads.mjs';

export const ASIDE_VIA = Object.freeze(['relay-prompt', 'thread-context', 'send_message', 'start_soul', 'final-reply']);
const BODY_LIMIT = 2048;
const KEEP = 2000;
const MAX_BYTES = 2 * 1024 * 1024;
// A trim keeps the newest asides up to half the byte limit (and KEEP), so
// the file grows for a while before the next trim instead of every append
// rereading and rewriting it.
const TRIM_FRACTION = 0.5;
// Turn -> harness session, so a reach-server send (which starts before its
// turn's session id exists) records the session its turn went into.
const TURN_SESSIONS_KEEP = 64;
export const READ_LIMIT_DEFAULT = 200;
const READ_LIMIT_MAX = 1000;
// A parent chain longer than this is corrupt; it reads as no team.
const MAX_CHAIN = 64;

export function asidesDirectory({ env = process.env, home = homedir() } = {}) {
  return path.join(stateDirectory({ env, home }), 'asides');
}

function asidesPath(agentId, options) {
  return path.join(asidesDirectory(options), `${validateAgentId(agentId)}.jsonl`);
}

function turnSessionsPath(agentId, options) {
  return path.join(asidesDirectory(options), `${validateAgentId(agentId)}.turns.json`);
}

function readTurnSessions(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Records which harness session a turn's prompt went into. The cold waker
// calls this when the session exists, before the prompt is sent, so every
// send the turn makes afterwards can name it. Best effort.
export function bindTurnSession(agentId, turnId, harnessSessionId, { env = process.env, home = homedir() } = {}) {
  try {
    if (!stringOrNull(turnId) || !stringOrNull(harnessSessionId)) return false;
    const file = turnSessionsPath(agentId, { env, home });
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    withLock(`${file}.lock`, 'aside turn sessions', () => {
      const entries = Object.entries(readTurnSessions(file)).filter(([key]) => key !== turnId);
      entries.push([turnId, harnessSessionId]);
      const pending = `${file}.${process.pid}.tmp`;
      writeFileSync(pending, JSON.stringify(Object.fromEntries(entries.slice(-TURN_SESSIONS_KEEP))), { mode: 0o600 });
      renameSync(pending, file);
    });
    return true;
  } catch {
    return false;
  }
}

export function turnSession(agentId, turnId, { env = process.env, home = homedir() } = {}) {
  if (!stringOrNull(turnId)) return null;
  try {
    return stringOrNull(readTurnSessions(turnSessionsPath(agentId, { env, home }))[turnId]);
  } catch {
    return null;
  }
}

// The newest lines that fit both `keep` and `budget` bytes.
function newestWithin(lines, keep, budget) {
  const kept = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0 && kept.length < keep; index -= 1) {
    const size = Buffer.byteLength(lines[index]) + 1;
    if (bytes + size > budget) break;
    kept.push(lines[index]);
    bytes += size;
  }
  return kept.reverse();
}

function stringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function censusRows({ env, home }) {
  try { return listSouls({ file: populationFile({ env, home }) }); } catch { return []; }
}

// The team a soul belongs to: the root of its parent chain, when the soul has
// a parent or has started souls of its own. A soul on no team reads null.
export function teamOf(agentId, rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  let root = agentId;
  for (let depth = 0; byId.get(root)?.parentId; depth += 1) {
    if (depth > MAX_CHAIN) return null;
    root = byId.get(root).parentId;
  }
  if (root !== agentId) return root;
  return rows.some((row) => row.parentId === agentId) ? agentId : null;
}

// The name a person knows a soul by: its soul.json `name` ("Bill - Starter"),
// else the census name.
function soulLabel(row) {
  if (typeof row?.soulDir === 'string' && path.isAbsolute(row.soulDir)) {
    try {
      const name = JSON.parse(readFileSync(path.join(row.soulDir, 'soul.json'), 'utf8'))?.name;
      if (typeof name === 'string' && name.trim() !== '' && name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name)) return name.trim();
    } catch { /* no readable soul.json */ }
  }
  return typeof row?.name === 'string' ? row.name : null;
}

// A peer address as the relay spells it: a principal id, a bare agent id or
// `account/agentId`. The soul's name is added for a soul known here.
export function describePeer(address, rows) {
  const value = stringOrNull(address);
  if (value === null) return { address: null, agentId: null, principal: null, name: null };
  if (value.startsWith('principal_')) return { address: value, agentId: null, principal: value, name: null };
  const tail = value.split('/').pop();
  const agentId = isAgentId(tail) ? tail : null;
  const row = agentId ? rows.find((candidate) => candidate.id === agentId) : null;
  const name = row ? soulLabel(row) : null;
  return { address: value, agentId, principal: null, name };
}

// Records one aside for `agentId`. Best effort, like the thread journal: an
// aside that cannot be written never fails a turn or a send.
export function recordAside(agentId, entry, {
  env = process.env, home = homedir(), now = () => new Date(), keep = KEEP, maxBytes = MAX_BYTES, rows = null,
} = {}) {
  try {
    if (!ASIDE_VIA.includes(entry?.via)) return null;
    const body = typeof entry.body === 'string' ? entry.body : '';
    if (entry.via === 'final-reply' && body.trim() === NO_REPLY) return null;
    const census = rows ?? censusRows({ env, home });
    const aside = {
      id: `aside_${randomUUID()}`,
      at: now().toISOString(),
      dir: entry.dir === 'out' ? 'out' : 'in',
      via: entry.via,
      reshown: entry.via === 'thread-context',
      peer: describePeer(entry.peer, census),
      messageId: stringOrNull(entry.messageId),
      replyTo: stringOrNull(entry.replyTo),
      correlation: stringOrNull(entry.correlation),
      teamId: teamOf(validateAgentId(agentId), census),
      turnId: stringOrNull(entry.turnId),
      harnessSessionId: stringOrNull(entry.harnessSessionId) ?? turnSession(agentId, entry.turnId, { env, home }),
      ...(entry.via === 'thread-context' ? { sentAt: stringOrNull(entry.sentAt) } : {}),
      body: clip(body, BODY_LIMIT),
    };
    const file = asidesPath(agentId, { env, home });
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // The daemon and each turn's reach server append to the same file, so
    // the append and any trim are one locked step.
    withLock(`${file}.lock`, 'aside journal', () => {
      appendFileSync(file, `${JSON.stringify(aside)}\n`, { mode: 0o600 });
      if (statSync(file).size > maxBytes) {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const kept = newestWithin(lines, keep, Math.floor(maxBytes * TRIM_FRACTION));
        const pending = `${file}.${process.pid}.tmp`;
        writeFileSync(pending, kept.length > 0 ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
        renameSync(pending, file);
      }
    });
    return aside;
  } catch {
    return null;
  }
}

// Asides oldest first. `after` is an aside id: only later asides are
// returned (an id no longer kept returns from the start). `next` is the
// cursor for the following page, null at the end.
export function readAsides(agentId, { after = null, limit = READ_LIMIT_DEFAULT, env = process.env, home = homedir() } = {}) {
  const file = asidesPath(agentId, { env, home });
  const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, READ_LIMIT_MAX) : READ_LIMIT_DEFAULT;
  let entries = [];
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object' && typeof entry.id === 'string') entries.push(entry);
      } catch { /* a torn line is skipped */ }
    }
  }
  if (after !== null && after !== undefined) {
    const index = entries.findIndex((entry) => entry.id === after);
    if (index >= 0) entries = entries.slice(index + 1);
  }
  const page = entries.slice(0, size);
  return { asides: page, next: entries.length > size ? page[page.length - 1].id : null };
}

const USAGE = 'usage: agent-bot soul asides <agentId|name> [--after ASIDE_ID] [--limit N] [--json]';

function resolveSoul(target, file) {
  try { return showSoul(validateAgentId(target), { file }); } catch (error) {
    if (/^agent_/.test(target)) throw error;
    return showSoulByName(target, { file });
  }
}

export async function soulAsidesCommand(argv, {
  env = process.env, home = homedir(), cwd = process.cwd(), write = (text) => process.stdout.write(text),
  markers = async () => (await import('./owner-gate.mjs')).soulMarkers({ env, cwd }),
} = {}) {
  const json = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json');
  const [target, ...rest] = args;
  if (!target || target.startsWith('--')) throw new Error(USAGE);
  let after = null;
  let limit = READ_LIMIT_DEFAULT;
  for (let index = 0; index < rest.length; index += 2) {
    const value = rest[index + 1];
    if (value === undefined) throw new Error(USAGE);
    if (rest[index] === '--after') after = value;
    else if (rest[index] === '--limit' && /^\d+$/.test(value)) limit = Number(value);
    else throw new Error(USAGE);
  }
  // Asides quote other souls' messages: a soul never reads them, only the
  // owner (no soul marker) or a principal over the daemon route.
  const found = await markers();
  if (found.length > 0) {
    throw Object.assign(new Error(`asides are for the owner; this caller carries a soul marker (${found.join(', ')})`), { code: 'not-owner' });
  }
  const soul = resolveSoul(target, populationFile({ env, home }));
  const result = { agentId: soul.id, ...readAsides(soul.id, { after, limit, env, home }) };
  if (json) write(`${JSON.stringify(result)}\n`);
  else {
    for (const aside of result.asides) {
      const who = aside.peer?.name ?? aside.peer?.address ?? 'unknown';
      const arrow = aside.dir === 'out' ? `→ ${who}` : `← ${who}`;
      write(`${aside.at} ${arrow} [${aside.via}${aside.teamId ? ` team ${aside.teamId}` : ''}] ${JSON.stringify(aside.body)}\n`);
    }
    if (result.next) write(`more: --after ${result.next}\n`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  soulAsidesCommand(process.argv.slice(2)).catch((error) => {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'soul-asides-failed', message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot soul asides: ${error.message}\n`);
    process.exitCode = 1;
  });
}
