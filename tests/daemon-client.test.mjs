// daemon-client.mjs is the daemon's client contract, apart from the process
// host (#645 step 3). These pin the compatibility shim and the health check
// that replaced available()'s daemonStatus call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as host from '../agent-daemon.mjs';
import { daemonClient, daemonStateFile } from '../daemon-client.mjs';

function stateEnv(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'daemon-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { AGENT_BOT_DAEMON_STATE_PATH: path.join(dir, 'daemon.json') };
}

function writeState(env, state) {
  writeFileSync(daemonStateFile({ env }), JSON.stringify({
    schemaVersion: 1, pid: 4242, host: '127.0.0.1', port: 45123, token: 't'.repeat(32), startedAt: '2026-10-08T00:00:00Z', ...state,
  }));
}

test('agent-daemon.mjs re-exports the client for existing importers', () => {
  assert.equal(host.daemonClient, daemonClient);
  assert.equal(host.daemonStateFile, daemonStateFile);
});

test('available() is false with no state file and never probes', async (t) => {
  const env = stateEnv(t);
  const fetchImpl = async () => assert.fail('no probe without a state file');
  assert.equal(await daemonClient({ env, fetchImpl }).available(), false);
});

test('available() follows the health probe of the recorded daemon', async (t) => {
  const env = stateEnv(t);
  writeState(env);
  const seen = [];
  const answer = (body) => async (url, init) => {
    seen.push([url, init.headers.authorization]);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  assert.equal(await daemonClient({ env, fetchImpl: answer({ status: 'ok', pid: 4242 }) }).available(), true);
  assert.deepEqual(seen[0], ['http://127.0.0.1:45123/v0/health', `Bearer ${'t'.repeat(32)}`]);
  assert.equal(await daemonClient({ env, fetchImpl: answer({ status: 'ok', pid: 1 }) }).available(), false, 'another process answering the port');
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await daemonClient({ env, fetchImpl: down }).available(), false);
});

test('available() is false for a malformed state file', async (t) => {
  const env = stateEnv(t);
  writeState(env, { host: '0.0.0.0' });
  const fetchImpl = async () => assert.fail('a non-loopback state file is never dialed');
  assert.equal(await daemonClient({ env, fetchImpl }).available(), false);
});

test('agent-daemon.mjs re-exports the status, membership and environment helpers it no longer owns (#645 step 3b)', async () => {
  const [status, membership, shellPath] = await Promise.all([
    import('../daemon-status.mjs'), import('../comms-membership.mjs'), import('../shell-path.mjs'),
  ]);
  assert.equal(host.daemonStatus, status.daemonStatus);
  assert.equal(host.joinLaunchedSoul, membership.joinLaunchedSoul);
  assert.equal(host.leaveLaunchedSoul, membership.leaveLaunchedSoul);
  assert.equal(host.soulEnvironment, shellPath.soulEnvironment);
  assert.equal(host.userToolDirs, shellPath.userToolDirs);
});

test('decideApproval sends a signed statement and surfaces a route challenge (#753)', async (t) => {
  const env = stateEnv(t);
  writeState(env);
  const challenges = [{ name: 'laptop', fingerprint: 'SHA256:abc', payload: { kind: 'challenge' } }];
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ error: 'owner presence is unavailable', code: 'owner-challenge-required', challenges }), { status: 409 });
  };
  const client = daemonClient({ env, fetchImpl });
  await assert.rejects(client.decideApproval({ proposalId: 'p1', decision: 'approve', digest: 'a'.repeat(64) }),
    (error) => error.code === 'owner-challenge-required' && JSON.stringify(error.challenges) === JSON.stringify(challenges));
  assert.equal('statement' in sent[0], false);
  await assert.rejects(client.decideApproval({ proposalId: 'p1', decision: 'approve', digest: 'a'.repeat(64), statement: 's1.a.b' }));
  assert.equal(sent[1].statement, 's1.a.b');
});
