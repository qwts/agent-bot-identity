// W3C Trace Context `traceparent` values (ADR-0983 decision 6).
//
// A traceparent links diagnostic events across processes, and later across
// machines (qwts/qwts-agent-org#46). It is never identity, authorization or
// evidence of who sent it: a caller may put anything in it. A value that does
// not parse is replaced by a fresh trace, never repaired or trusted.
//
// The grammar is exactly the one agent-comms forwards (agent-comms#164,
// #1027): version 00, lowercase hex, nonzero IDs, 55 characters, nothing
// before or after. A value the broker would drop is dropped here too, so the
// two ends never disagree about what continues a trace.

import { randomBytes } from 'node:crypto';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/**
 * `{ traceId, spanId, flags }` from an exact version-00 traceparent, or null.
 * Anything else is null: another version, uppercase, surrounding whitespace,
 * a suffix, or an all-zero trace or span ID.
 */
export function parseTraceparent(value) {
  if (typeof value !== 'string' || value.length !== 55) return null;
  const match = TRACEPARENT.exec(value);
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId, flags };
}

export function formatTraceparent({ traceId, spanId, flags = '01' }) {
  return `00-${traceId}-${spanId}-${flags}`;
}

function randomHex(bytes, zero) {
  for (;;) {
    const value = randomBytes(bytes).toString('hex');
    if (value !== zero) return value;
  }
}

/**
 * A span context for a new operation: a child of `parent` when it is a valid
 * traceparent (string or parsed), else the root of a new trace. Returns
 * `{ traceId, spanId, parentSpanId, flags, traceparent }`.
 */
export function startSpan(parent = null) {
  const context = typeof parent === 'string' ? parseTraceparent(parent)
    : (parent && typeof parent.traceId === 'string' ? parseTraceparent(formatTraceparent(parent)) : null);
  const traceId = context?.traceId ?? randomHex(16, ZERO_TRACE);
  const spanId = randomHex(8, ZERO_SPAN);
  const flags = context?.flags ?? '01';
  return { traceId, spanId, parentSpanId: context?.spanId ?? null, flags, traceparent: formatTraceparent({ traceId, spanId, flags }) };
}
