// identity-entry.mjs is identity's record entry, run as a child process
// through identityOp (#645, F6). These pin the wire shape, the error codes
// and that the child gives the same answers as the in-process functions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { identityOp } from '../daemon-client.mjs';
import { runIdentityOp } from '../identity-entry.mjs';
import { readAgentIdentity } from '../agent-identity.mjs';
import { bindTokenPath } from '../agent-binding.mjs';

const NOW = '2026-10-11T12:00:00.000Z';

// A child environment that names its own state root and home, and carries
// none of the caller's Agent ID or transcript variables.
function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'identity-entry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENT_BOT_|QWTS_AGENT_|CODEX_THREAD_ID$|CLAUDE_SESSION_ID$|CURSOR_CONVERSATION_ID$|XDG_STATE_HOME$)/.test(key)));
  const stateDir = path.join(dir, 'state');
  return { dir, stateDir, env: { ...env, HOME: dir, USERPROFILE: dir, AGENT_BOT_STATE_HOME: stateDir } };
}

const agentId = () => `agent_${randomUUID()}`;

test('mint and read round-trip through the child', (t) => {
  const { env, stateDir } = sandbox(t);
  const id = agentId();
  const minted = identityOp('mint', { appSlug: null, useGithub: false, harness: 'claude', id, now: NOW, stateDir }, { env });
  assert.equal(minted.id, id);
  assert.equal(minted.createdAt, NOW);
  assert.deepEqual(identityOp('read', { id, stateDir }, { env }), readAgentIdentity(id, { stateDir }));
});

test('the child and the in-process run give the same record', (t) => {
  const { env, stateDir } = sandbox(t);
  const id = agentId();
  identityOp('mint', { appSlug: null, useGithub: false, id, now: NOW, stateDir }, { env });
  assert.deepEqual(identityOp('read', { id, stateDir }, { env }), runIdentityOp('read', { id, stateDir }));
});

test('the child resolves the state root from the caller environment', (t) => {
  const { env, stateDir } = sandbox(t);
  const id = agentId();
  identityOp('mint', { appSlug: null, useGithub: false, id, now: NOW }, { env });
  assert.ok(existsSync(path.join(stateDir, `${id}.json`)));
  assert.equal(identityOp('read', { id }, { env }).id, id);
});

test('read-many reports each record or its error in place', (t) => {
  const { env, stateDir } = sandbox(t);
  const id = agentId();
  const missing = agentId();
  identityOp('mint', { appSlug: null, useGithub: false, id, now: NOW, stateDir }, { env });
  const [found, absent] = identityOp('read-many', { ids: [id, missing], stateDir }, { env });
  assert.equal(found.id, id);
  assert.equal(found.record.id, id);
  assert.equal(absent.id, missing);
  assert.equal(absent.record, undefined);
  assert.equal(absent.error.code, 'operation-failed');
  assert.match(absent.error.message, /could not read Agent ID/);
});

test('current and discover-transcript read the caller environment', (t) => {
  const { env, dir } = sandbox(t);
  const id = agentId();
  assert.equal(identityOp('current', {}, { env: { ...env, AGENT_BOT_ID: id }, cwd: dir }), id);
  assert.equal(identityOp('discover-transcript', {}, { env }), null);
  assert.deepEqual(identityOp('discover-transcript', {}, { env: { ...env, CLAUDE_SESSION_ID: 's-1' } }),
    { provider: 'claude', id: 's-1' });
});

test('ensure reuses the identity bound to the same transcript', (t) => {
  const { env, stateDir } = sandbox(t);
  const transcript = { provider: 'claude', id: 's-2' };
  const first = identityOp('ensure', { appSlug: null, useGithub: false, transcript, fields: {}, now: NOW, stateDir }, { env });
  const again = identityOp('ensure', { currentId: first.id, appSlug: null, useGithub: false, transcript, fields: {}, stateDir }, { env });
  assert.equal(again.id, first.id);
});

test('ensure with fieldsFromEnv reads the caller environment, and fields override it', (t) => {
  const { env, stateDir } = sandbox(t);
  const input = { appSlug: null, useGithub: false, transcript: null, fieldsFromEnv: true, stateDir };
  const callerEnv = { ...env, AGENT_BOT_TEAM: 'env-team', AGENT_BOT_SQUAD: 'env-squad' };
  const record = identityOp('ensure', { ...input, fields: { squad: 'flag-squad' } }, { env: callerEnv });
  assert.equal(record.team, 'env-team');
  assert.equal(record.squad, 'flag-squad');
  assert.equal(record.type, 'agent');
  assert.throws(() => identityOp('ensure', { ...input, fieldsFromEnv: 'yes' }, { env }), { code: 'invalid-input' });
  assert.throws(() => identityOp('ensure', input, { env: { ...env, AGENT_BOT_PARENT_ID: 'not-an-id' } }), { code: 'operation-failed' });
});

