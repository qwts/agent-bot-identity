// Identity's daemon routes (#645, F9 step 2; owner decisions D5 and Q-F9-1).
// The daemon (agent-daemon.mjs) still owns the HTTP server, the loopback
// check, the bearer check and the bearer-free route list, and it keeps the
// binding-proof checks: requireBinding, presentedCredential and grantBinding
// come in as ports and are called exactly where the routes called them
// before (Q-F9-2). What host and soul provide (the request helpers, the bind
// and App-claim steps, the grant ledger, the spawn hook, the package hash and
// the soul credential declaration) also comes in as ports, so identity
// imports neither. handleIdentityRoute answers true when it handled the
// route and false when the route is not identity's.
//
// POST /v0/spawn is split (D6, F9 step 4): the daemon keeps the route, its
// binding check and the spawn hook, and spawnChildIdentity does identity's
// half, minting the child and binding it under the parent.

import { readAgentIdentity, mintAgentIdentity } from './agent-identity.mjs';
import { childBindingPath } from './agent-binding.mjs';
import { isGateEnabled, loadConfig, soulOwnsAppSlug } from '../config.mjs';
import { SCHEMA_VERSION } from './daemon-client.mjs';
import { validAppSlug } from './identity-app-store.mjs';
import { appendAuditReceipt } from './identity-format.mjs';
import { boundRepository, inboxError } from './inbox-take.mjs';
import { grantTarget, KEYD_TOOL_NAMES, mintViaKeyd, signKeydGrant } from './keyd-client.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';
import { newOperationId, taskIdFor, ServerSession, serverUrl } from './server-client.mjs';
import { stateDirectory } from '../state-paths.mjs';

function eventsRefuse(res, error, sendJson) {
  const status = {
    'credential-unavailable': 503, 'device-revoked': 403, 'operation-conflict': 409,
    'event-rate-limited': 429, 'event-recipient-stale': 403,
  }[error?.code] ?? error?.statusCode ?? 502;
  sendJson(res, status, { error: error?.message ?? 'the identity service failed the events request', ...(error?.code ? { code: error.code } : {}) });
  return true;
}

// The events caller is the binding soul; its harness is the soul's own App
// slug, never a request field. Server mode only — nothing else holds a
// service session to poll.
function eventsSession(req, bindings, { env, home, config, requireBinding, serverFetch }) {
  const binding = requireBinding(req, bindings);
  const identity = readAgentIdentity(binding.agentId, { stateDir: stateDirectory({ env, home }) });
  const harness = boundAppSlug(binding, identity, { env, home, config });
  if (!harness) throw Object.assign(new Error('this soul has no harness App slug to receive events as'), { statusCode: 409, code: 'events-no-harness' });
  const base = serverUrl({ env, config });
  if (!base) throw Object.assign(new Error('live-session events need an enrolled device (AGENT_BOT_SERVER)'), { statusCode: 503, code: 'credential-unavailable' });
  const session = new ServerSession({ base, env, home, fetchImpl: serverFetch });
  session.agentId = binding.agentId;
  session.harness = harness;
  return session;
}

function boundAppSlug(binding, identity, { env, home, config }) {
  const recorded = identity.github?.appSlug ?? null;
  if (!recorded) return null;
  let cfg = config;
  if (!cfg) {
    try { cfg = loadConfig({ env, home }); } catch { cfg = {}; }
  }
  if (binding?.worktree) {
    try {
      const worktreeSlug = resolveAgentSlug({
        env: { ...env, AGENT_BOT_ID: binding.agentId, GH_AGENT_APP: '' },
        cwd: binding.worktree,
        config: cfg,
        detect: false,
        harness: binding.harness ?? identity.harness ?? null,
      });
      if (worktreeSlug && soulOwnsAppSlug(identity, worktreeSlug, cfg)) return worktreeSlug;
    } catch { /* fall back to binding.app or recorded */ }
  }
  if (binding?.app && soulOwnsAppSlug(identity, binding.app, cfg)) return binding.app;
  return recorded;
}

