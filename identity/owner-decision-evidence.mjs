// Disabled typed owner-decision effect evidence (agent-comms#77, slice C1):
// strict codecs and bindings for the daemon's preparation (slot 6), check
// (slot 7), refused (slot 8), entered (slot 9) and completed (slot 10)
// records, against agent-comms docs/owner-decision-effect-evidence.md and
// tests/fixtures/owner-decisions/effect-evidence-v1.json at f42c05b. Pure:
// nothing here writes, applies an effect, verifies a signature or grants
// authority. A record that validates is evidence of what was written, never
// permission to do anything.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical-json.mjs';

export const EVIDENCE_CAP = 4096;
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^sha256:[a-f0-9]{64}$/;
const PRINCIPAL = /^principal_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SOUL = /^agent_[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACCOUNT = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const REVISION_OPERATIONS = ['revision.approve', 'revision.reject', 'revision.adopt', 'revision.edit'];
// Final pre-effect refusal reasons and their public outcome codes, per
// agent-comms 77bb19c (#212). storage-refused is only ever emitted for a
// durably recorded refusal; failing to record one stays storage-failed or
// uncertain.
export const REFUSAL_OUTCOMES = Object.freeze({
  expired: 'deadline-expired',
  'expected-state-changed': 'validation-refused',
  'proposal-not-pending': 'validation-refused',
  'stage-invalid': 'validation-refused',
  'target-unavailable': 'validation-refused',
  'validation-failed': 'validation-refused',
  'storage-unavailable': 'storage-refused',
  'trust-unavailable': 'authority-refused',
});
const REFUSAL_CODES = Object.keys(REFUSAL_OUTCOMES);
const HARNESSES = ['codex', 'opencode', 'devin', 'grok'];
const WINDOW = 180;

const matches = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const seconds = (value) => Number.isSafeInteger(value) && value >= 0;
const seq = (value) => Number.isInteger(value) && value >= 0 && value <= 9_999_999_999;
const nullOr = (value, check) => value === null || check(value);
const digest = (value) => matches(DIGEST, value);
const revision = (value) => matches(REVISION, value);
const uuid = (value) => matches(UUID4, value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function evidenceError(reason) {
  return Object.assign(new Error('owner decision evidence refused'), { code: 'invalid-owner-decision-evidence', reason });
}
const fail = (reason = 'owner-evidence-invalid') => { throw evidenceError(reason); };

// Strict canonical JSON within the 4096-byte record cap.
function decodeCanonical(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > EVIDENCE_CAP) fail();
  let value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error();
  } catch { fail(); }
  return value;
}

function stageShape(stage) {
  return exact(stage, ['stagingId', 'kind', 'contentDigest', 'expiresAt']) && uuid(stage.stagingId)
    && ['package', 'webhook'].includes(stage.kind) && digest(stage.contentDigest) && seconds(stage.expiresAt);
}

function coldSetting(setting) {
  if (exact(setting, ['mode'])) return ['on', 'off', 'webhook'].includes(setting.mode);
  return exact(setting, ['mode', 'policy']) && setting.mode === 'resume' && ['read-only', 'workspace'].includes(setting.policy);
}

function expectedShape(operation, e) {
  if (REVISION_OPERATIONS.includes(operation)) {
    if (!exact(e, ['kind', 'head', 'proposal', 'destination']) || e.kind !== 'revision') return false;
    if (!nullOr(e.head, (h) => exact(h, ['seq', 'revision']) && seq(h.seq) && revision(h.revision))) return false;
    if ((e.head === null) !== (operation === 'revision.adopt')) return false;
    const proposalNamed = ['revision.approve', 'revision.reject'].includes(operation);
    if (proposalNamed !== (e.proposal !== null)) return false;
    if (!nullOr(e.proposal, (p) => exact(p, ['proposalId', 'seq', 'revision', 'parentRevision']) && uuid(p.proposalId)
      && seq(p.seq) && revision(p.revision) && revision(p.parentRevision) && p.parentRevision === e.head.revision)) return false;
    return nullOr(e.destination, (d) => exact(d, ['rootDigest', 'beforeInventoryDigest']) && digest(d.rootDigest)
      && digest(d.beforeInventoryDigest) && operation === 'revision.edit');
  }
  return operation === 'cold-wake.set' && exact(e, ['kind', 'setting', 'webhookDigest', 'resume']) && e.kind === 'cold-wake'
    && coldSetting(e.setting) && nullOr(e.webhookDigest, digest)
    && nullOr(e.resume, (r) => exact(r, ['harness', 'sessionDigest', 'toolHomeDigest', 'destinationDigest'])
      && HARNESSES.includes(r.harness) && nullOr(r.sessionDigest, digest) && digest(r.toolHomeDigest) && digest(r.destinationDigest));
}

