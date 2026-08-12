#!/usr/bin/env node

// Local principal and ACL store for the daemon interaction plane (#57). A
// transport account (Telegram user, web client, CLI caller) is never an Agent
// ID: adapters authenticate the provider identity and submit only a normalized
// (transport, providerId) pair, which this store maps to a locally enrolled
// principal. Authorization is deny-by-default — a principal can reach only the
// souls and operations an owner explicitly allowed from the local CLI.
// Display names, usernames, and message text never appear in the model, so a
// changed or spoofed handle can never mint or widen trust.

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateAgentId, withLock } from './agent-identity.mjs';
import { interactionHome } from './agent-jobs.mjs';

const SCHEMA_VERSION = 1;

// The complete operation vocabulary of the interaction contract (#55).
export const PRINCIPAL_OPERATIONS = Object.freeze(['message', 'observe', 'cancel', 'approve']);

const PRINCIPAL_ID_PATTERN = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRANSPORT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// Provider IDs are immutable provider-side identifiers (numeric Telegram user
// IDs, opaque web-client subjects). Normalized form: visible ASCII, no spaces.
const PROVIDER_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const STATUSES = new Set(['active', 'revoked']);

function printableText(name, value, { max = 512 } = {}) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > max
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${name} must be printable text no longer than ${max} characters`);
  }
  return value;
}

export function validatePrincipalId(value) {
  if (typeof value !== 'string' || !PRINCIPAL_ID_PATTERN.test(value)) {
    throw new Error('invalid principal ID');
  }
  return value;
}

export function validateTransport(value) {
  if (typeof value !== 'string' || !TRANSPORT_PATTERN.test(value)) {
    throw new Error('transport must be a short lowercase slug');
  }
  return value;
}

export function validateProviderId(value) {
  if (typeof value !== 'string' || !PROVIDER_ID_PATTERN.test(value)) {
    throw new Error('providerId must be a normalized provider identifier');
  }
  return value;
}

function agentIdOrThrow(value, name = 'soul') {
  try {
    return validateAgentId(value);
  } catch {
    throw new Error(`${name} must be a valid Agent ID`);
  }
}

function normalizeOperations(value) {
  if (!Array.isArray(value)) throw new Error('operations must be an array');
  const operations = [...new Set(value)];
  for (const operation of operations) {
    if (!PRINCIPAL_OPERATIONS.includes(operation)) {
      throw new Error('operations must be a subset of the interaction operations');
    }
  }
  return operations.sort();
}

// '*' is accepted only as the entire, deliberately configured soul list. It is
// never inferred, merged in, or created by any enrollment default.
function normalizeSouls(value) {
  if (!Array.isArray(value)) throw new Error('souls must be an array');
  if (value.includes('*')) {
    if (value.length !== 1) throw new Error("wildcard soul access must be exactly ['*']");
    return ['*'];
  }
  return [...new Set(value.map((soul) => agentIdOrThrow(soul)))].sort();
}

function normalizeBindings(value) {
  if (!Array.isArray(value)) throw new Error('bindings must be an array');
  const seen = new Set();
  const bindings = value.map((binding) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new Error('binding must be an object');
    }
    const transport = validateTransport(binding.transport);
    const providerId = validateProviderId(binding.providerId);
    const key = `${transport} ${providerId}`;
    if (seen.has(key)) throw new Error('bindings must be unique per transport identity');
    seen.add(key);
    return { transport, providerId };
  });
  return bindings;
}

function canonicalTimestamp(name, value) {
  const text = printableText(name, value, { max: 40 });
  let normalized;
  try {
    normalized = new Date(text).toISOString();
  } catch {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  if (normalized !== text) throw new Error(`${name} must be a canonical ISO timestamp`);
  return text;
}

function normalizePrincipal(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('principal record must be an object');
  }
  if (!record.authorizations || typeof record.authorizations !== 'object' || Array.isArray(record.authorizations)) {
    throw new Error('principal authorizations must be an object');
  }
  if (!STATUSES.has(record.status)) throw new Error('principal status must be active or revoked');
  return {
    principalId: validatePrincipalId(record.principalId),
    createdAt: canonicalTimestamp('createdAt', record.createdAt),
    label: printableText('label', record.label, { max: 80 }),
    bindings: normalizeBindings(record.bindings),
    authorizations: {
      souls: normalizeSouls(record.authorizations.souls),
      operations: normalizeOperations(record.authorizations.operations),
    },
    defaultSoul: record.defaultSoul === undefined || record.defaultSoul === null
      ? null
      : agentIdOrThrow(record.defaultSoul, 'defaultSoul'),
    status: record.status,
  };
}

export function principalsFile({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_PRINCIPALS_PATH) return path.resolve(env.AGENT_BOT_PRINCIPALS_PATH);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'principals.json');
}

function emptyDocument() {
  return { schemaVersion: SCHEMA_VERSION, principals: Object.create(null) };
}

function readDocument(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyDocument();
    throw new Error('principal store could not be read');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON parser errors may quote store contents; never reflect them.
    throw new Error('principal store is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('principal store must be an object');
  }
  if (!Number.isSafeInteger(parsed.schemaVersion) || parsed.schemaVersion < SCHEMA_VERSION) {
    throw new Error('principal store has an invalid schemaVersion');
  }
  if (!parsed.principals || typeof parsed.principals !== 'object' || Array.isArray(parsed.principals)) {
    throw new Error('principal store principals must be an object');
  }
  const principals = Object.create(null);
  for (const [key, value] of Object.entries(parsed.principals)) {
    const principal = normalizePrincipal(value);
    if (key !== principal.principalId) {
      throw new Error('principal store key does not match its principal ID');
    }
    principals[principal.principalId] = principal;
  }
  return { schemaVersion: parsed.schemaVersion, principals };
}

function ensurePrivateDirectory(directory) {
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created === undefined) return;
  try {
    chmodSync(directory, 0o700);
  } catch {
    /* POSIX modes are best-effort on other platforms. */
  }
}

function writeDocument(file, principals) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const document = { schemaVersion: SCHEMA_VERSION, principals };
  try {
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function mutateStore(file, mutation) {
  ensurePrivateDirectory(path.dirname(file));
  return withLock(`${file}.lock`, 'principal store', () => {
    const current = readDocument(file);
    if (current.schemaVersion > SCHEMA_VERSION) {
      throw new Error('principal store uses a future schemaVersion; refusing to rewrite it');
    }
    const { principals, result } = mutation(current.principals);
    if (principals) writeDocument(file, principals);
    return result;
  });
}

function requirePrincipal(principals, principalId) {
  const existing = principals[validatePrincipalId(principalId)];
  if (!existing) throw new Error('unknown principal');
  return existing;
}

// Secret-free audit receipts (#57 req 7, #31). Append-only JSONL under the
// interaction home. Only whitelisted identifier fields are recorded — never
// provider tokens, display names, or message bodies.
export function auditFile({ env = process.env, home = homedir() } = {}) {
  return path.join(interactionHome({ env, home }), 'audit.jsonl');
}

export function appendAuditReceipt(
  { event, principalId = null, transport = null, agentId = null, operation = null, decision = null },
  { env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const receipt = {
    at: now().toISOString(),
    event: printableText('event', event, { max: 40 }),
    ...(principalId === null ? {} : { principalId: validatePrincipalId(principalId) }),
    ...(transport === null ? {} : { transport: validateTransport(transport) }),
    ...(agentId === null ? {} : { agentId: agentIdOrThrow(agentId, 'agentId') }),
    ...(operation === null ? {} : { operation: printableText('operation', operation, { max: 40 }) }),
    ...(decision === null ? {} : { decision: printableText('decision', decision, { max: 40 }) }),
  };
  const file = auditFile({ env, home });
  ensurePrivateDirectory(path.dirname(file));
  appendFileSync(file, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  return receipt;
}

// Enrollment is a local owner ceremony: it starts with no bindings, no souls,
// and no operations, so a freshly enrolled principal can do nothing until the
// owner explicitly binds a transport identity and allows souls/operations.
export function enrollPrincipal(
  { label },
  {
    file = principalsFile(),
    env = process.env,
    home = homedir(),
    now = () => new Date(),
    idFactory = () => `principal_${randomUUID()}`,
  } = {},
) {
  const principal = normalizePrincipal({
    principalId: idFactory(),
    createdAt: now().toISOString(),
    label,
    bindings: [],
    authorizations: { souls: [], operations: [] },
    defaultSoul: null,
    status: 'active',
  });
  const stored = mutateStore(file, (principals) => {
    if (principals[principal.principalId]) throw new Error('principal already enrolled');
    return { principals: { ...principals, [principal.principalId]: principal }, result: principal };
  });
  appendAuditReceipt({ event: 'enroll', principalId: stored.principalId }, { env, home, now });
  return stored;
}

export function bindTransport(
  principalId,
  { transport, providerId },
  { file = principalsFile(), env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const nextBinding = {
    transport: validateTransport(transport),
    providerId: validateProviderId(providerId),
  };
  const updated = mutateStore(file, (principals) => {
    const existing = requirePrincipal(principals, principalId);
    if (existing.status !== 'active') throw new Error('principal is revoked');
    for (const principal of Object.values(principals)) {
      if (principal.bindings.some((binding) => (
        binding.transport === nextBinding.transport && binding.providerId === nextBinding.providerId
      ))) {
        // The immutable (transport, providerId) pair is the trust anchor; a
        // second binding would make two principals answer for one account.
        throw new Error('transport identity is already bound');
      }
    }
    const candidate = normalizePrincipal({
      ...existing,
      bindings: [...existing.bindings, nextBinding],
    });
    return { principals: { ...principals, [candidate.principalId]: candidate }, result: candidate };
  });
  appendAuditReceipt(
    { event: 'bind', principalId: updated.principalId, transport: nextBinding.transport },
    { env, home, now },
  );
  return updated;
}

export function authorizeSouls(
  principalId,
  souls,
  { file = principalsFile(), env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const nextSouls = normalizeSouls(souls);
  const updated = mutateStore(file, (principals) => {
    const existing = requirePrincipal(principals, principalId);
    if (existing.status !== 'active') throw new Error('principal is revoked');
    const candidate = normalizePrincipal({
      ...existing,
      authorizations: { ...existing.authorizations, souls: nextSouls },
      // Narrowing the soul list must not leave a stale default pointing at a
      // soul the principal can no longer reach.
      defaultSoul: existing.defaultSoul !== null
        && !nextSouls.includes('*') && !nextSouls.includes(existing.defaultSoul)
        ? null
        : existing.defaultSoul,
    });
    return { principals: { ...principals, [candidate.principalId]: candidate }, result: candidate };
  });
  appendAuditReceipt({ event: 'allow-souls', principalId: updated.principalId }, { env, home, now });
  return updated;
}

export function setOperations(
  principalId,
  operations,
  { file = principalsFile(), env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const nextOperations = normalizeOperations(operations);
  const updated = mutateStore(file, (principals) => {
    const existing = requirePrincipal(principals, principalId);
    if (existing.status !== 'active') throw new Error('principal is revoked');
    const candidate = normalizePrincipal({
      ...existing,
      authorizations: { ...existing.authorizations, operations: nextOperations },
    });
    return { principals: { ...principals, [candidate.principalId]: candidate }, result: candidate };
  });
  appendAuditReceipt({ event: 'allow-operations', principalId: updated.principalId }, { env, home, now });
  return updated;
}

export function setDefaultSoul(
  principalId,
  agentId,
  { file = principalsFile(), env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const nextDefault = agentId === null ? null : agentIdOrThrow(agentId, 'defaultSoul');
  const updated = mutateStore(file, (principals) => {
    const existing = requirePrincipal(principals, principalId);
    if (existing.status !== 'active') throw new Error('principal is revoked');
    if (
      nextDefault !== null
      && !existing.authorizations.souls.includes('*')
      && !existing.authorizations.souls.includes(nextDefault)
    ) {
      throw new Error('default soul must already be authorized for this principal');
    }
    const candidate = normalizePrincipal({ ...existing, defaultSoul: nextDefault });
    return { principals: { ...principals, [candidate.principalId]: candidate }, result: candidate };
  });
  appendAuditReceipt({
    event: 'set-default-soul',
    principalId: updated.principalId,
    ...(nextDefault === null ? {} : { agentId: nextDefault }),
  }, { env, home, now });
  return updated;
}

// Atomic multi-facet authorization update, used by `principal allow`. The
// COMPLETE request is validated before the store is touched and applied as
// one locked read-modify-write, so a request whose later element is invalid
// can never leave the store half-updated: a rejection leaves the file
// byte-identical. `souls`/`operations` are replacement lists when present;
// `defaultSoul` is an Agent ID, or null to clear, or undefined to keep.
export function applyAuthorizationChanges(
  principalId,
  { souls = undefined, operations = undefined, defaultSoul = undefined } = {},
  { file = principalsFile(), env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const wantedId = validatePrincipalId(principalId);
  const nextSouls = souls === undefined ? undefined : normalizeSouls(souls);
  const nextOperations = operations === undefined ? undefined : normalizeOperations(operations);
  const nextDefault = defaultSoul === undefined || defaultSoul === null
    ? defaultSoul
    : agentIdOrThrow(defaultSoul, 'defaultSoul');
  if (nextSouls === undefined && nextOperations === undefined && nextDefault === undefined) {
    throw new Error('principal allow requires at least one authorization change');
  }
  const updated = mutateStore(file, (principals) => {
    const existing = requirePrincipal(principals, wantedId);
    if (existing.status !== 'active') throw new Error('principal is revoked');
    const soulsAfter = nextSouls ?? existing.authorizations.souls;
    let defaultAfter = nextDefault === undefined ? existing.defaultSoul : nextDefault;
    if (
      nextDefault !== undefined && nextDefault !== null
      && !soulsAfter.includes('*') && !soulsAfter.includes(nextDefault)
    ) {
      // The requested default is checked against the soul list as it will be
      // AFTER this same request — the two facets commit or fail together.
      throw new Error('default soul must already be authorized for this principal');
    }
    // Narrowing the soul list must not leave a stale default pointing at a
    // soul the principal can no longer reach.
    if (defaultAfter !== null && !soulsAfter.includes('*') && !soulsAfter.includes(defaultAfter)) {
      defaultAfter = null;
    }
    const candidate = normalizePrincipal({
      ...existing,
      authorizations: {
        souls: soulsAfter,
        operations: nextOperations ?? existing.authorizations.operations,
      },
      defaultSoul: defaultAfter,
    });
    return { principals: { ...principals, [candidate.principalId]: candidate }, result: candidate };
  });
  // Receipts keep the per-facet audit vocabulary and are appended only after
  // the single store write succeeded.
  const receiptOptions = { env, home, now };
  if (nextSouls !== undefined) {
    appendAuditReceipt({ event: 'allow-souls', principalId: updated.principalId }, receiptOptions);
  }
  if (nextOperations !== undefined) {
    appendAuditReceipt({ event: 'allow-operations', principalId: updated.principalId }, receiptOptions);
  }
  if (nextDefault !== undefined) {
    appendAuditReceipt({
      event: 'set-default-soul',
      principalId: updated.principalId,
      ...(nextDefault === null ? {} : { agentId: nextDefault }),
    }, receiptOptions);
  }
  return updated;
}

export function revokePrincipal(
  principalId,
  { file = principalsFile(), env = process.env, home = homedir(), now = () => new Date() } = {},
) {
  const updated = mutateStore(file, (principals) => {
    const existing = requirePrincipal(principals, principalId);
    const candidate = normalizePrincipal({ ...existing, status: 'revoked' });
    return { principals: { ...principals, [candidate.principalId]: candidate }, result: candidate };
  });
  appendAuditReceipt({ event: 'revoke', principalId: updated.principalId }, { env, home, now });
  return updated;
}

// Deny by default: only an exact (transport, providerId) binding of an active
// principal resolves. Unknown identities, malformed identities, and revoked
// principals all come back empty-handed.
export function resolvePrincipal(
  { transport, providerId },
  { file = principalsFile() } = {},
) {
  const wantedTransport = validateTransport(transport);
  const wantedProviderId = validateProviderId(providerId);
  for (const principal of Object.values(readDocument(file).principals)) {
    if (principal.status !== 'active') continue;
    if (principal.bindings.some((binding) => (
      binding.transport === wantedTransport && binding.providerId === wantedProviderId
    ))) {
      return principal;
    }
  }
  return null;
}

// Fail-closed authorization gate. Every refusal shares one stable message so
// callers cannot distinguish "unknown soul" from "not yours" through the error.
export function assertAuthorized({ principal, agentId, operation }) {
  const target = agentIdOrThrow(agentId, 'agentId');
  if (!PRINCIPAL_OPERATIONS.includes(operation)) {
    throw new Error('operations must be a subset of the interaction operations');
  }
  const refused = () => Object.assign(
    new Error('principal is not authorized for this operation'),
    { statusCode: 403 },
  );
  if (!principal || typeof principal !== 'object') throw refused();
  if (principal.status !== 'active') throw refused();
  if (!principal.authorizations.operations.includes(operation)) throw refused();
  const souls = principal.authorizations.souls;
  if (!souls.includes('*') && !souls.includes(target)) throw refused();
  return true;
}

export function getPrincipal(principalId, { file = principalsFile() } = {}) {
  const principal = readDocument(file).principals[validatePrincipalId(principalId)];
  if (!principal) throw new Error('unknown principal');
  return principal;
}

export function listPrincipals({ file = principalsFile() } = {}) {
  const records = Object.values(readDocument(file).principals);
  records.sort((left, right) => left.principalId.localeCompare(right.principalId));
  return records;
}

function parseCli(argv) {
  const [command = 'list', ...tokens] = argv.slice(2);
  const positional = [];
  const flags = new Map();
  const multi = new Map([['soul', []], ['operation', []]]);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    if (token === '--json') { flags.set('json', true); continue; }
    if (token === '--all-souls') { flags.set('all-souls', true); continue; }
    if (token === '--clear-default') { flags.set('clear-default', true); continue; }
    if (['--soul', '--operation'].includes(token)) {
      const value = tokens[++index];
      if (!value) throw new Error(`${token} requires a value`);
      multi.get(token.slice(2)).push(value);
      continue;
    }
    if (!['--label', '--transport', '--provider-id', '--default-soul'].includes(token)) {
      throw new Error(`unknown option: ${token}`);
    }
    const value = tokens[++index];
    if (!value) throw new Error(`${token} requires a value`);
    flags.set(token.slice(2), value);
  }
  return { command, positional, flags, multi };
}

function formatPrincipals(records) {
  const lines = ['PRINCIPAL\tLABEL\tSTATUS\tBINDINGS\tSOULS\tOPERATIONS\tDEFAULT'];
  for (const record of records) {
    lines.push([
      record.principalId,
      record.label,
      record.status,
      record.bindings.map((binding) => `${binding.transport}:${binding.providerId}`).join(',') || '-',
      record.authorizations.souls.join(',') || '-',
      record.authorizations.operations.join(',') || '-',
      record.defaultSoul ?? '-',
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

const USAGE = 'usage: agent-bot principal list [--json]\n'
  + '       agent-bot principal show <principal-id>\n'
  + '       agent-bot principal enroll --label <label>\n'
  + '       agent-bot principal bind <principal-id> --transport <slug> --provider-id <id>\n'
  + '       agent-bot principal allow <principal-id> [--soul <agent-id>]... [--all-souls]\n'
  + '                                 [--operation <op>]... [--default-soul <agent-id>] [--clear-default]\n'
  + '       agent-bot principal revoke <principal-id>\n';

async function main() {
  const args = parseCli(process.argv);
  switch (args.command) {
    case 'list': {
      if (args.positional.length > 0) throw new Error('principal list does not accept arguments');
      const records = listPrincipals();
      if (args.flags.has('json')) process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
      else process.stdout.write(formatPrincipals(records));
      break;
    }
    case 'show': {
      if (args.positional.length !== 1) throw new Error('principal show requires one principal ID');
      process.stdout.write(`${JSON.stringify(getPrincipal(args.positional[0]), null, 2)}\n`);
      break;
    }
    case 'enroll': {
      if (args.positional.length > 0) throw new Error('principal enroll does not accept arguments');
      const principal = enrollPrincipal({ label: args.flags.get('label') });
      process.stdout.write(`${JSON.stringify(principal, null, 2)}\n`);
      break;
    }
    case 'bind': {
      if (args.positional.length !== 1) throw new Error('principal bind requires one principal ID');
      const principal = bindTransport(args.positional[0], {
        transport: args.flags.get('transport'),
        providerId: args.flags.get('provider-id'),
      });
      process.stdout.write(`${JSON.stringify(principal, null, 2)}\n`);
      break;
    }
    case 'allow': {
      if (args.positional.length !== 1) throw new Error('principal allow requires one principal ID');
      const souls = args.multi.get('soul');
      if (args.flags.has('all-souls') && souls.length > 0) {
        throw new Error('--all-souls cannot be combined with --soul');
      }
      const operations = args.multi.get('operation');
      // All requested facets are validated together and applied as one store
      // mutation; a request that is invalid anywhere changes nothing.
      const principal = applyAuthorizationChanges(args.positional[0], {
        ...(args.flags.has('all-souls') ? { souls: ['*'] } : {}),
        ...(!args.flags.has('all-souls') && souls.length > 0 ? { souls } : {}),
        ...(operations.length > 0 ? { operations } : {}),
        ...(args.flags.has('clear-default') ? { defaultSoul: null } : {}),
        ...(!args.flags.has('clear-default') && args.flags.has('default-soul')
          ? { defaultSoul: args.flags.get('default-soul') }
          : {}),
      });
      process.stdout.write(`${JSON.stringify(principal, null, 2)}\n`);
      break;
    }
    case 'revoke': {
      if (args.positional.length !== 1) throw new Error('principal revoke requires one principal ID');
      process.stdout.write(`${JSON.stringify(revokePrincipal(args.positional[0]), null, 2)}\n`);
      break;
    }
    default:
      throw new Error(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-principals: ${error.message}\n`);
    process.exit(1);
  });
}
