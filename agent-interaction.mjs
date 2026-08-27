#!/usr/bin/env node

// Shared interaction service behind the daemon's versioned /v1 contract
// (#55). Every adapter — Telegram, private web client, CLI, IDE — calls these
// operations; none of them locates Agent Space paths, mutates population
// files, or imports runtime modules directly. Messages are commands into a
// deterministic execution boundary: each operation validates its schema,
// enforces principal authorization (deny-by-default, #57) BEFORE resolving
// souls or creating jobs, and records secret-free audit receipts. The
// identity domains stay distinct end to end: transport identity is consumed
// at resolution and never stored beyond the principal binding, and
// principal_<uuid>, agent_<uuid>, session_<uuid>, and invocation_<uuid> are
// never conflated.
//
// Execution is an injectable port: `executor({ invocation, message,
// attachments, appendEvent, addArtifact, requestApproval, signal })` is the
// integration point for harness adapters. v1 ships with a deliberate
// 'unconfigured' default that records a stable event and fails the
// invocation, so the contract, store, and authorization plane are testable
// before any real executor exists.
//
// `requestApproval({ operation, summary, ttlMs })` implements immutable
// command approval (#59 req 8): the proposed operation is frozen into a
// proposal bound to the sha256 digest of its canonical JSON, the invocation
// parks in 'waiting-approval', and only a decision that echoes the exact
// digest — delivered by a principal holding the reserved 'approve' operation
// — resumes it. A conversational "yes" has no pathway to authorize anything.

import { homedir } from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';

import {
  DEFAULT_PROPOSAL_TTL_MS,
  addArtifact,
  appendEvent,
  createProposal,
  createSession,
  decideProposal,
  getInvocation,
  getProposal,
  getSession,
  listArtifacts,
  listInvocations,
  listProposals,
  listSessions,
  operationDigest,
  readEvents,
  submitInvocation,
  touchSession,
  transitionInvocation,
  validateArtifactName,
  validateInvocationId,
  validateProposalId,
  validateSessionId,
  writeInvocationPayload,
} from './agent-jobs.mjs';
import {
  appendAuditReceipt,
  assertAuthorized,
  validateTransport,
} from './agent-principals.mjs';
import { listSouls, populationFile, showSoul } from './agent-population.mjs';
import { validateAgentId } from './agent-identity.mjs';

// Bounded message size (#55 req 6). Kept below the daemon's 64 KiB request
// body cap so the whole JSON envelope of a maximal message still fits.
export const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_ATTACHMENT_REFS = 16;
const MAX_ATTACHMENT_REF_LENGTH = 256;

export const UNCONFIGURED_EXECUTOR_ERROR = 'no executor is configured for this daemon';

// The only failure text an arbitrary executor exception may leave in the job
// record and events. Exception messages can quote paths, provider output, or
// stack context; those details stay in the server-side log.
export const EXECUTION_FAILED_ERROR = 'job execution failed';

// Documented v1 default: accepting messages is contractually complete even
// when no harness executor has been wired in. The invocation fails with a
// stable, secret-free error after recording why.
export async function unconfiguredExecutor({ appendEvent: append }) {
  append('executor-unconfigured', {});
  throw new Error(UNCONFIGURED_EXECUTOR_ERROR);
}

// Errors carry a transport-neutral numeric code aligned with HTTP statuses so
// the daemon router maps them without inspecting message text.
function failure(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function agentIdOrFail(value) {
  try {
    return validateAgentId(value);
  } catch {
    throw failure(400, 'invalid Agent ID');
  }
}

function validated(operation) {
  try {
    return operation();
  } catch (error) {
    if (Number.isSafeInteger(error.statusCode)) throw error;
    throw failure(400, error.message);
  }
}

function validateMessage(message) {
  if (typeof message !== 'string' || message.length === 0) {
    throw failure(400, 'message must be a non-empty string');
  }
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw failure(400, 'message exceeds the bounded message size');
  }
  // Multiline text is fine; other control characters are not.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) {
    throw failure(400, 'message must not contain control characters');
  }
  return message;
}

