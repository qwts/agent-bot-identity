// End-to-end runner for the identity service (#1206): a throwaway device
// exercises the same ServerSession/mint/reconcile code the daemon uses, and
// every scenario reports PASS|FAIL|SKIP. It works against a mocked-GitHub
// service (later) and production `https://agents.true-line.ai`.
//
// Nothing secret is ever printed: details carry ids, statuses and counts —
// never a token, key or the enrollment token.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createPublicKey, randomBytes, verify as jwsVerify } from 'node:crypto';
import {
  ServerSession, enroll, mintViaServer, newOperationId,
} from '../identity/server-client.mjs';
import { readAction } from '../identity/action-ledger.mjs';

const SCENARIOS = [
  'enroll', 'mint-readback', 'replay-same-op', 'conflict-new-params', 'provider-key',
  'legacy-route-disabled', 'soul-token', 'github-5xx', 'outage', 'revoke',
];
const DEVICE_SCENARIOS = new Set(SCENARIOS.filter((name) => name !== 'github-5xx'));

const freshId = () => `e2e-${randomBytes(4).toString('hex')}`;

function outcome(pass, detail, extra = {}) {
  return { result: pass === null ? 'skipped' : pass ? 'passed' : 'failed', detail, ...extra };
}

/**
 * Runs the scenarios; `emit({scenario, result, detail, issuance_id?, operation_id?})`
 * receives each outcome. Returns { results, failed } — no exit codes, the CLI owns those.
 */
