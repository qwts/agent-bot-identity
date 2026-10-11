// Resolve hook for no-exec.mjs: `node:child_process` is the stub, except for
// the stub itself, which re-exports the real module.
const STUB = new URL('./no-exec-child-process.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if ((specifier === 'node:child_process' || specifier === 'child_process') && context.parentURL !== STUB) {
    return { url: STUB, shortCircuit: true };
  }
  return next(specifier, context);
}
