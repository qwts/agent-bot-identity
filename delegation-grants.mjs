// Human-origin delegation grants, narrowed (#108): a soul may ask for one
// named account write, the owner approves that exact write with keyd's
// presence prompt, and the identity service spends the grant once.
//
// Nothing here is a new record. A grant is an ordinary immutable proposal
// (agent-jobs.mjs) for a soul with no invocation: its operation digest is the
// sha256 of the operation's canonical JSON, its expiry is the proposal's,
// and its tool names the operation. Receipts are the audit log's
// (agent-principals.mjs).
//
// - Only GRANT_OPERATIONS can be granted. Approving or merging a pull
//   request, or anything else that meets the review bar, is not on the list
//   and never will be: those are refused when the grant is asked for.
// - Approval needs keyd's presence (owner-presence.mjs), Touch ID or the
//   login password, on an action line that carries the grant's digest, so
//   the signed assertion answers this grant and no other. There is no
//   administrator-dialog fallback and no principal stand-in: when keyd
//   cannot ask, the grant stays unapproved.
// - An approved grant waits in this ledger's memory until its soul spends
//   it with the exact operation, before it expires. The ledger forgets it
//   before the act runs, so a second spend finds nothing even while the
//   first is still in flight. A daemon restart forgets approved grants too:
//   they fail closed, and the owner approves again.
//
// The act itself is the caller's `perform(operation)`. The agent gets back
// the grant's status and a secret-free receipt, never a credential.

import { timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import { homedir } from 'node:os';

import {
  DEFAULT_PROPOSAL_TTL_MS,
  OWNER_DECIDER,
  createProposal,
  decideProposal,
  getProposal,
  operationDigest,
  validateProposalId,
} from './agent-jobs.mjs';
import { appendAuditReceipt } from './agent-principals.mjs';
import { validateAgentId } from './agent-identity.mjs';
import { keydPresence } from './owner-presence.mjs';

// The named operations (owner decision on #108). Each is an account write
// that is not an approval.
export const GRANT_OPERATIONS = Object.freeze(['issue-comment', 'issue-state', 'review-request']);
const TOOL_PREFIX = 'grant:';
const MAX_TTL_MS = DEFAULT_PROPOSAL_TTL_MS;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_REVIEWERS = 10;
const MAX_EXCERPT = 120;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function digestsMatch(expected, presented) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(typeof presented === 'string' ? presented : '', 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function printable(text) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

// The operation in its canonical shape, or a `grant-refused` error. Unknown
// members are refused rather than dropped, so the digest covers everything
// the caller sent.
export function grantOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('grant-refused', 'a grant names one operation object');
  }
  const { operation, repo, number, ...rest } = value;
  if (!GRANT_OPERATIONS.includes(operation)) {
    throw failure('grant-refused', `${String(operation)} cannot be granted; grantable operations are ${GRANT_OPERATIONS.join(', ')}`);
  }
  if (typeof repo !== 'string' || !REPO.test(repo)) throw failure('grant-refused', 'repo must be owner/name');
  if (!Number.isSafeInteger(number) || number <= 0) throw failure('grant-refused', 'number must be a positive integer');
  const extra = (allowed) => {
    const unknown = Object.keys(rest).filter((key) => !allowed.includes(key));
    if (unknown.length) throw failure('grant-refused', `${operation} does not take ${unknown.join(', ')}`);
  };
  if (operation === 'issue-comment') {
    extra(['body']);
    const { body } = rest;
    if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw failure('grant-refused', 'body must be non-empty text within 32 KiB');
    }
    return { operation, repo, number, body };
  }
  if (operation === 'issue-state') {
    extra(['state']);
    if (rest.state !== 'open' && rest.state !== 'closed') throw failure('grant-refused', 'state must be open or closed');
    return { operation, repo, number, state: rest.state };
  }
  extra(['reviewers']);
  const { reviewers } = rest;
  if (!Array.isArray(reviewers) || !reviewers.length || reviewers.length > MAX_REVIEWERS
    || !reviewers.every((login) => typeof login === 'string' && LOGIN.test(login))) {
    throw failure('grant-refused', `reviewers must be 1 to ${MAX_REVIEWERS} GitHub logins`);
  }
  return { operation, repo, number, reviewers: [...reviewers] };
}

// One line for the proposal and the presence prompt. Display only: the
// digest binds.
export function grantSummary(operation) {
  const where = `${operation.repo}#${operation.number}`;
  if (operation.operation === 'issue-state') return `${operation.state === 'closed' ? 'close' : 'reopen'} ${where}`;
  if (operation.operation === 'review-request') return `request review on ${where} from ${operation.reviewers.join(', ')}`;
  const body = Array.from(printable(operation.body));
  const excerpt = body.length > MAX_EXCERPT ? `${body.slice(0, MAX_EXCERPT - 1).join('')}…` : body.join('');
  return `comment on ${where}: "${excerpt}"`;
}

// What keyd signs: the soul, the write and the grant's digest.
export function grantPresenceAction(grant) {
  return `let ${grant.agentId} ${grant.summary} once (grant ${grant.operationDigest})`;
}

