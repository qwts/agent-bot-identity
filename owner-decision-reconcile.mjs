// The owner-local, record-only owner-decision reconciliation (agent-comms#77,
// C2): disabled, no route. After a crash between the linked event (slot 13)
// and the completed record (slot 10), a record-only revision (approve, reject,
// adopt, or edit without apply) stays effect-uncertain. Only this explicit,
// owner-authenticated ceremony may produce its missing typed completed
// record, never automatically and never by replaying the consumed completer.
// Applying edits and cold-wake are never reconciled here.
//
// Everything but the request ID is the daemon's own: its journal (own root),
// its broker namespace (own trust store), its revision journal and stored
// packages (own state directory). The ceremony is the existing local owner
// gate (native presence or interactive consent; no principal override and no
// soul caller). The owner chose, in session on 2026-10-12, to mint the
// ceremony's auditId per ceremony, with the terminal pair as the durable
// record and no separate audit record type.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createDaemonJournalStore, readOwnerDecisionTrust } from './identity-host.mjs';
import { createOwnerDecisionRevisionPort } from './owner-decision-revision-port.mjs';
import { revisionJournalRoot, revisionOwnerGate, revisionPackagePath } from './soul-revisions.mjs';
import { stateDirectory } from './state-paths.mjs';

const refuse = (reason) => { throw Object.assign(new Error('owner decision reconciliation refused'), { code: 'owner-decision-reconcile', reason }); };

// The ceremony, by default the existing local owner gate (async: it resolves
// only once presence or consent is proven). Tests inject one.
const ownerCeremony = (requestId, soul) => revisionOwnerGate(`owner-decision reconcile ${requestId}`, { target: soul });

// Factory for tests (an injected ceremony); production uses
// reconcileOwnerDecisionRecordOnly, which always runs the real owner gate.
export function createOwnerDecisionReconciler({ ceremony = ownerCeremony } = {}) {
  return async function reconcile({ requestId } = {}) {
    let namespaceDigest;
    try { ({ namespaceDigest } = readOwnerDecisionTrust()); } catch { refuse('trust-unavailable'); }
    const store = createDaemonJournalStore({ namespaceDigest });
    // What there is to reconcile, from the journal (refuses anything else).
    const view = store.readRecordOnlyReconcilable(requestId);
    // The owner-local ceremony, awaited: nothing below runs until it has
    // resolved, and a refusal (thrown or rejected) writes nothing.
    try { await ceremony(requestId, view.soul); } catch { refuse('ceremony-refused'); }
    const at = Math.floor(Date.now() / 1000);
    // The immutable package: for a revision that changes the head, the stored
    // package at the entered after-revision must still validate to it.
    if (view.afterRevision !== view.beforeRevision) {
      try { revisionPackagePath(view.soul, view.afterRevision); } catch { refuse('package-invalid'); }
    }
    // Resync: find the linked record in the soul's revision journal (its exact
    // bytes, through the daemon's own read-only port) and observe the current
    // head and proposal.
    const port = createOwnerDecisionRevisionPort({ stateDir: stateDirectory() });
    let names;
    try { names = readdirSync(revisionJournalRoot(view.soul)).filter((name) => /^\d{10}\.json$/.test(name)).sort(); } catch { refuse('revision-journal-unavailable'); }
    let journalSeq = null, head = null, proposal = null;
    for (const name of names) {
      const seq = Number(name.slice(0, 10));
      let bytes;
      try { bytes = port.read(view.soul, seq); } catch { refuse('revision-journal-unavailable'); }
      if (bytes.equals(view.linked)) journalSeq = seq;
      const record = JSON.parse(bytes.toString('utf8'));
      if (record.kind === 'revision') head = { seq, revision: record.revision };
      if (record.kind === 'proposal' && view.proposalId !== null && record.proposalId === view.proposalId) {
        proposal = { proposalId: record.proposalId, seq, revision: record.revision, parentRevision: record.parentRevision };
      }
    }
    if (journalSeq === null) refuse('linked-event-missing');
    // Matching from this preimage is mechanism-only: it is what the ceremony
    // observed, not daemon-verified actual state.
    const preimage = { v: 1, head, proposal, working: null };
    return store.reconcileRecordOnlyCompletion(requestId, { journalSeq, readLinkedEvent: (seq) => port.read(view.soul, seq), at, auditId: randomUUID(), preimage });
  };
}

export const reconcileOwnerDecisionRecordOnly = createOwnerDecisionReconciler();
