// `agent-bot events` — the bound soul's live-session events through the
// loopback daemon (#39): wait/peek for relayed messages (cursor-based —
// ack commits; not acking redelivers), and manual cursor commits. Used
// directly and from harness hooks (Devin Stop / PostToolUse); hook paths
// fail soft — they never block a turn on an events error.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readBinding } from './agent-binding.mjs';
import { stateDirectory } from '../state-paths.mjs';
import { daemonClient } from './daemon-client.mjs';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const readStdin = async () => {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try { return JSON.parse(data); } catch { return {}; }
};
// Consecutive Stop-hook blocks are capped per session: a harness loop that
// keeps answering events could otherwise stop a session forever. After
// STOP_BLOCK_CAP consecutive blocked stops the hook lets the turn end.
const STOP_BLOCK_CAP = 10;
const stopBlocksFile = ({ env, home }) => `${stateDirectory({ env, home })}/events-stop-blocks.json`;
function readStopBlocks({ env, home }) {
  try { return JSON.parse(readFileSync(stopBlocksFile({ env, home }), 'utf8')); }
  catch { return {}; }
}
function writeStopBlocks({ env, home }, counts) {
  try {
    mkdirSync(path.dirname(stopBlocksFile({ env, home })), { recursive: true, mode: 0o700 });
    writeFileSync(stopBlocksFile({ env, home }), JSON.stringify(counts), { mode: 0o600 });
  } catch { /* a lost counter just resets the cap */ }
}

const usage = () => {
  process.stderr.write('usage: agent-bot events <wait|peek|ack> [options]\n');
  return 2;
};

const arg = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const nextLine = (cursor) => `Next: run \`agent-bot events wait --cursor ${cursor}\` to wait for the next message.`;

