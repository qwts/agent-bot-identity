#!/usr/bin/env node

// Telegram transport adapter for remote agent messaging (#58). A thin,
// long-polling projection of the daemon's /v1 interaction contract (#55):
// Telegram is never an identity, memory, or execution authority. Every update
// is authenticated by its immutable numeric `from.id` through the local
// principal store (#57) — usernames, display names, chat titles, and
// forwarded metadata grant nothing — and every accepted message becomes a
// daemon invocation through the durable job store (#56). Telegram messages
// are a bounded projection of daemon state, never the record: killing and
// restarting this adapter loses nothing but an unread status edit.
//
//   agent-bot telegram run    — long-poll getUpdates against the local daemon
//   agent-bot telegram status — adapter state summary (never the token)
//
// Command grammar (deliberately tiny; DM-only by default):
//   /souls            list souls this principal may message
//   /use <agent-id>   select the soul for this chat (adapter-local, non-authoritative)
//   /status           status of this chat's active invocation
//   /cancel           cancel this chat's active invocation
//   /help, /start     usage text
//   <plain text>      submit a message to the selected (or default) soul
//
// Bot token provisioning is an explicit reviewed path only: the
// AGENT_BOT_TELEGRAM_TOKEN environment variable, or the secure-store flow via
// `settings.telegram.tokenSecret` ({provider, collection, item, field}) in the
// user config, resolved through the same provider registry as `agent-bot
// secret get`. The token is never read from repository config, never written
// to any state file, population or principal record, Agent Space, log line,
// event, or error message — a redaction guard strips it from every error that
// transits this module.
//
// Group/channel/supergroup updates are ignored unless the owner opts in with
// AGENT_BOT_TELEGRAM_ALLOW_GROUPS=1 or `settings.telegram.allowGroups: true`
// (a reviewed policy decision; the DM-only default is the contract).
//
// Attachments are refused in v1 with a documented message. A staged local
// ingress area (scan, opaque IDs) is future work; Telegram-supplied file
// names and paths are never interpreted.

import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { daemonClient, daemonStatus } from './agent-daemon.mjs';
import { validateAgentId } from './agent-identity.mjs';
import { MAX_MESSAGE_BYTES } from './agent-interaction.mjs';
import { appendAuditReceipt, principalsFile, resolvePrincipal } from './agent-principals.mjs';
import { loadConfig } from './config.mjs';
import { createSecretProviderRegistry, getSecret } from './secret-store.mjs';
import { BUILTIN_SECRET_PROVIDERS } from './secret.mjs';

const SCHEMA_VERSION = 1;
export const TELEGRAM_TRANSPORT = 'telegram';
const DEFAULT_API_BASE = 'https://api.telegram.org';

// Telegram caps messages at 4096 characters; stay under it so a status
// suffix can never push a projection over the provider limit.
const MAX_OUTBOUND_CHARS = 3900;
const MAX_LISTED_SOULS = 50;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

// Telegram bot tokens are `<numeric bot id>:<opaque secret>`. The shape check
// exists so a pasted username or file path cannot silently become "the token".
const BOT_TOKEN_PATTERN = /^\d{1,16}:[A-Za-z0-9_-]{16,128}$/;
const PROVIDER_ID_PATTERN = /^\d{1,20}$/;
const CHAT_KEY_PATTERN = /^-?\d{1,20}$/;
const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID_PATTERN = new RegExp(`^session_${UUID_BODY}$`);
const INVOCATION_ID_PATTERN = new RegExp(`^invocation_${UUID_BODY}$`);

// Message content that signals a non-text payload. The adapter never reads
// file names, file IDs, or paths out of these — presence alone refuses.
const ATTACHMENT_FIELDS = Object.freeze([
  'document', 'photo', 'audio', 'video', 'voice', 'video_note',
  'animation', 'sticker', 'contact', 'location', 'venue', 'poll', 'dice',
]);

// Stable, non-reflecting user-facing texts. None of them echo attacker input.
export const REFUSAL_NOT_ENROLLED = 'This Telegram account is not enrolled for agent messaging on this machine. '
  + 'Enrollment is an owner-only ceremony on the host: agent-bot principal enroll / bind / allow.';
export const REFUSAL_SOUL = 'That soul is not available to you.';
export const REFUSAL_ATTACHMENT = 'Attachments are not supported in v1; send plain text. '
  + 'A staged, scanned ingress area is planned follow-up work.';