// --- preparation (slot 6) ---

const PREPARATION_V1 = ['v', 'kind', 'requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'effectId', 'actionDigest',
  'nonce', 'acceptedAt', 'preparedAt', 'exp', 'daemonKey', 'daemonEpoch', 'watchId', 'stage', 'expected'];
// The trust chain version a v2 preparation records: the active enrollment's,
// so an odd integer 1..1023 (owner decision Q3; agent-comms effect-evidence-v2).
// (A negative or zero value is never odd under `% 2 === 1`.)
const trustChainVersion = (value) => Number.isSafeInteger(value) && value <= 1023 && value % 2 === 1;

// A preparation is v2, the v1 fields plus `trustVersion` (what the daemon
// writes), or v1 without it (the vendored v1 vectors). Only v2 can enter: the
// effect-entry gate requires its trustVersion to equal the current chain's.
export function decodePreparation(bytes) {
  const p = decodeCanonical(bytes);
  const shape = p?.v === 2 ? exact(p, [...PREPARATION_V1, 'trustVersion']) && trustChainVersion(p.trustVersion)
    : p?.v === 1 && exact(p, PREPARATION_V1);
  if (!shape || p.kind !== 'preparation' || !uuid(p.requestId) || !matches(PRINCIPAL, p.principal)
    || !matches(ACCOUNT, p.account) || !matches(SOUL, p.soul) || !digest(p.payloadDigest) || !uuid(p.effectId)
    || !digest(p.actionDigest) || !matches(/^[A-Za-z0-9_-]{43}$/, p.nonce) || Buffer.from(p.nonce, 'base64url').length !== 32
    || Buffer.from(p.nonce, 'base64url').toString('base64url') !== p.nonce
    || !seconds(p.acceptedAt) || !seconds(p.preparedAt) || !seconds(p.exp) || !digest(p.daemonKey)
    || !Number.isSafeInteger(p.daemonEpoch) || p.daemonEpoch < 1 || !uuid(p.watchId)
    || !nullOr(p.stage, stageShape) || !expectedShape(p.operation, p.expected)) fail();
  return p;
}

// A preparation belongs to exactly this admission: the same request, binding
// and original acceptance time; the stage the action names; for edit, a
// destination exactly when apply is requested; and exp as the exact minimum
// of the acceptance, preparation and stage deadlines.
export function bindPreparation(p, { acceptance, action }) {
  for (const key of ['requestId', 'principal', 'account', 'soul', 'operation', 'payloadDigest', 'acceptedAt', 'daemonKey', 'daemonEpoch', 'watchId']) {
    if (p[key] !== acceptance[key]) fail('owner-evidence-binding');
  }
  const parameters = action.parameters;
  if (Object.hasOwn(parameters, 'stagingId')) {
    const webhook = p.operation === 'cold-wake.set';
    if (p.stage === null || p.stage.stagingId !== parameters.stagingId || p.stage.kind !== (webhook ? 'webhook' : 'package')
      || p.stage.contentDigest !== (webhook ? parameters.configurationDigest : parameters.packageDigest)) fail('owner-evidence-binding');
  } else if (p.stage !== null) fail('owner-evidence-binding');
  // The prepared expectation must be the one the signed action names.
  const e = p.expected;
  if (['revision.approve', 'revision.reject'].includes(p.operation)) {
    if (e.proposal.proposalId !== parameters.proposalId || e.head.revision !== parameters.expectedRevision) fail('owner-evidence-binding');
  } else if (p.operation === 'revision.adopt') {
    if (parameters.expectedRevision !== null || e.head !== null) fail('owner-evidence-binding');
  } else if (p.operation === 'revision.edit') {
    if (e.head.revision !== parameters.expectedRevision || (e.destination !== null) !== (parameters.apply === true)) fail('owner-evidence-binding');
  } else {
    // Resume context is bound exactly when the current or desired mode is resume.
    if (!coldSetting(desiredSetting(parameters)) || (e.resume !== null) !== (parameters.mode === 'resume' || e.setting.mode === 'resume')) {
      fail('owner-evidence-binding');
    }
  }
  const deadlines = [p.acceptedAt + WINDOW, p.preparedAt + WINDOW, ...(p.stage ? [p.stage.expiresAt] : [])];
  if (!deadlines.every(Number.isSafeInteger) || p.exp !== Math.min(...deadlines)
    || p.preparedAt < Math.max(0, p.acceptedAt - 30)) fail('owner-evidence-binding');
  return p;
}

