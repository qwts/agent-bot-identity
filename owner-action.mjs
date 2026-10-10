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
    // A daemon decision route brings its own challenge hook (a ledger's), so
    // it never prompts on the daemon's terminal.
    challenge: typeof options.challenge === 'function' ? options.challenge : allowChallenge ? async (pendingAction, { summary }) => {
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

// Signed challenges for the daemon's decision routes (ADR-0753 section 4,
// #753). Where presence is unavailable and an SSH owner key is pinned, a
// decision without a reply is refused with `owner-challenge-required` and
// the unsigned challenges, which the gate records here. The owner signs one
// with `owner sign --challenge` wherever the key is, and the caller repeats
// the same decision with the signed `statement`. A reply answers only the
// challenges recorded for that request and that exact action, and checking
// it spends them whether it verifies or not, so each nonce is used once.
// Pending challenges live only in daemon memory: a restart drops them.
export function createChallengeLedger({ env = process.env, now = Date.now, host = localHost, limit = 64 } = {}) {
  const pending = new Map();
  const prune = () => {
    const seconds = Math.floor(now() / 1000);
    for (const [key, challenges] of pending) {
      if (challenges.every(({ payload }) => payload.exp < seconds)) pending.delete(key);
    }
  };
  return {
    get size() { prune(); return pending.size; },
    // The gate hook for one request: `request` names it (a proposal ID) and
    // `statement` is the caller's signed reply, if any.
    hook({ request, statement = null } = {}) {
      return async (action, { summary }) => {
        const keys = readOwnerKeys({ env });
        if (keys.length === 0) return null;
        const sshKeys = keys.filter((pin) => pin.store === 'ssh');
        if (sshKeys.length === 0) {
          throw statementError('owner-unreachable', 'owner pins exist, but a signed challenge can use only enrolled SSH keys; nothing was changed');
        }
        prune();
        const key = `${request}\0${action}`;
        if (statement === null || statement === undefined || statement === '') {
          const challenges = createOwnerChallenges(action, summary, sshKeys, { host: host(), now: now() });
          pending.delete(key);
          while (pending.size >= limit) pending.delete(pending.keys().next().value);
          pending.set(key, challenges);
          throw Object.assign(statementError('owner-challenge-required',
            'owner presence is unavailable: sign one of these challenges with `agent-bot owner sign --challenge`, then repeat this decision with the signed statement'),
          { challenges: challenges.map(({ name, fingerprint, payload }) => ({ name, fingerprint, payload })) });
        }
        if (typeof statement !== 'string') throw statementError('statement-invalid', 'the statement is not a token');
        const challenges = pending.get(key);
        if (!challenges) {
          throw statementError('statement-scope-mismatch', 'no owner challenge is pending for this decision; repeat it without a statement for a new one');
        }
        pending.delete(key);
        // Checked against the pins as they are now, not when the challenge was made.
        const currentKeys = readOwnerKeys({ env });
        if (!currentKeys.some((pin) => pin.store === 'ssh' && challenges.some(({ fingerprint }) => fingerprint === pin.fingerprint))) {
          throw statementError('owner-unreachable', 'the challenged owner key is no longer enrolled; nothing was changed');
        }
        return verifyOwnerChallenge(statement, { challenges, keys: currentKeys, now: now() });
      };
    },
  };
}
