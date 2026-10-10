// The owner gate as soul-level and host commands use it: owner-gate.mjs with
// its two outside dependencies wired in, the broker check for a presented
// principal (owner-principal.mjs) and the census, so the Touch ID and consent
// prompts name each soul (#429). owner-gate.mjs itself stays free of both
// (#645); a caller that bypasses this module and presents a principal is
// refused, not waved through.
import process from 'node:process';
import { listSouls, populationFile } from './agent-population.mjs';
import * as gate from './owner-gate.mjs';
import {
  createOwnerChallenges,
  localHost,
  promptOwnerChallenge,
  readOwnerKeys,
  statementError,
  verifyOwnerChallenge,
} from './owner-statement.mjs';
import { verifyPrincipalOwner } from './owner-principal.mjs';

export { consentOwner, ownerCredentialRequired, soulMarkers } from './owner-gate.mjs';
export { verifyPrincipalOwner } from './owner-principal.mjs';

export const populationSouls = (env = process.env) => () => listSouls({ file: populationFile({ env }) });

function sharedGateOptions(options) {
  const env = options.env ?? process.env;
  const list = populationSouls(env);
  const allowChallenge = options.allowChallenge !== false;
  return {
    ...options,
    env,
    presence: options.presence,
    consent: options.fallbackConsent ?? gate.consentOwner,
    listSouls: options.listSouls ?? list,
    challenge: allowChallenge ? async (pendingAction, { summary }) => {
      const keys = readOwnerKeys({ env });
      if (keys.length === 0) return null;
      const sshKeys = keys.filter((pin) => pin.store === 'ssh');
      if (sshKeys.length === 0) {
        throw statementError('owner-unreachable', 'owner pins exist, but this CLI challenge flow can use only enrolled SSH keys; nothing was changed');
      }
      const now = options.challengeNow ?? Date.now;
      const challenges = createOwnerChallenges(pendingAction, summary, sshKeys, {
        host: (options.challengeHost ?? localHost)(), now: now(),
      });
      const prompt = options.challengePrompt ?? promptOwnerChallenge;
      const reply = await prompt(challenges);
      // Pin changes made while the owner is signing take effect immediately.
      // A reply is checked against the current store, never the stale snapshot
      // that was used to create the prompt.
      const currentKeys = readOwnerKeys({ env });
      const stillPinned = currentKeys.some((pin) => pin.store === 'ssh'
        && challenges.some(({ fingerprint }) => fingerprint === pin.fingerprint));
      if (!stillPinned) {
        throw statementError('owner-unreachable', 'the challenged owner key is no longer enrolled; nothing was changed');
      }
      return verifyOwnerChallenge(reply, { challenges, keys: currentKeys, now: now() });
    } : null,
  };
}

function wired(options) {
  const env = options.env ?? process.env;
  const list = populationSouls(env);
  const consent = options.consent ?? ((action, gateOptions = {}) => gate.presenceOrConsent(action, {
    ...sharedGateOptions(options),
    ...gateOptions,
  }));
  return { verifyPrincipal: verifyPrincipalOwner, listSouls: list, ...options, consent };
}

export function assertOwnerAction(action, options = {}) {
  return gate.assertOwnerAction(action, wired(options));
}

export function confirmOwnerPresence(action, options = {}) {
  return gate.confirmOwnerPresence(action, wired(options));
}

export function presenceOrConsent(action, options = {}) {
  return gate.presenceOrConsent(action, {
    ...sharedGateOptions(options),
    consent: options.consent ?? options.fallbackConsent ?? gate.consentOwner,
  });
}

export function ownerActionSummary(action, options = {}) {
  return gate.ownerActionSummary(action, { listSouls: populationSouls(options.env ?? process.env), ...options });
}