// The exact challenge (slot 3) a preparation implies, given the original
// action bytes: the daemon never stores a challenge that differs from it.
export function challengeFor(p, actionBytes) {
  return Buffer.from(canonicalJson({
    requestId: p.requestId, principal: p.principal, account: p.account, soul: p.soul, operation: p.operation,
    payloadDigest: p.payloadDigest, action: Buffer.from(actionBytes).toString('base64url'), nonce: p.nonce,
    acceptedAt: p.acceptedAt, preparedAt: p.preparedAt, exp: p.exp, daemonKey: p.daemonKey, daemonEpoch: p.daemonEpoch, watchId: p.watchId,
  }));
}

// --- the one live successful check (slot 7) ---

export function decodeSuccessfulCheck(bytes, { acceptance, receiptDigest }) {
  const c = decodeCanonical(bytes);
  if (!exact(c, ['requestId', 'payloadDigest', 'receiptDigest', 'daemonKey', 'daemonEpoch', 'watchId', 'state', 'mayApply', 'exp'])
    || c.state !== 'released' || c.mayApply !== true || !seconds(c.exp) || c.receiptDigest !== receiptDigest) fail();
  for (const key of ['requestId', 'payloadDigest', 'daemonKey', 'daemonEpoch', 'watchId']) if (c[key] !== acceptance[key]) fail('owner-evidence-binding');
  return c;
}

// --- effect records (slots 8, 9, 10) ---

function revisionDetail(d, phase) {
  return exact(d, phase === 'entered' ? ['kind', 'beforeRevision', 'afterRevision', 'proposalId', 'apply']
    : ['kind', 'journalSeq', 'journalRecordDigest', 'beforeRevision', 'afterRevision', 'proposalId', 'working'])
    && d.kind === 'revision' && nullOr(d.beforeRevision, revision) && revision(d.afterRevision) && nullOr(d.proposalId, uuid)
    && (phase === 'entered' ? typeof d.apply === 'boolean'
      : seq(d.journalSeq) && digest(d.journalRecordDigest)
        && nullOr(d.working, (w) => exact(w, ['rootDigest', 'inventoryDigest']) && digest(w.rootDigest) && digest(w.inventoryDigest)));
}

function coldDetail(d, phase) {
  return exact(d, phase === 'entered' ? ['kind', 'beforeDigest', 'afterDigest'] : ['kind', 'beforeDigest', 'afterDigest', 'settingsDigest', 'webhookDigest'])
    && d.kind === 'cold-wake' && digest(d.beforeDigest) && digest(d.afterDigest)
    && (phase === 'entered' || (digest(d.settingsDigest) && nullOr(d.webhookDigest, digest)));
}

export function decodeEffect(bytes) {
  const r = decodeCanonical(bytes);
  if (!exact(r, ['v', 'kind', 'requestId', 'payloadDigest', 'preparationDigest', 'receiptDigest', 'effectId', 'phase', 'at', 'detail'])
    || r.v !== 1 || r.kind !== 'effect' || !uuid(r.requestId) || !digest(r.payloadDigest) || !digest(r.preparationDigest)
    || !nullOr(r.receiptDigest, digest) || !uuid(r.effectId) || !seconds(r.at)) fail();
  if (r.phase === 'refused') {
    if (!exact(r.detail, ['code']) || !REFUSAL_CODES.includes(r.detail.code)) fail();
  } else if (r.phase === 'entered' || r.phase === 'completed') {
    if (r.receiptDigest === null || !(revisionDetail(r.detail, r.phase) || coldDetail(r.detail, r.phase))) fail();
  } else fail();
  return r;
}

// The cold-wake setting a `cold-wake.set` action asks for.
function desiredSetting(parameters) {
  return parameters.mode === 'resume' ? { mode: 'resume', policy: parameters.policy } : { mode: parameters.mode };
}

// The SHA-256 of the typed cold-wake state, as before/after digests use it.
export function coldStateDigest({ setting, webhookDigest, resume }) {
  return sha256(canonicalJson({ v: 1, setting, webhookDigest, resume }));
}

