// GitHub App mailbox. GitHub posts a signed delivery. A session takes the
// oldest record for one App and one full owner/name repository. The take
// removes the record. This module has no network and no Cloudflare binding;
// the Worker entry below is a thin fetch wrapper around an in-memory mailbox
// for one isolate. A Durable Object can replace that mailbox later without
// changing the routes.

const text = new TextEncoder();

export function createMailbox() {
  const records = [];
  let next = 1;
  return {
    async add(record) {
      records.push({ ...record, id: next++ });
    },
    async take({ app, repo }) {
      const index = records.findIndex((record) => record.app === app && record.repo === repo);
      if (index < 0) return null;
      const [record] = records.splice(index, 1);
      return record;
    },
    async size() {
      return records.length;
    },
  };
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
  return json(404, { error: 'not found' });
}

export class InboxDurable {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const records = (await this.storage.get('records')) ?? [];
    const body = await request.json();
    if (new URL(request.url).pathname === '/take') {
      const index = records.findIndex((record) => record.app === body.app && record.repo === body.repo);
      if (index < 0) return new Response(null, { status: 204 });
      const [record] = records.splice(index, 1);
      await this.storage.put('records', records);
      return Response.json(record);
    }
    records.push(body);
    await this.storage.put('records', records);
    return new Response(null, { status: 204 });
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
