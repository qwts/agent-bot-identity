// Redaction for diagnostic text (#983): what an error message, a stage
// detail or a log line may carry once it leaves the code that raised it.
//
// Diagnostics are allowlisted by construction; this is the guard behind
// that, for the free text an allowlisted field still holds (`error.message`
// from fs, git or fetch). It removes:
//   - the values of credential-shaped environment variables, and any
//     exact secrets the caller names;
//   - well-known token shapes (GitHub, bearer, JWT, PEM private keys,
//     provider API keys, URL userinfo and credential query parameters);
//   - paths under the home directory, and under any user's home, which
//     identify a person and a project;
// then replaces control characters and bounds the length.
//
// It never throws and keeps nothing: the input is not stored or logged.
// A path containing whitespace is redacted only up to that whitespace
// unless it is quoted, as Node's fs errors quote it.

import process from 'node:process';
import { homedir } from 'node:os';

export const REDACTED = '[redacted]';
export const HOME_PATH = '[home-path]';
export const DEFAULT_MAX_LENGTH = 500;

// Environment variables whose values are credentials by name.
const SECRET_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL|AUTH)/i;
// Shorter values are too likely to appear by chance to replace safely.
const MIN_SECRET_LENGTH = 8;

const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\babp_[0-9a-f]{48}\b/g, // inference-proxy bearer tokens (#1202)
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // bot tokens of the `id:secret` shape
];
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@'"]+@/gi;
const SECRET_QUERY = /([?&](?:access_token|token|key|api_key|apikey|secret|password|sig|signature|code)=)[^&\s'"#]+/gi;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The values of credential-named variables in `env`, longest first. */
export function environmentSecrets(env = process.env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && SECRET_ENV_NAME.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function homePattern(home) {
  // A quoted path keeps its spaces; an unquoted one ends at whitespace.
  const roots = ['/Users/[^/\\s\'"]+', '/home/[^/\\s\'"]+', '[A-Za-z]:\\\\Users\\\\[^\\\\\\s\'"]+'];
  if (typeof home === 'string' && home.length > 1 && home !== '/') roots.unshift(escapeRegExp(home.replace(/[/\\]+$/, '')));
  const root = `(?:(?:/private)?(?:${roots.slice(0, -1).join('|')})|${roots.at(-1)})`;
  return new RegExp(`(['"])${root}(?:[/\\\\][^'"]*)?\\1|${root}(?:[/\\\\][^\\s'"]*)?`, 'g');
}

/**
 * Redacted, single-line, bounded text for a diagnostic. `secrets` adds exact
 * values to remove; `home` defaults to the user's home directory.
 */
export function redactDiagnostic(value, { env = process.env, home = homedir(), secrets = [], maxLength = DEFAULT_MAX_LENGTH } = {}) {
  let text;
  try {
    text = typeof value === 'string' ? value : String(value?.message ?? value ?? '');
  } catch {
    return REDACTED;
  }
  const exact = [...secrets.filter((secret) => typeof secret === 'string' && secret.length > 0), ...environmentSecrets(env)]
    .sort((a, b) => b.length - a.length);
  for (const secret of exact) text = text.split(secret).join(REDACTED);
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTED);
  text = text
    .replace(BEARER, (_, scheme) => `${scheme} ${REDACTED}`)
    .replace(URL_USERINFO, (_, scheme) => `${scheme}${REDACTED}@`)
    .replace(SECRET_QUERY, (_, name) => `${name}${REDACTED}`)
    .replace(homePattern(home), (match, quote) => (quote ? `${quote}${HOME_PATH}${quote}` : HOME_PATH))
    .replace(CONTROL, ' ');
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  return text;
}

/**
 * `{ code, message }` for an error that a diagnostic will keep: the code only
 * when it is a short identifier, else `fallbackCode`, and the redacted message.
 */
export function redactError(error, { fallbackCode = 'error', ...options } = {}) {
  const code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : fallbackCode;
  return { code, message: redactDiagnostic(error, options) };
}
