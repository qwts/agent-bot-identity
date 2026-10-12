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
import { createOwnerDecisionIdentityPort } from './owner-decision-identity-port.mjs';
import { createOwnerDecisionRevisionPort } from './owner-decision-revision-port.mjs';
import { stateDirectory } from './state-paths.mjs';
import { populationFile } from './agent-population.mjs';
import { loadCommsCredential } from './comms-client.mjs';
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
// revision's journalSeq and working) and returns the settled request, for
// this request only; it works once, and every journal refusal (used,
// poisoned, invalid result, linked event refused) is thrown as the journal's
// error. A revision's linked event is read only through the revision-journal
// port the gate builds itself over the daemon's own state directory; no
// caller can supply the port, the bytes or the digest.
// Refusal reasons are the final-refusal reasons (trust-unavailable,
// validation-failed, target-unavailable); a consumed request or a storage
// failure reports the journal's own code and reason. Nothing is written for
// any refusal.
// The caller supplies only the request it presents: `requestId` and the p1
// `presenceToken`, both checked against what the journal holds. Everything
// that names a location of state or proof, an identity, or the clock is this
// daemon's own and derived here, never taken from the caller (any further
// argument is ignored): the journal (its own root), the broker namespace (its
// own trust store), the trust records, the identity and revision-journal
// ports (its own state directory), the census (its own population file), its
// paired account (its own comms pairing credential) and the time (Date.now).
export function enterOwnerDecisionEffect({ requestId, presenceToken } = {}) {
  try {
    const nowMilliseconds = Date.now();
    // The enrolled broker namespace, from the daemon's own trust store; the
    // journal is opened only under it.
    let namespaceDigest;
    try { ({ namespaceDigest } = readOwnerDecisionTrust()); } catch { refuse('trust-unavailable'); }
    // This daemon's paired account (its own comms pairing credential). With
    // none, the target check below refuses (it requires a named account).
    let daemonAccount;
    try { daemonAccount = loadCommsCredential()?.account; } catch { daemonAccount = undefined; }
    const stateDir = stateDirectory(), censusFile = populationFile();
    const identityPort = createOwnerDecisionIdentityPort({ stateDir }), revisionPort = createOwnerDecisionRevisionPort({ stateDir });
    const store = createDaemonJournalStore({ namespaceDigest });
    let soul;
    const entered = store.enterEffect(requestId, (view) => {
      soul = view.action.soul;
      let trust;
      // Always this daemon's own trust store, from its launch env and home:
      // the same store the preparation writer read, never the caller's choice.
      try { trust = readOwnerDecisionTrust({ namespaceDigest }); } catch { refuse('trust-unavailable'); }
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
      physicalFlushGuaranteed: false,
      // A revision's completion reads its linked event only through the
      // host's revision-journal port, for this request's soul.
      complete: (result) => store.completeEffect(entry, result, { readLinkedEvent: (seq) => revisionPort.read(soul, seq) }) });
  } catch (error) {
    return Object.freeze({ state: 'refused', reason: error?.refusal ?? error?.reason ?? 'storage-unavailable', code: error?.code ?? 'storage-failed' });
  }
}