function grantOf(proposal) {
  if (!proposal || proposal.invocationId !== null || !proposal.tool?.startsWith(TOOL_PREFIX)) return null;
  return proposal;
}

export function createGrantLedger({
  env = process.env,
  home = homedir(),
  now = () => new Date(),
  presence = keydPresence,
  receipt = appendAuditReceipt,
} = {}) {
  const storeOptions = { env, home, now };
  // proposalId -> agentId of an approved grant not yet spent.
  const approved = new Map();
  const record = (fields) => receipt({ event: 'delegation-grant', ...fields }, storeOptions);

  function request({ agentId, operation, ttlMs = MAX_TTL_MS }) {
    const soul = validateAgentId(agentId);
    let shaped;
    try {
      shaped = grantOperation(operation);
    } catch (error) {
      record({ agentId: soul, operation: 'request', decision: 'refused', detail: error.message });
      throw error;
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
      throw failure('grant-refused', `a grant expires within ${MAX_TTL_MS / 60_000} minutes`);
    }
    const grant = createProposal({
      agentId: soul,
      tool: `${TOOL_PREFIX}${shaped.operation}`,
      risk: 'external',
      operationDigest: operationDigest(shaped),
      summary: grantSummary(shaped),
    }, { ...storeOptions, ttlMs });
    record({ agentId: soul, operation: 'request', decision: 'open', detail: `${grant.proposalId} ${grant.tool} ${grant.operationDigest}` });
    return grant;
  }

  // The owner's approval. `digest` is the one the owner was shown; it must be
  // the grant's, and keyd's assertion is bound to it.
  async function approve(proposalId, { digest }) {
    const grant = grantOf(getProposal(validateProposalId(proposalId), storeOptions));
    if (!grant) throw failure('grant-unknown', `${proposalId} is not a grant`);
    const refuse = (code, message, decision = 'refused') => {
      record({ agentId: grant.agentId, operation: 'approve', decision, detail: `${grant.proposalId} ${message}` });
      return failure(code, message);
    };
    if (grant.status !== 'open') throw refuse('grant-closed', 'grant is no longer open');
    if (now().getTime() > new Date(grant.expiresAt).getTime()) {
      try { decideProposal(grant.proposalId, { decision: 'expired' }, storeOptions); } catch { /* already settled */ }
      throw refuse('grant-expired', 'grant has expired', 'expired');
    }
    if (!digestsMatch(grant.operationDigest, digest)) throw refuse('grant-mismatch', 'digest does not match the grant');
    try {
      await presence(grantPresenceAction(grant), { env, home });
    } catch (error) {
      // keyd unavailable is a refusal here too: no other ceremony stands in.
      throw refuse(error.code === 'presence-unavailable' ? 'presence-required' : (error.code ?? 'owner-declined'),
        `owner presence was not given: ${error.message}`);
    }
    let decided;
    try {
      decided = decideProposal(grant.proposalId, { decision: 'approved', decidedBy: OWNER_DECIDER }, storeOptions);
    } catch (error) {
      throw refuse('grant-closed', error.message);
    }
    approved.set(decided.proposalId, decided.agentId);
    record({ agentId: decided.agentId, operation: 'approve', decision: 'approved', detail: `${decided.proposalId} ${decided.operationDigest}` });
    return decided;
  }

  // The soul's spend. The grant is forgotten before `perform` runs, so it is
  // spent at most once whatever the act does.
  async function spend(proposalId, { agentId, operation }, perform) {
    const soul = validateAgentId(agentId);
    const id = validateProposalId(proposalId);
    const refuse = (code, message) => {
      record({ agentId: soul, operation: 'spend', decision: 'refused', detail: `${id} ${message}` });
      return failure(code, message);
    };
    const grant = grantOf(getProposal(id, storeOptions));
    if (!grant || grant.agentId !== soul || approved.get(id) !== soul || grant.status !== 'approved') {
      throw refuse('grant-unavailable', 'no approved, unspent grant for this soul');
    }
    if (now().getTime() > new Date(grant.expiresAt).getTime()) {
      approved.delete(id);
      throw refuse('grant-expired', 'grant has expired');
    }
    let shaped;
    try { shaped = grantOperation(operation); } catch (error) { throw refuse(error.code, error.message); }
    if (`${TOOL_PREFIX}${shaped.operation}` !== grant.tool || !digestsMatch(grant.operationDigest, operationDigest(shaped))) {
      throw refuse('grant-mismatch', 'operation does not match the grant');
    }
    approved.delete(id);
    try {
      await perform(shaped);
    } catch (error) {
      // The act's error stays with the caller's log: it may quote what the
      // agent must not see, so the receipt says only that it failed.
      record({ agentId: soul, operation: 'spend', decision: 'failed', detail: `${id} ${grant.tool}` });
      throw Object.assign(new Error(`the granted ${shaped.operation} failed; the grant is spent`), { code: 'grant-act-failed', cause: error });
    }
    const spent = record({ agentId: soul, operation: 'spend', decision: 'spent', detail: `${id} ${grant.tool} ${grant.operationDigest}` });
    return { proposalId: id, status: 'spent', receipt: spent };
  }

  return { request, approve, spend };
}
