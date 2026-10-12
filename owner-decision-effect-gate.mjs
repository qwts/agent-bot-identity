// The owner-decision effect-entry gate (agent-comms#77, C2): disabled, no
// route. Host composes identity (trust readiness, native p1 verification and
// the request journal, through identity-host.mjs) with soul's locked target
// resolution. Everything below runs inside the journal's exclusive lock,
// synchronously, in this order, before any effect:
//   1. re-read the current trust records (readOwnerDecisionTrust); refuse if
//      none is ready or the active pair was enrolled after this request was
//      prepared (revoked, rotated or re-enrolled since);
//   2. require the presented p1 to be exactly the one stored for the request,
//      and re-verify it against the active presence pin, the preparation's own
//      nonce and the daemon's clock;
//   3. re-resolve the target through the strict in-process identity port;
//   4. let the journal publish the request's entered record: the consumption,
//      keyed per request by its daemon-generated nonce, never by presenceDigest.
// A request already entered, applied or refused is consumed and refuses. No
// effect runs here; the caller's domain step follows a returned `entered`.
import { createDaemonJournalStore, readOwnerDecisionTrust, verifyOwnerDecisionPresence } from './identity-host.mjs';
import { resolveOwnerDecisionTargetLocked } from './owner-decision-target.mjs';

const refuse = (reason) => { throw Object.assign(new Error('owner decision effect entry refused'), { reason }); };

// Returns { state: 'entered', ... } or a frozen { state: 'refused', reason, code }.
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
    return store.enterEffect(requestId, (view) => {
      let trust;
      try { trust = readOwnerDecisionTrust({ root: trustRoot, namespaceDigest, env, home }); } catch { refuse('trust-unavailable'); }
      if (!Number.isSafeInteger(trust.enrolledAt) || trust.enrolledAt > view.preparation.preparedAt) refuse('trust-unavailable');
      if (typeof presenceToken !== 'string' || presenceToken !== view.presenceToken) refuse('validation-failed');
      try {
        verifyOwnerDecisionPresence(presenceToken, { actionBytes: view.actionBytes, nonce: view.preparation.nonce, trust, nowMilliseconds });
      } catch { refuse('validation-failed'); }
      const target = resolveOwnerDecisionTargetLocked({ account: view.action.account, soul: view.action.soul },
        { daemonAccount, file: censusFile, identityPort });
      if (target.state !== 'resolved') refuse('target-unavailable');
      return { at: Math.floor(nowMilliseconds / 1000) };
    });
  } catch (error) {
    return Object.freeze({ state: 'refused', reason: error?.refusal ?? error?.reason ?? 'storage-unavailable', code: error?.code ?? 'storage-failed' });
  }
}