export const REFUSAL_OVERSIZE = 'Message is too large for the bounded interaction contract; send a shorter message.';
export const REFUSAL_CONTROL = 'Message contains unsupported control characters.';
export const REFUSAL_DAEMON = 'The request was refused or failed; nothing new was submitted. Check /status or the host logs.';
export const NO_SOUL_SELECTED = 'No soul selected. List authorized souls with /souls, then pick one with /use <agent-id>.';
export const NO_ACTIVE_INVOCATION = 'No active invocation for this chat.';
const HELP_TEXT = 'Commands:\n'
  + '/souls — list souls you may message\n'
  + '/use <agent-id> — select the soul for this chat\n'
  + '/status — status of the active invocation\n'
  + '/cancel — cancel the active invocation\n'
  + 'Plain text is sent to the selected soul.';

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Redaction guard: any text that might reach a log, an error, or Telegram is
// passed through here so the bot token can never leak, even when a lower
// layer (fetch, URL parsing) embeds the request URL in its message.
export function redactBotToken(text, token) {
  const raw = String(text ?? '');
  if (typeof token !== 'string' || token.length === 0) return raw;
  return raw.split(token).join('[redacted-bot-token]');
}

export function validateBotToken(value) {
  if (typeof value !== 'string' || !BOT_TOKEN_PATTERN.test(value)) {
    // Never include the candidate value: it may be a real secret in the
    // wrong place.
    throw new Error('telegram bot token has an unsupported shape');
  }
  return value;
}

function tokenSecretSelector(config) {
  const selector = config?.settings?.telegram?.tokenSecret;
  if (selector === undefined || selector === null) return null;
  if (typeof selector !== 'object' || Array.isArray(selector)) {
    throw new Error('settings.telegram.tokenSecret must be an object');
  }
  return selector;
}

function defaultSecretReader(selector) {
  return getSecret({
    provider: selector.provider,
    collection: selector.collection,
    item: selector.item,
    field: selector.field,
    reason: 'telegram bot token for the agent-bot telegram adapter',
  }, { registry: createSecretProviderRegistry(BUILTIN_SECRET_PROVIDERS) });
}

// The only two reviewed token paths (#58 req 9): explicit environment
// variable, or the audited secure-store provider flow. There is no config
// field that carries the token itself, and nothing here ever persists it.
export function resolveBotToken({
  env = process.env,
  home = homedir(),
  config,
  secretReader = defaultSecretReader,
} = {}) {
  const fromEnv = env.AGENT_BOT_TELEGRAM_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv !== '') return validateBotToken(fromEnv);
  const loaded = config === undefined ? loadConfig({ env, home }) : config;
  const selector = tokenSecretSelector(loaded);
  if (selector) return validateBotToken(secretReader(selector));
  throw new Error(
    'no Telegram bot token: set AGENT_BOT_TELEGRAM_TOKEN or configure settings.telegram.tokenSecret',
  );
}

// True when a token source is configured, without ever touching the secret.
export function botTokenConfigured({ env = process.env, home = homedir(), config } = {}) {
  if (typeof env.AGENT_BOT_TELEGRAM_TOKEN === 'string' && env.AGENT_BOT_TELEGRAM_TOKEN !== '') return true;
  const loaded = config === undefined ? loadConfig({ env, home }) : config;
  return tokenSecretSelector(loaded) !== null;
}

export function telegramStateFile({ env = process.env, home = homedir() } = {}) {
  if (env.AGENT_BOT_TELEGRAM_STATE_PATH) return path.resolve(env.AGENT_BOT_TELEGRAM_STATE_PATH);
  const stateHome = env.XDG_STATE_HOME
    ? path.resolve(env.XDG_STATE_HOME)
    : path.join(home, '.local', 'state');
  return path.join(stateHome, 'agent-bot', 'telegram', 'state.json');
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    offset: 0,
    // chat id -> selected agentId. Chat IDs are adapter-local projection keys
    // only; they never become session or identity keys.
    selections: Object.create(null),
    // `${principalId} ${agentId}` -> daemon sessionId (non-authoritative
    // cache; the daemon re-validates ownership on every continue).
    sessions: Object.create(null),
    // chat id -> latest submitted invocationId, for /status and /cancel.
    active: Object.create(null),
  };
}

function stateMap(value, name, keyPattern, validateValue) {
  if (value === undefined || value === null) return Object.create(null);
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`telegram state ${name} must be an object`);
  }
  const map = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (!keyPattern.test(key)) throw new Error('telegram state file has an unsupported shape');
    map[key] = validateValue(entry);
  }
  return map;
}