export function createIdentityRoutes({
  bindings, env, home, config, now,
  readBody, parseJsonBody, sendJson,
  requireBinding, presentedCredential, grantBinding,
  bindWorktreeConversation, reconcileSoulApp, ownerGate,
  mintImpl, keydCall, signingKey, serverFetch = fetch,
  // A bounded seen-set receipted per daemon process: a re-delivered notice
  // (lease lapsed, ack stale) never writes event-deliver twice.
  deliveredNoticeIds = new Set(),
  inboxTake,
  grantLedger, grantActor, grantView, grantFailure,
  soulCredentialsDeclaration, soulDirectory, populationFile,
}) {
  return async function handleIdentityRoute(route, req, res) {
    switch (route) {
      case 'POST /v0/bind': {
        const body = parseJsonBody(await readBody(req));
        // The App the session was explicitly run as (#107), checked before
        // the bind consumes anything so a malformed claim leaves the
        // single-use token in place. It is a claim, never authority: the
        // record changes only as reconcileSoulApp decides.
        if (body.app !== undefined && body.app !== null && !validAppSlug(body.app)) {
          throw Object.assign(new Error('app must be a GitHub App slug'), { statusCode: 400 });
        }
        const bound = bindWorktreeConversation({ body, bindings, env, home, config, now, presented: presentedCredential(req) });
        const app = body.app ? await reconcileSoulApp({ agentId: bound.agentId, claimed: body.app, env, home, config, now, ownerGate }) : null;
        sendJson(res, 200, app ? { ...bound, app } : bound);
        return true;
      }
      // A session resuming on a binding that outlived its last one (#107)
      // states the App it was run as, like a first bind does. The binding
      // names the soul; the App is a claim reconcileSoulApp decides on.
      case 'POST /v0/binding/app': {
        const binding = requireBinding(req, bindings);
        const body = parseJsonBody(await readBody(req));
        if (!validAppSlug(body.app)) throw Object.assign(new Error('app must be a GitHub App slug'), { statusCode: 400 });
        const app = await reconcileSoulApp({ agentId: binding.agentId, claimed: body.app, env, home, config, now, ownerGate });
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, agentId: binding.agentId, ...(app ? { app } : {}) });
        return true;
      }
      case 'GET /v0/binding': {
        const binding = requireBinding(req, bindings);
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, binding });
        return true;
      }
      // Explicit revocation invalidates the secret and removes its file.
      case 'DELETE /v0/binding': {
        const presented = presentedCredential(req);
        const released = typeof presented === 'string'
          ? bindings.release(presented)
          : bindings.releaseProof(presented.proof, presented.request);
        if (!released) {
          throw Object.assign(new Error('missing or invalid agent binding'), { statusCode: 401 });
        }
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, released: true });
        return true;
      }
      // Tier-1 credential brokering (#90): an App installation token for
      // the bot the caller already IS. Authorization is the live binding —
      // "a bound agent on an enforced connection" — never a request
      // parameter, and never a key-file read in the caller's process. The
      // request names no App and no Agent ID: both derive from the binding.
      // Delegated human authority (tier 2) is deliberately NOT this route —
      // it must never return a credential at all.
      case 'POST /v0/credential': {
        // Drain the (unused) request body so keep-alive connections are left
        // clean; readBody enforces MAX_BODY_BYTES like every other route.
        await readBody(req);
        let binding;
        try {
          binding = requireBinding(req, bindings);
        } catch (error) {
          appendAuditReceipt(
            { event: 'credential-mint', operation: 'tier1-app-token', decision: 'denied', reason: 'no-live-binding' },
            { env, home, now },
          );
          // Stable codes for diagnostics (#983); the response is unchanged.
          error.code ??= 'credential-no-binding';
          throw error;
        }
        let grant;
        let identity;
        try {
          identity = readAgentIdentity(binding.agentId, {
            stateDir: stateDirectory({ env, home }),
          });
        } catch (error) {
          appendAuditReceipt({
            event: 'credential-mint',
            agentId: binding.agentId,
            operation: 'tier1-app-token',
            decision: 'failed',
            reason: 'identity-unreadable',
          }, { env, home, now });
          throw Object.assign(error, { code: 'credential-identity-unreadable' });
        }
        // A retired soul's binding proof is not authority to mint (#775):
        // retirement ends its App use even before its bindings are swept.
        if (identity.status === 'retired') {
          appendAuditReceipt({
            event: 'credential-mint',
            agentId: binding.agentId,
            operation: 'tier1-app-token',
            decision: 'denied',
            ...(identity.github?.appSlug ? { appSlug: identity.github.appSlug } : {}),
            reason: 'soul-retired',
          }, { env, home, now });
          throw Object.assign(new Error('this soul is retired'), { statusCode: 409, code: 'credential-soul-retired' });
        }
        // The agent path mints only for a conversation (ENG-0081 amendment
        // decision 2): the binding's transcript locator, or the one the
        // soul's record already carries. A still-pending soul cannot mint.
        if (!binding.transcript && !identity.transcript) {
          appendAuditReceipt({
            event: 'credential-mint',
            agentId: binding.agentId,
            operation: 'tier1-app-token',
            decision: 'denied',
            ...(identity.github?.appSlug ? { appSlug: identity.github.appSlug } : {}),
            reason: 'no-transcript-locator',
          }, { env, home, now });
          throw Object.assign(new Error('this soul has no transcript locator yet; bind it to its conversation first'), { statusCode: 409, code: 'credential-no-transcript' });
        }
        // The add-on gate decides, not the record: a soul that carries a
        // github field gets no App token while github-identity is off.
        const githubOn = isGateEnabled('github-identity', { env, home, config });
        const appSlug = boundAppSlug(binding, identity, { env, home, config });
        if (!githubOn || !appSlug) {
          appendAuditReceipt({
            event: 'credential-mint',
            agentId: binding.agentId,
            operation: 'tier1-app-token',
            decision: 'denied',
            ...(appSlug ? { appSlug } : {}),
            reason: githubOn ? 'no-github-app' : 'github-identity-off',
          }, { env, home, now });
          throw Object.assign(new Error(githubOn ? 'this soul has no GitHub App' : 'the github-identity add-on is off'), { statusCode: 409, code: githubOn ? 'credential-no-app' : 'credential-github-off' });
        }
        // One credential per request: a fresh operation, for the task this
        // soul's conversation is (0.4 §7). Nothing is cached for reuse.
        const operationId = newOperationId();
        const taskId = taskIdFor({ env, agentId: binding.agentId, transcript: binding.transcript ?? identity.transcript ?? null, operationId });
        try {
          grant = await mintImpl({
            slug: appSlug, env, agentId: binding.agentId, taskId, operationId,
            fetchImpl: serverFetch,
            viaKeyd: (soul) => mintViaKeyd({ ...soul, env, home, now, request: keydCall }),
          });
        } catch (error) {
          // A verified binding whose mint fails must still leave a receipt —
          // the audit stream has to account for every attempt, not only the
          // ones that reached a decision. Identity-service answers keep their
          // stable codes (credential-unavailable, device-revoked, ...).
          const coded = ['credential-unavailable', 'device-revoked', 'outcome-unknown', 'operation-conflict', 'legacy-local-custody-off'].includes(error?.code) ? error.code : null;
          appendAuditReceipt({
            event: 'credential-mint',
            agentId: binding.agentId,
            operation: 'tier1-app-token',
            decision: 'failed',
            appSlug,
            reason: coded ?? 'mint-failed',
            taskId,
            operationId,
          }, { env, home, now });
          if (coded) {
            throw Object.assign(error, {
              statusCode: { 'credential-unavailable': 503, 'outcome-unknown': 503, 'device-revoked': 403, 'operation-conflict': 409, 'legacy-local-custody-off': 409 }[coded],
            });
          }
          throw error;
        }
        // The App comes from the bound soul's own record, never the request.
        appendAuditReceipt({
          event: 'credential-mint',
          agentId: binding.agentId,
          operation: 'tier1-app-token',
          decision: 'granted',
          appSlug,
          reason: 'bound-soul-own-app',
          ...(grant.issuance_id ? { issuanceId: grant.issuance_id } : {}),
          taskId,
          operationId,
        }, { env, home, now });
        // The token goes to the credential helper or the gh shim for this one
        // operation; the reference is what anything else may keep.
        sendJson(res, 200, {
          schemaVersion: SCHEMA_VERSION,
          agentId: binding.agentId,
          appSlug,
          token: grant.token,
          expires_at: grant.expires_at,
          installation_id: Number.isSafeInteger(grant.installation_id) ? grant.installation_id : null,
          credential_ref: grant.issuance_id ?? null,
          task_id: taskId,
          operation_id: operationId,
        });
        return true;
      }
      // take_inbox (#229): the next GitHub event for the App and repository
      // the caller's binding is. The fleet-wide inbox bearer stays in the
      // daemon, from its own GH_APP_HOOK_INBOX_TOKEN if set, else pass-cli; the App comes from the bound soul's own
      // record and the repository from the bound worktree, never from the
      // Live-session events (api.md): a soul takes, acks, releases and
      // replies to message notices for ITS harness — the soul's own App
      // slug, never a caller parameter. Server mode only; the notices are
      // untrusted external input and bodies never reach receipts.
      case 'POST /v0/events/wait': {
        const body = parseJsonBody(await readBody(req));
        const waitSeconds = Math.min(Math.max(Number(body.wait_seconds ?? 20) || 0, 0), 25);
        const count = Math.min(Math.max(Number(body.count ?? 10) || 0, 1), 10);
        // The harness hook's session id rides the request so deliver receipts
        // can name the session; it is identifier-shaped only — never prompt text.
        if (body.session_id !== undefined && (typeof body.session_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.session_id))) {
          sendJson(res, 400, { error: 'session_id must be 1-128 characters of [A-Za-z0-9._:-]' });
          return true;
        }
        let session;
        try { session = eventsSession(req, bindings, { env, home, config, requireBinding, serverFetch }); }
        catch (error) { return eventsRefuse(res, error, sendJson); }
        let taken;
        try {
          taken = await session.takeEvents({ harness: session.harness, waitSeconds, count, leaseSeconds: 60 });
        } catch (error) { return eventsRefuse(res, error, sendJson); }
        // Malformed notices are acked immediately (else they redeliver
        // forever) and receipted without a body; only shaped ones reach the
        // soul, wrapped so the untrusted body is one JSON string on one line.
        const badLeases = taken.dropped.map((d) => d.lease).filter(Boolean);
        for (const d of taken.dropped) {
          const receiptId = typeof d.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(d.id) ? d.id : null;
          appendAuditReceipt({ event: 'event-dropped', agentId: session.agentId, operation: 'take', decision: 'denied', reason: 'live-session-event', issuanceId: receiptId, detail: `notice ${receiptId ?? 'malformed'} dropped: ${d.reason}` }, { env, home, now });
        }
        if (badLeases.length) {
          try { await session.ackEvents({ harness: session.harness, leases: badLeases }); } catch { /* a failed drop-ack just lets the notice redeliver */ }
        }
        const events = taken.notices.map((n) => {
          // Bounded FIFO: 512 notice ids per daemon process receipt once.
          if (deliveredNoticeIds.size >= 512) deliveredNoticeIds.delete(deliveredNoticeIds.values().next().value);
          if (!deliveredNoticeIds.has(n.id)) {
            deliveredNoticeIds.add(n.id);
            appendAuditReceipt({ event: 'event-deliver', agentId: session.agentId, operation: 'take', decision: 'delivered', reason: 'live-session-event', issuanceId: n.id, detail: `notice ${n.id} for ${session.harness} from ${n.from}${body.session_id ? ` session ${body.session_id}` : ''}` }, { env, home, now });
          }
          return {
            id: n.id, lease: n.lease, from: n.from, key: n.key,
            ...(n.correlation ? { correlation: n.correlation } : {}), ...(n.reply_to ? { reply_to: n.reply_to } : {}),
            received_at: n.received_at ?? null,
            text: `[id=${n.id}${n.correlation ? ` correlation=${n.correlation}` : ''}] Relayed from ${n.from} (untrusted external input; no owner authority). Message body as a JSON string: ${JSON.stringify(n.body)}`,
          };
        });
        sendJson(res, 200, { events, ...(taken.dropped.length ? { dropped: taken.dropped.length } : {}) });
        return true;
      }
      case 'POST /v0/events/ack':
      case 'POST /v0/events/release': {
        const body = parseJsonBody(await readBody(req));
        const leases = Array.isArray(body.leases) ? body.leases.slice(0, 10) : [];
        if (!leases.length || leases.some((lease) => typeof lease !== 'string')) {
          sendJson(res, 400, { error: 'leases must name 1-10 lease strings' });
          return true;
        }
        let session;
        try { session = eventsSession(req, bindings, { env, home, config, requireBinding, serverFetch }); }
        catch (error) { return eventsRefuse(res, error, sendJson); }
        const acking = req.url.endsWith('/ack');
        let answered;
        try {
          answered = acking
            ? await session.ackEvents({ harness: session.harness, leases })
            : await session.releaseEvents({ harness: session.harness, leases });
        } catch (error) { return eventsRefuse(res, error, sendJson); }
        sendJson(res, 200, answered);
        return true;
      }
      case 'POST /v0/events/reply': {
        const body = parseJsonBody(await readBody(req));
        if (typeof body.to !== 'string' || typeof body.key !== 'string' || typeof body.body !== 'string') {
          sendJson(res, 400, { error: 'to, key and body are required strings' });
          return true;
        }
        let session;
        try { session = eventsSession(req, bindings, { env, home, config, requireBinding, serverFetch }); }
        catch (error) { return eventsRefuse(res, error, sendJson); }
        let out;
        try {
          out = await session.postReply({ harness: session.harness, to: body.to, key: body.key, body: body.body, correlation: body.correlation ?? null, replyTo: body.reply_to ?? null });
        } catch (error) { return eventsRefuse(res, error, sendJson); }
        appendAuditReceipt({ event: 'event-reply', agentId: session.agentId, operation: 'reply', decision: 'delivered', reason: 'live-session-event', issuanceId: out.id ?? null, detail: `reply ${out.id ?? ''} for ${session.harness} to ${body.to}` }, { env, home, now });
        sendJson(res, 200, { id: out.id, ...(out.replayed ? { replayed: true } : {}) });
        return true;
      }
      // request.
      case 'POST /v0/inbox/take': {
        await readBody(req);
        const receipt = (decision, fields = {}) => appendAuditReceipt({
          event: 'inbox-take', operation: 'take', decision, ...fields,
        }, { env, home, now });
        let binding;
        try { binding = requireBinding(req, bindings); }
        catch (error) { receipt('denied', { reason: 'no-live-binding' }); throw error; }
        const agentId = binding.agentId;
        let identity;
        try { identity = readAgentIdentity(agentId, { stateDir: stateDirectory({ env, home }) }); }
        catch (error) { receipt('failed', { agentId, reason: 'identity-unreadable' }); throw error; }
        const appSlug = boundAppSlug(binding, identity, { env, home, config });
        if (!appSlug) {
          receipt('denied', { agentId, reason: 'no-github-app' });
          throw inboxError('inbox-no-app', 'take_inbox failed: this soul has no GitHub App', { statusCode: 409 });
        }
        let result;
        try {
          const repo = boundRepository(binding.worktree);
          result = await inboxTake({ app: appSlug, repo });
        } catch (error) {
          receipt('failed', {
            agentId, appSlug, reason: typeof error.code === 'string' ? error.code : 'take-failed',
            ...(error.bearerSource ? { bearerSource: error.bearerSource } : {}),
          });
          throw error;
        }
        receipt('taken', {
          agentId, appSlug, reason: result.event ? 'event' : 'empty',
          ...(result.bearerSource ? { bearerSource: result.bearerSource } : {}),
        });
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, event: result.event ?? null });
        return true;
      }
      // Delegation grants (#108). A soul asks for one named write; the
      // owner approves that exact write at keyd's presence prompt, which
      // this request raises and waits on. The soul is the binding's, never
      // a request parameter.
      case 'POST /v0/grants/request': {
        const binding = grantBinding(req, 'request');
        const body = parseJsonBody(await readBody(req));
        try {
          const grant = grantLedger.request({ agentId: binding.agentId, operation: body.operation });
          const decided = await grantLedger.approve(grant.proposalId, { digest: grant.operationDigest });
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, grant: grantView(decided) });
        } catch (error) {
          throw grantFailure(error);
        }
        return true;
      }
      // Spends an approved grant once, as the owner's account. A refusal
      // before the act (no stored token, the wrong account) leaves the
      // grant approved.
      case 'POST /v0/grants/spend': {
        const binding = grantBinding(req, 'spend');
        const body = parseJsonBody(await readBody(req));
        try {
          const spent = await grantLedger.spend(body.proposalId, { agentId: binding.agentId, operation: body.operation },
            grantActor.perform, { prepare: grantActor.prepare });
          sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, proposalId: spent.proposalId, status: spent.status, receipt: spent.receipt });
        } catch (error) {
          throw grantFailure(error);
        }
        return true;
      }
      // agent-bot-keyd grants (#397): a soul's `agent-bot-keyd mcp` relay
      // asks here, on the soul's binding, before each keyd tool call. The
      // daemon keeps the policy — binding, add-on gate, the soul's own App,
      // a keyd-held key — and answers with a one-call grant signed by its
      // account key, which keyd pinned. keyd checks the grant and mints;
      // the key never leaves keyd and the grant is useless after 60s.
      case 'POST /v0/keyd/grant': {
        const body = parseJsonBody(await readBody(req));
        const tool = body?.tool;
        const receipt = (decision, agentId = null) => appendAuditReceipt({
          event: 'credential-grant', ...(agentId ? { agentId } : {}),
          operation: `keyd ${KEYD_TOOL_NAMES.includes(tool) ? tool : 'unknown'}`, decision,
        }, { env, home, now });
        if (!KEYD_TOOL_NAMES.includes(tool)) {
          receipt('denied');
          throw Object.assign(new Error('unknown keyd tool'), { statusCode: 400 });
        }
        let binding;
        try { binding = requireBinding(req, bindings); }
        catch (error) { receipt('denied'); throw error; }
        let identity;
        let declaration;
        try {
          identity = readAgentIdentity(binding.agentId, { stateDir: stateDirectory({ env, home }) });
          declaration = soulCredentialsDeclaration(soulDirectory(binding.agentId, { file: populationFile({ env, home }), env, home }));
        } catch (error) {
          receipt('failed', binding.agentId);
          throw error;
        }
        const githubOn = isGateEnabled('github-identity', { env, home, config });
        const app = identity.github?.appSlug;
        const refusal = !githubOn ? 'the github-identity add-on is off'
          : !app ? 'this soul has no GitHub App'
            : declaration?.app !== app || declaration?.store !== 'keyd' ? "agent-bot-keyd does not hold this soul's key"
              : null;
        if (refusal) {
          receipt('denied', binding.agentId);
          throw Object.assign(new Error(refusal), { statusCode: 409 });
        }
        const signed = signKeydGrant({ agentId: binding.agentId, app, tool, ...(await grantTarget({ env, config })) }, signingKey(), now);
        receipt('granted', binding.agentId);
        sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, grant: signed });
        return true;
      }
      default:
        return false;
    }
  };
}