export async function run({
  base, env: outerEnv = process.env, harness = null, repo = null,
  only = null, includeRevoke = false,
  enrollToken = outerEnv.AGENT_BOT_E2E_ENROLL_TOKEN ?? null,
  requireDevice = false, keepState = false, stateDir = null,
  fetchImpl = fetch, emit = () => {},
} = {}) {
  const own = stateDir === null;
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), 'agent-bot-e2e-'));
  const env = {
    AGENT_BOT_SERVER_STATE: dir,
    AGENT_BOT_INTERACTION_HOME: path.join(dir, 'interaction'),
    AGENT_BOT_CONFIG: path.join(dir, 'none.json'),
    HOME: dir,
    AGENT_BOT_SERVER: base,
  };
  const home = dir;
  const record = (scenario, out) => { const row = { scenario, ...out }; emit(row); return row; };
  const results = [];
  try {
    if (!enrollToken && requireDevice) return { results: [record('enroll', outcome(false, 'no enrollment token and --require was passed'))], failed: 1, noToken: true };

    const picked = (name) => !only || only.includes(name);
    const device = { enrolled: false, session: null };
    const ctx = { taskId: null, operationId: null, issuanceId: null };

    const steps = {
      async enroll() {
        await enroll({ base, env, home, harnesses: harness ? [harness] : ['e2e'], enrollToken, fetchImpl, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
        device.enrolled = true;
        device.session = new ServerSession({ base, env, home, fetchImpl });
        const who = await device.session.call('GET', '/api/daemon/whoami');
        return outcome(Boolean(who?.device?.id), who?.device?.id ? `device ${who.device.id}` : 'whoami carried no device');
      },
      async 'mint-readback'() {
        if (!harness || !repo) return outcome(null, 'needs --harness and --repo');
        ctx.taskId = `e2e-task-${randomBytes(4).toString('hex')}`;
        ctx.operationId = newOperationId();
        const minted = await mintViaServer({ base, harness, repo, env, home, fetchImpl, taskId: ctx.taskId, operationId: ctx.operationId, session: device.session });
        if (typeof minted?.token !== 'string' || !minted.token) return outcome(false, 'the mint carried no token');
        ctx.issuanceId = minted.issuance_id;
        const lookup = await device.session.issuance(ctx.operationId);
        return outcome(lookup?.state === 'issued' && lookup.issuance_id === minted.issuance_id,
          lookup?.state === 'issued' ? 'issued, hasToken' : `lookup answered ${lookup?.state ?? 'nothing'}`,
          { issuance_id: minted.issuance_id, operation_id: ctx.operationId });
      },
      async 'replay-same-op'() {
        if (!ctx.operationId) return outcome(null, 'mint-readback did not issue');
        // The local ledger rightly refuses to re-mint a succeeded operation;
        // the service's replay contract is what this checks, directly.
        const again = await device.session.call('POST', '/api/daemon/credentials', {
          harness, repo, task_id: ctx.taskId, operation_id: ctx.operationId,
        });
        return outcome(again.issuance_id === ctx.issuanceId && again.replayed === true,
          again.issuance_id === ctx.issuanceId ? `replayed ${again.issuance_id}` : `a different issuance ${again.issuance_id ?? 'none'}`,
          { issuance_id: again.issuance_id, operation_id: ctx.operationId });
      },
      async 'conflict-new-params'() {
        const prior = ctx.operationId ? { operation_id: ctx.operationId } : results.find((r) => r.scenario === 'mint-readback' && r.result === 'passed');
        if (!prior) return outcome(null, 'mint-readback did not issue');
        try {
          await mintViaServer({ base, harness, repo: `${repo}-other`, env, home, fetchImpl, taskId: ctx.taskId, operationId: ctx.operationId, session: device.session });
          return outcome(false, 'a changed repo replayed instead of conflicting');
        } catch (error) {
          return outcome(error?.code === 'operation-conflict', `answered ${error?.code ?? error.message}`);
        }
      },
      async 'provider-key'() {
        try {
          const out = await device.session.call('GET', `/api/daemon/provider-key?provider=openai&operation_id=${encodeURIComponent(newOperationId())}&profile=e2e`);
          return outcome(true, `held key, key_id ${out.key_id ?? 'none reported'}`);
        } catch (error) {
          return outcome(/provider_key_not_configured|provider-key-not-configured/.test(error?.message ?? error?.code ?? ''),
            `answered ${error?.code ?? 'error'}${/provider_key_not_configured/.test(error?.message ?? '') ? ' (provider_key_not_configured)' : `: ${String(error?.message ?? '').slice(0, 60)}`}`);
        }
      },
      async 'legacy-route-disabled'() {
        try {
          await device.session.call('POST', '/api/daemon/installation-token', {});
          return outcome(false, 'the route still answers requests');
        } catch (error) {
          return outcome(/legacy_route_disabled/.test(error?.message ?? ''), `answered ${error?.code ?? error.message}`);
        }
      },
      async 'soul-token'() {
        try {
          const operationId = newOperationId();
          const out = await device.session.soulToken({
            agentId: freshId(), parent: null, account: 'e2e', taskId: 'e2e-soul', operationId,
          });
          // Verify the JWS against the service's published JWKS.
          const res = await fetchImpl(`${base}/.well-known/agent-bot/soul-keys.json`, { redirect: 'error' });
          const jwks = res?.ok ? await res.json() : null;
          const [h, p, s] = out.token.split('.');
          const kid = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')).kid;
          const jwk = jwks?.keys?.find((k) => k.kid === kid);
          const key = jwk ? createPublicKey({ key: jwk, format: 'jwk' }) : null;
          const good = key ? jwsVerify('sha256', Buffer.from(`${h}.${p}`, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')) : false;
          return outcome(good, good ? `validated; jwks kid ${kid}` : 'the JWS did not verify against the published keys',
            { issuance_id: out.issuance_id, operation_id: operationId });
        } catch (error) {
          if (error?.code === 'credential-unavailable') return outcome(null, `the signing key is unavailable (${error?.code})`);
          throw error;
        }
      },
      'github-5xx': async () => outcome(null, 'needs mocked GitHub'),
      async outage() {
        // The enrolled device and base stay put; the outage is a fetch that
        // refuses every request — the same ECONNREFUSED ServerSession maps to
        // credential-unavailable.
        const operationId = newOperationId();
        const deadFetch = async () => {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        };
        const dead = new ServerSession({ base, env, home, fetchImpl: deadFetch });
        try {
          await mintViaServer({ base, harness: harness ?? 'e2e', repo: repo ?? 'e2e/x', env, home, fetchImpl: deadFetch, taskId: 'e2e-outage', operationId, session: dead });
          return outcome(false, 'an outage mint issued something');
        } catch (error) {
          const action = readAction(dir, operationId);
          let lookup = 'unreadable';
          try { lookup = (await device.session.issuance(operationId))?.state ?? 'none'; } catch { /* lookup itself is best-effort */ }
          return outcome(error?.code === 'credential-unavailable' && action?.state !== 'issued' && lookup !== 'issued',
            `answered ${error?.code ?? 'uncoded'} (ledger ${action?.state ?? 'none'}, lookup ${lookup})`);
        }
      },
      async revoke() {
        if (!includeRevoke) return outcome(null, 'needs --include-revoke');
        await device.session.call('DELETE', '/api/daemon/device');
        try {
          await device.session.call('GET', '/api/daemon/whoami');
          return outcome(false, 'the revoked device still answered');
        } catch (error) {
          return outcome(error?.code === 'device-revoked', `answered ${error?.code ?? error.message}`);
        }
      },
    };

    for (const name of SCENARIOS) {
      if (!picked(name)) continue;
      if ((DEVICE_SCENARIOS.has(name) && !device.enrolled && name !== 'enroll')
        || (name === 'enroll' && !enrollToken)) {
        results.push(record(name, outcome(null, enrollToken ? 'enroll did not run' : 'no enrollment token (AGENT_BOT_E2E_ENROLL_TOKEN)')));
        continue;
      }
      try {
        results.push(record(name, await steps[name]()));
      } catch (error) {
        results.push(record(name, outcome(false, String(error?.message ?? error).slice(0, 120))));
      }
    }
    return { results, failed: results.filter((r) => r.result === 'failed').length, noToken: !enrollToken };
  } finally {
    if (own && !keepState) rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const opts = { only: null, includeRevoke: false, requireDevice: false, keepState: false, json: false, harness: null, repo: null, stateDir: null };
  const args = [...argv];
  const take = () => args.shift();
  while (args.length) {
    const arg = take();
    if (arg === '--base') opts.base = take();
    else if (arg === '--state') opts.stateDir = take();
    else if (arg === '--harness') opts.harness = take();
    else if (arg === '--repo') opts.repo = take();
    else if (arg === '--only') opts.only = take().split(',').map((s) => s.trim());
    else if (arg === '--include-revoke') opts.includeRevoke = true;
    else if (arg === '--require') opts.requireDevice = true;
    else if (arg === '--keep-state') opts.keepState = true;
    else if (arg === '--json') opts.json = true;
    else throw new Error(`unknown option: ${arg}\nusage: node scripts/e2e-server.mjs --base <https url> [--state dir] [--harness slug] [--repo owner/name] [--only a,b] [--include-revoke] [--require] [--keep-state] [--json]`);
  }
  if (!opts.base) throw new Error('--base is required');
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const rows = [];
    const { failed, noToken } = await run({
      ...opts,
      emit: (row) => {
        rows.push(row);
        if (!opts.json) process.stdout.write(`${row.result === 'passed' ? 'PASS' : row.result === 'failed' ? 'FAIL' : 'SKIP'} ${row.scenario} ${row.detail}\n`);
      },
    });
    if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    if (noToken && !opts.json && !opts.requireDevice) process.stdout.write('scenarios needing a device were skipped (AGENT_BOT_E2E_ENROLL_TOKEN not set)\n');
    if (noToken && opts.requireDevice) process.exit(2);
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    process.stderr.write(`e2e-server: ${error.message}\n`);
    process.exit(2);
  }
}
