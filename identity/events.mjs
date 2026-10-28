// `agent-bot events` — the bound soul's live-session events through the
// loopback daemon (api.md "Messages and live-session events"): wait/peek for
// message notices, ack or release leases, and reply. Used directly and from
// harness hooks (Devin Stop / PostToolUse); hook paths fail soft — they
// never block a turn on an events error.

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
  process.stderr.write('usage: agent-bot events <wait|peek|ack|release|reply> [options]\n');
  return 2;
};

const arg = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const textsOf = (events) => events.map((event) => event.text).join('\n\n');

async function takeLoop({ client, binding, timeoutMs, sessionId }) {
  const deadline = Date.now() + timeoutMs;
  let backoff = 1000;
  let lastError = null;
  for (;;) {
    const waitSeconds = Math.min(25, Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    try {
      const out = await client.eventsWait(binding.secret, { waitSeconds, count: 10, sessionId });
      if (out?.events?.length) return { events: out.events, error: null };
      if (Date.now() >= deadline) return { events: [], error: lastError };
      backoff = 1000;
    } catch (error) {
      if (error?.code === 'device-revoked') throw error;
      lastError = error;
      if (Date.now() + backoff >= deadline) return { events: [], error };
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

async function ackQuietly(client, binding, events) {
  const leases = events.map((event) => event.lease).filter(Boolean);
  if (!leases.length) return;
  const out = await client.eventsAck(binding.secret, leases).catch(() => null);
  if (out && (out.stale?.length || out.missing?.length)) {
    process.stderr.write(`agent-bot events: ${[...(out.stale ?? []), ...(out.missing ?? [])].length} lease(s) were stale or missing — the event may come back; dedupe on the notice id\n`);
  }
}

async function main(argv) {
  const [first, ...rest] = argv;
  const [sub, ...args] = first === 'events' ? rest : [first, ...rest];
  const env = process.env;
  const cwd = process.cwd();
  if (!sub || !['wait', 'peek', 'ack', 'release', 'reply'].includes(sub)) return usage();
  const binding = readBinding({ env, cwd });
  if (!binding) { process.stderr.write('agent-bot events: no soul binding in this checkout\n'); return 1; }
  const client = daemonClient({ env, cwd });

  if (sub === 'ack' || sub === 'release') {
    if (!args.length) return usage();
    const out = sub === 'ack' ? await client.eventsAck(binding.secret, args) : await client.eventsRelease(binding.secret, args);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }
  if (sub === 'reply') {
    const to = arg(args, '--to');
    const key = arg(args, '--key');
    const file = arg(args, '--body-file');
    const body = file ? readFileSync(file === '-' ? 0 : file, 'utf8') : arg(args, '--body');
    if (!to || !key || typeof body !== 'string') return usage();
    const out = await client.eventsReply(binding.secret, {
      to, key, body, correlation: arg(args, '--correlation'), replyTo: arg(args, '--reply-to'),
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }
  const format = arg(args, '--format') ?? 'json';
  if (sub === 'wait') {
    const timeout = Math.min(Number(arg(args, '--timeout') ?? 120) || 0, 3600);
    if (format === 'devin-stop') {
      // Stop-hook stdin: {hook_event_name, stop_hook_active, session_id, ...}.
      // Only session_id is used; prompt/last_assistant_message are never read.
      const hook = await readStdin();
      const sessionId = typeof hook.session_id === 'string' ? hook.session_id : null;
      const blocksKey = sessionId ?? 'unknown';
      const counting = hook.stop_hook_active === true;
      const home = env.HOME ?? env.USERPROFILE;
      try {
        const { events, error: takeError } = await takeLoop({ client, binding, timeoutMs: timeout * 1000, sessionId });
        if (!events.length) {
          if (counting) { const counts = readStopBlocks({ env, home }); delete counts[blocksKey]; writeStopBlocks({ env, home }, counts); }
          if (takeError) process.stderr.write(`agent-bot events: ${takeError?.code ?? takeError?.message ?? 'events unavailable'} — letting the turn end\n`);
          return 0;
        }
        if (counting) {
          const counts = readStopBlocks({ env, home });
          const blocked = (counts[blocksKey] ?? 0) + 1;
          if (blocked > STOP_BLOCK_CAP) {
            const leases = events.map((event) => event.lease).filter(Boolean);
            if (leases.length) await client.eventsRelease(binding.secret, leases).catch(() => {});
            process.stderr.write(`agent-bot events: ${STOP_BLOCK_CAP} consecutive blocks for this session — letting the stop through\n`);
            return 0;
          }
          counts[blocksKey] = blocked;
          writeStopBlocks({ env, home }, counts);
        }
        const reason = `Untrusted relayed messages follow; reply with: agent-bot events reply --to <from> --key <new key> --reply-to <id> --body ...\n${events.map((event) => event.text).join('\n')}`;
        process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
        await ackQuietly(client, binding, events);
      } catch (error) {
        process.stderr.write(`agent-bot events: ${error?.code ?? error?.message ?? 'events unavailable'} — letting the turn end\n`);
      }
      return 0;
    }
    const { events } = await takeLoop({ client, binding, timeoutMs: timeout * 1000 });
    process.stdout.write(`${JSON.stringify({ events })}\n`);
    return 0;
  }
  // peek
  const hookEnv = format === 'devin-context' ? await readStdin() : null;
  const out = await client.eventsWait(binding.secret, { waitSeconds: 0, count: 10, sessionId: typeof hookEnv?.session_id === 'string' ? hookEnv.session_id : null }).catch((error) => ({ events: [], error }));
  const events = out.events ?? [];
  if (format === 'devin-context') {
    const hook = hookEnv;
    if (!events.length) return 0;
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: hook.hook_event_name ?? 'PostToolUse', additionalContext: textsOf(events) } })}\n`);
    await ackQuietly(client, binding, events);
    return 0;
  }
  // A plain peek does not consume: release the leases it was dealt.
  const leases = events.map((event) => event.lease).filter(Boolean);
  if (leases.length) await client.eventsRelease(binding.secret, leases).catch(() => {});
  process.stdout.write(`${JSON.stringify({ events })}\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`agent-bot events: ${error?.message ?? error}\n`);
  process.exitCode = 1;
}
