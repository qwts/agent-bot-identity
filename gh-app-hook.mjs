// GitHub App mailbox. GitHub posts a signed delivery. A session takes the
// oldest record for one App and one full owner/name repository. The take
// marks the record pulled rather than deleting it. A record stays in
// storage until every push subscriber has acked (or been dead-lettered):
// fully pushed records expire 24h after the last ack (pulled or not, so
// push-only consumers don't accumulate forever), a record no subscriber
// matched stays until pulled with a 7-day cap, and dead letters stay 7
// days. So a record a push is still delivering is never lost, and /inbox
// stays a working catch-up path.
//
// Push delivery, retry, and dead-lettering live in the Durable Object. Each
// record is stored under its own key (`record:<id>`) so no single storage
// value grows with the inbox. `/add` never pushes inline: it normalizes the
// record, persists it, schedules an alarm, and returns immediately, so a
// hung receiver can never delay GitHub's webhook. All outbound pushes run
// from `alarm()` with bounded concurrency and never under the concurrency
// lock. When GitHub provides `X-GitHub-Delivery`, that GUID becomes the
// record id, so a GitHub redelivery dedupes instead of re-pushing.
//
// The core decision logic (subscriber selection, HMAC signing, retry
// classification, delivery-state transitions, TTL pruning) is pure and
// Cloudflare-free so the Node test runner can cover it without a Worker
// runtime.
//
// SUBSCRIBERS is a Worker secret (JSON object) mapping an App slug to a
// list of destinations:
//
//   {
//     "qwts-grok-agent": [
//       { "url": "https://receiver.example/hook", "key": "sender-key",
//         "repos": ["qwts/example1"], "auth": { "header": "x-hub-auth", "scheme": "Token" } }
//     ]
//   }
//
// Per entry: `url` must be https, `key` is the per-subscriber sender key,
// `repos` (optional) scopes the entry to full owner/name repositories
// (matched case-insensitively), `auth` (optional) overrides the default
// `Authorization: Bearer <key>` header (the header must not be a reserved
// name like `x-hub-signature-256`; `scheme` defaults to `Bearer`). Every
// request also carries `x-hub-signature-256`, an HMAC-SHA256 of the body
// keyed by `key`. Malformed JSON or invalid entries fail closed (skipped,
// with a redacted warning); duplicate destinations are deduped. Keys and
// URLs are never echoed into logs, errors, or stored state.

const text = new TextEncoder();

export const MAX_DELIVERY_ATTEMPTS = 5;
export const PUSH_TIMEOUT_MS = 5_000;
export const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEAD_LETTER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Hard cap for records no subscriber matched (pull-only): they can't ack, so
// they can't wait on `pulled` forever.
export const PULL_ONLY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Cap on the stored comment text so one record can't exceed the 128 KiB
// storage value limit; the pull path sees a truncation marker, never a gap.
export const TEXT_LIMIT = 16_384;
// ~30s, 2m, 10m, 1h: long enough for a receiver to outlive a deploy blip,
// short enough that MAX_DELIVERY_ATTEMPTS converges in hours, not days.
export const BACKOFF_SCHEDULE_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];

const RECORD_PREFIX = 'record:';
const LEGACY_KEY = 'records';
const RESERVED_AUTH_HEADERS = new Set(['x-hub-signature-256', 'content-type']);

// Records stored by earlier versions (or handed in by tests) may lack
// `id`, `deliveries`, `createdAt`, or `pulled`. Normalize on every read
// path so no consumer ever sees a record without them.
export function normalizeRecord(record, now = Date.now()) {
  const source = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const normalized = {
    ...source,
    id: typeof source.id === 'string' && source.id !== '' ? source.id : crypto.randomUUID(),
    pulled: source.pulled === true,
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : now,
    deliveries: Array.isArray(source.deliveries) ? source.deliveries : [],
  };
  if (typeof normalized.text === 'string' && normalized.text.length > TEXT_LIMIT) {
    normalized.text = `${normalized.text.slice(0, TEXT_LIMIT)}\n[truncated]`;
  }
  return normalized;
}

export function createMailbox() {
  let records = [];
  return {
    async add(record) {
      records.push(normalizeRecord(record, Date.now()));
    },
    async take({ app, repo }) {
      const result = takeRecord(records, { app, repo });
      records = result.records;
      return result.record;
    },
    async size() {
      return records.filter((record) => record.pulled !== true).length;
    },
  };
}

