#!/usr/bin/env node

// Read-only view of the interaction audit JSONL for GeniusBar and the CLI.
import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

import { auditFile } from './agent-principals.mjs';

const USAGE = 'usage: agent-bot audit list [--json] [--since ISO-8601|-P1D] [--agent AGENT_ID] [--event KIND] [--limit N] | audit tail [--json] [--agent ID]';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

function sinceTime(value, now) {
  // Relative ISO durations use fixed units; calendar months/years are ambiguous.
  const duration = /^-P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (duration && duration.slice(1).some((part) => part !== undefined)) {
    const [weeks, days, hours, minutes, seconds] = duration.slice(1).map((part) => Number(part ?? 0));
    const time = now().getTime() - (((weeks * 7 + days) * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
    if (Number.isFinite(time)) return time;
  }
  const time = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new Error('--since needs an ISO-8601 timestamp or negative duration such as -P1D');
  return time;
}

function options(argv, now) {
  const [action, ...args] = argv;
  if (!['list', 'tail'].includes(action)) throw new Error(USAGE);
  const result = { action, json: false, limit: DEFAULT_LIMIT };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(USAGE);
    seen.add(flag);
    if (flag === '--json') { result.json = true; continue; }
    const allowed = action === 'list' ? ['--agent', '--event', '--since', '--limit'] : ['--agent'];
    if (!allowed.includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(USAGE);
    const value = args[++i];
    if (flag === '--limit') {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_LIMIT) {
        throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
      }
      result.limit = Number(value);
    } else if (flag === '--since') result.since = sinceTime(value, now);
    else result[flag.slice(2)] = value;
  }
  return result;
}

function recordFrom(line, filters) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (!record || Array.isArray(record) || typeof record !== 'object'
    || typeof record.at !== 'string' || typeof record.event !== 'string') return null;
  if (filters.agent !== undefined && record.agentId !== filters.agent) return null;
  if (filters.event !== undefined && record.event !== filters.event) return null;
  if (filters.since !== undefined && !(Date.parse(record.at) >= filters.since)) return null;
  return record;
}

function plain(record) {
  return ['at', 'event', 'principalId', 'transport', 'agentId', 'operation', 'decision', 'detail']
    .filter((key) => record[key] !== undefined)
    .map((key) => String(record[key]).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')).join(' ');
}

async function list(file, filters) {
  const records = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const record = recordFrom(line, filters);
      if (record) {
        records.push(record);
        if (records.length > filters.limit) records.shift();
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally { lines.close(); }
  return records;
}

function tail(file, filters, { write, stdin, signals, pollIntervalMs }) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    let identity = null;
    let pending = '';
    let decoder = new StringDecoder('utf8');
    let timer;
    let stopped = false;
    const wasPaused = stdin.readableFlowing !== true;
    const finish = (error) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      signals.off('SIGINT', stop);
      stdin.off('end', stop);
      stdin.off('close', stop);
      if (wasPaused) {
        stdin.pause?.();
        stdin.unref?.();
      }
      if (error) reject(error); else resolve();
    };
    const stop = () => finish();
    const poll = () => {
      if (stopped) return;
      let fd;
      try {
        try { fd = openSync(file, 'r'); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        const stat = fstatSync(fd);
        const nextIdentity = `${stat.dev}:${stat.ino}`;
        if (identity !== nextIdentity || stat.size < offset) {
          offset = 0;
          pending = '';
          decoder = new StringDecoder('utf8');
          identity = nextIdentity;
        }
        const buffer = Buffer.alloc(64 * 1024);
        while (!stopped && offset < stat.size) {
          const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (!bytes) break;
          offset += bytes;
          pending += decoder.write(buffer.subarray(0, bytes));
          let newline;
          while (!stopped && (newline = pending.indexOf('\n')) !== -1) {
            const record = recordFrom(pending.slice(0, newline), filters);
            pending = pending.slice(newline + 1);
            if (record) write(`${filters.json ? JSON.stringify(record) : plain(record)}\n`);
          }
        }
      } catch (error) { finish(error); }
      finally { if (fd !== undefined) closeSync(fd); }
    };
    signals.on('SIGINT', stop);
    stdin.on('end', stop);
    stdin.on('close', stop);
    timer = setInterval(poll, pollIntervalMs);
    poll();
    if (stopped) return;
    if (stdin.readableEnded || stdin.destroyed) stop();
    else stdin.resume?.();
  });
}

export async function auditCommand(argv, {
  env = process.env,
  home = homedir(),
  write = (text) => process.stdout.write(text),
  now = () => new Date(),
  stdin = process.stdin,
  signals = process,
  pollIntervalMs = 250,
} = {}) {
  const filters = options(argv, now);
  const file = auditFile({ env, home });
  if (filters.action === 'tail') return tail(file, filters, { write, stdin, signals, pollIntervalMs });
  const records = await list(file, filters);
  if (filters.json) write(`${JSON.stringify({ records })}\n`);
  else for (const record of records) write(`${plain(record)}\n`);
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  auditCommand(process.argv.slice(2)).catch((error) => {
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ error: { code: error.code ?? 'audit-failed', message: error.message } })}\n`);
    }
    process.stderr.write(`agent-bot audit: ${error.message}\n`);
    process.exitCode = 1;
  });
}
