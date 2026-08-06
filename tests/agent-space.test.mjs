import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  initAgentSpace,
  inspectAgentSpace,
  showAgentSpace,
  spacePath,
  spacesHome,
} from '../agent-space.mjs';

const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const roots = [];

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-space-'));
  roots.push(root);
  return root;
}

function cleanAgentEnv(extra = {}) {
  const env = { ...process.env };
  delete env.AGENT_BOT_ID;
  delete env.QWTS_AGENT_ID;
  return { ...env, ...extra };
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: cleanAgentEnv(env),
  });
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('space root follows override, XDG data, then the home default', () => {
  assert.equal(
    spacesHome({ env: { AGENT_BOT_SPACES_HOME: '/override', XDG_DATA_HOME: '/xdg' }, home: '/home/u' }),
    '/override',
  );
  assert.equal(
    spacesHome({ env: { XDG_DATA_HOME: '/xdg' }, home: '/home/u' }),
    path.join('/xdg', 'agent-bot', 'spaces'),
  );
  assert.equal(
    spacesHome({ env: {}, home: '/home/u' }),
    path.join('/home/u', '.local', 'share', 'agent-bot', 'spaces'),
  );
  assert.equal(
    spacePath(ID, { env: { AGENT_BOT_SPACES_HOME: '/override' } }),
    path.join('/override', ID),
  );
  assert.throws(() => spacePath('not-an-agent-id'), /invalid Agent ID/);
});

test('init atomically creates a private, secret-free marker and is idempotent', () => {
  const root = scratch();
  const env = { AGENT_BOT_SPACES_HOME: root };
  const first = initAgentSpace(ID, {
    env,
    now: () => new Date('2026-08-06T00:00:00.000Z'),
  });
  assert.equal(first.created, true);
  assert.equal(first.path, path.join(root, ID));
  assert.deepEqual(first.marker, {
    schemaVersion: 1,
    agentId: ID,
    createdAt: '2026-08-06T00:00:00.000Z',
  });
  assert.deepEqual(readdirSync(first.path), ['space.json']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(first.path, 'space.json'), 'utf8')), first.marker);
  if (process.platform !== 'win32') {
    assert.equal(statSync(first.path).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(first.path, 'space.json')).mode & 0o777, 0o600);
  }

  const second = initAgentSpace(ID, {
    env,
    now: () => new Date('2099-01-01T00:00:00.000Z'),
  });
  assert.equal(second.created, false);
  assert.deepEqual(second.marker, first.marker);
  assert.deepEqual(showAgentSpace(ID, { env }), {
    id: ID,
    path: first.path,
    marker: first.marker,
  });
});

test('init refuses unmarked, malformed, and differently bound spaces', () => {
  const unmarkedRoot = scratch();
  const unmarkedEnv = { AGENT_BOT_SPACES_HOME: unmarkedRoot };
  mkdirSync(path.join(unmarkedRoot, ID), { recursive: true });
  assert.throws(() => initAgentSpace(ID, { env: unmarkedEnv }), /without space\.json/);

  const malformedRoot = scratch();
  const malformedEnv = { AGENT_BOT_SPACES_HOME: malformedRoot };
  mkdirSync(path.join(malformedRoot, ID), { recursive: true });
  writeFileSync(path.join(malformedRoot, ID, 'space.json'), 'not json\n');
  assert.throws(() => initAgentSpace(ID, { env: malformedEnv }));

  const mismatchRoot = scratch();
  const mismatchEnv = { AGENT_BOT_SPACES_HOME: mismatchRoot };
  mkdirSync(path.join(mismatchRoot, ID), { recursive: true });
  writeFileSync(path.join(mismatchRoot, ID, 'space.json'), `${JSON.stringify({
    schemaVersion: 1,
    agentId: OTHER_ID,
    createdAt: '2026-08-06T00:00:00.000Z',
  })}\n`);
  assert.throws(() => initAgentSpace(ID, { env: mismatchEnv }), /bound to agent_22222222/);
});

test('inspect is read-only and distinguishes present, missing, mismatch, and invalid', () => {
  const root = scratch();
  const env = { AGENT_BOT_SPACES_HOME: root };
  assert.deepEqual(inspectAgentSpace(ID, { env }), {
    status: 'missing',
    id: ID,
    path: path.join(root, ID),
    directoryPresent: false,
  });
  assert.equal(existsSync(path.join(root, ID)), false, 'inspection must not create the space');

  initAgentSpace(ID, { env, now: () => new Date('2026-08-06T00:00:00.000Z') });
  assert.deepEqual(inspectAgentSpace(ID, { env }), {
    status: 'ok',
    id: ID,
    path: path.join(root, ID),
  });

  writeFileSync(path.join(root, ID, 'space.json'), `${JSON.stringify({
    schemaVersion: 1,
    agentId: OTHER_ID,
    createdAt: '2026-08-06T00:00:00.000Z',
  })}\n`);
  assert.deepEqual(inspectAgentSpace(ID, { env }), {
    status: 'mismatch',
    id: ID,
    path: path.join(root, ID),
    boundTo: OTHER_ID,
  });

  writeFileSync(path.join(root, ID, 'space.json'), 'not json: secret-sentinel\n');
  assert.deepEqual(inspectAgentSpace(ID, { env }), {
    status: 'invalid',
    id: ID,
    path: path.join(root, ID),
  });
});

test('space CLI exposes init, path, and show without ensure', () => {
  const root = scratch();
  const env = { AGENT_BOT_SPACES_HOME: root, AGENT_BOT_ID: ID };
  const pathResult = runCli(['space', 'path'], env);
  assert.equal(pathResult.status, 0, pathResult.stderr);
  assert.equal(pathResult.stdout.trim(), path.join(root, ID));
  assert.equal(existsSync(path.join(root, ID)), false, 'path is calculation-only');

  const init = runCli(['space', 'init', '--json'], env);
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(init.stdout), {
    agentId: ID,
    path: path.join(root, ID),
    created: true,
    schemaVersion: 1,
    createdAt: JSON.parse(init.stdout).createdAt,
  });

  const markerPath = path.join(root, ID, 'space.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  writeFileSync(markerPath, `${JSON.stringify({ ...marker, secret: 'must-not-print' })}\n`);
  const show = runCli(['space', 'show', ID], env);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).agentId, ID);
  assert.doesNotMatch(show.stdout, /must-not-print/);

  writeFileSync(markerPath, 'not-json must-not-print\n');
  const malformed = runCli(['space', 'show', ID], env);
  assert.notEqual(malformed.status, 0);
  assert.doesNotMatch(malformed.stderr, /must-not-print/);

  const ensure = runCli(['space', 'ensure', ID], env);
  assert.notEqual(ensure.status, 0);
  assert.match(ensure.stderr, /usage: agent-bot space <init\|path\|show>/);
});

test('space CLI fails closed without an explicit or current Agent ID', () => {
  const root = scratch();
  const globalConfig = path.join(root, 'global.gitconfig');
  writeFileSync(globalConfig, '');
  const run = spawnSync(process.execPath, [CLI, 'space', 'path'], {
    cwd: root,
    encoding: 'utf8',
    env: cleanAgentEnv({
      AGENT_BOT_SPACES_HOME: path.join(root, 'spaces'),
      GIT_CONFIG_GLOBAL: globalConfig,
    }),
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /no Agent ID/);
});
