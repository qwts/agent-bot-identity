// Server-mode GitHub notices (replaces gh-app-hook's take_inbox).
//
// The agent-bot server receives each GitHub App's webhooks and keeps a
// lease-based queue per harness. This module talks to it with the device's
// DPoP-bound, signature-checked ServerSession:
//   take    POST /api/daemon/notices/take     lease up to `count` notices, oldest first
//   ack     POST /api/daemon/notices/ack      delete handled notices (lease tokens)
//   release POST /api/daemon/notices/release  hand leased notices back early
//   peek    GET  /api/daemon/notices          look without leasing
// Un-acked notices come back when their lease expires.
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { ServerSession, loadDevice, serverHarness, serverUrl } from './server-client.mjs';

export const NOTICE_TYPES = ['discussion', 'issue', 'pr', 'review', 'comment'];
const FILTER_KEYS = ['type', 'kind', 'repo', 'since'];

function list(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const items = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  return items.length ? items.join(',') : undefined;
}

// Validated request body for take/peek from loose options (CLI or MCP args).
export function noticeQuery(opts = {}) {
  const q = {};
  if (opts.harness) q.harness = serverHarness(opts.harness);
  if (opts.count !== undefined && opts.count !== null && opts.count !== '') {
    const n = Number(opts.count);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('count must be an integer 1..50');
    q.count = n;
  }
  if (opts.lease_seconds !== undefined || opts.leaseSeconds !== undefined) {
    const n = Number(opts.lease_seconds ?? opts.leaseSeconds);
    if (!Number.isInteger(n) || n < 10 || n > 3600) throw new Error('lease_seconds must be an integer 10..3600');
    q.lease_seconds = n;
  }
  for (const k of FILTER_KEYS) {
    const v = k === 'since' ? (opts.since || undefined) : list(opts[k]);
    if (v !== undefined) q[k] = String(v);
  }
  return q;
}

// The server harness for a soul's App: the App slug if the device holds it,
// else the device's only harness.
export function harnessForApp(appSlug, device) {
  const hs = device?.harnesses ?? [];
  const want = serverHarness(appSlug);
  if (want && hs.includes(want)) return want;
  if (hs.length === 1) return hs[0];
  throw Object.assign(new Error(`this device is not enrolled for harness ${want ?? '(none)'}; enrolled: ${hs.join(', ') || 'none'}`), { code: 'notices-no-harness', statusCode: 409 });
}

export function createServerNotices({ env = process.env, fetchImpl = fetch, home } = {}) {
  let session = null;
  const s = () => {
    const base = serverUrl({ env });
    if (!base) throw Object.assign(new Error('server mode is off: set AGENT_BOT_SERVER'), { code: 'notices-not-configured', statusCode: 503 });
    if (!session || session.base !== base) session = new ServerSession({ base, env, home, fetchImpl });
    return session;
  };
  const ids = (v) => {
    const out = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x ?? '').split(',')).map((x) => x.trim()).filter(Boolean);
    if (out.length === 0 || out.length > 100) throw new Error('ids must list 1..100 lease tokens or notice ids');
    return out;
  };
  const api = {
    enabled: () => Boolean(serverUrl({ env })),
    device: () => loadDevice({ env, home }),
    take: async (opts = {}) => s().call('POST', '/api/daemon/notices/take', noticeQuery(opts)),
    peek: async (opts = {}) => {
      const q = new URLSearchParams(Object.entries(noticeQuery(opts)).map(([k, v]) => [k, String(v)]));
      return s().call('GET', `/api/daemon/notices${q.size ? `?${q}` : ''}`);
    },
    ack: async ({ harness, ids: v } = {}) => s().call('POST', '/api/daemon/notices/ack', { ...noticeQuery({ harness }), ids: ids(v) }),
    release: async ({ harness, ids: v } = {}) => s().call('POST', '/api/daemon/notices/release', { ...noticeQuery({ harness }), ids: ids(v) }),
    // take_inbox compatibility: the oldest notice for one repository, acked
    // on return so it is not handed out twice (at-most-once, like the Worker's pull).
    async takeOne({ app, repo }) {
      const harness = harnessForApp(app, api.device());
      const out = await api.take({ harness, repo, count: 1 });
      const n = out?.notices?.[0];
      if (!n) return { event: null };
      await api.ack({ harness, ids: [n.lease] });
      const { lease, lease_expires_at: _exp, ...event } = n;
      return { event: { ...event, pulled: true } };
    },
  };
  return api;
}

