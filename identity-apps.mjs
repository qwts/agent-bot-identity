#!/usr/bin/env node
// Managed GitHub Apps. All public results/errors are constructed here; API,
// provider, filesystem and crypto exceptions must never reach the caller.
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apiBase, isGateEnabled, loadConfig, slugForHarness, appLifecycleStatus } from './config.mjs';
import { PROFILE_HARNESSES, profileAppSlugs } from './organization-profile.mjs';
import { assertOwnerAction } from './owner-gate.mjs';
import { assignAgentApp, readAgentIdentity, stateDirectory, validateAgentId } from './agent-identity.mjs';
import { listSouls, populationFile, showSoul, setSoulApp, soulDirectory } from './agent-population.mjs';
import { soulCredentialsDeclaration } from './soul-package.mjs';
import { credentialStores, defaultCredentialStore, resolveAppCredential } from './soul-credentials.mjs';
import { createProtonPassCredentialProvider, validateIssuer, validatePrivateKey } from './ensure-private-key.mjs';
import { buildAppJwt, pickInstallation } from './mint-token.mjs';
import { MINT_CODES, appStoreTarget, readAppDoctorCache, readAppMetadata, updateAppConfig, validAppSlug } from './identity-app-store.mjs';

export class IdentityAppError extends Error {
  constructor(code, message, statusCode = 409) { super(message); Object.assign(this, { code, statusCode }); }
}
const fail = (code, message, status) => { throw new IdentityAppError(code, message, status); };
export function identityAppFailure(error) {
  return error instanceof IdentityAppError ? { code: error.code, message: error.message }
    : { code: 'identity-app-failed', message: 'App operation failed; check the configuration and credential store, then retry.' };
}
function slug(value) {
  if (!validAppSlug(value)) fail('identity-app-invalid', 'A valid App slug is required.', 400);
  return value;
}
function settings(options) {
  const env = options.env ?? process.env, home = options.home ?? homedir();
  return { ...options, env, home, config: loadConfig({ env, home }), stores: options.stores ?? credentialStores({ env }), platform: options.platform ?? process.platform };
}
function enabled(config) {
  if (!isGateEnabled('github-identity', { config })) fail('identity-app-disabled', 'Enable the github-identity add-on before managing Apps.');
}
function active(app, config) {
  if (appLifecycleStatus(app, config) === 'retired') fail('identity-app-retired', `App ${app} is retired; choose an active App.`);
  if (config.scope?.apps && !config.scope.apps.includes(app)) fail('identity-app-out-of-scope', `App ${app} is outside this account's scope.`);
}
const installUrl = (app) => `https://github.com/apps/${slug(app)}/installations/new`;
function fingerprint(pem) {
  return `SHA256:${createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('base64')}`;
}
function installations(rows) {
  if (!Array.isArray(rows)) fail('identity-app-github', 'GitHub returned invalid installation metadata.');
  return rows.map((row) => {
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || !validAppSlug(row.account?.login?.toLowerCase()) || !['all', 'selected'].includes(row.repository_selection)) {
      fail('identity-app-github', 'GitHub returned invalid installation metadata.');
    }
    return { id: row.id, account: row.account.login, repositorySelection: row.repository_selection };
  });
}
async function github(method, route, credential, options) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agent-bot-identity' };
  if (credential) headers.authorization = `Bearer ${buildAppJwt(credential.appId, credential.privateKeyPem, Math.floor(Date.now() / 1000))}`;
  try {
    const response = await (options.fetchImpl ?? fetch)(`${apiBase(options.config)}${route}`, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) fail('identity-app-github', `GitHub refused the App operation (HTTP ${response.status}); check the App ID, key and installation.`);
    return await response.json();
  } catch (error) {
    if (error instanceof IdentityAppError) throw error;
    fail('identity-app-github', 'GitHub did not complete the App operation; retry after checking connectivity and credentials.');
  }
}
async function appInstallations(credential, options) {
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await github('GET', `/app/installations?per_page=100&page=${page}`, credential, options);
    installations(batch);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  fail('identity-app-github', 'The App installation list exceeded the supported limit; no changes were made.');
}
function keyInput(body, options) {
  if (Boolean(body.keyFile) === Boolean(body.passCli)) fail('identity-app-invalid', 'Supply exactly one keyFile/--key-file or passCli/--pass-cli.', 400);
  let pem;
  try {
    if (body.keyFile) {
      if (typeof body.keyFile !== 'string' || !path.isAbsolute(body.keyFile)) fail('identity-app-invalid', 'keyFile must be an absolute path.', 400);
      pem = readFileSync(body.keyFile, 'utf8');
    } else {
      // Existing provider contract: title in Agent Identities; temporary
      // download is private and removed even if the provider fails.
      slug(body.passCli);
      const dir = mkdtempSync(path.join(options.home ?? tmpdir(), '.app-key-'));
      try {
        const destination = path.join(dir, 'key.pem');
        (options.passProvider ?? createProtonPassCredentialProvider()).restore({ slug: body.passCli, privateKeyDestination: destination });
        pem = readFileSync(destination, 'utf8');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    if (!validatePrivateKey(pem) || createPrivateKey(pem).asymmetricKeyType !== 'rsa') fail('identity-app-key-invalid', 'The supplied key must be a valid RSA private key.', 400);
    return pem;
  } catch (error) {
    if (error instanceof IdentityAppError) throw error;
    fail('identity-app-key-unavailable', 'Could not read the replacement key; check the file or unlock the selected pass-cli item.');
  }
}
function persist(app, credential, cachedInstallations, options, { replace = false, previousFingerprint = null, metadata = {} } = {}) {
  active(app, options.config);
  const kind = options.config.identityApps?.[app]?.store ?? defaultCredentialStore(options.platform);
  if (!['file', 'keychain'].includes(kind)) fail('identity-app-store', 'This App requires a supported file or Keychain store.');
  const keyFingerprint = fingerprint(credential.privateKeyPem);
  let rollback = null;
  return updateAppConfig((config) => {
    active(app, config);
    const previous = config.identityApps?.[app];
    if (previous?.store && !replace) {
      // A verified connect can repair an absent item, but cannot silently
      // rotate a present key or treat a locked store as empty.
      const stored = options.stores[kind].read(appStoreTarget(app, options));
      if (stored || previous.id !== String(credential.appId)) fail('identity-app-exists', `App ${app} is already connected; use rotate-key.`);
    }
    if (replace && previous?.keyFingerprint !== previousFingerprint) fail('identity-app-conflict', `App ${app} changed; retry rotation.`);
    // A managed App must not shadow a signed-helper credential. The keyd
    // owner/import lifecycle remains with migrate-credentials.
    for (const soul of listSouls({ file: populationFile(options) })) {
      let directory;
      try { directory = soulDirectory(soul.id, { ...options, file: populationFile(options), readOnly: true }); } catch { fail('identity-app-store', 'Could not inspect soul credential declarations; repair the census before managing Apps.'); }
      const declaration = soulCredentialsDeclaration(directory);
      if (declaration?.app === app && declaration.store === 'keyd') fail('identity-app-keyd-held', `App ${app} is held by keyd; manage its keys through the keyd owner workflow.`);
    }
    if (previous?.store) {
      const before = options.stores[kind].read(appStoreTarget(app, options));
      if (before) rollback = () => options.stores[kind].write(appStoreTarget(app, options), before);
    }
    options.stores[kind].write(appStoreTarget(app, options), credential);
    config.identityApps ??= {};
    config.identityApps[app] = { ...previous, ...metadata, id: String(credential.appId), store: kind, keyFingerprint, installations: cachedInstallations };
    return { id: String(credential.appId), slug: app, installUrl: installUrl(app) };
  }, { ...options, rollback: () => rollback?.() });
}
export function listIdentityApps(options = {}) {
  const opts = settings(options), { config, env, home } = opts;
  if (!isGateEnabled('github-identity', { config })) return { schemaVersion: 1, apps: [] };
  const souls = listSouls({ file: populationFile({ env, home }) });
  const harnesses = [...new Set([...PROFILE_HARNESSES, ...Object.keys(config.apps ?? {})])];
  const mapped = harnesses.map((harness) => ({ harness, slug: slugForHarness(harness, config) }));
  const apps = new Set([...Object.keys(config.identityApps ?? {}), ...profileAppSlugs(config), ...mapped.map((r) => r.slug), ...souls.map((s) => s.appSlug)].filter(Boolean));
  const cache = readAppDoctorCache(opts);
  return { schemaVersion: 1, apps: [...apps].sort().map((app) => {
    slug(app);
    let issuerPresent = false, keyPresent = false;
    try {
      const credential = resolveAppCredential(app, { ...opts, cwd: home, readOnly: true, warn: () => {} });
      issuerPresent = Boolean(credential.appId);
      keyPresent = Boolean(credential.privateKeyPem);
    } catch {
      // Report independent presence for incomplete legacy installations.
      if (!config.identityApps?.[app]?.store) {
        issuerPresent = Boolean(readAppMetadata(app, opts).id);
        keyPresent = existsSync(path.join(home, '.config', app, 'private-key.pem'));
      }
    }
    const last = cache[app];
    const liveMint = last && ['ready', 'failed'].includes(last.status) && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(last.checkedAt)
      ? { status: last.status, code: MINT_CODES.includes(last.code) ? last.code : null, checkedAt: last.checkedAt } : { status: 'unknown' };
    const cached = config.identityApps?.[app]?.installations;
    return { slug: app, botLogin: `${app}[bot]`, issuerPresent, keyPresent,
      installations: Array.isArray(cached) ? installations(cached.map((r) => ({ id: r.id, account: { login: r.account }, repository_selection: r.repositorySelection }))) : [],
      harnesses: mapped.filter((r) => r.slug === app).map((r) => r.harness),
      souls: souls.filter((s) => s.appSlug === app).map((s) => s.id), liveMint };
  }) };
}
async function botMetadata(app, options) {
  // /app's id is the App issuer, never the bot user's UID.
  const profile = await github('GET', `/users/${encodeURIComponent(`${app}[bot]`)}`, null, options);
  if (!Number.isSafeInteger(profile.id) || profile.id <= 0 || typeof profile.avatar_url !== 'string') {
    fail('identity-app-github', 'GitHub returned invalid bot metadata.');
  }
  let url;
  try { url = new URL(profile.avatar_url); } catch { fail('identity-app-github', 'GitHub returned invalid bot metadata.'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('identity-app-github', 'GitHub returned invalid bot metadata.');
  return { botUid: String(profile.id), botAvatarUrl: profile.avatar_url };
}
async function connect(body, options) {
  if (typeof body.id !== 'string' || !validateIssuer(body.id)) fail('identity-app-invalid', 'A valid App ID is required.', 400);
  const credential = { appId: body.id, privateKeyPem: keyInput(body, options) };
  const info = await github('GET', '/app', credential, options);
  const app = slug(info.slug);
  if (String(info.id) !== body.id) fail('identity-app-mismatch', 'GitHub returned a different App ID.');
  const rows = await appInstallations(credential, options);
  return persist(app, credential, installations(rows), options, { metadata: await botMetadata(app, options) });
}
async function rotate(body, options) {
  const app = slug(body.slug), previous = options.config.identityApps?.[app];
  active(app, options.config);
  let old;
  try { old = resolveAppCredential(app, { ...options, warn: () => {} }); }
  catch { fail('identity-app-not-found', `App ${app} has no readable credential; connect it first.`, 404); }
  if (old.source === 'keyd') fail('identity-app-keyd-held', `App ${app} is held by keyd; use the keyd owner workflow.`);
  const credential = { appId: old.appId, privateKeyPem: keyInput(body, options), ...(old.webhookSecret ? { webhookSecret: old.webhookSecret } : {}) };
  if (fingerprint(old.privateKeyPem) === fingerprint(credential.privateKeyPem)) fail('identity-app-key-unchanged', `App ${app} needs a new key file or pass-cli item.`);
  const info = await github('GET', '/app', credential, options);
  if (info.slug !== app || String(info.id) !== String(old.appId)) fail('identity-app-mismatch', `The replacement key does not belong to App ${app}.`);
  const rows = await appInstallations(credential, options);
  let installation;
  try { installation = pickInstallation(rows, options.config.owner); }
  catch { fail('identity-app-installation', `Install App ${app}, or configure owner to select an installation, then retry.`); }
  const grant = await github('POST', `/app/installations/${installation.id}/access_tokens`, credential, options);
  if (typeof grant.token !== 'string' || !grant.token) fail('identity-app-mint-failed', `App ${app} returned no installation token; the stored key was not changed.`);
  const result = persist(app, credential, installations(rows), options, { replace: Boolean(previous?.store), previousFingerprint: previous?.keyFingerprint ?? null, metadata: await botMetadata(app, options) });
  return { ...result, retired: fingerprint(old.privateKeyPem), action: 'Delete the retired key in the App settings on github.com.' };
}
function assign(body, options) {
  const app = slug(body.slug);
  active(app, options.config);
  if (!options.config.identityApps?.[app]?.store) fail('identity-app-not-found', `App ${app} is not managed; connect it first.`, 404);
  if (Boolean(body.harness) === Boolean(body.soul)) fail('identity-app-invalid', 'Supply exactly one harness or soul.', 400);
  if (body.harness) {
    if (!PROFILE_HARNESSES.includes(body.harness)) fail('identity-app-invalid', 'Unknown harness.', 400);
    updateAppConfig((config) => { config.apps ??= {}; config.apps[body.harness] = app; }, options);
    return { slug: app, harness: body.harness };
  }
  let id;
  try { id = validateAgentId(body.soul); } catch { fail('identity-app-invalid', 'A valid soul Agent ID is required.', 400); }
  const file = populationFile(options), stateDir = stateDirectory(options);
  const soul = showSoul(id, { file });
  if (soul.status === 'retired') fail('identity-app-retired', 'Cannot assign a retired soul.');
  readAgentIdentity(id, { stateDir });
  let directory;
  try { directory = soulDirectory(id, { ...options, file }); } catch { /* census-only soul */ }
  if (directory && soulCredentialsDeclaration(directory)?.store === 'keyd') fail('identity-app-keyd-held', 'This soul uses keyd; change its identity through the keyd owner workflow.');
  assignAgentApp(id, app, { stateDir, afterWrite: () => setSoulApp(id, app, { file }) });
  return { slug: app, soul: id };
}
const htmlEscape = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export async function startAppManifest(body, options) {
  const state = randomBytes(32).toString('hex');
  let settled = false, accepted = false, timer, localUrl;
  let resolve, reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Consumers may attach after the listener starts; never emit an unhandled rejection.
  completion.catch(() => {});
  const finish = (error, result) => {
    if (settled) return;
    settled = true; clearTimeout(timer); server.close(); server.closeAllConnections();
    if (error) reject(error); else resolve(result);
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action https://github.com; frame-ancestors 'none'");
    const reply = (status, text, type = 'text/plain') => { res.writeHead(status, { 'content-type': `${type}; charset=utf-8` }); res.end(text); };
    try {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(localUrl).host) return reply(403, 'Loopback only.');
      const url = new URL(req.url, localUrl);
      if (url.pathname === '/' && req.method === 'GET' && url.searchParams.get('state') === state && !accepted) {
        const manifest = { ...(body.name ? { name: body.name } : {}), url: 'https://github.com',
          redirect_url: `${localUrl}callback`, public: false, hook_attributes: { url: 'https://example.invalid/disabled', active: false }, request_oauth_on_install: false,
          default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write' }, default_events: [] };
        const action = `https://github.com/${body.org ? `organizations/${body.org}/settings` : 'settings'}/apps/new?state=${state}`;
        return reply(200, `<!doctype html><title>Create GitHub App</title><form method="post" action="${action}"><input type="hidden" name="manifest" value="${htmlEscape(JSON.stringify(manifest))}"><button>Create GitHub App on github.com</button></form>`, 'text/html');
      }
      if (url.pathname !== '/callback' || !['GET', 'POST'].includes(req.method)) return reply(404, 'Not found.');
      let params = url.searchParams;
      if (req.method === 'POST') {
        if (req.headers.origin && !['https://github.com', new URL(localUrl).origin].includes(req.headers.origin)) return reply(403, 'Invalid origin.');
        if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return reply(400, 'Invalid callback.');
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return reply(413, 'Callback too large.'); }
        params = new URLSearchParams(raw);
      }
      if (params.getAll('state').length !== 1 || params.get('state') !== state) return reply(403, 'Invalid state.');
      if (accepted || settled) return reply(409, 'Callback already accepted.');
      const code = params.get('code');
      if (params.getAll('code').length !== 1 || !/^[A-Za-z0-9_-]{1,512}$/.test(code ?? '')) return reply(400, 'Invalid callback.');
      accepted = true;
      reply(200, 'GitHub callback received. Return to agent-bot to see the result.');
      const data = await github('POST', `/app-manifests/${code}/conversions`, null, options);
      if (settled) return;
      const app = slug(data.slug);
      if (!Number.isSafeInteger(data.id) || data.id <= 0 || !validatePrivateKey(data.pem) || typeof data.webhook_secret !== 'string') fail('identity-app-github', 'GitHub returned invalid App credentials.');
      const credential = { appId: String(data.id), privateKeyPem: data.pem, webhookSecret: data.webhook_secret };
      // Conversion is a one-time handoff of the key. A profile outage must
      // not discard that credential; setup can backfill the public profile.
      const metadata = await botMetadata(app, options).catch(() => ({}));
      if (settled) return;
      const result = persist(app, credential, [], options, { metadata });
      finish(null, metadata.botUid ? result : { ...result, metadataPending: true });
    } catch (error) {
      if (!res.headersSent) reply(400, 'App operation failed.');
      finish(error instanceof IdentityAppError ? error : new IdentityAppError('identity-app-store', 'Could not store the App; reconnect it using its settings on github.com.'));
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  localUrl = `http://127.0.0.1:${server.address().port}/`;
  timer = setTimeout(() => finish(new IdentityAppError('identity-app-timeout', 'App creation timed out after 10 minutes; start create again.')), options.timeoutMs ?? 600_000);
  return { localUrl: `${localUrl}?state=${state}`, completion, cancel: () => finish(new IdentityAppError('identity-app-cancelled', 'App creation was cancelled.')) };
}

export async function identityAppOperation(action, body = {}, options = {}) {
  try {
    const opts = settings(options);
    enabled(opts.config);
    const allowed = { create: ['manifest', 'name', 'org'], connect: ['id', 'keyFile', 'passCli'], 'rotate-key': ['slug', 'keyFile', 'passCli'], assign: ['slug', 'harness', 'soul'] };
    if (!allowed[action] || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => ![...allowed[action], 'principal'].includes(key))) fail('identity-app-invalid', 'Invalid App operation or fields.', 400);
    if (action === 'create') {
      if (body.manifest !== true || (body.name !== undefined && (typeof body.name !== 'string' || !/^[\p{L}\p{N} ._-]{1,100}$/u.test(body.name))) || (body.org !== undefined && !validAppSlug(body.org))) fail('identity-app-invalid', 'create requires manifest: true and an optional valid name/org.', 400);
    }
    const label = `identity app ${action}${validAppSlug(body.slug) ? ` ${body.slug}` : ''}${body.harness && PROFILE_HARNESSES.includes(body.harness) ? ` --harness ${body.harness}` : ''}${body.name && action === 'create' ? ` ${body.name}` : ''}`;
    try { await (opts.gate ?? ((label, { principal }) => assertOwnerAction(label, { env: opts.env, cwd: opts.cwd ?? opts.home, principal })))(label, { principal: body.principal ?? null }); }
    catch { fail('identity-app-owner-required', 'The owner must approve this App operation.', 403); }
    if (action === 'create') return await startAppManifest(body, opts);
    if (action === 'connect') return await connect(body, opts);
    if (action === 'rotate-key') return await rotate(body, opts);
    return assign(body, opts);
  } catch (error) {
    if (error instanceof IdentityAppError) throw error;
    const safe = identityAppFailure(error);
    throw new IdentityAppError(safe.code, safe.message);
  }
}

export function createIdentityAppJobs(options = {}) {
  const jobs = new Map();
  let closed = false;
  return {
    async start(body) {
      if (closed) fail('identity-app-cancelled', 'App job service is closed.');
      for (const [id, job] of jobs) if (job.expires < Date.now() && job.status !== 'pending') jobs.delete(id);
      if (jobs.size >= 32) fail('identity-app-jobs-full', 'Too many App creation jobs; retry later.', 429);
      const id = randomUUID();
      // Reserve before awaiting owner approval to bound concurrent requests.
      const job = { jobId: id, status: 'pending', expires: Date.now() + 3600_000 };
      jobs.set(id, job);
      let flow;
      try { flow = await identityAppOperation('create', body, options); }
      catch (error) { jobs.delete(id); throw error; }
      if (closed) { flow.cancel(); fail('identity-app-cancelled', 'App job service is closed.'); }
      job.localUrl = flow.localUrl; job.cancel = flow.cancel;
      flow.completion.then((result) => { job.status = 'complete'; job.result = result; }, (error) => { job.status = 'failed'; job.error = identityAppFailure(error); });
      return { jobId: id, status: 'pending', localUrl: flow.localUrl };
    },
    get(id) {
      let job = jobs.get(id);
      if (job?.status !== 'pending' && job?.expires < Date.now()) { jobs.delete(id); job = null; }
      if (!job) fail('identity-app-job-not-found', 'App creation job not found; jobs expire on daemon restart.', 404);
      return { jobId: job.jobId, status: job.status, ...(job.status === 'pending' ? { localUrl: job.localUrl } : {}), ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
    },
    close() { closed = true; for (const job of jobs.values()) job.cancel?.(); jobs.clear(); },
  };
}

const USAGE = 'identity apps list [--json] | identity app create --manifest [--name NAME] [--org ORG] [--open] | connect --id ID (--key-file PATH|--pass-cli ITEM) | rotate-key SLUG (--key-file PATH|--pass-cli ITEM) | assign SLUG (--harness H|--soul AGENT_ID) [--json] [--principal-stdin]';
export async function identityAppsCommand(argv, { write = (value) => process.stdout.write(value), ...options } = {}) {
  const [group, action, ...args] = argv;
  let json = false, open = false, principal = false;
  const body = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--open' && !open && action === 'create') open = true;
    else if (arg === '--principal-stdin' && !principal) principal = true;
    else if (arg === '--manifest' && body.manifest === undefined) body.manifest = true;
    else if (['--name', '--org', '--id', '--key-file', '--pass-cli', '--harness', '--soul'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('-')) {
      const key = ({ '--key-file': 'keyFile', '--pass-cli': 'passCli' })[arg] ?? arg.slice(2);
      if (body[key] !== undefined) fail('identity-app-invalid', USAGE, 400);
      body[key] = args[++i];
      if (key === 'keyFile') body[key] = path.resolve(body[key]);
    } else if (!arg.startsWith('-') && ['rotate-key', 'assign'].includes(action) && !body.slug) body.slug = arg;
    else fail('identity-app-invalid', USAGE, 400);
  }
  if (group === 'apps' && action === 'list' && !Object.keys(body).length && !principal) {
    const result = listIdentityApps(options);
    write(`${json ? JSON.stringify(result) : result.apps.map((row) => `${row.slug} (${row.botLogin}) issuer:${row.issuerPresent} key:${row.keyPresent} mint:${row.liveMint.status}`).join('\n') || 'No configured Apps.'}\n`);
    return result;
  }
  if (group !== 'app') fail('identity-app-invalid', USAGE, 400);
  if (principal) {
    try { body.principal = JSON.parse((options.readStdin ?? (() => readFileSync(0, 'utf8')))()); }
    catch { fail('identity-app-invalid', 'Present the principal credential as JSON on stdin.', 400); }
  }
  let result = await identityAppOperation(action, body, options);
  if (action === 'create') {
    const flow = result;
    write(json ? `${JSON.stringify({ status: 'pending', localUrl: flow.localUrl })}\n` : `Open ${flow.localUrl}\nUse --open to launch the browser automatically.\n`);
    if (open) { try { execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [flow.localUrl], { stdio: 'ignore', timeout: 10_000 }); } catch { /* the printed URL works without an opener */ } }
    const cancel = () => flow.cancel();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try { result = await flow.completion; } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
  write(`${JSON.stringify(result)}\n`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  identityAppsCommand(process.argv.slice(2)).catch((error) => {
    const failure = identityAppFailure(error);
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
    else process.stderr.write(`${failure.code}: ${failure.message}\n`);
    process.exitCode = 1;
  });
}
