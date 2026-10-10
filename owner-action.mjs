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
  // The terminal's signed-challenge fallback (#822) trusts the owner pin
  // file, which anything running as the owner can write: a soul could pin a
  // software-made "security key" and sign its own challenge. It stays off
  // until pins are integrity-protected (#753); only `signedChallenges: true`
  // turns it on, and nothing does yet. Without it the gate asks keyd, then
  // the administrator dialog, and never reads the pins.
  const allowChallenge = options.signedChallenges === true && options.allowChallenge !== false;
  return {
    ...options,
    env,
    presence: options.presence,
    consent: options.fallbackConsent ?? gate.consentOwner,
    listSouls: options.listSouls ?? list,
    // A daemon decision route brings its own challenge hook (a ledger's,
    // behind the daemon's own default-off guard), so it never prompts on the
    // daemon's terminal.
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

// The owner gate the daemon's decision routes use (#438, #753). A route call
// names its `request` (a proposal ID); other daemon callers pass none and
// keep the default gate. A route never answers through a terminal prompt.
// Without `challenges` it asks keyd, then the administrator dialog, and
// reads no owner pins: the pin file is writable by anything running as the
// owner, a soul included, so nothing in it may stand in for the owner until
// pins are integrity-protected. With a ledger from createChallengeLedger,
// a security-key pin may answer instead; the daemon passes one only when
// its default-off `signedChallengeRoutes` guard is on.
export function decisionOwnerGate({ env = process.env, challenges = null, ...gateOptions } = {}) {
  return (action, { principal = null, request = null, statement = null } = {}) => {
    const route = request === null ? {}
      : challenges ? { challenge: challenges.hook({ request, statement }) } : { allowChallenge: false };
    return confirmOwnerPresence(action, { ...gateOptions, env, principal, ...route });
  };
}

// Signed challenges for the daemon's decision routes (ADR-0753 section 4,
// #753), off until owner pins are integrity-protected (see
// decisionOwnerGate). Where presence is unavailable and a security-key owner pin exists,
// a decision without a reply is refused with `owner-challenge-required` and
// the unsigned challenges, which the gate records here. The owner signs one
// with `owner sign --challenge` wherever the key is, and the caller repeats
// the same decision with the signed `statement`. A software SSH key never
// answers here: a soul in the owner's account could read it and sign its own
// approval, so those hosts keep the administrator dialog. One set of
// challenges is pending per request (a proposal), for one exact action; a new
// request replaces it, and checking a reply spends it whether it verifies or
// not, so each nonce is used once. Pending challenges live only in daemon
// memory: a restart drops them.
const securityKeyPin = (pin) => pin.store === 'ssh' && pin.softwareKey !== true && /^sk-/.test(pin.publicKey);

export function createChallengeLedger({ env = process.env, now = Date.now, host = localHost, limit = 64 } = {}) {
  const pending = new Map();
  const prune = () => {
    const seconds = Math.floor(now() / 1000);
    for (const [request, { challenges }] of pending) {
      if (challenges.every(({ payload }) => payload.exp < seconds)) pending.delete(request);
    }
  };
  return {
    get size() { prune(); return pending.size; },
    // The gate hook for one request: `request` names it (a proposal ID) and
    // `statement` is the caller's signed reply, if any.
    hook({ request, statement = null } = {}) {
      return async (action, { summary }) => {
        let keys;
        // A pin file that cannot be read never blocks a decision: the dialog asks.
        try { keys = readOwnerKeys({ env }); } catch { return null; }
        if (keys.length === 0) return null;
        const securityKeys = keys.filter(securityKeyPin);
        if (securityKeys.length === 0) {
          // Software SSH keys alone fall back to the dialog, as with no pins.
          if (keys.some((pin) => pin.store === 'ssh')) return null;
          throw statementError('owner-unreachable', 'owner pins exist, but a signed challenge can use only enrolled SSH security keys; nothing was changed');
        }
        prune();
        if (statement === null || statement === undefined || statement === '') {
          const challenges = createOwnerChallenges(action, summary, securityKeys, { host: host(), now: now() });
          pending.delete(request);
          while (pending.size >= limit) pending.delete(pending.keys().next().value);
          pending.set(request, { action, challenges });
          throw Object.assign(statementError('owner-challenge-required',
            'owner presence is unavailable: sign one of these challenges with `agent-bot owner sign --challenge`, then repeat this decision with the signed statement'),
          { challenges: challenges.map(({ name, fingerprint, payload }) => ({ name, fingerprint, payload })) });
        }
        const entry = pending.get(request);
        pending.delete(request);
        if (typeof statement !== 'string') throw statementError('statement-invalid', 'the statement is not a token');
        if (!entry || entry.action !== action) {
          throw statementError('statement-scope-mismatch', 'no owner challenge is pending for this decision; repeat it without a statement for a new one');
        }
        // Checked against the pins as they are now, not when the challenge was made.
        let currentKeys;
        try { currentKeys = readOwnerKeys({ env }).filter(securityKeyPin); } catch { currentKeys = []; }
        if (!currentKeys.some((pin) => entry.challenges.some(({ fingerprint }) => fingerprint === pin.fingerprint))) {
          throw statementError('owner-unreachable', 'the challenged owner key is no longer enrolled; nothing was changed');
        }
        return verifyOwnerChallenge(statement, { challenges: entry.challenges, keys: currentKeys, now: now() });
      };
    },
  };
}
