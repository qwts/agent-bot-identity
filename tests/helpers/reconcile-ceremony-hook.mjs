// Test-only resolve hook: when owner-decision-reconcile.mjs imports
// ./soul-revisions.mjs, it gets reconcile-ceremony.mjs, which re-exports
// everything there but replaces revisionOwnerGate with an injected ceremony.
// Register before the reconciler is first imported (import it dynamically).
// module.register (Node 20.6+) runs the loader's resolve off-thread.
import { register } from 'node:module';

register('./reconcile-ceremony-loader.mjs', import.meta.url);
