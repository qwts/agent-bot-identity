// The owner-decision effect-entry gate (agent-comms#77, C2): disabled, no
// route. Host composes identity (trust readiness, native p1 verification and
// the request journal, through identity-host.mjs) with soul's locked target
// resolution. Everything below runs inside the journal's exclusive lock,
// synchronously, in this order, before any effect:
//   1. re-read the current trust records (readOwnerDecisionTrust); refuse if
//      none is ready, if the stored receipt's brokerKey and presenceKey are
//      not the active pair's key IDs (recomputed here from the active public
//      keys), or if the active pair was enrolled at or after this request's
//      preparedAt. The key binding covers any rotation of either key, in any
//      second and across clock rollback; the timestamp is a second layer that
//      also refuses a same-pair re-enroll in or after the preparation's
//      second. The trust chain version recorded in the v2 preparation must
//      equal the current one, which also catches a same-pair re-enroll
//      stamped before preparedAt (a rollback); a v1 preparation, with no
//      version, never enters. Then re-verify the stored
//      d1 itself under the current receipt pin (signature, daemonKey, saved
//      challenge, stored p1), on the receipt's own clock so entry is never
//      tightened (validation-failed; a pin problem has already refused as
//      trust-unavailable through the key binding above);
//   2. require the presented p1 to be exactly the one stored for the request,
//      and re-verify it against the active presence pin, the preparation's own
//      nonce and the daemon's clock;
//   3. re-resolve the target through the strict in-process identity port;
//   4. let the journal publish the request's entered record: the consumption,
//      keyed per request by its daemon-generated nonce, never by presenceDigest.
// A request already entered, applied or refused is consumed and refuses. No
// effect runs here; the caller's domain step follows a returned `entered`,
// then calls its bound `complete(result)`: completion through the same store
// instance that entered, with that instance's one-shot entry handle. Nothing
// else can complete it, so a crash or reopen leaves it effect-uncertain.
import { createDaemonJournalStore, readOwnerDecisionTrust, verifyOwnerDecisionPresence } from './identity-host.mjs';
import { resolveOwnerDecisionTargetLocked } from './owner-decision-target.mjs';
import { createHash, createPublicKey } from 'node:crypto';

const refuse = (reason) => { throw Object.assign(new Error('owner decision effect entry refused'), { reason }); };

// SHA-256 of the key's SPKI DER, recomputed from the trust pin's public key
// rather than taken from the pin's stated keyId.
function keyIdOf(pin) {
  try {
    const spki = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pin.publicKey }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spki).digest('hex');
  } catch { return null; }
}

// Returns a frozen { state: 'entered', requestId, effectId, enteredDigest,
// physicalFlushGuaranteed: false, complete } or a frozen
// { state: 'refused', reason, code } with no completer.
// `complete(result)` takes the store's completion result ({ at }, plus a
// revision's journalSeq, journalRecordDigest and working) and returns the
// settled request, for this request only; it works once, and every journal
// refusal (used, poisoned, invalid result) is thrown as the journal's error.
// Refusal reasons are the final-refusal reasons (trust-unavailable,
// validation-failed, target-unavailable); a consumed request or a storage
// failure reports the journal's own code and reason. Nothing is written for
// any refusal.
export function enterOwnerDecisionEffect({ requestId, presenceToken } = {}, {
  journalRoot, namespaceDigest, trustRoot, env, home, daemonAccount, censusFile, identityPort, nowMilliseconds,
} = {}) {
  try {
    if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) refuse('validation-failed');
    const store = createDaemonJournalStore({ root: journalRoot, namespaceDigest });
    const entered = store.enterEffect(requestId, (view) => {
      let trust;
      try { trust = readOwnerDecisionTrust({ root: trustRoot, namespaceDigest, env, home }); } catch { refuse('trust-unavailable'); }
      const brokerKey = keyIdOf(trust.receiptKey), presenceKey = keyIdOf(trust.presenceKey);
      if (!view.receiptKeys || !brokerKey || !presenceKey
        || view.receiptKeys.brokerKey !== brokerKey || view.receiptKeys.presenceKey !== presenceKey) refuse('trust-unavailable');
      if (!Number.isSafeInteger(trust.enrolledAt) || trust.enrolledAt >= view.preparation.preparedAt) refuse('trust-unavailable');
      // The trust chain version recorded at preparation (v2) must still be
      // the current one: any revoke, rotation or re-enrollment since, in any
      // second and across clock rollback, refuses. A v1 preparation has none.
      if (trust.version !== view.preparation.trustVersion) refuse('trust-unavailable');
      // The stored d1 itself, re-verified under the current receipt pin, as
      // issued: a planted receipt (bad signature, another challenge or p1)
      // refuses even when it names the right key IDs.
      try { view.verifyReceipt(trust); } catch { refuse('validation-failed'); }
      if (typeof presenceToken !== 'string' || presenceToken !== view.presenceToken) refuse('validation-failed');
      try {
        verifyOwnerDecisionPresence(presenceToken, { actionBytes: view.actionBytes, nonce: view.preparation.nonce, trust, nowMilliseconds });
      } catch { refuse('validation-failed'); }
      const target = resolveOwnerDecisionTargetLocked({ account: view.action.account, soul: view.action.soul },
        { daemonAccount, file: censusFile, identityPort });
      if (target.state !== 'resolved') refuse('target-unavailable');
      return { at: Math.floor(nowMilliseconds / 1000) };
    });
    const { entry } = entered;
    return Object.freeze({ state: 'entered', requestId: entered.requestId, effectId: entered.effectId, enteredDigest: entered.enteredDigest,
      physicalFlushGuaranteed: false, complete: (result) => store.completeEffect(entry, result) });
  } catch (error) {
    return Object.freeze({ state: 'refused', reason: error?.refusal ?? error?.reason ?? 'storage-unavailable', code: error?.code ?? 'storage-failed' });
  }
}
