// Live-session events over SEP-3415 MCP events/poll (#39): validation for
// relay.message events, the one transport seam (nextEvents — a future
// events/stream implementation must be a drop-in with the same signature
// and return shape), and the on-disk cursor store.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
export async function nextEvents({ session, harness, cursor = null, waitMs = 0, maxEvents = 1, sleep = defaultSleep }) {
  const want = Math.max(Number(maxEvents) || 0, 1);
  const deadline = Date.now() + waitMs;
  let at = cursor;
  const dropped = [];
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
      // Only a well-formed cursor can name a position; an event whose
      // own cursor is malformed is dropped but cannot be advanced past
      // (a prod cursor is server-generated base64url — always well-formed).
      if (typeof ev?.cursor === 'string' && CURSOR_RE.test(ev.cursor)) last = ev.cursor;
    }
    const next = last !== sent ? last : (typeof out?.cursor === 'string' ? out.cursor : sent);
    at = next;
    if (events.length || Date.now() >= deadline) {
      return { events: events.slice(0, want), dropped, cursor: next, truncated: Boolean(out?.truncated) };
    }
    // Drops only: hasMore means another page is ready — keep walking without
    // sleeping only when this poll actually moved the cursor; a stuck
    // cursor falls through to the sleep path so a buggy server cannot
    // hot-loop us until the deadline.
    if (out?.hasMore && next !== sent) continue;
    const nap = Math.min(Math.max(Number(out?.nextPollMs) || 5000, 1000), 60000, Math.max(deadline - Date.now(), 0));
    if (nap <= 0) return { events, dropped, cursor: next, truncated: Boolean(out?.truncated) };
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
