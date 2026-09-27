// GitHub App mailbox. GitHub posts a signed delivery. A session takes the
// oldest record for one App and one full owner/name repository. The take
// marks the record pulled rather than deleting it: a record stays in storage
// until every push subscriber has acked (or been dead-lettered) and the pull
// path has seen it, so a record a push is still delivering is never lost.
//
// Push delivery, retry, and dead-lettering live in the Durable Object. The
// core decision logic (subscriber selection, HMAC signing, retry
// classification, delivery-state transitions, TTL pruning) is pure and
// Cloudflare-free so the Node test runner can cover it without a Worker
// runtime.

const text = new TextEncoder();

export const MAX_DELIVERY_ATTEMPTS = 5;
export const PUSH_TIMEOUT_MS = 5_000;
export const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const DEAD_LETTER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createMailbox() {
  let records = [];
  let next = 1;
  return {
    async add(record) {
      records.push({ ...record, id: next++, pulled: false, createdAt: Date.now(), deliveries: [] });
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

function isValidUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// SUBSCRIBERS is a Worker secret mapping an App slug to a list of
// destinations. Each entry carries its own sender key and an optional repo
// scope and auth override. Malformed JSON or invalid entries fail closed
// (skipped); keys and URLs are never echoed.
export async function parseSubscribers(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const subscribers = [];
  for (const [app, entries] of Object.entries(parsed)) {
    if (typeof app !== 'string' || app === '' || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const url = entry.url;
      const key = entry.key;
      if (!isValidUrl(url) || typeof key !== 'string' || key === '') continue;
      let repos = null;
      if (entry.repos !== undefined) {
        if (!Array.isArray(entry.repos) || !entry.repos.every((repo) => typeof repo === 'string' && repo.includes('/'))) {
          continue;
        }
        repos = entry.repos;
      }
      let auth = null;
      if (entry.auth !== undefined) {
        if (
          !entry.auth || typeof entry.auth !== 'object'
          || typeof entry.auth.header !== 'string' || entry.auth.header === ''
          || typeof entry.auth.scheme !== 'string' || entry.auth.scheme === ''
        ) {
          continue;
        }
        auth = { header: entry.auth.header.toLowerCase(), scheme: entry.auth.scheme };
      }
      const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : await hashText(url);
      subscribers.push({ id, app, url, key, repos, auth });
    }
  }
  return subscribers;
}

export function selectSubscribers(subscribers, record) {
  return subscribers.filter((subscriber) => (
    subscriber.app === record.app
    && (subscriber.repos === null || subscriber.repos.includes(record.repo))
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
  return Math.min(1000 * 2 ** Math.max(0, attempts - 1), 60_000);
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

// Push one record to all matching subscribers and fold the outcomes into
// per-subscriber delivery state. Returns the earliest alarm time (if any)
// for a pending retry.
export async function runDeliveries(record, subscribers, { fetchImpl = fetch, now = Date.now(), maxAttempts = MAX_DELIVERY_ATTEMPTS, timeoutMs = PUSH_TIMEOUT_MS } = {}) {
  const envelope = buildDeliveryEnvelope(record);
  const deliveries = await Promise.all(subscribers.map(async (subscriber) => {
    const outcome = await deliverToSubscriber(subscriber, envelope, { fetchImpl, timeoutMs });
    return applyDeliveryAttempt(
      { subscriberId: subscriber.id, status: 'pending', attempts: 0, lastError: null, nextRetryAt: null, deliveredAt: null },
      outcome,
      { maxAttempts, now },
    );
  }));
  let nextAlarm = null;
  for (const delivery of deliveries) {
    if (delivery.status === 'pending' && (nextAlarm === null || delivery.nextRetryAt < nextAlarm)) {
      nextAlarm = delivery.nextRetryAt;
    }
  }
  return { deliveries, nextAlarm };
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

// Remove records whose push deliveries are terminal and whose TTL has
// elapsed. Fully delivered records live 24h; records with a dead delivery
// live 7 days so /deadletter stays readable. Pending records are never
// pruned. Returns the earliest future expiry among kept settled records.
export function pruneRecords(records, now = Date.now(), { deliveredTtlMs = DELIVERED_TTL_MS, deadLetterTtlMs = DEAD_LETTER_TTL_MS } = {}) {
  const kept = [];
  let nextExpiry = null;
  for (const record of records) {
    const pending = record.deliveries.some((delivery) => delivery.status === 'pending');
    if (pending) {
      kept.push(record);
      continue;
    }
    const hasDead = record.deliveries.some((delivery) => delivery.status === 'dead');
    const ttl = hasDead ? deadLetterTtlMs : deliveredTtlMs;
    const age = now - record.createdAt;
    if (age >= ttl) continue;
    kept.push(record);
    const expiry = record.createdAt + ttl;
    if (nextExpiry === null || expiry < nextExpiry) nextExpiry = expiry;
  }
  return { kept, nextExpiry };
}

function earliestWake(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return a < b ? a : b;
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
    if (record) await mailbox.add(record);
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
  }

  async read() {
    return (await this.storage.get('records')) ?? [];
  }

  async write(records) {
    await this.storage.put('records', records);
  }

  async subscribers() {
    return parseSubscribers(this.env?.SUBSCRIBERS ?? null);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json();
    if (path === '/take') return this.handleTake(body);
    if (path === '/deadletter') return this.handleDeadletter(body);
    if (path === '/add') return this.handleAdd(body);
    return new Response(null, { status: 404 });
  }

  async handleAdd(record) {
    const now = Date.now();
    const stored = { ...record, id: crypto.randomUUID(), pulled: false, createdAt: now, deliveries: [] };
    const subscribers = await this.subscribers();
    const matches = selectSubscribers(subscribers, stored);
    await this.state.blockConcurrencyWhile(async () => {
      const { deliveries, nextAlarm } = await runDeliveries(stored, matches, { now });
      const records = await this.read();
      records.push({ ...stored, deliveries });
      const { kept, nextExpiry } = pruneRecords(records, now);
      await this.write(kept);
      const wake = earliestWake(nextAlarm, nextExpiry);
      if (wake !== null) await this.storage.setAlarm(wake);
      else await this.storage.deleteAlarm();
    });
    return new Response(null, { status: 204 });
  }

  async handleTake({ app, repo }) {
    const record = await this.state.blockConcurrencyWhile(async () => {
      const records = await this.read();
      const { records: next, record: taken } = takeRecord(records, { app, repo });
      await this.write(next);
      return taken;
    });
    if (!record) return new Response(null, { status: 204 });
    return Response.json(record);
  }

  async handleDeadletter({ app }) {
    const records = await this.read();
    const dead = records.filter((record) => record.app === app && record.deliveries.some((delivery) => delivery.status === 'dead'));
    return Response.json(dead);
  }

  async alarm() {
    const now = Date.now();
    await this.state.blockConcurrencyWhile(async () => {
      const subscribers = await this.subscribers();
      const byId = new Map(subscribers.map((subscriber) => [subscriber.id, subscriber]));
      const records = await this.read();
      let nextAlarm = null;
      const updated = [];
      for (const record of records) {
        const due = record.deliveries.some((delivery) => (
          delivery.status === 'pending' && delivery.nextRetryAt !== null && delivery.nextRetryAt <= now
        ));
        if (!due) {
          updated.push(record);
          continue;
        }
        const envelope = buildDeliveryEnvelope(record);
        const deliveries = [];
        for (const delivery of record.deliveries) {
          if (!(delivery.status === 'pending' && delivery.nextRetryAt !== null && delivery.nextRetryAt <= now)) {
            deliveries.push(delivery);
            continue;
          }
          const subscriber = byId.get(delivery.subscriberId);
          if (!subscriber) {
            deliveries.push({ ...delivery, status: 'dead', lastError: 'subscriber removed', nextRetryAt: null });
            continue;
          }
          const outcome = await deliverToSubscriber(subscriber, envelope, { fetchImpl: fetch });
          const applied = applyDeliveryAttempt(delivery, outcome, { maxAttempts: MAX_DELIVERY_ATTEMPTS, now });
          deliveries.push(applied);
          if (applied.status === 'pending' && (nextAlarm === null || applied.nextRetryAt < nextAlarm)) {
            nextAlarm = applied.nextRetryAt;
          }
        }
        updated.push({ ...record, deliveries });
      }
      const { kept, nextExpiry } = pruneRecords(updated, now);
      await this.write(kept);
      const wake = earliestWake(nextAlarm, nextExpiry);
      if (wake !== null) await this.storage.setAlarm(wake);
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
