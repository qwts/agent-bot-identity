// Test-only: the record-only reconciler's owner ceremony. A resolve hook
// (reconcile-ceremony-hook.mjs) gives owner-decision-reconcile.mjs, and only
// it, this module's revisionOwnerGate in place of soul-revisions.mjs's; the
// production module exports no way to pass a ceremony.
export * from '../../soul-revisions.mjs';

let current = null;
export function useCeremony(ceremony) { current = ceremony; }
export function revisionOwnerGate(action, options) {
  if (typeof current !== 'function') throw new Error('no test ceremony');
  return current(action, options);
}
