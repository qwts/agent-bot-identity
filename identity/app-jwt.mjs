// Signing with an App key held on this host (#1386): the legacy-custody
// check that must pass first, and the App JWT. mint-token.mjs mints with them
// and soul-credentials.mjs verifies a stored key with them, so they sit below
// both, which keeps the two out of an import cycle (HQ plan §2.4).
// mint-token.mjs re-exports both names.
import { createSign, createPrivateKey } from 'node:crypto';
import { homedir } from 'node:os';
import process from 'node:process';
import { LEGACY_LOCAL_CUSTODY_REMOVE_BY, legacyLocalCustody } from './identity-format.mjs';

/**
 * Throws `legacy-local-custody-off` unless the owner opted in to minting with
 * an App key held on this host. Server mode never reaches this.
 */
export function assertLegacyLocalCustody({ env = process.env, home = env.HOME ?? homedir(), now } = {}) {
  const custody = legacyLocalCustody({ env, home, ...(now ? { now } : {}) });
  if (custody.enabled) return custody;
  const why = custody.expired
    ? `legacy local custody was removed on ${LEGACY_LOCAL_CUSTODY_REMOVE_BY.slice(0, 10)}`
    : 'legacy local custody is off';
  throw Object.assign(new Error(
    `${why}: no App key on this host may mint. Mint through the identity service (set AGENT_BOT_SERVER and run \`agent-bot server enroll\`)${custody.expired ? '' : ', or opt in for this machine with AGENT_BOT_LEGACY_LOCAL_CUSTODY=1 or settings.legacyLocalCustody: true (standalone unenforced profile)'}`,
  ), { code: 'legacy-local-custody-off' });
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// App JWTs are capped at 10 minutes by GitHub; 9 minutes with a 60-second
// backdate absorbs clock drift between this machine and GitHub.
export function buildAppJwt(appId, privateKeyPem, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(createPrivateKey(privateKeyPem));
  return `${signingInput}.${b64url(signature)}`;
}
