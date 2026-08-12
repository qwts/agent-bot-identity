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
// attachments, appendEvent, signal })` is the integration point for harness
// adapters. v1 ships with a deliberate 'unconfigured' default that records a
// stable event and fails the invocation, so the contract, store, and
// authorization plane are testable before any real executor exists.

import { homedir } from 'node:os';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  appendEvent,
  createSession,
  getInvocation,
  getSession,
  listArtifacts,
  readEvents,
  submitInvocation,
  touchSession,
  transitionInvocation,
  validateInvocationId,
  validateSessionId,
} from './agent-jobs.mjs';
import {
  appendAuditReceipt,
  assertAuthorized,
  validateTransport,
} from './agent-principals.mjs';
import { populationFile, showSoul } from './agent-population.mjs';
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
