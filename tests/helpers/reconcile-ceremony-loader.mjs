// Test-only module loader (see reconcile-ceremony-hook.mjs): redirects only
// owner-decision-reconcile.mjs's own ./soul-revisions.mjs import.
const shim = new URL('./reconcile-ceremony.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === './soul-revisions.mjs' && context.parentURL?.endsWith('/owner-decision-reconcile.mjs')) return { url: shim, shortCircuit: true };
  return next(specifier, context);
}
