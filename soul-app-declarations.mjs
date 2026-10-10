// Soul's read-only App declaration contract (#645, ADR-0645 §2).
//
// Identity mints a GitHub App token for whichever soul declares that App in
// its soul.json (`credentials.github`), but the census and soul.json are soul
// state. The git credential helper and signed-commit mint in-process with no
// composition root that could hand identity this data, so identity imports
// this one module instead of soul's internals. The map in
// governance/runtime-modules.json lists it under `contracts` as importable by
// identity.
//
// Read-only by contract: nothing here writes, locks or creates state. The
// exported surface is versioned; widening it is a reviewed change to the
// map's `exports` list for this file.

import { listSouls, populationFile, soulDirectory } from './agent-population.mjs';
import { soulCredentialsDeclaration } from './soul-package.mjs';

export const APP_DECLARATIONS_CONTRACT_VERSION = 1;

// Souls that declare `slug` as their GitHub App, the caller's own soul first.
// `own` is the caller's Agent ID or null; a missing census leaves only the
// caller's own soul. A soul whose folder cannot be resolved is skipped.
export function appDeclarations(slug, { own = null, env, home, readOnly = false, strict = false } = {}) {
  const file = populationFile({ env, home });
  const ids = [];
  if (own) ids.push(own);
  try { for (const record of listSouls({ file })) if (!ids.includes(record.id)) ids.push(record.id); }
  catch { /* No census: only the caller's own soul can declare. */ }
  const found = [];
  for (const id of ids) {
    let soulDir;
    try { soulDir = soulDirectory(id, { file, env, home, readOnly }); } catch { continue; }
    const declaration = soulCredentialsDeclaration(soulDir, { strict });
    if (declaration?.app === slug) found.push({ agentId: id, soulDir, declaration });
  }
  return found;
}

// Agent IDs of census souls, not retired, recorded as using `slug`.
export function appUsers(slug, { env, home } = {}) {
  return listSouls({ file: populationFile({ env, home }) })
    .filter((soul) => soul.appSlug === slug && soul.status !== 'retired')
    .map((soul) => soul.id);
}
