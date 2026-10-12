// Test-only resolve hook: when owner-decision-reconcile.mjs imports
// ./soul-revisions.mjs, it gets reconcile-ceremony.mjs, which re-exports
// everything there but replaces revisionOwnerGate with an injected ceremony.
// Register before the reconciler is first imported (import it dynamically).
import { registerHooks } from 'node:module';

const shim = new URL('./reconcile-ceremony.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './soul-revisions.mjs' && context.parentURL?.endsWith('/owner-decision-reconcile.mjs')) return { url: shim, shortCircuit: true };
    return next(specifier, context);
  },
});
