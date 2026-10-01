// Wake dispatch (#256) — the seam between a paired daemon's `account-watch`
// stream and the warm pool (#147).
//
// ADR-0008 decision 7 fixes the wire: the broker streams one coalesced
// `{ event: 'wake', agentId, count, cursor, messageIds }` per soul, and the
// daemon answers with `wake-report { agentId, messageIds, outcome, detail }`
// where the outcome is `warm`, `cold`, `waiting`, or `failed`. The broker
// records it beside each message and in the census `lastWake`.
//
// The dispatcher itself is pure: every capability it touches is an injected
// port, so the outcome table below is testable without a broker, a socket, or
// an ACP turn. The sibling issues own the ports themselves and nothing here
// re-implements them:
//
//   pool      — the warm sockets (#147): `has(agentId)` and
//               `send(agentId, frame) -> number delivered`, plus
//               `drop(agentId)` to retire a soul whose every socket failed.
//   coldWake  — the per-soul opt-in cold path (#259): `coldWake(event)` returns
//               `null` when the owner has cold wake off for that soul, and
//               otherwise `{ outcome, detail }`.
//   report    — the broker port: `report(agentId, messageIds, outcome, detail)`.
//   receipt   — the daemon's own audit sink: `receipt(object)`.
//
// The outcome table this pins, and why each row exists:
//
//   warm     — at least one warm socket took the frame. A soul's own
//              `inbox watch` also counts as warm upstream, so R1 workers are
//              unaffected by anything here.
//   cold     — no warm socket, and the cold path took the wake (ADR-0008
//              decision 9). Only the cold path may return it.
//   waiting  — no warm socket and cold wake is off for that soul. This is the
//              honest answer, not a failure: the message is durable and the
//              next arm of a session or a future `wake listen` collects it.
//   failed   — the warm pool claimed sockets but delivered to none, or the
//              cold path itself failed. A send error on every socket is a
//              `failed`, never a `waiting`: the sockets are dropped so the
//              soul is honestly cold next time.
//
// Every dispatch also writes a receipt. The receipt is `{ agentId, count,
// outcome }` and nothing else: it names a soul and a count, never message
// content, a cursor, or anything a socket carried — the audit trail must not
// become a second copy of the mailbox.

import { isAgentId } from './agent-identity.mjs';

export const WAKE_OUTCOMES = Object.freeze(['warm', 'cold', 'waiting', 'failed']);
export const WAKE_FRAME_EVENT = 'wake';
// The cold path (#259) owns `cold`, `failed`, and `waiting`; it can never
// answer `warm`, because a soul it woke had no warm socket to answer from.
const COLD_OUTCOMES = Object.freeze(['cold', 'failed', 'waiting']);
const MAX_MESSAGE_IDS = 512;
// A detail is broker-visible text: printable, bounded, and never a payload.
const MAX_DETAIL_LENGTH = 200;

function failDispatch(message) {
  throw new Error(`wake dispatch: ${message}`);
}

function boundedDetail(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    failDispatch('detail must be a non-empty string when present');
  }
  if (value.length > MAX_DETAIL_LENGTH || /[\x00-\x1f\x7f]/.test(value)) {
    failDispatch(`detail must be printable text no longer than ${MAX_DETAIL_LENGTH} characters`);
  }
  return value;
}

// The frame a warm socket receives. Built field by field from the watch event
// so an unexpected extra field on the event (a future broker addition, a
// redaction) is never forwarded to a listener by accident.
export function wakeFrame(event) {
  return {
    event: WAKE_FRAME_EVENT,
    agentId: event.agentId,
    count: event.count,
    cursor: event.cursor,
    messageIds: [...event.messageIds],
  };
}

function validateEvent(event) {
  if (!event || typeof event !== 'object') failDispatch('wake event must be an object');
  if (event.event !== undefined && event.event !== WAKE_FRAME_EVENT) {
    failDispatch(`event must be '${WAKE_FRAME_EVENT}'`);
  }
  if (!isAgentId(event.agentId)) failDispatch('wake event requires a valid agentId');
  if (!Number.isSafeInteger(event.count) || event.count < 0) {
    failDispatch('wake event requires a non-negative integer count');
  }
  // The broker's cursor is the oldest unacked sequence number; accept an
  // opaque string too so a future cursor format does not break dispatch.
  const cursorOk = (Number.isSafeInteger(event.cursor) && event.cursor >= 0)
    || (typeof event.cursor === 'string' && event.cursor.length > 0);
  if (!cursorOk) failDispatch('wake event requires a sequence-number or string cursor');
  if (!Array.isArray(event.messageIds) || event.messageIds.length > MAX_MESSAGE_IDS) {
    failDispatch(`wake event requires an array of at most ${MAX_MESSAGE_IDS} message IDs`);
  }
  for (const id of event.messageIds) {
    if (typeof id !== 'string' || id.length === 0) failDispatch('message IDs must be non-empty strings');
  }
  return event;
}

