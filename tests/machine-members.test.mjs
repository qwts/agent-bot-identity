// Member accounts plans and the approve-members request (#1401). The
// fixture is a plan saved by managed-machine itself (agent-bot-machine
// internal/members), so the digest check here is a check against the Go
// implementation, not against this file's own idea of the canonical form.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRequest, requestCanonical } from '../machine-client.mjs';
import { listMembersPlans, membersPlanDigest, membersPlansDir, readMembersPlan } from '../machine-members.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/members-plan.json', import.meta.url), 'utf8');
const SAVED = JSON.parse(FIXTURE);
const PLAN_ID = SAVED.plan_id;

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function homeWith(files = { [PLAN_ID]: FIXTURE }) {
  const home = mkdtempSync(path.join(tmpdir(), 'members-plan-'));
  roots.push(home);
  mkdirSync(membersPlansDir({ home }), { recursive: true });
  for (const [id, text] of Object.entries(files)) writeFileSync(path.join(membersPlansDir({ home }), `${id}.json`), text);
  return home;
}

test('the digest of a plan saved by managed-machine is recomputed exactly', () => {
  assert.equal(membersPlanDigest(SAVED.plan), SAVED.plan_digest);
  const read = readMembersPlan({ home: homeWith(), planId: PLAN_ID });
  assert.equal(read.plan_digest, SAVED.plan_digest);
  assert.deepEqual(read.plan, SAVED.plan);
  // The fixture exercises every action and both files.
  assert.deepEqual([...new Set(read.plan.steps.map((s) => s.action))].sort(), ['create', 'none', 'remove', 'repair', 'write']);
});

test('a plan edited after planning is refused', () => {
  const edit = (fn) => { const s = JSON.parse(FIXTURE); fn(s); return JSON.stringify(s); };
  const cases = {
    'another member': edit((s) => { s.plan.members[0] = 'abm-evil'; }),
    'a wider rule': edit((s) => { s.plan.steps.at(-1).content = s.plan.steps.at(-1).content.replace('(ABHQ_MEMBERS)', '(ALL)'); }),
    'an extra field': edit((s) => { s.plan.extra = 1; }),
    'an extra step field': edit((s) => { s.plan.steps[0].run = 'id'; }),
    'a stated digest that is wrong': edit((s) => { s.plan_digest = '0'.repeat(64); }),
    'another plan id': edit((s) => { s.plan_id = 'plan-20261110T040000Z-ffff'; }),
    'text outside plain ASCII': edit((s) => { s.plan.steps[0].detail = 'café'; }),
    'not JSON': '{',
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.throws(() => readMembersPlan({ home: homeWith({ [PLAN_ID]: text }), planId: PLAN_ID }), /members-plan-invalid/, name);
  }
});

test('a plan id is a file name and nothing else; a link is not a plan', { skip: process.platform === 'win32' }, () => {
  const home = homeWith();
  for (const planId of ['../../../etc/passwd', `${PLAN_ID}/..`, '', undefined, 'plan-1']) {
    assert.throws(() => readMembersPlan({ home, planId }), /members-plan-invalid/, String(planId));
  }
  assert.throws(() => readMembersPlan({ home, planId: 'plan-20261110T040000Z-0000' }), /members-plan-missing/);
  const linked = 'plan-20261110T050000Z-0001';
  symlinkSync(path.join(membersPlansDir({ home }), `${PLAN_ID}.json`), path.join(membersPlansDir({ home }), `${linked}.json`));
  assert.throws(() => readMembersPlan({ home, planId: linked }), /members-plan-invalid/);
});

test('the list is newest first and reports a plan that fails its digest', () => {
  const newer = 'plan-20261110T060000Z-0002';
  const home = homeWith({ [PLAN_ID]: FIXTURE, [newer]: FIXTURE.replace('abm-lead', 'abm-evil'), 'notes': '{}' });
  const plans = listMembersPlans({ home });
  assert.deepEqual(plans.map((p) => p.plan_id), [newer, PLAN_ID]);
  assert.match(plans[0].error, /members-plan-invalid/);
  assert.equal(plans[0].plan_digest, undefined);
  assert.equal(plans[1].plan_digest, SAVED.plan_digest);
  assert.equal(plans[1].hq_account, 'agent-bot-hq');
  assert.equal(plans[1].changes, SAVED.plan.steps.filter((s) => !['none', 'write'].includes(s.action)).length);
  assert.deepEqual(listMembersPlans({ home: path.join(home, 'absent') }), []);
});

test('approve-members signs plan_id and plan_digest as agent-machine verifies them', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signer = { publicKeyRaw: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'), sign: (bytes) => edSign(null, bytes, privateKey) };
  const digest = SAVED.plan_digest;
  const req = buildRequest({ verb: 'approve-members', plan_id: PLAN_ID, plan_digest: digest }, signer, { now: 1700000000, nonce: 'n1' });
  assert.deepEqual(Object.keys(req), ['verb', 'plan_id', 'plan_digest', 'timestamp', 'nonce', 'public_key', 'signature']);
  // canonical in protocol.go: the eight fields, timestamp, nonce, then the
  // two lines "plan_digest" and its value.
  const want = ['approve-members', '', '', '', PLAN_ID, '', '', '', '1700000000', 'n1', 'plan_digest', digest].join('\n');
  assert.equal(requestCanonical(req).toString(), want);
  assert.ok(edVerify(null, Buffer.from(want), publicKey, Buffer.from(req.signature, 'base64')));
  // A swapped digest no longer verifies.
  assert.ok(!edVerify(null, requestCanonical({ ...req, plan_digest: 'f'.repeat(64) }), publicKey, Buffer.from(req.signature, 'base64')));
  // A request without the digest signs exactly as before.
  const status = buildRequest({ verb: 'status' }, signer, { now: 1700000000, nonce: 'n2' });
  assert.equal(requestCanonical(status).toString(), ['status', '', '', '', '', '', '', '', '1700000000', 'n2'].join('\n'));

  const bad = [
    { verb: 'approve-members', plan_id: PLAN_ID },
    { verb: 'approve-members', plan_digest: digest },
    { verb: 'approve-members', plan_id: 'p-77', plan_digest: digest },
    { verb: 'approve-members', plan_id: PLAN_ID, plan_digest: digest.toUpperCase() },
    { verb: 'approve-members', plan_id: PLAN_ID, plan_digest: digest, name: 'jq' },
    { verb: 'approve-members', plan_id: PLAN_ID, plan_digest: digest, soul: 'agent_x' },
    { verb: 'approve-members', plan_id: PLAN_ID, plan_digest: digest, harness: 'web-ui' },
    { verb: 'apply', plan_id: PLAN_ID, plan_digest: digest },
    { verb: 'status', plan_digest: digest },
  ];
  for (const fields of bad) assert.throws(() => buildRequest(fields, signer), /machine-field-invalid/, JSON.stringify(fields));
});