test('bind-transcript and record-evidence match the in-process run', (t) => {
  const { env, stateDir } = sandbox(t);
  const [viaChild, inProcess] = [agentId(), agentId()];
  for (const id of [viaChild, inProcess]) identityOp('mint', { appSlug: null, useGithub: false, id, now: NOW, stateDir }, { env });
  const transcript = { provider: 'custom', id: 't-1', sha256: null };
  const strip = ({ id, updatedAt, ...rest }) => rest;
  const bound = identityOp('bind-transcript', { id: viaChild, transcript, now: NOW, stateDir }, { env });
  assert.deepEqual(bound.transcript, { provider: 'custom', id: 't-1', sha256: null });
  assert.deepEqual(strip(bound), strip(runIdentityOp('bind-transcript', { id: inProcess, transcript, now: NOW, stateDir })));
  const evidence = { subjects: ['qwts/agent-bot-identity#1'], artifacts: ['commit:abc'], now: NOW, stateDir };
  const recorded = identityOp('record-evidence', { id: viaChild, ...evidence }, { env });
  assert.deepEqual(recorded.subjects, ['qwts/agent-bot-identity#1']);
  assert.deepEqual(recorded.artifacts, ['commit:abc']);
  assert.deepEqual(strip(recorded), strip(runIdentityOp('record-evidence', { id: inProcess, ...evidence })));
  assert.throws(() => identityOp('bind-transcript', { id: viaChild, transcript: { provider: 'custom', id: 't-2' }, stateDir }, { env }),
    { code: 'operation-failed' });
  assert.throws(() => identityOp('record-evidence', { id: viaChild, extra: 1, stateDir }, { env }), { code: 'invalid-input' });
});

test('mint-bind-token writes the bind token for the worktree', (t) => {
  const { env, dir } = sandbox(t);
  const gitDir = path.join(dir, 'git');
  mkdirSync(gitDir);
  const id = agentId();
  const record = identityOp('mint-bind-token', { gitDir, worktree: dir, agentId: id, now: NOW }, { env });
  assert.equal(record.agentId, id);
  assert.equal(record.mintedAt, NOW);
  assert.match(record.token, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(statSync(bindTokenPath(gitDir)).mode & 0o777, 0o600);
});

test('failures carry the entry error code and message', (t) => {
  const { env, stateDir } = sandbox(t);
  assert.throws(() => identityOp('nope', {}, { env }), { code: 'unknown-op', message: /unknown identity operation/ });
  assert.throws(() => identityOp('read', { id: agentId(), extra: 1 }, { env }), { code: 'invalid-input', message: /unexpected input: extra/ });
  assert.throws(() => identityOp('read', { id: agentId(), stateDir: 'relative' }, { env }), { code: 'invalid-input' });
  assert.throws(() => identityOp('mint', { appSlug: null, useGithub: false, now: 'not a date', stateDir }, { env }), { code: 'invalid-input' });
  assert.throws(() => identityOp('mint', { appSlug: null, useGithub: false, now: '2026-10-11', stateDir }, { env }), { code: 'invalid-input' });
  assert.throws(() => identityOp('mint', { appSlug: null, useGithub: false, id: agentId(), packageRevision: 'a'.repeat(64), stateDir }, { env }),
    { code: 'invalid-input', message: /cannot both be given/ });
  assert.throws(() => identityOp('read', { id: agentId(), stateDir }, { env }), { code: 'operation-failed', message: /could not read Agent ID/ });
  assert.throws(() => identityOp('mint-bind-token', { gitDir: stateDir, worktree: 'relative', agentId: agentId() }, { env }),
    { code: 'operation-failed', statusCode: 400 });
});

test('an empty stdin is invalid input, not an empty request', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../identity-entry.mjs', import.meta.url)), 'current'], { input: '', encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout).error.code, 'invalid-input');
});

test('a child that writes no result is a plain failure', () => {
  const execFile = () => { throw Object.assign(new Error('killed'), { stdout: '', stderr: 'boom\n' }); };
  assert.throws(() => identityOp('read', {}, { execFile }), { code: 'operation-failed', message: 'identity read failed: boom' });
  assert.throws(() => identityOp('read', {}, { execFile: () => '{}' }), { code: 'operation-failed', message: /no result/ });
});

test('current with pinOnly ignores the Agent ID variables and reads the pin', (t) => {
  const { env, dir } = sandbox(t);
  const id = agentId();
  assert.equal(identityOp('current', { pinOnly: true }, { env: { ...env, AGENT_BOT_ID: id }, cwd: dir }), null);
  assert.throws(() => identityOp('current', { pinOnly: 'yes' }, { env }), { code: 'invalid-input' });
});

test('a git failure keeps its exit status', (t) => {
  const { env, dir } = sandbox(t);
  // A .git file naming a missing directory makes git exit 128.
  const broken = path.join(dir, 'broken');
  mkdirSync(broken);
  writeFileSync(path.join(broken, '.git'), `gitdir: ${path.join(dir, 'missing')}\n`);
  assert.throws(() => identityOp('current', {}, { env, cwd: broken }),
    (error) => error.code === 'operation-failed' && error.status === 128);
});