function assertPorts(ports) {
  const { pool, coldWake, report, receipt } = ports;
  if (!pool || typeof pool.has !== 'function' || typeof pool.send !== 'function') {
    failDispatch('pool must provide has(agentId) and send(agentId, frame)');
  }
  if (coldWake !== null && coldWake !== undefined && typeof coldWake !== 'function') {
    failDispatch('coldWake must be a function or null');
  }
  if (typeof report !== 'function') failDispatch('report must be a function');
  if (receipt !== null && receipt !== undefined && typeof receipt !== 'function') {
    failDispatch('receipt must be a function or null');
  }
  return ports;
}

// Retire the soul's sockets. Best-effort by design: a pool that refuses to drop
// must not change the outcome the broker already earned, but the sockets are
// still asked to go so the next wake for this soul starts cold.
function dropSockets(pool, agentId) {
  if (typeof pool.drop !== 'function') return false;
  try {
    pool.drop(agentId);
    return true;
  } catch {
    return false;
  }
}

// Dispatch one watch event and report what happened.
//
// Ports are the whole contract: `pool` must exist (the daemon always has a
// warm pool, even an empty one), `report` must exist to answer the broker, and
// `coldWake`/`receipt` may be null while their siblings are unmerged — a null
// cold path means the outcome is `waiting`, never a fabricated `cold`.
export async function dispatchWake(event, ports) {
  assertPorts(ports ?? {});
  const { pool, coldWake, report, receipt } = ports;
  const wake = validateEvent(event);
  const agentId = wake.agentId;
  const messageIds = [...wake.messageIds];

  let outcome = null;
  let detail = null;

  if (pool.has(agentId)) {
    const frame = wakeFrame(wake);
    let delivered;
    let sendError = null;
    try {
      delivered = await pool.send(agentId, frame);
    } catch (error) {
      // A pool that throws instead of counting has delivered to nobody, which
      // is the same condition as a zero return: the sockets are unusable.
      sendError = error?.message ?? 'unknown error';
      delivered = 0;
    }
    if (Number.isSafeInteger(delivered) && delivered > 0) {
      outcome = 'warm';
      detail = `delivered to ${delivered} warm socket(s)`;
    } else {
      // A send error on every socket is `failed`, never `waiting`, and the
      // sockets are dropped so the soul is honestly cold on its next wake.
      outcome = 'failed';
      detail = sendError === null
        ? 'every warm socket failed to take the frame'
        : `every warm socket failed to take the frame: ${sendError}`;
      dropSockets(pool, agentId);
    }
  } else if (typeof coldWake === 'function') {
    let cold = null;
    try {
      cold = await coldWake(wake);
    } catch (error) {
      cold = { outcome: 'failed', detail: `cold wake failed: ${error?.message ?? 'unknown error'}` };
    }
    if (cold === null || cold === undefined) {
      // The cold path was asked and declined: cold wake is off for this soul
      // (ADR-0008 decision 9), so the wake waits for a session to arm.
      outcome = 'waiting';
      detail = 'no warm socket and cold wake is off for this soul';
    } else if (typeof cold !== 'object' || !COLD_OUTCOMES.includes(cold.outcome)) {
      // A cold path that answers with something outside its own vocabulary is
      // a defect, and the broker still needs an answer for this wake. Fail
      // closed as `failed` rather than inventing a `cold` or a `waiting`.
      outcome = 'failed';
      detail = 'cold wake returned an outcome outside its contract';
    } else {
      outcome = cold.outcome;
      detail = boundedDetail(cold.detail) ?? null;
      if (detail === null && outcome === 'waiting') {
        detail = 'no warm socket and cold wake is off for this soul';
      }
    }
  } else {
    outcome = 'waiting';
    detail = 'no warm socket and no cold wake path configured';
  }

  // The broker learns the outcome first: a wake report is what makes the
  // message's fate legible, and a receipt is the daemon's private audit of a
  // dispatch that already happened.
  await report(agentId, messageIds, outcome, detail);
  if (typeof receipt === 'function') {
    receipt({ event: 'wake', agentId, count: wake.count, outcome });
  }
  return { agentId, messageIds, outcome, detail, count: wake.count };
}

// The dispatcher a long-lived account-watch client holds: one
// `(event) => Promise` that serialises per agentId.
//
// Serialisation is per soul, not global. Two wakes for the same soul must not
// interleave — a report that lands after a newer one would leave the broker's
// `lastWake` reading backwards — while two different souls stay independent, so
// one soul's slow (or hanging) cold turn cannot stall the account. A rejected
// dispatch is reported to the caller and does not poison the queue behind it.
export function createWakeDispatcher(ports) {
  assertPorts(ports ?? {});
  const queues = new Map();
  return function wakeDispatcher(event) {
    const agentId = event?.agentId;
    if (typeof agentId !== 'string') return dispatchWake(event, ports);
    const previous = queues.get(agentId) ?? Promise.resolve();
    const next = previous.then(
      () => dispatchWake(event, ports),
      () => dispatchWake(event, ports),
    );
    // Keep the tail resolved so one failure never rejects the next link, and
    // drop the entry once the soul is idle so a long-lived daemon does not
    // accumulate one queue per soul it has ever woken.
    const tail = next.then(() => {}, () => {});
    queues.set(agentId, tail);
    tail.then(() => {
      if (queues.get(agentId) === tail) queues.delete(agentId);
    });
    return next;
  };
}