// ---- CLI: agent-bot notices take|peek|ack|release ----

export const NOTICES_USAGE = `usage: agent-bot notices take [--count N] [--type T[,T]] [--kind K] [--repo owner/name] [--since TIME] [--lease SECONDS] [--harness H] [--json]
       agent-bot notices peek [same filters] [--json]
       agent-bot notices ack LEASE_OR_ID... [--harness H]
       agent-bot notices release LEASE_OR_ID... [--harness H]

Types: ${NOTICE_TYPES.join(', ')} (plurals ok). Kinds include mention, review_requested,
issues.opened, pull_request.closed. Taken notices are leased (default 300s);
ack the lease tokens when handled, or they come back. Needs AGENT_BOT_SERVER
and an enrolled device (agent-bot server enroll).
`;

export function parseNoticesArgs(argv) {
  const [sub, ...rest] = argv;
  const out = { sub, ids: [], json: false };
  const flags = { '--count': 'count', '--type': 'type', '--kind': 'kind', '--repo': 'repo', '--since': 'since', '--lease': 'lease_seconds', '--harness': 'harness' };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--json') out.json = true;
    else if (flags[a]) {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      const k = flags[a];
      out[k] = ['type', 'kind', 'repo'].includes(k) && out[k] ? `${out[k]},${v}` : v;
    } else if (a.startsWith('--')) throw new Error(`unknown option: ${a}\n${NOTICES_USAGE}`);
    else out.ids.push(a);
  }
  if (!['take', 'peek', 'ack', 'release', undefined, 'help', '--help', '-h'].includes(sub)) throw new Error(`unknown notices command: ${sub}\n${NOTICES_USAGE}`);
  if (['take', 'peek'].includes(sub) && out.ids.length) throw new Error(`unexpected argument: ${out.ids[0]}`);
  return out;
}

function formatNotices(out) {
  const ns = out.notices ?? [];
  if (ns.length === 0) return `no notices${out.remaining || out.visible ? ` (${out.remaining ?? out.visible} more)` : ''}\n`;
  const lines = ns.map((n) => `${n.lease ?? n.id}  ${n.kind}  ${n.repo}#${n.number ?? '-'}  ${n.actor ?? ''}  ${n.title ?? ''}${n.attempts > 1 ? `  (attempt ${n.attempts})` : ''}`);
  const tail = out.remaining !== undefined ? `${out.remaining} more matching; lease ends ${out.next_lease_expiry}` : `${out.visible} visible, ${out.leased} leased`;
  return `${lines.join('\n')}\n${tail}\n`;
}

export async function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, err = process.stderr, fetchImpl = fetch } = {}) {
  try {
    const a = parseNoticesArgs(argv);
    if (!a.sub || ['help', '--help', '-h'].includes(a.sub)) { out.write(NOTICES_USAGE); return 0; }
    const n = createServerNotices({ env, fetchImpl });
    const res = ['ack', 'release'].includes(a.sub) ? await n[a.sub]({ harness: a.harness, ids: a.ids }) : await n[a.sub](a);
    if (a.json) out.write(`${JSON.stringify(res)}\n`);
    else if (a.sub === 'take' || a.sub === 'peek') out.write(formatNotices(res));
    else out.write(`${a.sub === 'ack' ? 'acked' : 'released'}: ${(res.acked ?? res.released ?? []).length}${res.stale?.length ? `, stale: ${res.stale.join(' ')}` : ''}${res.missing?.length ? `, missing: ${res.missing.join(' ')}` : ''}\n`);
    return 0;
  } catch (e) {
    err.write(`agent-bot notices: ${e.message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