// Identity's half of POST /v0/spawn: checks the request against the parent's
// authority, mints the child and binds it under the parent's binding. The
// package hash is soul's, so it comes in as a port. Returns the response
// body and the name and harness the daemon hands its spawn hook.
export function spawnChildIdentity({ source, body, bindings, env, home, config, now, computePackageRevision }) {
  const stateDir = stateDirectory({ env, home });
  const parent = readAgentIdentity(source.agentId, { stateDir });
  const parentApp = parent.github?.appSlug ?? null;
  if ((body.parent && body.parent !== source.agentId)
    || (body.app && body.app !== parentApp)) {
    throw Object.assign(new Error('spawn cannot override parent authority'), { statusCode: 403 });
  }
  const harness = body.harness ?? source.harness ?? parent.harness ?? 'unknown';
  const name = body.name ?? 'child';
  for (const value of [name, harness]) {
    if (typeof value !== 'string' || !value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw Object.assign(new Error('invalid spawn name or harness'), { statusCode: 400 });
    }
  }
  // A parent with no github field stays without one even when the
  // gate is on. The gate off omits github on the child either way.
  const useGithub = isGateEnabled('github-identity', { env, home, config }) && parent.github != null;
  const identity = mintAgentIdentity({
    appSlug: parentApp, botUid: parent.github?.botUid ?? null, harness,
    transcript: body.transcript, parentId: source.agentId,
    packageRevision: body.packagePath == null ? null : computePackageRevision(body.packagePath),
    team: body.team ?? parent.team, squad: body.squad ?? parent.squad,
    type: body.type ?? 'agent', level: body.level, subjects: body.subjects ?? [], stateDir, now,
    useGithub,
  });
  bindings.bind({ agentId: identity.id, parent: source.agentId, spawnedBy: source.bindingHash,
    worktree: source.worktree, gitDir: source.gitDir, app: identity.github?.appSlug ?? null,
    harness, transcript: identity.transcript });
  const result = { agentId: identity.id, parent: source.agentId,
    binding: childBindingPath(source.gitDir, identity.id) };
  return { result, name: body.name ?? identity.id, harness };
}