// The one entered record a released request can have: the transition from
// the prepared expectation to exactly what the signed action asks for, at
// `at` seconds. Derived only from the saved preparation and action, so a
// caller never supplies record content; bindEffect re-checks it.
export function enteredRecordFor({ preparation, preparationDigest, receiptDigest, action, at }) {
  const e = preparation.expected, parameters = action.parameters;
  let detail;
  if (preparation.operation === 'cold-wake.set') {
    const desired = desiredSetting(parameters);
    detail = { kind: 'cold-wake', beforeDigest: coldStateDigest(e),
      afterDigest: coldStateDigest({ setting: desired, webhookDigest: desired.mode === 'webhook' ? parameters.configurationDigest : null, resume: e.resume }) };
  } else {
    const before = e.head?.revision ?? null;
    const after = preparation.operation === 'revision.approve' ? e.proposal.revision
      : preparation.operation === 'revision.reject' ? before : `sha256:${parameters.packageDigest}`;
    detail = { kind: 'revision', beforeRevision: before, afterRevision: after, proposalId: e.proposal?.proposalId ?? null,
      apply: preparation.operation === 'revision.edit' && parameters.apply === true };
  }
  return { v: 1, kind: 'effect', requestId: preparation.requestId, payloadDigest: preparation.payloadDigest, preparationDigest,
    receiptDigest, effectId: preparation.effectId, phase: 'entered', at, detail };
}

// The completed record for one entered effect. It repeats the entered
// transition; a cold-wake completion derives its settings and webhook digests
// from the signed action, and a revision completion takes what the effect
// reports: its revision-journal sequence and record digest, and the working
// tree digests (null unless the entered record applies). The caller binds it.
export function completedRecordFor({ entered, action, at, journalSeq, journalRecordDigest, working }) {
  const d = entered.detail;
  let detail;
  if (d.kind === 'cold-wake') {
    const desired = desiredSetting(action.parameters);
    detail = { kind: 'cold-wake', beforeDigest: d.beforeDigest, afterDigest: d.afterDigest, settingsDigest: sha256(canonicalJson(desired)),
      webhookDigest: desired.mode === 'webhook' ? action.parameters.configurationDigest : null };
  } else {
    detail = { kind: 'revision', journalSeq, journalRecordDigest, beforeRevision: d.beforeRevision, afterRevision: d.afterRevision,
      proposalId: d.proposalId, working };
  }
  return { ...entered, phase: 'completed', at, detail };
}

// The final pre-effect refusal record for one prepared request. The receipt
// digest is the checked receipt's, or null before a successful check.
export function refusedRecordFor({ preparation, preparationDigest, receiptDigest, code, at }) {
  return { v: 1, kind: 'effect', requestId: preparation.requestId, payloadDigest: preparation.payloadDigest, preparationDigest,
    receiptDigest, effectId: preparation.effectId, phase: 'refused', at, detail: { code } };
}

// One effect record belongs to exactly this preparation and receipt, in the
// phase expected. Entered must describe the transition from the prepared
// expectation to exactly what the signed action asks for, and completed must
// repeat its entered record's transition. `action` is the original action.
export function bindEffect(r, { phase, preparation, preparationDigest, receiptDigest, action, entered = null }) {
  if (r.phase !== phase || r.requestId !== preparation.requestId || r.payloadDigest !== preparation.payloadDigest
    || r.preparationDigest !== preparationDigest || r.effectId !== preparation.effectId) fail('owner-evidence-binding');
  if (phase === 'refused') {
    if (r.receiptDigest !== null && r.receiptDigest !== receiptDigest) fail('owner-evidence-binding');
    return r;
  }
  if (r.receiptDigest !== receiptDigest) fail('owner-evidence-binding');
  const d = r.detail, e = preparation.expected, parameters = action?.parameters;
  if (!plain(parameters) || action.requestId !== preparation.requestId || action.operation !== preparation.operation) fail('owner-evidence-binding');
  if (preparation.operation === 'cold-wake.set') {
    const desired = desiredSetting(parameters), webhookDigest = desired.mode === 'webhook' ? parameters.configurationDigest : null;
    if (d.kind !== 'cold-wake' || d.beforeDigest !== coldStateDigest(e)
      || d.afterDigest !== coldStateDigest({ setting: desired, webhookDigest, resume: e.resume })) fail('owner-evidence-binding');
    if (phase === 'completed' && (d.beforeDigest !== entered.detail.beforeDigest || d.afterDigest !== entered.detail.afterDigest
      || d.settingsDigest !== sha256(canonicalJson(desired)) || d.webhookDigest !== webhookDigest)) fail('owner-evidence-binding');
    return r;
  }
  const named = ['revision.approve', 'revision.reject'].includes(preparation.operation) ? parameters.proposalId : null;
  if (d.kind !== 'revision' || d.beforeRevision !== (e.head?.revision ?? null) || d.beforeRevision !== (parameters.expectedRevision ?? null)
    || d.proposalId !== named || d.proposalId !== (e.proposal?.proposalId ?? null)) fail('owner-evidence-binding');
  if (preparation.operation === 'revision.approve' && d.afterRevision !== e.proposal.revision) fail('owner-evidence-binding');
  if (preparation.operation === 'revision.reject' && d.afterRevision !== d.beforeRevision) fail('owner-evidence-binding');
  if (['revision.adopt', 'revision.edit'].includes(preparation.operation) && d.afterRevision !== `sha256:${parameters.packageDigest}`) fail('owner-evidence-binding');
  const apply = preparation.operation === 'revision.edit' && parameters.apply === true;
  if (phase === 'entered') {
    if (d.apply !== apply) fail('owner-evidence-binding');
  } else if (d.beforeRevision !== entered.detail.beforeRevision || d.afterRevision !== entered.detail.afterRevision
    || (d.working !== null) !== entered.detail.apply) fail('owner-evidence-binding');
  return r;
}

