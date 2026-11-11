// Member accounts plans (#1401): the saved output of `managed-machine members
// plan` (agent-bot-machine docs/plans/member-accounts.md). The web UI shows
// one as a proposal; the owner's approval sends agent-machine the signed
// approve-members request carrying the plan id and digest.
//
// The plan file is data from disk and is trusted for nothing. The digest is
// recomputed here over the same bytes managed-machine digests (Plan.Canonical
// in internal/members/plan.go: the plan as JSON, fields in declaration order,
// no HTML escaping, one trailing newline), and a file whose content does not
// match its stated digest is refused. What the owner is shown is therefore
// exactly what the digest covers.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const MEMBERS_PLAN_ID = /^plan-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/;
export const MEMBERS_PLAN_DIGEST = /^[0-9a-f]{64}$/;
const MAX_PLAN_BYTES = 256 * 1024;
const STEP_FIELDS = ['kind', 'target', 'action', 'owner', 'group', 'mode', 'content', 'detail'];
const STEP_REQUIRED = ['kind', 'target', 'action'];
// Printable ASCII, tab and newline: for these Go's JSON encoder and
// JSON.stringify write the same bytes. Anything else is refused rather than
// risk a digest that differs for an encoding reason.
const PLAIN = /^[\x20-\x7e\t\n]*$/;

function refuse(message) {
  return Object.assign(new Error(`${message} [members-plan-invalid]`), { code: 'members-plan-invalid' });
}

// Where managed-machine saves a plan when no state directory is configured:
// its state directory, which is in Application Support on macOS.
// `members apply` reads the same fixed place under sudo, so a plan saved
// anywhere else could be approved here but never applied.
export function membersPlansDir({ home = homedir(), platform = process.platform } = {}) {
  const state = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'managed-machine')
    : path.join(home, '.local', 'share', 'managed-machine');
  return path.join(state, 'members', 'plans');
}

function plain(value, what) {
  if (typeof value !== 'string' || !PLAIN.test(value)) throw refuse(`${what} is not plain text`);
  return value;
}

// The plan rebuilt field by field in managed-machine's declaration order,
// with its omitempty rule: an optional step field that is empty is absent.
function canonicalPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw refuse('the plan is not an object');
  for (const key of Object.keys(plan)) {
    if (!['version', 'hq_account', 'dir', 'members', 'steps'].includes(key)) throw refuse(`the plan has an unknown field ${key}`);
  }
  if (!Number.isInteger(plan.version) || plan.version < 1) throw refuse('the plan version is not a positive integer');
  if (!Array.isArray(plan.members) || !Array.isArray(plan.steps)) throw refuse('the plan has no members or steps list');
  return {
    version: plan.version,
    hq_account: plain(plan.hq_account, 'hq_account'),
    dir: plain(plan.dir, 'dir'),
    members: plan.members.map((m) => plain(m, 'a member account')),
    steps: plan.steps.map((step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw refuse('a step is not an object');
      for (const key of Object.keys(step)) if (!STEP_FIELDS.includes(key)) throw refuse(`a step has an unknown field ${key}`);
      const out = {};
      for (const field of STEP_FIELDS) {
        const value = step[field];
        if (value === undefined || value === '') {
          if (STEP_REQUIRED.includes(field)) throw refuse(`a step has no ${field}`);
          continue;
        }
        out[field] = plain(value, `step ${field}`);
      }
      return out;
    }),
  };
}

export function membersPlanDigest(plan) {
  return createHash('sha256').update(`${JSON.stringify(canonicalPlan(plan))}\n`, 'utf8').digest('hex');
}

// Read one saved plan. Returns the canonical plan and its verified digest.
export function readMembersPlan({ home = homedir(), planId } = {}) {
  if (typeof planId !== 'string' || !MEMBERS_PLAN_ID.test(planId)) throw refuse('plan_id is not a plan id');
  const file = path.join(membersPlansDir({ home }), `${planId}.json`);
  let stat;
  try { stat = lstatSync(file); } catch { throw Object.assign(new Error(`no saved plan ${planId}; run managed-machine members plan first [members-plan-missing]`), { code: 'members-plan-missing' }); }
  if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) throw refuse('the saved plan is not a regular file of a sane size');
  let saved;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { throw refuse('the saved plan is not JSON'); }
  if (!saved || typeof saved !== 'object' || saved.plan_id !== planId) throw refuse('the saved plan names another plan id');
  if (typeof saved.plan_digest !== 'string' || !MEMBERS_PLAN_DIGEST.test(saved.plan_digest)) throw refuse('the saved plan has no digest');
  const plan = canonicalPlan(saved.plan);
  const digest = membersPlanDigest(plan);
  if (digest !== saved.plan_digest) throw refuse('the saved plan does not match its digest; plan again');
  return {
    plan_id: planId,
    plan_digest: digest,
    created_at: typeof saved.created_at === 'string' && PLAIN.test(saved.created_at) ? saved.created_at.slice(0, 32) : null,
    plan,
  };
}

// The newest saved plans, newest first. A file that cannot be verified is
// listed with its error and no content, so the owner sees why it is absent.
export function listMembersPlans({ home = homedir(), limit = 10 } = {}) {
  let names;
  try { names = readdirSync(membersPlansDir({ home })); } catch { return []; }
  const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => MEMBERS_PLAN_ID.test(id));
  ids.sort().reverse();
  return ids.slice(0, limit).map((planId) => {
    try {
      const { plan_digest, created_at, plan } = readMembersPlan({ home, planId });
      return {
        plan_id: planId, plan_digest, created_at, hq_account: plan.hq_account, dir: plan.dir, members: plan.members,
        changes: plan.steps.filter((s) => s.action !== 'none' && s.action !== 'write').length,
      };
    } catch (error) {
      return { plan_id: planId, error: error?.message ?? 'unreadable' };
    }
  });
}