// Attachments are opaque references resolved by the executor inside the
// soul's boundary — never inline bytes and never filesystem paths.
function validateAttachments(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENT_REFS) {
    throw failure(400, 'attachments must be a bounded array of opaque references');
  }
  return attachments.map((reference) => {
    if (
      typeof reference !== 'string' || reference.length === 0
      || reference.length > MAX_ATTACHMENT_REF_LENGTH
      || /[\x00-\x1f\x7f]/.test(reference)
    ) {
      throw failure(400, 'attachments must be a bounded array of opaque references');
    }
    return reference;
  });
}

function publicSession(session) {
  const { sessionId, agentId, principalId, transport, createdAt, lastActivity } = session;
  return { sessionId, agentId, principalId, transport, createdAt, lastActivity };
}

function publicInvocation(invocation) {
  const {
    invocationId, sessionId, agentId, principalId, transport,
    status, idempotencyKey, error, artifacts, createdAt, updatedAt,
  } = invocation;
  return {
    invocationId, sessionId, agentId, principalId, transport,
    status, idempotencyKey, error, artifacts, createdAt, updatedAt,
  };
}

function publicProposal(proposal, invocation) {
  const { proposalId, invocationId, operationDigest: digest, summary, createdAt, expiresAt, status } = proposal;
  return {
    proposalId,
    invocationId,
    agentId: invocation.agentId,
    operationDigest: digest,
    summary,
    createdAt,
    expiresAt,
    status,
  };
}