// One structurally valid reconciliation pair (decodeReconciliationPair) bound
// to this request and the finding its slot and proof allow (agent-comms
// d071a9b journal records, effect companion):
// - the acceptance's request, payload and original daemon key/epoch;
// - the saved preparation's effectId, or null only when no preparation exists
//   (an indeterminate observation);
// - basisDigest: SHA-256 of the exact completed record for applied, of the
//   exact pre-effect refused record for refused, and null for an
//   indeterminate observation, which has no proof;
// - the preimage kind of the operation: a cold state for cold-wake.set, a
//   revision observation otherwise, whose working digests are present exactly
//   when the action is an applying edit.
// The reporting daemon key/epoch and the observed state are the reporting
// ceremony's; this binds them to nothing else.
export function bindReconciliationPair(pair, { finding, acceptance, action, preparation = null, basisBytes = null }) {
  const r = pair.record, p = pair.preimage;
  if (r.finding !== finding) fail('owner-evidence-binding');
  // The pair codec binds requestId to the frame's request.
  if (r.payloadDigest !== acceptance.payloadDigest || r.originalDaemonKey !== acceptance.daemonKey || r.originalDaemonEpoch !== acceptance.daemonEpoch) fail('owner-evidence-binding');
  if (r.effectId !== (preparation ? preparation.effectId : null)) fail('owner-evidence-binding');
  if (r.finding === 'indeterminate' ? (r.basisDigest !== null || basisBytes !== null)
    : (basisBytes === null || r.basisDigest !== sha256(basisBytes))) fail('owner-evidence-binding');
  const cold = acceptance.operation === 'cold-wake.set', revisionShape = Object.hasOwn(p, 'head');
  if (cold === revisionShape) fail('owner-evidence-binding');
  if (revisionShape && (p.working !== null) !== (acceptance.operation === 'revision.edit' && action.parameters.apply === true)) {
    fail('owner-evidence-binding');
  }
  return pair;
}

// The owner-local reconciliation finding for one recovery scenario, exactly
// the agent-comms classification: refused only from durable pre-effect
// refusal before entry; applied only with the owner ceremony and matching
// state after entry, from completion or, for record-only revision
// operations, a linked authoritative event; otherwise indeterminate.
export function reconciliationFinding({ operation, apply = false, entered, completed, linkedEvent, matchingState, ownerCeremony, durablePreEffectRefusal }) {
  const recordOnly = ['revision.approve', 'revision.reject', 'revision.adopt'].includes(operation) || (operation === 'revision.edit' && apply === false);
  if (durablePreEffectRefusal && !entered) return 'refused';
  if (ownerCeremony && matchingState && entered && (completed || (recordOnly && linkedEvent))) return 'applied';
  return 'indeterminate';
}

export const effectDigest = (bytes) => sha256(bytes);

// The producer's public outcome for one durable effect record (canonical
// bytes): completed is applied with its digest; a final refusal maps its
// reason, with its digest; entered alone is indeterminate with no digest.
// Early refusals and absent proof have no record and report a null digest.
export function effectOutcome(bytes) {
  const record = decodeEffect(bytes);
  if (record.phase === 'completed') return { state: 'applied', outcome: { code: 'applied', effectDigest: sha256(bytes) } };
  if (record.phase === 'refused') return { state: 'refused', outcome: { code: REFUSAL_OUTCOMES[record.detail.code], effectDigest: sha256(bytes) } };
  return { state: 'indeterminate', outcome: { code: 'effect-uncertain', effectDigest: null } };
}