export async function signBody(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    text.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, text.encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function verifyGithubSignature(secret, body, header) {
  if (typeof secret !== 'string' || secret === '' || typeof header !== 'string' || !header.startsWith('sha256=')) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    text.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, text.encode(body)));
  const expected = [...mac].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const got = header.slice('sha256='.length);
  if (expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// Redaction guard: any text that might reach a log, an error, or a stored
// delivery state is passed through here so a sender key or subscriber URL can
// never leak, even when a lower layer (fetch, URL parsing) embeds it in a
// message.
export function redactSecrets(value, secrets) {
  let out = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

async function hashText(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', text.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// Parse the SUBSCRIBERS secret. Returns `{ subscribers, issues }`: issues are
// redacted, loggable reasons for skipping malformed input (never the key or
// URL). Identical destinations (same derived id) are deduped.
export async function parseSubscribers(raw) {
  const issues = [];
  if (typeof raw !== 'string' || raw.trim() === '') return { subscribers: [], issues };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push('SUBSCRIBERS is not valid JSON');
    return { subscribers: [], issues };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    issues.push('SUBSCRIBERS must be a JSON object keyed by App slug');
    return { subscribers: [], issues };
  }
  const subscribers = [];
  const seen = new Set();
  for (const [app, entries] of Object.entries(parsed)) {
    if (typeof app !== 'string' || app === '' || !Array.isArray(entries)) {
      issues.push(`skipped app ${JSON.stringify(app)}: expected an array of subscribers`);
      continue;
    }
    for (const entry of entries) {
      const skip = (reason) => issues.push(`skipped a subscriber for ${app}: ${reason}`);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        skip('entry is not an object');
        continue;
      }
      if (!isHttpsUrl(entry.url)) {
        skip('url is missing or not https');
        continue;
      }
      if (typeof entry.key !== 'string' || entry.key === '') {
        skip('key is missing');
        continue;
      }
      let repos = null;
      if (entry.repos !== undefined) {
        if (!Array.isArray(entry.repos) || entry.repos.length === 0
          || !entry.repos.every((repo) => typeof repo === 'string' && repo.includes('/'))) {
          skip('repos is malformed');
          continue;
        }
        repos = entry.repos.map((repo) => repo.toLowerCase());
      }
      let auth = null;
      if (entry.auth !== undefined) {
        if (!entry.auth || typeof entry.auth !== 'object' || Array.isArray(entry.auth)
          || typeof entry.auth.header !== 'string' || entry.auth.header === '') {
          skip('auth is malformed');
          continue;
        }
        const header = entry.auth.header.toLowerCase();
        if (RESERVED_AUTH_HEADERS.has(header)) {
          skip(`auth header ${header} is reserved`);
          continue;
        }
        const scheme = typeof entry.auth.scheme === 'string' && entry.auth.scheme !== ''
          ? entry.auth.scheme
          : 'Bearer';
        auth = { header, scheme };
      }
      const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : await hashText(entry.url);
      if (seen.has(id)) {
        issues.push(`skipped a subscriber for ${app}: duplicate destination`);
        continue; // identical URL/id, deduped
      }
      seen.add(id);
      subscribers.push({ id, app, url: entry.url, key: entry.key, repos, auth });
    }
  }
  return { subscribers, issues };
}

export function selectSubscribers(subscribers, record) {
  const repo = typeof record.repo === 'string' ? record.repo.toLowerCase() : record.repo;
  return subscribers.filter((subscriber) => (
    subscriber.app === record.app
    && (subscriber.repos === null || subscriber.repos.includes(repo))
  ));
}

// The pushed envelope is small and stable across retries so a receiver can
// dedupe on `id` and re-verify state against GitHub. It never carries the
// full GitHub payload (no `text`).
export function buildDeliveryEnvelope(record) {
  return {
    id: record.id,
    app: record.app,
    repo: record.repo,
    prOrIssueNumber: record.number ?? null,
    kind: record.kind,
    actor: record.actor ?? null,
    headSha: record.headSha ?? null,
    deliveredAt: Number.isFinite(record.createdAt) ? new Date(record.createdAt).toISOString() : null,
    url: record.url ?? null,
  };
}

export function classifyRetryable(status) {
  if (!Number.isInteger(status)) return false;
  return status === 429 || status >= 500;
}

export function backoffMs(attempts) {
  const index = Math.max(0, Math.min(attempts - 1, BACKOFF_SCHEDULE_MS.length - 1));
  return BACKOFF_SCHEDULE_MS[index];
}

// Attempt delivery to one subscriber. 2xx is final; 429/5xx retry; any other
// 4xx is permanent. Network errors and timeouts retry. The receiver response
// body is never reflected; only the status is surfaced, and every message
// transits the redaction guard.
export async function deliverToSubscriber(subscriber, envelope, { fetchImpl = fetch, timeoutMs = PUSH_TIMEOUT_MS } = {}) {
  const body = JSON.stringify(envelope);
  const signature = await signBody(subscriber.key, body);
  const auth = subscriber.auth ?? { header: 'authorization', scheme: 'Bearer' };
  const headers = {
    'content-type': 'application/json',
    'x-hub-signature-256': signature,
  };
  headers[auth.header] = `${auth.scheme} ${subscriber.key}`;
  try {
    const response = await fetchImpl(subscriber.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return { ok: true, status: response.status, retryable: false, error: null };
    return { ok: false, status: response.status, retryable: classifyRetryable(response.status), error: `HTTP ${response.status}` };
  } catch (error) {
    const message = redactSecrets(error?.message ?? 'network error', [subscriber.key, subscriber.url]);
    return { ok: false, status: null, retryable: true, error: message };
  }
}

export function applyDeliveryAttempt(delivery, outcome, { maxAttempts = MAX_DELIVERY_ATTEMPTS, now = Date.now() } = {}) {
  const attempts = (delivery.attempts ?? 0) + 1;
  if (outcome.ok) {
    return { ...delivery, status: 'delivered', attempts, lastError: null, nextRetryAt: null, deliveredAt: now };
  }
  if (outcome.retryable === true && attempts < maxAttempts) {
    return { ...delivery, status: 'pending', attempts, lastError: outcome.error ?? null, nextRetryAt: now + backoffMs(attempts) };
  }
  return { ...delivery, status: 'dead', attempts, lastError: outcome.error ?? null, nextRetryAt: null };
}

// Collect every due delivery across ALL records (pending and nextRetryAt in
// the past) and push them with bounded concurrency. Returns one outcome per
// due delivery as `{ recordId, subscriberId, delivery }`. This runs outside
// any concurrency lock: the caller applies the results afterward.
export async function collectAndPush(records, subscribers, { now = Date.now(), fetchImpl = fetch, maxAttempts = MAX_DELIVERY_ATTEMPTS, timeoutMs = PUSH_TIMEOUT_MS, concurrency = 8 } = {}) {
  const subscriberById = new Map(subscribers.map((subscriber) => [subscriber.id, subscriber]));
  const recordById = new Map(records.map((record) => [record.id, record]));
  const due = [];
  for (const record of records) {
    const deliveries = Array.isArray(record.deliveries) ? record.deliveries : [];
    for (const delivery of deliveries) {
      if (delivery.status === 'pending' && delivery.nextRetryAt !== null && delivery.nextRetryAt <= now) {
        due.push({ recordId: record.id, subscriberId: delivery.subscriberId, delivery });
      }
    }
  }
  return mapConcurrent(due, concurrency, async ({ recordId, subscriberId, delivery }) => {
    const subscriber = subscriberById.get(subscriberId);
    const record = recordById.get(recordId);
    if (!subscriber || !record) {
      // A transiently malformed SUBSCRIBERS secret (or a deploy between
      // reads) must not dead-letter live deliveries: retry with the normal
      // backoff and let the attempt cap decide.
      return {
        recordId,
        subscriberId,
        delivery: applyDeliveryAttempt(delivery, { ok: false, retryable: true, error: 'subscriber removed' }, { maxAttempts, now }),
      };
    }
    const outcome = await deliverToSubscriber(subscriber, buildDeliveryEnvelope(record), { fetchImpl, timeoutMs });
    return { recordId, subscriberId, delivery: applyDeliveryAttempt(delivery, outcome, { maxAttempts, now }) };
  });
}

// Run `fn` over `items` with at most `limit` in flight, preserving order.
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = [];
  const count = Math.max(1, Math.min(limit, items.length));
  for (let worker = 0; worker < count; worker += 1) {
    workers.push((async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) break;
        results[index] = await fn(items[index], index);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

// Non-destructive take: return the oldest not-yet-pulled record for an
// app/repo and mark it pulled. It stays in storage until the push deliveries
// are terminal and its TTL expires.
export function takeRecord(records, { app, repo }) {
  const index = records.findIndex((record) => record.app === app && record.repo === repo && record.pulled !== true);
  if (index < 0) return { records, record: null };
  const next = records.slice();
  next[index] = { ...next[index], pulled: true };
  return { records: next, record: next[index] };
}

// Prune records whose push deliveries are terminal and whose TTL has
// elapsed, and compute when the object should next wake. Pending records
// are never pruned (the earliest nextRetryAt wins the wake). Dead-lettered
// records live 7 days from creation. Fully pushed records live 24h past
// the LAST ack regardless of `pulled` — a push-only subscriber never
// pulls, so waiting on `pulled` would accumulate forever. Records no
// subscriber matched (pull-only) live until pulled (then 24h), with a
// 7-day hard cap that also counts toward the wake. Returns
// `{ kept, nextWake }`.
export function pruneRecords(records, now = Date.now(), { deliveredTtlMs = DELIVERED_TTL_MS, deadLetterTtlMs = DEAD_LETTER_TTL_MS, pullOnlyTtlMs = PULL_ONLY_TTL_MS } = {}) {
  const kept = [];
  let nextWake = null;
  const consider = (time) => {
    if (Number.isFinite(time) && (nextWake === null || time < nextWake)) nextWake = time;
  };
  for (const record of records) {
    const deliveries = Array.isArray(record.deliveries) ? record.deliveries : [];
    const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : now;
    if (deliveries.some((delivery) => delivery.status === 'pending')) {
      kept.push(record);
      for (const delivery of deliveries) {
        if (delivery.status === 'pending') consider(delivery.nextRetryAt);
      }
      continue;
    }
    if (deliveries.some((delivery) => delivery.status === 'dead')) {
      if (now - createdAt < deadLetterTtlMs) {
        kept.push(record);
        consider(createdAt + deadLetterTtlMs);
      }
      continue;
    }
    if (deliveries.length === 0) {
      // Pull-only: nothing can ack it, so it can't wait on `pulled` forever.
      if (record.pulled === true) {
        if (now - createdAt < deliveredTtlMs) {
          kept.push(record);
          consider(createdAt + deliveredTtlMs);
        }
      } else if (now - createdAt < pullOnlyTtlMs) {
        kept.push(record);
        consider(createdAt + pullOnlyTtlMs);
      }
      continue;
    }
    // Delivered to every matched subscriber: 24h past the last ack, pulled
    // or not, so push-only consumers don't accumulate and replays stop.
    // A delivery without a recorded ack time contributes nothing (the
    // creation time is the floor), never the epoch.
    const lastAck = deliveries.reduce(
      (latest, delivery) => (Number.isFinite(delivery.deliveredAt) ? Math.max(latest, delivery.deliveredAt) : latest),
      createdAt,
    );
    if (now - lastAck < deliveredTtlMs) {
      kept.push(record);
      consider(lastAck + deliveredTtlMs);
    }
  }
  return { kept, nextWake };
}

function mentions(body, app) {
  if (typeof body !== 'string' || typeof app !== 'string' || app === '') return false;
  const escaped = app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\w-])@${escaped}(?:\\[bot\\])?(?![\\w-])`, 'i').test(body);
}

function sameAccount(login, app) {
  if (typeof login !== 'string' || typeof app !== 'string') return false;
  const left = login.toLowerCase();
  const right = app.toLowerCase();
  return left === right || left === `${right}[bot]`;
}

export function acceptDelivery(app, payload) {
  const repo = payload?.repository?.full_name;
  if (typeof repo !== 'string' || !repo.includes('/')) return null;
  if (payload.action === 'review_requested') {
    const login = payload.requested_reviewer?.login;
    if (!sameAccount(login, app)) return null;
    if (sameAccount(payload.pull_request?.user?.login, app)) return null;
    return {
      app,
      repo,
      kind: 'review_requested',
      url: payload.pull_request?.html_url ?? null,
      text: null,
      number: payload.pull_request?.number ?? null,
      actor: payload.sender?.login ?? payload.pull_request?.user?.login ?? null,
      headSha: payload.pull_request?.head?.sha ?? null,
    };
  }
  if (payload.action === 'created' && payload.comment) {
    const login = payload.comment.user?.login;
    if (sameAccount(login, app)) return null;
    if (!mentions(payload.comment.body, app)) return null;
    return {
      app,
      repo,
      kind: 'mention',
      url: payload.comment.html_url ?? payload.issue?.html_url ?? null,
      text: payload.comment.body ?? null,
      number: payload.pull_request?.number ?? payload.issue?.number ?? null,
      actor: payload.sender?.login ?? payload.comment?.user?.login ?? null,
      headSha: payload.pull_request?.head?.sha ?? null,
    };
  }
  return null;
}

function json(status, body) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: body == null ? {} : { 'content-type': 'application/json' },
  });
}

function bearer(request) {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

function authorized(request, inboxToken) {
  const token = bearer(request);
  if (typeof inboxToken !== 'string' || inboxToken === '' || token == null) return false;
  if (token.length !== inboxToken.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ inboxToken.charCodeAt(i);
  return diff === 0;
}

function fullName(value) {
  return typeof value === 'string' && /^[^/]+\/[^/]+$/.test(value);
}

export async function handleHookRequest(request, mailbox, { inboxToken, webhookSecrets }) {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname.startsWith('/github/')) {
    const requested = decodeURIComponent(url.pathname.slice('/github/'.length));
    const app = Object.keys(webhookSecrets ?? {}).find((name) => name.toLowerCase() === requested.toLowerCase()) ?? requested;
    const secret = webhookSecrets?.[app];
    const body = await request.text();
    const ok = await verifyGithubSignature(secret, body, request.headers.get('x-hub-signature-256'));
    if (!ok) return json(401, { error: 'bad signature' });
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(400, { error: 'bad payload' });
    }
    const record = acceptDelivery(app, payload);
    if (record) {
      // GitHub redeliveries reuse the same delivery GUID; carrying it as the
      // record id lets the storage dedupe instead of re-pushing.
      const deliveryId = request.headers.get('x-github-delivery');
      if (typeof deliveryId === 'string' && deliveryId !== '') record.id = deliveryId;
      await mailbox.add(record);
    }
    return json(200, { stored: Boolean(record) });
  }
  if (request.method === 'POST' && url.pathname === '/inbox') {
    if (!authorized(request, inboxToken)) return json(401, { error: 'unauthorized' });
    const app = url.searchParams.get('app');
    const repo = url.searchParams.get('repo');
    if (typeof app !== 'string' || app === '' || !fullName(repo)) {
      return json(400, { error: 'app and repo=owner/name are required' });
    }
    const record = await mailbox.take({ app, repo });
    if (!record) return new Response(null, { status: 204 });
    return json(200, record);
  }
  if (request.method === 'GET' && url.pathname === '/deadletter') {
    if (!authorized(request, inboxToken)) return json(401, { error: 'unauthorized' });
    const app = url.searchParams.get('app');
    if (typeof app !== 'string' || app === '') return json(400, { error: 'app is required' });
    if (typeof mailbox.deadletter !== 'function') return json(404, { error: 'not found' });
    const records = await mailbox.deadletter({ app });
    return json(200, records);
  }
  return json(404, { error: 'not found' });
}

export class InboxDurable {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    // Production uses the Worker runtime fetch; tests inject a fake here.
    this.fetchImpl = env?.fetchImpl ?? fetch;
    this.alarmFailures = 0;
  }

  keyFor(id) {
    return `${RECORD_PREFIX}${id}`;
  }

  // Migrate the legacy single-`records`-array layout to per-record keys.
  // Ids for legacy records are derived deterministically (content plus array
  // index, so identical legacy events stay distinct records) so two
  // overlapping migrations can't duplicate one. Idempotent: safe to call
  // anywhere.
  async migrateLegacy(now) {
    const legacy = await this.storage.get(LEGACY_KEY);
    if (!Array.isArray(legacy)) return;
    for (const [index, raw] of legacy.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const id = typeof raw.id === 'string' && raw.id !== ''
        ? raw.id
        : await hashText(JSON.stringify([index, raw.app, raw.repo, raw.kind, raw.url, raw.text ?? null, raw.number ?? null]));
      await this.storage.put(this.keyFor(id), normalizeRecord({ ...raw, id }, now));
    }
    await this.storage.delete(LEGACY_KEY);
  }

  // storage.list() yields raw values in KEY order, and keys are opaque ids
  // (delivery GUIDs), so take would return a random record. Order by
  // creation time (then id, for same-millisecond ties) to keep /inbox FIFO.
  // A StoredValue `{value}` wrapper is unwrapped defensively in case the
  // runtime ever hands one back.
  async listRecords() {
    const map = await this.storage.list({ prefix: RECORD_PREFIX });
    const records = [];
    for (const value of map.values()) {
      const record = value && typeof value === 'object' && !Array.isArray(value) && 'value' in value
        ? value.value
        : value;
      if (record && typeof record === 'object' && !Array.isArray(record)) records.push(record);
    }
    return records.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
  }

  async subscribers() {
    const { subscribers, issues } = await parseSubscribers(this.env?.SUBSCRIBERS ?? null);
    for (const issue of issues) console.warn(`gh-app-hook: ${issue}`);
    return subscribers;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json();
    if (path === '/take') return this.handleTake(body);
    if (path === '/deadletter') return this.handleDeadletter(body);
    if (path === '/add') return this.handleAdd(body);
    return new Response(null, { status: 404 });
  }

  // Persist first, push later: normalize, dedupe on id, persist the record
  // with pending deliveries, schedule the alarm, return. No outbound fetch
  // happens here, so GitHub's webhook is never held hostage to a receiver.
  async handleAdd(body) {
    const now = Date.now();
    return this.state.blockConcurrencyWhile(async () => {
      await this.migrateLegacy(now);
      const record = normalizeRecord(body, now);
      if (await this.storage.get(this.keyFor(record.id))) {
        return new Response(null, { status: 204 }); // redelivery, already stored
      }
      const subscribers = await this.subscribers();
      const matches = selectSubscribers(subscribers, record);
      record.deliveries = matches.map((subscriber) => ({
        subscriberId: subscriber.id,
        status: 'pending',
        attempts: 0,
        lastError: null,
        nextRetryAt: now,
        deliveredAt: null,
      }));
      await this.storage.put(this.keyFor(record.id), record);
      await this.storage.setAlarm(now);
      return new Response(null, { status: 204 });
    });
  }

  async handleTake({ app, repo }) {
    return this.state.blockConcurrencyWhile(async () => {
      await this.migrateLegacy(Date.now());
      const records = await this.listRecords();
      const { record } = takeRecord(records, { app, repo });
      if (record) await this.storage.put(this.keyFor(record.id), record);
      return record ? Response.json(record) : new Response(null, { status: 204 });
    });
  }

  async handleDeadletter({ app }) {
    await this.migrateLegacy(Date.now());
    const records = await this.listRecords();
    const dead = records.filter((record) => (
      record.app === app && record.deliveries.some((delivery) => delivery.status === 'dead')
    ));
    return Response.json(dead);
  }

  async alarm() {
    try {
      await this.runAlarm();
      this.alarmFailures = 0;
    } catch (error) {
      // Cloudflare retries a *failed* alarm only six times, so a transiently
      // throwing alarm would silently drop the retry loop. Catch, log
      // redacted, and re-arm with backoff. Durable attempt reservations
      // prevent a failed outcome save from allowing unlimited re-pushes.
      this.alarmFailures += 1;
      let retryAt = Date.now() + backoffMs(this.alarmFailures);
      try {
        const { nextWake } = pruneRecords(await this.listRecords(), Date.now());
        if (nextWake !== null) retryAt = Math.max(retryAt, nextWake);
      } catch {
        // Storage may still be unavailable; keep the alarm retry alive.
      }
      const { subscribers } = await parseSubscribers(this.env?.SUBSCRIBERS ?? null);
      const secrets = subscribers.flatMap((subscriber) => [subscriber.key, subscriber.url]);
      console.warn(`gh-app-hook: alarm failed; re-armed: ${redactSecrets(error?.message ?? 'unknown error', secrets)}`);
      await this.storage.setAlarm(retryAt);
    }
  }

  async runAlarm() {
    const now = Date.now();
    await this.migrateLegacy(now);
    const subscribers = await this.subscribers();
    const snapshot = await this.state.blockConcurrencyWhile(async () => {
      const records = await this.listRecords();
      const reserved = records.map((record) => ({
        ...record,
        deliveries: record.deliveries.map((delivery) => (
          delivery.status === 'pending' && delivery.nextRetryAt !== null && delivery.nextRetryAt <= now
            ? applyDeliveryAttempt(delivery, { ok: false, retryable: true, error: 'delivery outcome not saved' }, { now })
            : delivery
        )),
      }));
      // Persist the attempt and backoff BEFORE sending. If the outcome
      // save fails or the object restarts, retries still consume the cap.
      for (const [index, record] of reserved.entries()) {
        if (record.deliveries.some((delivery, i) => delivery !== records[index].deliveries[i])) {
          await this.storage.put(this.keyFor(record.id), record);
        }
      }
      const { nextWake } = pruneRecords(reserved, now);
      if (nextWake !== null) await this.storage.setAlarm(nextWake);
      return records;
    });
    // Outbound pushes run with bounded concurrency and no lock held, so a
    // hung receiver can't stall the object or other events.
    const outcomes = await collectAndPush(snapshot, subscribers, { now, fetchImpl: this.fetchImpl });
    await this.state.blockConcurrencyWhile(async () => {
      const current = await this.listRecords();
      const outcomeByKey = new Map(outcomes.map((outcome) => [`${outcome.recordId}\u0000${outcome.subscriberId}`, outcome.delivery]));
      const merged = current.map((record) => {
        let changed = false;
        const deliveries = record.deliveries.map((delivery) => {
          const replacement = outcomeByKey.get(`${record.id}\u0000${delivery.subscriberId}`);
          // Apply an outcome only while the reservation it answers is still
          // current. A later alarm may have reserved another attempt while
          // this push ran; a stale outcome must never lower that count.
          if (replacement && delivery.attempts === replacement.attempts) {
            changed = true;
            return replacement;
          }
          return delivery;
        });
        return changed ? { ...record, deliveries } : record;
      });
      const changedIds = new Set(outcomes.map((outcome) => outcome.recordId));
      const { kept, nextWake } = pruneRecords(merged, now);
      const keptIds = new Set(kept.map((record) => record.id));
      for (const record of kept) {
        if (changedIds.has(record.id)) await this.storage.put(this.keyFor(record.id), record);
      }
      for (const record of current) {
        if (!keptIds.has(record.id)) await this.storage.delete(this.keyFor(record.id));
      }
      if (nextWake !== null) await this.storage.setAlarm(nextWake);
      else await this.storage.deleteAlarm();
    });
  }
}

function durableMailbox(namespace) {
  const stub = namespace.get(namespace.idFromName('inbox'));
  return {
    async add(record) {
      const response = await stub.fetch('https://inbox/add', { method: 'POST', body: JSON.stringify(record) });
      if (!response.ok && response.status !== 204) throw new Error(`inbox add failed: ${response.status}`);
    },
    async take(key) {
      const response = await stub.fetch('https://inbox/take', { method: 'POST', body: JSON.stringify(key) });
      if (response.status === 204) return null;
      if (!response.ok) throw new Error(`inbox take failed: ${response.status}`);
      return response.json();
    },
    async deadletter(key) {
      const response = await stub.fetch('https://inbox/deadletter', { method: 'POST', body: JSON.stringify(key) });
      if (!response.ok) throw new Error(`inbox deadletter failed: ${response.status}`);
      return response.json();
    },
  };
}

export default {
  async fetch(request, env = {}) {
    if (!env.INBOX) return json(500, { error: 'inbox storage is not bound' });
    let webhookSecrets = {};
    try {
      webhookSecrets = JSON.parse(env.WEBHOOK_SECRETS ?? '{}');
    } catch {
      webhookSecrets = {};
    }
    return handleHookRequest(request, durableMailbox(env.INBOX), {
      inboxToken: env.INBOX_TOKEN,
      webhookSecrets,
    });
  },
};
