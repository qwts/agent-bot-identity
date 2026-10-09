// The owner gate as soul-level and host commands use it: owner-gate.mjs with
// its two outside dependencies wired in, the broker check for a presented
// principal (owner-principal.mjs) and the census, so the Touch ID and consent
// prompts name each soul (#429). owner-gate.mjs itself stays free of both
// (#645); a caller that bypasses this module and presents a principal is
// refused, not waved through.
import process from 'node:process';
import { listSouls, populationFile } from './agent-population.mjs';
import * as gate from './owner-gate.mjs';
import { verifyPrincipalOwner } from './owner-principal.mjs';

export { consentOwner, ownerCredentialRequired, soulMarkers } from './owner-gate.mjs';
export { verifyPrincipalOwner } from './owner-principal.mjs';

export const populationSouls = (env = process.env) => () => listSouls({ file: populationFile({ env }) });

const wired = (options) => ({ verifyPrincipal: verifyPrincipalOwner, listSouls: populationSouls(options.env ?? process.env), ...options });

export function assertOwnerAction(action, options = {}) {
  return gate.assertOwnerAction(action, wired(options));
}

export function confirmOwnerPresence(action, options = {}) {
  return gate.confirmOwnerPresence(action, wired(options));
}

export function presenceOrConsent(action, options = {}) {
  return gate.presenceOrConsent(action, { listSouls: populationSouls(options.env ?? process.env), ...options });
}

export function ownerActionSummary(action, options = {}) {
  return gate.ownerActionSummary(action, { listSouls: populationSouls(options.env ?? process.env), ...options });
}