function agentIdOrThrow(value) {
  try {
    return validateAgentId(value);
  } catch {
    throw new Error('telegram state file has an unsupported shape');
  }
}

function readState(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error('telegram state file could not be read');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON parser messages may quote file contents; never reflect them.
    throw new Error('telegram state file is not valid JSON');
  }
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0
  ) {
    throw new Error('telegram state file has an unsupported shape');
  }
  const shape = (pattern) => (value) => {
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new Error('telegram state file has an unsupported shape');
    }
    return value;
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    offset: parsed.offset,
    selections: stateMap(parsed.selections, 'selections', CHAT_KEY_PATTERN, agentIdOrThrow),
    sessions: stateMap(parsed.sessions, 'sessions', /^principal_\S+ agent_\S+$/, shape(SESSION_ID_PATTERN)),
    active: stateMap(parsed.active, 'active', CHAT_KEY_PATTERN, shape(INVOCATION_ID_PATTERN)),
  };
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

function writeState(file, state) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// Minimal Bot API client over built-in fetch. 429 responses are honored by
// sleeping for the reported retry_after before retrying; every failure is a
// stable, redacted error that never reflects provider response bodies.
export function createBotApi({
  baseUrl = DEFAULT_API_BASE,
  token,
  fetchImpl = fetch,
  sleep = defaultSleep,
  maxAttempts = 3,
  requestTimeoutMs = 30_000,
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');
  validateBotToken(token);
  async function callMethod(method, payload = {}) {
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        const budget = requestTimeoutMs + (Number(payload.timeout) > 0 ? Number(payload.timeout) * 1000 : 0);
        response = await fetchImpl(`${root}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(budget),
        });
      } catch (error) {
        throw new Error(redactBotToken(`telegram ${method} request failed: ${error?.message}`, token));
      }
      const body = await response.json().catch(() => null);
      if (response.status === 429 && attempt < maxAttempts) {
        const hinted = Number(body?.parameters?.retry_after ?? response.headers.get('retry-after'));
        const retryAfter = Number.isFinite(hinted) && hinted > 0 ? hinted : 1;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!response.ok || !body || body.ok !== true) {
        // Provider descriptions are third-party text; only the method name
        // and HTTP status are surfaced.
        throw new Error(redactBotToken(`telegram ${method} failed: HTTP ${response.status}`, token));
      }
      return body.result;
    }
  }
  return {
    getUpdates: (payload) => callMethod('getUpdates', payload),
    sendMessage: (payload) => callMethod('sendMessage', payload),
    editMessageText: (payload) => callMethod('editMessageText', payload),
  };
}

function boundedText(text) {
  const value = String(text);
  return value.length <= MAX_OUTBOUND_CHARS ? value : `${value.slice(0, MAX_OUTBOUND_CHARS - 3)}...`;
}

function aclAllows(principal, agentId) {
  const souls = principal.authorizations.souls;
  return souls.includes('*') || souls.includes(agentId);
}

function groupsAllowed(env, config) {
  const flag = env.AGENT_BOT_TELEGRAM_ALLOW_GROUPS;
  if (flag === '1' || flag === 'true') return true;
  return config?.settings?.telegram?.allowGroups === true;
}

export function createTelegramAdapter({
  env = process.env,
  home = homedir(),
  config = {},
  token,
  baseUrl = env.AGENT_BOT_TELEGRAM_API_BASE ?? DEFAULT_API_BASE,
  fetchImpl = fetch,
  sleep = defaultSleep,
  stderr = process.stderr,
  daemon = daemonClient({ env, home }),
  now = () => new Date(),
  longPollSeconds = 30,
  projectionIntervalMs = 750,
  projectionTimeoutMs = 10 * 60_000,
  errorBackoffMs = 2_000,
} = {}) {
  const botToken = validateBotToken(token);
  const api = createBotApi({ baseUrl, token: botToken, fetchImpl, sleep });
  const stateFile = telegramStateFile({ env, home });
  const allowGroups = groupsAllowed(env, config);
  const state = readState(stateFile);
  const projections = new Set();

  function note(text) {
    // Every stderr line transits the redaction guard, so a token planted in
    // any lower-layer error can never reach the log.
    stderr.write(`telegram-adapter: ${redactBotToken(text, botToken)}\n`);
  }

  function save() {
    writeState(stateFile, state);
  }

  async function replySafe(chatId, text) {
    try {
      return await api.sendMessage({ chat_id: chatId, text: boundedText(text) });
    } catch (error) {
      // Delivery is best-effort projection; daemon state is unaffected.
      note(`sendMessage failed (daemon state unaffected): ${error.message}`);
      return null;
    }
  }

  function renderStatus(invocationId, status, errorText, artifacts) {
    let text = `${invocationId}: ${status}`;
    if (status === 'failed' && errorText) text += ` — ${errorText}`;
    if (artifacts.length > 0) text += `\nartifacts: ${artifacts.join(', ')}`;
    return boundedText(text);
  }

  // Progress projection (#58 req 7): poll ordered events with the afterSeq
  // cursor and keep ONE bounded status message edited in place, falling back
  // to a fresh message when the edit fails. The daemon event log stays the
  // record; losing every Telegram write loses nothing.
  async function projectInvocation({ chatId, invocationId, requester }) {
    let cursor = 0;
    let status = 'queued';
    let errorText = null;
    let statusMessageId = null;
    let lastRendered = null;
    const artifacts = [];
    const deadline = Date.now() + projectionTimeoutMs;
    const show = async () => {
      const text = renderStatus(invocationId, status, errorText, artifacts);
      if (text === lastRendered) return;
      if (statusMessageId !== null) {
        try {
          await api.editMessageText({ chat_id: chatId, message_id: statusMessageId, text });
          lastRendered = text;
          return;
        } catch (error) {
          note(`editMessageText failed; falling back to a new message: ${error.message}`);
          statusMessageId = null;
        }
      }
      const sent = await replySafe(chatId, text);
      if (sent && Number.isSafeInteger(sent.message_id)) statusMessageId = sent.message_id;
      lastRendered = text;
    };
    await show();
    while (Date.now() < deadline) {
      let events;
      try {
        ({ events } = await daemon.events(invocationId, { ...requester, afterSeq: cursor }));
      } catch (error) {
        note(`event poll failed: ${error.message}`);
        return;
      }
      for (const event of events) {
        if (Number.isSafeInteger(event.seq)) cursor = Math.max(cursor, event.seq);
        if (event.type === 'status' && typeof event.data?.status === 'string') {
          status = event.data.status;
          if (typeof event.data.error === 'string') errorText = event.data.error;
        }
        if (event.type === 'artifact' && typeof event.data?.name === 'string') {
          artifacts.push(event.data.name);
        }
      }
      await show();
      if (TERMINAL_STATUSES.has(status)) return;
      await sleep(projectionIntervalMs);
    }
    note(`projection timed out for ${invocationId}; the daemon record is authoritative`);
  }

  function dispatchProjection(context) {
    const settled = projectInvocation(context)
      .catch((error) => note(`projection failed: ${error.message}`));
    projections.add(settled);
    settled.finally(() => projections.delete(settled));
  }

  async function drain() {
    while (projections.size > 0) await Promise.allSettled([...projections]);
  }

  async function authorizedActiveSouls(principal) {
    const souls = await daemon.population({ status: 'active' });
    return souls.filter((soul) => aclAllows(principal, soul.id));
  }

  async function ensureSession(principal, requester, agentId) {
    const key = `${principal.principalId} ${agentId}`;
    const cached = state.sessions[key];
    if (cached) {
      try {
        const { session } = await daemon.createSession({ ...requester, agentId, sessionId: cached });
        return session.sessionId;
      } catch {
        // Stale or foreign cache entry: the daemon is the authority; start over.
        delete state.sessions[key];
      }
    }
    const { session } = await daemon.createSession({ ...requester, agentId });
    state.sessions[key] = session.sessionId;
    save();
    return session.sessionId;
  }

  async function handleCommand({ chatKey, chatId, principal, requester, text }) {
    const tokens = text.trim().split(/\s+/);
    const command = tokens[0].toLowerCase().replace(/@\S+$/, '');
    switch (command) {
      case '/help':
      case '/start': {
        await replySafe(chatId, HELP_TEXT);
        return;
      }
      case '/souls': {
        const souls = await authorizedActiveSouls(principal);
        if (souls.length === 0) {
          await replySafe(chatId, 'No souls are authorized for you.');
          return;
        }
        const lines = souls.slice(0, MAX_LISTED_SOULS)
          .map((soul) => `- ${soul.id} (${soul.appSlug})`);
        const selected = state.selections[chatKey] ?? principal.defaultSoul ?? 'none';
        await replySafe(chatId, `Authorized souls:\n${lines.join('\n')}\nSelected: ${selected}`);
        return;
      }
      case '/use': {
        let agentId;
        try {
          agentId = validateAgentId(tokens[1]);
        } catch {
          await replySafe(chatId, 'Usage: /use <agent-id>');
          return;
        }
        // Unknown and unauthorized souls answer identically so the command
        // cannot be used to enumerate the population.
        const souls = await authorizedActiveSouls(principal);
        if (!aclAllows(principal, agentId) || !souls.some((soul) => soul.id === agentId)) {
          await replySafe(chatId, REFUSAL_SOUL);
          return;
        }
        state.selections[chatKey] = agentId;
        save();
        await replySafe(chatId, `Selected soul ${agentId} for this chat.`);
        return;
      }
      case '/status': {
        const invocationId = state.active[chatKey];
        if (!invocationId) {
          await replySafe(chatId, NO_ACTIVE_INVOCATION);
          return;
        }
        const { invocation } = await daemon.invocation(invocationId, requester);
        await replySafe(chatId, renderStatus(
          invocation.invocationId,
          invocation.status,
          invocation.error,
          invocation.artifacts.map((artifact) => artifact.name),
        ));
        return;
      }
      case '/cancel': {
        const invocationId = state.active[chatKey];
        if (!invocationId) {
          await replySafe(chatId, NO_ACTIVE_INVOCATION);
          return;
        }
        const outcome = await daemon.cancel(invocationId, requester);
        await replySafe(chatId, outcome.alreadyFinished
          ? `${invocationId}: already finished (${outcome.status})`
          : `${invocationId}: ${outcome.status}`);
        return;
      }
      default:
        await replySafe(chatId, HELP_TEXT);
    }
  }

  async function handleText({ chatKey, chatId, principal, requester, text, updateId }) {
    const agentId = state.selections[chatKey] ?? principal.defaultSoul;
    if (!agentId) {
      await replySafe(chatId, NO_SOUL_SELECTED);
      return;
    }
    const sessionId = await ensureSession(principal, requester, agentId);
    // Telegram update_id maps deterministically onto the daemon idempotency
    // key (#58 req 6): a replayed or duplicated update can never create a
    // second invocation.
    const { invocation, duplicate } = await daemon.submitMessage(sessionId, {
      ...requester,
      message: text,
      idempotencyKey: `telegram:${updateId}`,
    });
    state.active[chatKey] = invocation.invocationId;
    save();
    if (duplicate) {
      await replySafe(chatId, `${invocation.invocationId}: already submitted (${invocation.status})`);
      return;
    }
    dispatchProjection({ chatId, invocationId: invocation.invocationId, requester });
  }

  // One update, fully mediated: structural validation, DM policy, principal
  // resolution by immutable numeric ID, attachment and size bounds, then the
  // tiny command grammar. Returns nothing; failures are logged, refused, or
  // both — the caller advances the offset after every processing attempt.
  async function processUpdate(update) {
    const message = update.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      note('skipping unsupported update (no message)');
      return;
    }
    const chat = message.chat;
    const from = message.from;
    if (
      !chat || typeof chat !== 'object' || !Number.isSafeInteger(chat.id)
      || typeof chat.type !== 'string'
      || !from || typeof from !== 'object' || !Number.isSafeInteger(from.id)
    ) {
      note('skipping malformed update (missing chat or sender)');
      return;
    }
    if (chat.type !== 'private' && !allowGroups) {
      // DM-only default (#58 req 4): stay silent in groups so an unexpected
      // membership cannot be used to make the bot announce itself.
      return;
    }
    const providerId = String(from.id);
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      note('skipping malformed update (unsupported sender ID)');
      return;
    }
    // Authentication is the immutable numeric user ID, nothing else (#58
    // req 3). Resolution is read fresh per update so a revocation on the
    // host takes effect immediately.
    let principal = null;
    try {
      principal = resolvePrincipal(
        { transport: TELEGRAM_TRANSPORT, providerId },
        { file: principalsFile({ env, home }) },
      );
    } catch {
      principal = null;
    }
    if (!principal) {
      appendAuditReceipt(
        { event: 'denied-request', transport: TELEGRAM_TRANSPORT, decision: 'denied' },
        { env, home, now },
      );
      await replySafe(chat.id, REFUSAL_NOT_ENROLLED);
      return;
    }
    if (ATTACHMENT_FIELDS.some((field) => message[field] !== undefined)) {
      // v1 refuses all attachments (#58 req 10, documented delta). The
      // refusal is static: Telegram-supplied file names are never read,
      // echoed, or treated as paths.
      await replySafe(chat.id, REFUSAL_ATTACHMENT);
      return;
    }
    const text = message.text;
    if (typeof text !== 'string' || text.length === 0) {
      note('skipping unsupported update (no text)');
      return;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      await replySafe(chat.id, REFUSAL_OVERSIZE);
      return;
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
      await replySafe(chat.id, REFUSAL_CONTROL);
      return;
    }
    const context = {
      chatKey: String(chat.id),
      chatId: chat.id,
      principal,
      requester: { transport: TELEGRAM_TRANSPORT, providerId },
      text,
      updateId: update.update_id,
    };
    try {
      if (text.startsWith('/')) await handleCommand(context);
      else await handleText(context);
    } catch (error) {
      // Daemon refusals and failures are terminal for this update; the
      // daemon has already audited its own decision.
      note(`update handling failed: ${error.message}`);
      await replySafe(chat.id, REFUSAL_DAEMON);
    }
  }

  // One long-poll cycle. The offset is persisted only after each update has
  // had its processing attempt, so a crash replays at-least-once and the
  // idempotency key makes the replay harmless.
  async function pollOnce() {
    let updates;
    try {
      updates = await api.getUpdates({
        offset: state.offset,
        timeout: longPollSeconds,
        allowed_updates: ['message'],
      });
    } catch (error) {
      note(`getUpdates failed: ${error.message}`);
      return { ok: false, processed: 0 };
    }
    if (!Array.isArray(updates)) {
      note('getUpdates returned an unsupported payload');
      return { ok: false, processed: 0 };
    }
    let processed = 0;
    for (const update of updates) {
      const hasId = update && typeof update === 'object' && !Array.isArray(update)
        && Number.isSafeInteger(update.update_id);
      if (!hasId) {
        // Without an update_id the offset cannot acknowledge it; skip.
        note('skipping malformed update (no update_id)');
        continue;
      }
      try {
        await processUpdate(update);
      } catch (error) {
        note(`update processing failed: ${error.message}`);
      }
      processed += 1;
      if (update.update_id + 1 > state.offset) {
        state.offset = update.update_id + 1;
        save();
      }
    }
    return { ok: true, processed };
  }

  async function run({ signal } = {}) {
    while (!signal?.aborted) {
      const { ok } = await pollOnce();
      if (!ok && !signal?.aborted) await sleep(errorBackoffMs);
    }
    await drain();
  }

  return { pollOnce, drain, run, stateFile, get offset() { return state.offset; } };
}

function parseCli(argv) {
  const [command = 'status', ...rest] = argv.slice(2);
  const json = rest.includes('--json');
  const unknown = rest.filter((tokenArg) => tokenArg !== '--json');
  if (unknown.length > 0) throw new Error(`unknown option: ${unknown[0]}`);
  return { command, json };
}

const USAGE = 'usage: agent-bot telegram <run|status> [--json]';

async function main() {
  const { command, json } = parseCli(process.argv);
  switch (command) {
    case 'run': {
      const config = loadConfig();
      const status = await daemonStatus();
      if (!status.running) {
        // No direct in-process fallback (#58 design constraint): messaging
        // requires the daemon trust boundary.
        throw new Error('daemon is not running; start it with: agent-bot daemon start');
      }
      const token = resolveBotToken({ config });
      const adapter = createTelegramAdapter({ config, token });
      const controller = new AbortController();
      process.on('SIGINT', () => controller.abort());
      process.on('SIGTERM', () => controller.abort());
      process.stderr.write('agent-bot telegram: long polling started (direct messages only by default)\n');
      await adapter.run({ signal: controller.signal });
      break;
    }
    case 'status': {
      const config = loadConfig();
      const file = telegramStateFile({});
      const state = readState(file);
      const daemon = await daemonStatus();
      const report = {
        stateFile: file,
        offset: state.offset,
        selections: Object.keys(state.selections).length,
        tokenConfigured: botTokenConfigured({ config }),
        daemonRunning: daemon.running,
      };
      if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(
          `state file: ${report.stateFile}\n`
          + `offset: ${report.offset}\n`
          + `chat selections: ${report.selections}\n`
          + `token configured: ${report.tokenConfigured ? 'yes' : 'no'}\n`
          + `daemon running: ${report.daemonRunning ? 'yes' : 'no'}\n`,
        );
      }
      break;
    }
    default:
      throw new Error(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`telegram-adapter: ${error.message}\n`);
    process.exit(1);
  });
}
