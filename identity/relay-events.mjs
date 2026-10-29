// Live-session events over SEP-3415 MCP events/poll (#39): validation for
// relay.message events, the one transport seam (nextEvents — a future
// events/stream implementation must be a drop-in with the same signature
// and return shape), and the on-disk cursor store.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.mjs';
import { serverStateDir } from './server-client.mjs';

export const RELAY_EVENT = 'relay.message';
// Shared identifier charset for relay ids/correlations/session ids and
// the receipts that name them — server ids are always msg-…/rcpt-…, so a
// leading alphanumeric is required (same rule as receipt references).
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// GitHub login: alphanumeric with single hyphens, case-preserving (Qwts ok).
const FROM_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

export function validateRelayEvent(ev, harness) {
  const d = ev?.data;
  const reason = !(ev && typeof ev === 'object') ? 'not an object'
    : ev.name !== RELAY_EVENT ? 'wrong event name'
    : typeof ev.eventId !== 'string' || !ID_RE.test(ev.eventId) ? 'bad id'
    : typeof ev.cursor !== 'string' || !CURSOR_RE.test(ev.cursor) ? 'bad cursor'
    : !(d && typeof d === 'object') ? 'no data'
    : d.id !== ev.eventId ? 'data id does not match event id'
    : d.harness !== harness ? 'event is for a different harness'
    : typeof d.from !== 'string' || !FROM_RE.test(d.from) ? 'bad sender'
    : typeof d.body !== 'string' || Buffer.byteLength(d.body, 'utf8') > 16384 ? 'bad body'
    : d.untrusted !== true ? 'not marked untrusted'
    : (d.correlation !== undefined && d.correlation !== null && (typeof d.correlation !== 'string' || !ID_RE.test(d.correlation))) ? 'bad correlation'
    : (d.reply_to !== undefined && d.reply_to !== null && typeof d.reply_to !== 'string') ? 'bad reply_to'
    : null;
  // relayed_text is the service's own wrapping and is never read: the text
  // shown to a harness is built from data.body only, so a forged line in
  // relayed_text cannot inject into context.
  if (reason) {
    return { ok: false, reason, id: typeof ev?.eventId === 'string' ? ev.eventId : null, cursor: typeof ev?.cursor === 'string' ? ev.cursor : null };
  }
  return { ok: true, event: { id: ev.eventId, cursor: ev.cursor, from: d.from, body: d.body, correlation: d.correlation ?? null, reply_to: d.reply_to ?? null, received_at: ev.timestamp ?? null } };
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Poll until a valid event, a deadline, or a hasMore page. The returned
// cursor sits after the last returned-or-dropped event so malformed events
// are never redelivered; when the server sends more than maxEvents the
// cursor stays at the last event the caller was given — nothing is skipped.
// Event transport: 'auto' (edge push, falling back to poll), 'poll', or
// 'edge'. Resolution order: option > AGENT_BOT_EVENT_TRANSPORT >
// settings.eventTransport > 'auto'.
function eventTransport(env) {
  const envValue = env?.AGENT_BOT_EVENT_TRANSPORT;
  let value = envValue;
  if (value === undefined) {
    // A config the caller cannot read fails safe: poll, the transport
    // that needs no extra endpoint or ticket.
    try { value = loadConfig({ env }).settings?.eventTransport; } catch { return 'poll'; }
  }
  return ['auto', 'poll', 'edge'].includes(value) ? value : 'auto';
}

const EDGE_UNSUPPORTED_MS = 5 * 60 * 1000;
const FRAME_MAX = 64 * 1024;
const EDGE_REMINT_REASONS = new Set(['revoked', 'revalidation_unavailable', 'ticket_expired']);
const edgeError = (message, cursor = null) => Object.assign(new Error(message), { edge: true, cursor });

// Server cursors are v1.<sub>.<pos>; only advance, never rewind.
function cursorAhead(candidate, current) {
  if (typeof candidate !== 'string' || !CURSOR_RE.test(candidate) || candidate === current) return false;
  const pos = (c) => /^v1\.([^.]+)\.(\d+)$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
  const a = pos(candidate); const b = pos(current ?? '!');
  if (a && b && a[1] === b[1]) return Number(a[2]) > Number(b[2]);
  return true; // different subscription or shape — the server moved on
}

// The advertised SSE endpoint must be https — loopback http only so tests
// can run without TLS.
function sseUrlOk(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
  } catch { return false; }
}