function digestsMatch(expected, presented) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(typeof presented === 'string' ? presented : '', 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createInteractionService({
  env = process.env,
  home = homedir(),
  config,
  executor = unconfiguredExecutor,
  now = () => new Date(),
  // Server-side diagnostics only: whatever this writes never reaches the job
  // store, events, or clients.
  log = (line) => process.stderr.write(`agent-interaction: ${line}\n`),
} = {}) {
  void config; // reserved for executor policy; the store paths are env/home-driven
  const storeOptions = { env, home, now };
  const populationOptions = { file: populationFile({ env, home }) };
  // In-flight executions in this process: invocationId -> { controller, settled }.
  const executions = new Map();
  // Executors waiting on an open proposal: proposalId -> settle(outcome).
  const approvalWaiters = new Map();

  function audit(decision, { principal = null, transport = null, agentId = null, operation = null }) {
    appendAuditReceipt({
      event: decision === 'accepted' ? 'accepted-request' : 'denied-request',
      ...(principal ? { principalId: principal.principalId } : {}),
      ...(transport ? { transport } : {}),
      ...(agentId ? { agentId } : {}),
      ...(operation ? { operation } : {}),
      decision,
    }, storeOptions);
  }

  // Complete mediation: every operation flows through here before any soul
  // resolution or job mutation, and every decision leaves a receipt.
  function authorize({ principal, transport, agentId, operation }) {
    try {
      assertAuthorized({ principal, agentId, operation });
    } catch (error) {
      audit('denied', { principal, transport, agentId, operation });
      throw failure(403, 'principal is not authorized for this operation');
    }
    audit('accepted', { principal, transport, agentId, operation });
  }

  // Fail-closed soul resolution through the population registry: unknown and
  // retired souls are rejected with stable errors before any job exists.
  function resolveSoul(agentId) {
    let soul;
    try {
      soul = showSoul(agentId, populationOptions);
    } catch {
      throw failure(404, 'unknown soul');
    }
    if (soul.status === 'retired') throw failure(409, 'soul is not available for interaction');
    return soul;
  }

  // Ownership check that never leaks existence: a foreign or absent record
  // answers identically.
  function ownedInvocation(principal, invocationId) {
    const target = validated(() => validateInvocationId(invocationId));
    const invocation = getInvocation(target, storeOptions);
    if (!invocation || invocation.principalId !== principal.principalId) {
      throw failure(404, 'unknown invocation');
    }
    return invocation;
  }

  function recordStatus(invocationId, status, data = {}) {
    appendEvent(invocationId, 'status', { status, ...data }, storeOptions);
  }

  // Immutable command approval, exposed to executors as a capability. The
  // invocation parks in 'waiting-approval' while an open proposal carries the
  // digest of the exact operation; the wait settles on a decision, expiry, or
  // cancellation, and execution resumes only through the legal transitions.
  function makeRequestApproval(id, controller) {
    return async ({ operation, summary, ttlMs = DEFAULT_PROPOSAL_TTL_MS } = {}) => {
      const digest = operationDigest(operation);
      transitionInvocation(id, 'waiting-approval', storeOptions);
      recordStatus(id, 'waiting-approval');
      const proposal = createProposal(
        { invocationId: id, operationDigest: digest, summary },
        { ...storeOptions, ttlMs },
      );
      appendEvent(id, 'approval-requested', {
        proposalId: proposal.proposalId,
        operationDigest: digest,
        summary: proposal.summary,
        expiresAt: proposal.expiresAt,
      }, storeOptions);
      const outcome = await new Promise((resolve) => {
        let finished = false;
        const settle = (value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
          approvalWaiters.delete(proposal.proposalId);
          resolve(value);
        };
        const onAbort = () => settle({ decision: 'deny', cancelled: true });
        const timer = setTimeout(() => {
          try {
            decideProposal(proposal.proposalId, { decision: 'expired' }, storeOptions);
            appendEvent(id, 'approval-decision', {
              proposalId: proposal.proposalId,
              decision: 'expired',
            }, storeOptions);
          } catch {
            /* a concurrent decision beat the expiry timer */
          }
          settle({ decision: 'deny', expired: true });
        }, Math.max(0, new Date(proposal.expiresAt).getTime() - now().getTime()));
        timer.unref?.();
        controller.signal.addEventListener('abort', onAbort, { once: true });
        approvalWaiters.set(proposal.proposalId, settle);
      });
      // Cancellation owns its own state transitions; every other outcome puts
      // the invocation back to work so the executor can act on the decision.
      if (!outcome.cancelled && getInvocation(id, storeOptions).status === 'waiting-approval') {
        transitionInvocation(id, 'running', storeOptions);
        recordStatus(id, 'running');
      }
      return outcome;
    };
  }

  async function runInvocation(invocation, message, attachments, controller) {
    const id = invocation.invocationId;
    // Cancellation can land between submission and dispatch.
    if (getInvocation(id, storeOptions).status === 'cancel-requested') {
      transitionInvocation(id, 'cancelled', storeOptions);
      recordStatus(id, 'cancelled');
      return;
    }
    transitionInvocation(id, 'running', storeOptions);
    recordStatus(id, 'running');
    try {
      await executor({
        invocation: publicInvocation(invocation),
        message,
        attachments,
        appendEvent: (type, data) => appendEvent(id, type, data, storeOptions),
        addArtifact: (artifact) => addArtifact(id, artifact, storeOptions),
        requestApproval: makeRequestApproval(id, controller),
        signal: controller.signal,
      });
      // An executor that finished before honoring a cancel request still
      // completed; cancel reporting stays accurate (stopped: false).
      transitionInvocation(id, 'completed', storeOptions);
      recordStatus(id, 'completed');
    } catch (error) {
      if (controller.signal.aborted) {
        transitionInvocation(id, 'cancelled', storeOptions);
        recordStatus(id, 'cancelled');
      } else {
        // Executor exception text is an internal detail and may leak paths or
        // provider output; persist only a fixed public failure reason. The
        // default executor's refusal is itself a fixed documented constant.
        const text = executor === unconfiguredExecutor
          ? UNCONFIGURED_EXECUTOR_ERROR
          : EXECUTION_FAILED_ERROR;
        log(`invocation ${id} failed: ${typeof error?.message === 'string' ? error.message : String(error)}`);
        transitionInvocation(id, 'failed', { ...storeOptions, error: text });
        recordStatus(id, 'failed', { error: text });
      }
    }
  }

  function soulAllowed(principal, agentId) {
    const souls = principal.authorizations.souls;
    return souls.includes('*') || souls.includes(agentId);
  }

  // Listing endpoints have no single target soul; the gate is the operation
  // itself, and each row is then filtered through the per-soul authorization.
  function authorizeListing(principal, transport, operation) {
    if (
      !principal || typeof principal !== 'object' || principal.status !== 'active'
      || !principal.authorizations.operations.includes(operation)
    ) {
      audit('denied', { principal, transport, operation });
      throw failure(403, 'principal is not authorized for this operation');
    }
    audit('accepted', { principal, transport, operation });
  }

  function dispatch(invocation, message, attachments) {
    const controller = new AbortController();
    const settled = runInvocation(invocation, message, attachments, controller)
      .catch(() => { /* runInvocation records its own outcome */ });
    executions.set(invocation.invocationId, { controller, settled });
    settled.then(() => executions.delete(invocation.invocationId));
  }

  return {
    // create/continue a session bound to one principal, transport, and soul.
    createOrContinueSession({ principal, transport, agentId, sessionId = null }) {
      const wantedTransport = validated(() => validateTransport(transport));
      const target = agentIdOrFail(agentId);
      authorize({ principal, transport: wantedTransport, agentId: target, operation: 'message' });
      resolveSoul(target);
      if (sessionId !== null && sessionId !== undefined) {
        const wantedSession = validated(() => validateSessionId(sessionId));
        const session = getSession(wantedSession, storeOptions);
        if (
          !session
          || session.principalId !== principal.principalId
          || session.agentId !== target
          || session.transport !== wantedTransport
        ) {
          // A mismatched soul, transport, or owner reads as absence.
          throw failure(404, 'unknown session');
        }
        return { session: publicSession(touchSession(wantedSession, storeOptions)), created: false };
      }
      const session = createSession(
        { agentId: target, principalId: principal.principalId, transport: wantedTransport },
        storeOptions,
      );
      return { session: publicSession(session), created: true };
    },

    submitMessage({ principal, transport, sessionId, message, idempotencyKey, attachments }) {
      const wantedTransport = validated(() => validateTransport(transport));
      const wantedSession = validated(() => validateSessionId(sessionId));
      const text = validateMessage(message);
      const references = validateAttachments(attachments);
      if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
        throw failure(400, 'invalid idempotency key');
      }
      const session = getSession(wantedSession, storeOptions);
      if (
        !session
        || session.principalId !== principal.principalId
        || session.transport !== wantedTransport
      ) {
        throw failure(404, 'unknown session');
      }
      authorize({
        principal,
        transport: wantedTransport,
        agentId: session.agentId,
        operation: 'message',
      });
      resolveSoul(session.agentId);
      const { invocation, created } = validated(() => submitInvocation({
        sessionId: session.sessionId,
        agentId: session.agentId,
        principalId: principal.principalId,
        transport: wantedTransport,
        idempotencyKey,
      }, storeOptions));
      if (!created) return { invocation: publicInvocation(invocation), duplicate: true };
      // The invocation record never stores message text; the payload file is
      // what a reach-back fetch_context reads after the daemon hands off.
      writeInvocationPayload(
        invocation.invocationId,
        { message: text, attachments: references },
        storeOptions,
      );
      recordStatus(invocation.invocationId, 'queued');
      touchSession(session.sessionId, storeOptions);
      dispatch(invocation, text, references);
      return { invocation: publicInvocation(invocation), duplicate: false };
    },

    getInvocation({ principal, transport, invocationId }) {
      const wantedTransport = validated(() => validateTransport(transport));
      const invocation = ownedInvocation(principal, invocationId);
      authorize({
        principal,
        transport: wantedTransport,
        agentId: invocation.agentId,
        operation: 'observe',
      });
      return { invocation: publicInvocation(invocation) };
    },

    readEvents({ principal, transport, invocationId, afterSeq = 0 }) {
      const wantedTransport = validated(() => validateTransport(transport));
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw failure(400, 'afterSeq must be a non-negative integer');
      }
      const invocation = ownedInvocation(principal, invocationId);
      authorize({
        principal,
        transport: wantedTransport,
        agentId: invocation.agentId,
        operation: 'observe',
      });
      return { events: readEvents(invocation.invocationId, { afterSeq }, storeOptions) };
    },

    // Cooperative cancellation: mark cancel-requested, fire the executor's
    // AbortSignal, then wait for execution to settle so `stopped` reports
    // what actually happened rather than what was asked for.
    async cancelInvocation({ principal, transport, invocationId }) {
      const wantedTransport = validated(() => validateTransport(transport));
      const invocation = ownedInvocation(principal, invocationId);
      authorize({
        principal,
        transport: wantedTransport,
        agentId: invocation.agentId,
        operation: 'cancel',
      });
      if (INVOCATION_FINISHED.has(invocation.status)) {
        return {
          invocationId: invocation.invocationId,
          status: invocation.status,
          stopped: invocation.status === 'cancelled',
          alreadyFinished: true,
        };
      }
      if (invocation.status !== 'cancel-requested') {
        transitionInvocation(invocation.invocationId, 'cancel-requested', storeOptions);
        recordStatus(invocation.invocationId, 'cancel-requested');
      }
      const execution = executions.get(invocation.invocationId);
      if (execution) {
        execution.controller.abort();
        await execution.settled;
      } else if (getInvocation(invocation.invocationId, storeOptions).status === 'cancel-requested') {
        // Nothing is executing in this process, so the request is final.
        transitionInvocation(invocation.invocationId, 'cancelled', storeOptions);
        recordStatus(invocation.invocationId, 'cancelled');
      }
      const final = getInvocation(invocation.invocationId, storeOptions);
      return {
        invocationId: final.invocationId,
        status: final.status,
        stopped: final.status === 'cancelled',
        alreadyFinished: false,
      };
    },

    listArtifacts({ principal, transport, invocationId }) {
      const wantedTransport = validated(() => validateTransport(transport));
      const invocation = ownedInvocation(principal, invocationId);
      authorize({
        principal,
        transport: wantedTransport,
        agentId: invocation.agentId,
        operation: 'observe',
      });
      return { artifacts: listArtifacts(invocation.invocationId, storeOptions) };
    },

    // Population projection for control surfaces (#59 req 5): only the souls
    // this principal is authorized to observe, and only census metadata.
    listAuthorizedSouls({ principal, transport }) {
      const wantedTransport = validated(() => validateTransport(transport));
      authorizeListing(principal, wantedTransport, 'observe');
      const souls = listSouls(populationOptions)
        .filter((soul) => soulAllowed(principal, soul.id))
        .map(({ id, appSlug, parentId, status, spacePath, lastSeen }) => (
          { id, appSlug, parentId, status, spacePath, lastSeen }
        ));
      return { souls };
    },

    // Sessions are bound to one transport (#56); a listing is scoped to the
    // caller's transport so one surface never renders — or tries to continue
    // — another adapter's sessions (a web client must not list Telegram
    // sessions, and could not continue them anyway).
    listSessions({ principal, transport, agentId = null }) {
      const wantedTransport = validated(() => validateTransport(transport));
      authorizeListing(principal, wantedTransport, 'observe');
      const wantedAgent = agentId === null || agentId === undefined ? null : agentIdOrFail(agentId);
      const sessions = listSessions(
        { principalId: principal.principalId, agentId: wantedAgent },
        storeOptions,
      )
        .filter((session) => session.transport === wantedTransport)
        .filter((session) => soulAllowed(principal, session.agentId));
      return { sessions: sessions.map(publicSession) };
    },

    listInvocations({ principal, transport, sessionId = null }) {
      const wantedTransport = validated(() => validateTransport(transport));
      authorizeListing(principal, wantedTransport, 'observe');
      const wantedSession = sessionId === null || sessionId === undefined
        ? null
        : validated(() => validateSessionId(sessionId));
      const invocations = listInvocations(
        { principalId: principal.principalId, sessionId: wantedSession },
        storeOptions,
      ).filter((invocation) => soulAllowed(principal, invocation.agentId));
      return { invocations: invocations.map(publicInvocation) };
    },

    // Open, unexpired proposals over souls this principal may observe. The
    // digest travels with each row so an approving client signs off on the
    // exact operation the daemon recorded, not on whatever text it rendered.
    listProposals({ principal, transport }) {
      const wantedTransport = validated(() => validateTransport(transport));
      authorizeListing(principal, wantedTransport, 'observe');
      const nowMs = now().getTime();
      const proposals = [];
      for (const proposal of listProposals({ status: 'open' }, storeOptions)) {
        if (nowMs > new Date(proposal.expiresAt).getTime()) continue;
        const invocation = getInvocation(proposal.invocationId, storeOptions);
        if (!invocation || invocation.status !== 'waiting-approval') continue;
        if (!soulAllowed(principal, invocation.agentId)) continue;
        proposals.push(publicProposal(proposal, invocation));
      }
      return { proposals };
    },

    // Approve/deny an immutable proposal (#59 req 8). The caller must hold the
    // reserved 'approve' operation for the soul, and must echo the exact
    // operation digest; a mismatched or stale digest is refused. Consuming the
    // proposal is atomic in the store, so a decision can never land twice.
    decideProposal({ principal, transport, proposalId, decision, digest }) {
      const wantedTransport = validated(() => validateTransport(transport));
      const target = validated(() => validateProposalId(proposalId));
      if (decision !== 'approve' && decision !== 'deny') {
        throw failure(400, 'decision must be approve or deny');
      }
      const proposal = getProposal(target, storeOptions);
      if (!proposal) throw failure(404, 'unknown proposal');
      const invocation = getInvocation(proposal.invocationId, storeOptions);
      if (!invocation) throw failure(404, 'unknown proposal');
      authorize({
        principal,
        transport: wantedTransport,
        agentId: invocation.agentId,
        operation: 'approve',
      });
      if (proposal.status !== 'open' || invocation.status !== 'waiting-approval') {
        throw failure(409, 'proposal is no longer open');
      }
      if (now().getTime() > new Date(proposal.expiresAt).getTime()) {
        try {
          decideProposal(proposal.proposalId, { decision: 'expired' }, storeOptions);
          appendEvent(invocation.invocationId, 'approval-decision', {
            proposalId: proposal.proposalId,
            decision: 'expired',
          }, storeOptions);
        } catch {
          /* already settled by the expiry timer */
        }
        const waiter = approvalWaiters.get(proposal.proposalId);
        if (waiter) waiter({ decision: 'deny', expired: true });
        throw failure(409, 'proposal is no longer open');
      }
      if (!digestsMatch(proposal.operationDigest, digest)) {
        audit('denied', {
          principal,
          transport: wantedTransport,
          agentId: invocation.agentId,
          operation: 'approve',
        });
        throw failure(409, 'operation digest does not match the proposal');
      }
      let decided;
      try {
        decided = decideProposal(proposal.proposalId, {
          decision: decision === 'approve' ? 'approved' : 'denied',
          decidedBy: principal.principalId,
        }, storeOptions);
      } catch {
        throw failure(409, 'proposal is no longer open');
      }
      appendEvent(invocation.invocationId, 'approval-decision', {
        proposalId: decided.proposalId,
        decision: decided.status,
        operationDigest: decided.operationDigest,
        decidedBy: decided.decidedBy,
      }, storeOptions);
      const settle = approvalWaiters.get(decided.proposalId);
      if (settle) settle({ decision });
      return { proposal: publicProposal(decided, invocation) };
    },

    // Bounded artifact resolution for download surfaces (#59 req 7). Bytes
    // never flow through this service; it authorizes, matches recorded
    // metadata, and proves the real path stays inside the soul's Agent Space
    // (symlinks included) before the caller streams anything.
    resolveArtifact({ principal, transport, invocationId, name }) {
      const wantedTransport = validated(() => validateTransport(transport));
      const invocation = ownedInvocation(principal, invocationId);
      authorize({
        principal,
        transport: wantedTransport,
        agentId: invocation.agentId,
        operation: 'observe',
      });
      let wantedName;
      try {
        wantedName = validateArtifactName(name);
      } catch {
        throw failure(400, 'invalid artifact name');
      }
      const artifact = invocation.artifacts.find((entry) => entry.name === wantedName);
      if (!artifact) throw failure(404, 'unknown artifact');
      let soul;
      try {
        soul = showSoul(invocation.agentId, populationOptions);
      } catch {
        throw failure(404, 'unknown soul');
      }
      const root = path.resolve(soul.spacePath);
      const candidate = path.resolve(root, artifact.spacePath);
      if (candidate !== root && !candidate.startsWith(root + path.sep)) {
        throw failure(404, 'artifact is not available');
      }
      let realRoot;
      let realFile;
      try {
        realRoot = realpathSync(root);
        realFile = realpathSync(candidate);
      } catch {
        throw failure(404, 'artifact is not available');
      }
      if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
        throw failure(404, 'artifact is not available');
      }
      return { artifact, path: realFile };
    },
  };
}

const INVOCATION_FINISHED = new Set(['completed', 'failed', 'cancelled']);

async function main() {
  throw new Error('agent-interaction is a library consumed by the daemon; use agent-bot daemon');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`agent-interaction: ${error.message}\n`);
    process.exit(1);
  });
}
