// Draft, disabled producer-owned validation of daemon slot 14,
// `local-lifecycle-outcome` (agent-comms#77): the daemon's fixed typed local
// outcome. Pure: no slot write, route or reader integration yet.
//
// The shape is agent-comms' exact administrative outcome record (d071a9b,
// docs/owner-decision-journal-records.md "Exact administrative records"):
// {v:1, kind:"outcome", requestId, payloadDigest, state, receiptDigest,
// outcome:{code, effectDigest}, source, reportingDaemonKey,
// reportingDaemonEpoch, at}. This is not the broker's lifecycle validator. In
// this daemon slot the record is contextual: the request's own journal graph,
// not the record, decides which state, code and digest are possible, using the
// effect-outcomes-v1 mapping.
//
// The context, read by the caller from the validated journal graph:
// - `phase`: admitted, preparing, prepared, authorizing, released, refused,
//   indeterminate or applied;
// - `acceptance`: {requestId, payloadDigest, daemonKey, daemonEpoch};
// - `receiptDigest`: the saved receipt's digest, or null before one exists;
// - `effectDigest`: SHA-256 of the exact completed record (applied) or
//   pre-effect refused record (refused), otherwise null;
// - `refusalCode`: the refused record's reason (refused only).
import { canonicalJson } from '../canonical-json.mjs';
import { REFUSAL_OUTCOMES } from './owner-decision-evidence.mjs';

export const LOCAL_OUTCOME_CAP = 4096;
const KEYS = ['v', 'kind', 'requestId', 'payloadDigest', 'state', 'receiptDigest', 'outcome', 'source', 'reportingDaemonKey', 'reportingDaemonEpoch', 'at'];
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PHASES = ['admitted', 'preparing', 'prepared', 'authorizing', 'released', 'refused', 'indeterminate', 'applied'];
// Refusals with no durable record (effect-outcomes-v1 early results).
const EARLY_REFUSALS = ['validation-refused', 'authority-refused', 'deadline-expired'];
const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nullOr = (value, check) => value === null || check(value);

export function localOutcomeError(reason) {
  return Object.assign(new Error('owner decision local outcome refused'), { code: 'invalid-owner-decision-evidence', reason });
}
const fail = (reason) => { throw localOutcomeError(reason); };

// The outcomes the graph allows, as [state, code, effectDigest] triples.
function allowed({ phase, effectDigest, refusalCode }) {
  switch (phase) {
    // Before the decision arrives (the broker's preparing or prepared): an
    // early refusal, a cancellation or an expiry, none proven by an effect
    // record.
    case 'admitted':
    case 'preparing':
    case 'prepared': return EARLY_REFUSALS.map((code) => ['refused', code, null])
      .concat([['cancelled', 'cancelled', null], ['expired', 'deadline-expired', null]]);
    // Presence and receipt arrived, not yet released: no cancellation.
    case 'authorizing': return EARLY_REFUSALS.map((code) => ['refused', code, null]).concat([['expired', 'deadline-expired', null]]);
    // Released: any refusal or expiry must first be the durable pre-effect
    // refused record, so no local outcome stands on its own.
    case 'released': return [];
    case 'refused': return [['refused', REFUSAL_OUTCOMES[refusalCode], effectDigest]];
    // Entered alone proves neither application nor refusal.
    case 'indeterminate': return [['indeterminate', 'effect-uncertain', null]];
    case 'applied': return [['applied', 'applied', effectDigest]];
    default: return fail('owner-outcome-context');
  }
}

function checkContext(context) {
  const a = context?.acceptance;
  if (!plain(context) || !PHASES.includes(context.phase) || !plain(a) || !matches(UUID4, a.requestId) || !matches(DIGEST, a.payloadDigest)
    || !matches(DIGEST, a.daemonKey) || !Number.isSafeInteger(a.daemonEpoch) || a.daemonEpoch < 1
    || !nullOr(context.receiptDigest, (d) => matches(DIGEST, d))) fail('owner-outcome-context');
  const proven = ['refused', 'applied'].includes(context.phase);
  if (proven !== matches(DIGEST, context.effectDigest) || (!proven && context.effectDigest !== null)) fail('owner-outcome-context');
  if ((context.phase === 'refused') !== Object.hasOwn(REFUSAL_OUTCOMES, context.refusalCode ?? '')) fail('owner-outcome-context');
  // A receipt exists exactly from authorizing on.
  if (['admitted', 'preparing', 'prepared'].includes(context.phase) && context.receiptDigest !== null) fail('owner-outcome-context');
}

// Validates exact slot-14 payload bytes against the request's graph. Returns
// the record, or throws invalid-owner-decision-evidence with a fixed reason.
export function validateLocalLifecycleOutcome(bytes, context) {
  checkContext(context);
  let r;
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > LOCAL_OUTCOME_CAP) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    r = JSON.parse(text);
    if (canonicalJson(r) !== text) throw new Error();
  } catch { fail('owner-outcome-encoding'); }
  // The exact outcome shape, daemon origin only.
  if (!exact(r, KEYS) || r.v !== 1 || r.kind !== 'outcome' || !matches(UUID4, r.requestId) || !matches(DIGEST, r.payloadDigest)
    || !exact(r.outcome, ['code', 'effectDigest']) || !nullOr(r.outcome.effectDigest, (d) => matches(DIGEST, d))
    || !nullOr(r.receiptDigest, (d) => matches(DIGEST, d)) || !Number.isSafeInteger(r.at) || r.at < 0) fail('owner-outcome-shape');
  // Daemon origin always carries its reporting key and epoch (the key is then
  // bound to this daemon's below).
  if (r.source !== 'daemon' || !Number.isSafeInteger(r.reportingDaemonEpoch) || r.reportingDaemonEpoch < 1) fail('owner-outcome-source');
  // This request, reported by this daemon (its vouch key never changes; its
  // epoch never goes back), with the receipt it actually holds.
  const a = context.acceptance;
  if (r.requestId !== a.requestId || r.payloadDigest !== a.payloadDigest) fail('owner-outcome-binding');
  if (r.reportingDaemonKey !== a.daemonKey || r.reportingDaemonEpoch < a.daemonEpoch) fail('owner-outcome-reporter');
  if (r.receiptDigest !== context.receiptDigest) fail('owner-outcome-receipt');
  // The graph decides the finding.
  if (!allowed(context).some(([state, code, effectDigest]) => r.state === state && r.outcome.code === code && r.outcome.effectDigest === effectDigest)) {
    fail('owner-outcome-finding');
  }
  return r;
}
