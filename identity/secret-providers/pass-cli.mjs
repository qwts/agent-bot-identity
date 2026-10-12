import { execFileSync } from 'node:child_process';

export const PROVIDER_SESSION_REQUIRED = 'provider-session-required';
export const PROVIDER_LOCKED = 'provider-locked';
export const PROVIDER_UNAVAILABLE = 'provider-unavailable';
export const STORE_UNAVAILABLE_CODES = Object.freeze([
  PROVIDER_SESSION_REQUIRED,
  PROVIDER_LOCKED,
  PROVIDER_UNAVAILABLE,
]);

const PASS_CLI_FAILURE_CODES = new Set([
  ...STORE_UNAVAILABLE_CODES,
  'missing-item',
  'ambiguous-item',
  'provider-failure',
]);

function passCliText(error) {
  return `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`;
}

// Classify a pass-cli failure without splicing provider output into the
// operator action. Locked / missing sessions are a store gate, not an item
// defect — they must not be reported as missing-issuer or a generic restore.
export function classifyPassCliFailure(error) {
  if (error?.code && PASS_CLI_FAILURE_CODES.has(error.code)) {
    return { code: error.code };
  }
  if (error?.code === 'ENOENT') {
    return { code: PROVIDER_UNAVAILABLE };
  }
  const text = passCliText(error);
  if (/no session|authenticated client|not logged in|unauthenticated/i.test(text)) {
    return { code: PROVIDER_SESSION_REQUIRED };
  }
  if (/session is locked|session locked|unlock the (?:current )?session|requires.*unlock/i.test(text)) {
    return { code: PROVIDER_LOCKED };
  }
  if (/not found|no item/i.test(text)) {
    return { code: 'missing-item' };
  }
  if (/ambiguous|multiple/i.test(text)) {
    return { code: 'ambiguous-item' };
  }
  return { code: 'provider-failure' };
}

export function passCliFailure(error) {
  const { code } = classifyPassCliFailure(error);
  const detail = {
    [PROVIDER_UNAVAILABLE]: 'was not found',
    [PROVIDER_SESSION_REQUIRED]: 'has no session',
    [PROVIDER_LOCKED]: 'session is locked',
    'missing-item': 'item not found',
    'ambiguous-item': 'item selection is ambiguous',
    'provider-failure': 'provider command failed',
  }[code];
  const wrapped = new Error(`pass-cli ${detail}`);
  wrapped.code = code;
  return wrapped;
}

// Shared by App-key restore and the per-soul store. Never retain child output
// on an Error (including its cause); providers may echo decrypted material.
export function runPass(args, { env = process.env, input, run = execFileSync } = {}) {
  try {
    return run('pass-cli', args, {
      encoding: 'utf8', env, input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw passCliFailure(error);
  }
}