// Poll /v0/events/wait in ≤25 s chunks until an event or the deadline.
// Network errors and 5xx back off 1 s doubling to 60 s; device-revoked
// stops immediately. Returns {events, cursor, error}; never throws except
// for revocation.
async function takeLoop({ client, binding, timeoutMs, sessionId, cursor }) {
  const deadline = Date.now() + timeoutMs;
  let backoff = 1000;
  let lastError = null;
  for (;;) {
    const waitSeconds = Math.min(25, Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    try {
      const out = await client.eventsWait(binding.secret, { waitSeconds, sessionId, cursor });
      // The route's cursor may have moved past drops the daemon committed;
      // carry it so the next chunk never re-fetches them.
      if (typeof out?.cursor === 'string' && out.cursor !== cursor) cursor = out.cursor;
      if (out?.events?.length) return { events: out.events, cursor: out.cursor, error: null };
      if (Date.now() >= deadline) return { events: [], cursor: out?.cursor ?? cursor, error: lastError };
      backoff = 1000;
    } catch (error) {
      if (error?.code === 'device-revoked') throw error;
      lastError = error;
      if (Date.now() + backoff >= deadline) return { events: [], cursor, error };
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

async function ackQuietly(client, binding, { cursor, ids, sessionId = null }) {
  if (typeof cursor !== 'string' || !cursor) return;
  await client.eventsAck(binding.secret, { cursor, ids, sessionId }).catch(() => {});
}

async function main(argv) {
  const [first, ...rest] = argv;
  const [sub, ...args] = first === 'events' ? rest : [first, ...rest];
  const env = process.env;
  const cwd = process.cwd();
  if (!sub || !['wait', 'peek', 'ack'].includes(sub)) return usage();
  const binding = readBinding({ env, cwd });
  if (!binding) { process.stderr.write('agent-bot events: no soul binding in this checkout\n'); return 1; }
  const client = daemonClient({ env, cwd });

  if (sub === 'ack') {
    const cursor = arg(args, '--cursor');
    if (!cursor) return usage();
    const out = await client.eventsAck(binding.secret, { cursor, ids: args.filter((a, i) => args[i - 1] === '--id') });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }
  const format = arg(args, '--format') ?? 'text';
  if (sub === 'wait') {
    const timeout = Math.min(Number(arg(args, '--timeout') ?? 120) || 0, 3600);
    const cursorArg = arg(args, '--cursor');
    if (format === 'devin-stop') {
      // Stop-hook stdin: {hook_event_name, stop_hook_active, session_id, ...}.
      // Only session_id is used; prompt/last_assistant_message are never read.
      const hook = await readStdin();
      const sessionId = typeof hook.session_id === 'string' ? hook.session_id : null;
      const blocksKey = sessionId ?? 'unknown';
      const counting = hook.stop_hook_active === true;
      const home = env.HOME ?? env.USERPROFILE;
      if (!counting) {
        // A stop outside an active hook loop starts a fresh chain.
        const counts = readStopBlocks({ env, home });
        if (blocksKey in counts) { delete counts[blocksKey]; writeStopBlocks({ env, home }, counts); }
      }
      try {
        const { events, cursor, error: takeError } = await takeLoop({ client, binding, timeoutMs: timeout * 1000, sessionId, cursor: cursorArg });
        if (!events.length) {
          if (counting) { const counts = readStopBlocks({ env, home }); delete counts[blocksKey]; writeStopBlocks({ env, home }, counts); }
          if (takeError) process.stderr.write(`agent-bot events: ${takeError?.code ?? takeError?.message ?? 'events unavailable'} — letting the turn end\n`);
          return 0;
        }
        if (counting) {
          const counts = readStopBlocks({ env, home });
          const blocked = (counts[blocksKey] ?? 0) + 1;
          if (blocked > STOP_BLOCK_CAP) {
            // Capped: no ack — the cursor stays and the event may be taken
            // again once a clean stop resets the chain.
            process.stderr.write(`agent-bot events: ${STOP_BLOCK_CAP} consecutive blocks for this session — letting the stop through\n`);
            return 0;
          }
          counts[blocksKey] = blocked;
          writeStopBlocks({ env, home }, counts);
        }
        const reason = `${events.map((event) => event.text).join('\n')}\n${nextLine(cursor)}`;
        process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
        await ackQuietly(client, binding, { cursor, ids: events.map((event) => event.id), sessionId });
      } catch (error) {
        process.stderr.write(`agent-bot events: ${error?.code ?? error?.message ?? 'events unavailable'} — letting the turn end\n`);
      }
      return 0;
    }
    try {
      const { events, cursor, error } = await takeLoop({ client, binding, timeoutMs: timeout * 1000, cursor: cursorArg });
      if (!events.length) {
        if (error) { process.stderr.write(`agent-bot events: ${error?.code ?? 'error'}: ${error?.message ?? 'events unavailable'}\n`); return 1; }
        return 0;
      }
      process.stdout.write(`${events.map((event) => event.text).join('\n')}\n${nextLine(cursor)}\n`);
      await ackQuietly(client, binding, { cursor, ids: events.map((event) => event.id) });
      return 0;
    } catch (error) {
      process.stderr.write(`agent-bot events: ${error?.code ?? 'error'}: ${error?.message ?? 'events unavailable'}\n`);
      return 1;
    }
  }
  // peek
  const hookEnv = format === 'devin-context' ? await readStdin() : null;
  const out = await client.eventsWait(binding.secret, { waitSeconds: 0, sessionId: typeof hookEnv?.session_id === 'string' ? hookEnv.session_id : null }).catch((error) => ({ events: [], error }));
  const events = out.events ?? [];
  if (format === 'devin-context') {
    const hook = hookEnv;
    if (!events.length) return 0;
    // Delivery into context counts: commit the cursor after printing.
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: hook.hook_event_name ?? 'PostToolUse', additionalContext: events.map((event) => event.text).join('\n') } })}\n`);
    await ackQuietly(client, binding, { cursor: out.cursor, ids: events.map((event) => event.id), sessionId: hook?.session_id ?? null });
    return 0;
  }
  // A plain peek does not consume: the cursor is left for a later wait.
  process.stdout.write(`${JSON.stringify({ events, cursor: out.cursor })}\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`agent-bot events: ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