function edgeTicketKey(harness) { return harness; }
function ticketValid(t) { return t && Date.parse(t.expiresAt) - 30000 > Date.now(); }

async function edgeTicket(session, harness, cursor) {
  const cache = (session._edgeTickets ??= new Map());
  const key = edgeTicketKey(harness);
  const held = cache.get(key);
  if (ticketValid(held)) return held;
  const t = await session.mcpEdgeTicket({ name: RELAY_EVENT, args: { harness }, cursor });
  // The ticket is a bearer secret: it is held in memory only, never
  // logged, receipted, or interpolated into any thrown message.
  const held2 = { ticket: String(t.ticket), expiresAt: t.expiresAt, cursor: t.cursor ?? null, sse: t.sse ?? null };
  cache.set(key, held2);
  return held2;
}
function dropTicket(session, harness) { session._edgeTickets?.delete(edgeTicketKey(harness)); }

// One SSE subscription attempt against the edge. Throws `edge` errors on
// any failure the caller may fall back from; returns the same event shape
// as nextEvents plus transport:'edge'.
async function edgeEvents({ session, harness, cursor, waitMs, maxEvents, sleep }) {
  const deadline = Date.now() + waitMs;
  const want = maxEvents;
  const fetchImpl = session.edgeFetch ?? session.fetch ?? fetch;
  let at = cursor;
  const dropped = [];
  const events = [];
  let truncated = false;
  let remints = 0;
  if (typeof session.mcpEdgeTicket !== 'function') throw edgeError('this session cannot mint edge tickets', at);
  // The stream's own timer is the truth for "edge did the waiting": it
  // fires on a monotonic clock that can beat the wall-clock deadline
  // by a hair, so callers ask endedBy, not Date.now().
  // Precedence: 'max-events' > 'deadline' > 'eof'.
  let timedOut = false;
  const endedBy = () => (events.length >= want ? 'max-events' : (timedOut || Date.now() >= deadline ? 'deadline' : 'eof'));
  for (;;) {
    const ticket = await edgeTicket(session, harness, at);
    if (!sseUrlOk(ticket.sse)) { dropTicket(session, harness); throw edgeError('the edge advertised a non-https sse endpoint', at); }
    const url = `${ticket.sse}?cursor=${encodeURIComponent(at ?? ticket.cursor ?? '')}`;
    const ctl = new AbortController();
    timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; ctl.abort(); }, Math.max(deadline - Date.now(), 1));
    let res;
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${ticket.ticket}`, accept: 'text/event-stream' }, signal: ctl.signal, redirect: 'error' });
    } catch (e) {
      clearTimeout(timeout);
      if (Date.now() >= deadline) return { events, dropped, cursor: at, truncated, transport: 'edge', endedBy: endedBy() };
      throw edgeError(`edge sse fetch failed: ${e?.name ?? 'error'}`, at);
    }
    if (res.status === 401) {
      clearTimeout(timeout);
      dropTicket(session, harness);
      if (remints < 1) { remints += 1; continue; }
      throw edgeError('the edge refused the minted ticket', at);
    }
    if (!res.ok) { clearTimeout(timeout); throw edgeError(`the edge answered ${res.status} for the sse stream`, at); }
    // Read frames: split on blank lines, cap each frame at 64 KiB.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let streamEnded = false;
    let fail = null;
    try {
      while (events.length < want && Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) { streamEnded = true; break; }
        buf += dec.decode(value, { stream: true });
        let sep;
        while ((sep = /\r?\n\r?\n/.exec(buf)) !== null) {
          const frame = buf.slice(0, sep.index);
          buf = buf.slice(sep.index + sep[0].length);
          let data = '';
          for (const raw of frame.split('\n')) {
            const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            if (line.startsWith('data:')) data += line.slice(5).trimStart();
          }
          if (!data) continue;
          let note;
          try { note = JSON.parse(data); } catch { fail = edgeError('an edge frame carried malformed JSON', at); break; }
          const p = note?.params ?? note ?? {};
          const method = note?.method ?? '';
          if (method.endsWith('/event')) {
            const ev = { ...p, cursor: p.cursor ?? p.event?.cursor };
            // A replayed or stale position is skipped entirely: not
            // delivered, not a drop, never receipted again.
            const cursorIsFresh = typeof ev?.cursor === 'string' && CURSOR_RE.test(ev.cursor) && cursorAhead(ev.cursor, at);
            const cursorIsStale = typeof ev?.cursor === 'string' && CURSOR_RE.test(ev.cursor) && !cursorAhead(ev.cursor, at);
            if (!cursorIsStale) {
              const v = validateRelayEvent(ev, harness);
              if (v.ok) events.push(v.event);
              else dropped.push({ id: v.id, reason: v.reason });
            }
            if (cursorIsFresh) at = ev.cursor;
          } else if (method.endsWith('/active') || method.endsWith('/heartbeat')) {
            if (p?.truncated === true) truncated = true;
            if (cursorAhead(p?.cursor, at)) at = p.cursor;
          } else if (method.endsWith('/error')) {
            const reason = p?.error?.data?.reason;
            if (EDGE_REMINT_REASONS.has(reason)) dropTicket(session, harness);
            fail = edgeError(`the edge stream ended with an error frame${reason ? ` (${reason})` : ''}`, at);
            streamEnded = true;
          }
          if (events.length >= want || fail || streamEnded) break;
        }
        // Only the leftover (incomplete) tail is capped: a chunk of many
        // small frames drains below it, one unterminated giant does not.
        if (buf.length > FRAME_MAX) { fail = edgeError('an edge frame exceeded the 64 KiB cap', at); break; }
        if (fail || streamEnded || events.length >= want) break;
      }
    } catch (e) {
      if (ctl.signal.aborted || Date.now() >= deadline) break;
      fail = edgeError(`the edge stream failed: ${e?.name ?? 'error'}`, at);
    } finally {
      clearTimeout(timeout);
      try { await reader.cancel(); } catch { /* best effort */ }
    }
    if (events.length || Date.now() >= deadline) return { events: events.slice(0, want), dropped, cursor: at, truncated, transport: 'edge', endedBy: endedBy() };
    if (fail) throw fail;
    // A clean stream end returns whatever the stream yielded — 'auto'
    // falls through to polling; the next call opens a fresh stream.
    break;
  }
  return { events: events.slice(0, want), dropped, cursor: at, truncated, transport: 'edge', endedBy: endedBy() };
}

export async function nextEvents({ session, harness, cursor = null, waitMs = 0, maxEvents = 1, sleep = defaultSleep, transport = null } = {}) {
  const mode = transport ?? eventTransport(session?.opts?.env);
  const want = Math.max(Number(maxEvents) || 0, 1);
  const deadline = Date.now() + waitMs;
  let at = cursor;
  const edgeDrops = [];
  // auto mode only: when the edge stream did the whole wait without a
  // failure, the one poll that runs after it is a catch-up check, not
  // the transport that waited — the result says so.
  let edgeHeld = false;
  if (mode !== 'poll' && !(session._edgeUnsupportedUntil > Date.now())) {
    try {
      const out = await edgeEvents({ session, harness, cursor: at, waitMs: Math.max(deadline - Date.now(), 0), maxEvents: want, sleep });
      // endedBy is internal bookkeeping — never part of the result.
      const edgeEndedBy = out.endedBy;
      delete out.endedBy;
      if (out.events.length || mode === 'edge') return { ...out, dropped: edgeDrops.concat(out.dropped) };
      // auto, edge produced no events (clean end or the wait burned out):
      // poll always runs next — even an immediate check — from wherever
      // the stream advanced the cursor.
      at = out.cursor;
      edgeDrops.push(...out.dropped);
      edgeHeld = edgeEndedBy === 'deadline';
    } catch (e) {
      if (mode === 'edge') throw e;
      // Coded service refusals (scope, cursor, credential) are not
      // transport failures — they surface exactly like the poll path.
      if (e?.code === 'event-edge-unsupported') session._edgeUnsupportedUntil = Date.now() + EDGE_UNSUPPORTED_MS;
      else if (!e?.edge) throw e;
      // Resume poll from wherever the edge attempt got — never backwards.
      if (cursorAhead(e?.cursor, at)) at = e.cursor;
    }
  } else if (mode === 'edge') {
    // Explicit edge with a fresh 'unsupported' memo: never fall back —
    // surface the same coded refusal the last attempt earned.
    const e = new Error('edge transport unavailable: the service reported events/edgeTicket unsupported');
    e.code = 'event-edge-unsupported';
    e.status = 400;
    throw e;
  }
  const dropped = edgeDrops;
  for (;;) {
    const sent = at;
    const out = await session.mcpEventsPoll({ name: RELAY_EVENT, args: { harness }, cursor: at, maxEvents: want });
    const events = [];
    let last = at;
    for (const ev of out?.events ?? []) {
      if (events.length >= want) break;
      const v = validateRelayEvent(ev, harness);
      if (v.ok) events.push(v.event);
      else dropped.push({ id: v.id, reason: v.reason });
      if (typeof ev?.cursor === 'string' && CURSOR_RE.test(ev.cursor)) last = ev.cursor;
    }
    const next = last !== sent ? last : (typeof out?.cursor === 'string' ? out.cursor : sent);
    at = next;
    if (events.length || Date.now() >= deadline) {
      return { events: events.slice(0, want), dropped, cursor: next, truncated: Boolean(out?.truncated), transport: edgeHeld ? 'edge' : 'poll', ...(edgeHeld ? { finalPoll: true } : {}) };
    }
    if (out?.hasMore && next !== sent) continue;
    const nap = Math.min(Math.max(Number(out?.nextPollMs) || 5000, 1000), 60000, Math.max(deadline - Date.now(), 0));
    if (nap <= 0) return { events, dropped, cursor: next, truncated: Boolean(out?.truncated), transport: edgeHeld ? 'edge' : 'poll', ...(edgeHeld ? { finalPoll: true } : {}) };
    await sleep(nap);
  }
}

// Cursors live under the device state directory: one entry per
// (event name, harness) subscription, 0600, atomic tmp+rename.
export const cursorKey = (harness) => `${RELAY_EVENT}:${harness}`;
const cursorFile = (opts) => join(serverStateDir(opts), 'event-cursors.json');

export function loadCursor(opts, key) {
  try {
    const stored = JSON.parse(readFileSync(cursorFile(opts), 'utf8'))?.[key];
    return typeof stored === 'string' && CURSOR_RE.test(stored) ? stored : null;
  } catch { return null; }
}

export function commitCursor(opts, key, cursor) {
  if (typeof cursor !== 'string' || !CURSOR_RE.test(cursor)) throw new Error('refusing to commit a malformed event cursor');
  const file = cursorFile(opts);
  mkdirSync(serverStateDir(opts), { recursive: true, mode: 0o700 });
  let map = {};
  try { map = JSON.parse(readFileSync(file, 'utf8')); } catch { /* a lost store re-arms */ }
  map[key] = cursor;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
  renameSync(tmp, file);
}

// Arming: with no stored cursor the subscription starts at the server's
// head — messages sent before the first arm are never delivered.
export async function armCursor({ session, harness, opts }) {
  const out = await session.mcpEventsPoll({ name: RELAY_EVENT, args: { harness }, cursor: null, maxEvents: 0 });
  const head = typeof out?.cursor === 'string' ? out.cursor : null;
  if (head) commitCursor(opts, cursorKey(harness), head);
  return head;
}
