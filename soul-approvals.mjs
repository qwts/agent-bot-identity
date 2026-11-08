// The approvals port for owner-only soul changes (#1384, HQ plan §2.4, C1
// remedy 3). Every owner-only soul command asks it, before it changes
// anything, whether the owner approves `action`, and gets back the
// authorization or an error. HQ's approval records will back this port; until
// then it does what cold-wake-settings.mjs's gate did (#293): any soul marker
// refuses, then the owner proves themselves with a presented principal or the
// consent dialog. Harness detection stays off: only stated markers count.
//
// It lives apart from the settings modules so that reading a soul's settings
// never loads the gate, and so soul's census does not reach identity through
// it.
import { assertOwnerAction } from './owner-action.mjs';

export const ownerGate = (action, { principal, target, env, cwd }) => assertOwnerAction(action, { principal, target, env, cwd, detect: false });
