import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { initAgentSpace } from '../agent-space.mjs';

const DOCTOR = fileURLToPath(new URL('../doctor.mjs', import.meta.url));
const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const SECRET = 'doctor-must-not-print-this-secret';
const roots = [];

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-doctor-space-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  const home = path.join(root, 'home');
  const spaces = path.join(root, 'spaces');
  const globalConfig = path.join(root, 'global.gitconfig');
  mkdirSync(repo);
  mkdirSync(home);
  writeFileSync(globalConfig, '');
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'core.hooksPath', '/dev/null');
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'initial');
  git(repo, 'worktree', 'add', '--quiet', '--detach', worktree);
  git(worktree, 'config', '--worktree', 'user.name', 'test-agent[bot]');
  git(worktree, 'config', '--worktree', 'agentBot.agentId', ID);
  return { root, repo, worktree, home, spaces, globalConfig };
}

function doctor(cwd, fx, args = []) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AGENT_BOT|QWTS_AGENT|GH_AGENT_APP)/.test(key)) delete env[key];
  }
  return spawnSync(process.execPath, [DOCTOR, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...env,
      HOME: fx.home,
      ZDOTDIR: fx.home,
      GIT_CONFIG_GLOBAL: fx.globalConfig,
      AGENT_BOT_CONFIG: path.join(fx.root, 'missing-config.json'),
      AGENT_BOT_SPACES_HOME: fx.spaces,
    },
  });
}

function markerPath(fx) {
  return path.join(fx.spaces, ID, 'space.json');
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('doctor reports the pinned Agent ID and a valid Agent Space path without marker contents', () => {
  const fx = fixture();
  initAgentSpace(ID, {
    env: { AGENT_BOT_SPACES_HOME: fx.spaces },
    now: () => new Date('2026-08-06T00:00:00.000Z'),
  });
  const marker = JSON.parse(readFileSync(markerPath(fx), 'utf8'));
  writeFileSync(markerPath(fx), `${JSON.stringify({ ...marker, secret: SECRET })}\n`);

  const run = doctor(fx.worktree, fx);
  assert.match(run.stdout, new RegExp(`ok    Agent ID ${ID}`));
  assert.match(run.stdout, new RegExp(`ok    Agent Space ${path.join(fx.spaces, ID)}`));
  assert.doesNotMatch(run.stdout, new RegExp(SECRET));
  assert.doesNotMatch(run.stderr, new RegExp(SECRET));
});

test('doctor reports a missing marker and does not create or repair the space', () => {
  const fx = fixture();
  const expected = path.join(fx.spaces, ID);
  const run = doctor(fx.worktree, fx);
  assert.match(run.stdout, new RegExp(`FAIL  no Agent Space marker for ${ID} at ${expected}`));
  const report = JSON.parse(doctor(fx.worktree, fx, ['--json']).stdout);
  const space = report.worktree.checks.find((check) => check.id === 'worktree.agent_space');
  assert.match(space.action, /run: agent-bot space init/);
  assert.equal(existsSync(expected), false, 'doctor must remain read-only');
});

test('doctor reports a marker bound to another Agent ID', () => {
  const fx = fixture();
  mkdirSync(path.dirname(markerPath(fx)), { recursive: true });
  writeFileSync(markerPath(fx), `${JSON.stringify({
    schemaVersion: 1,
    agentId: OTHER_ID,
    createdAt: '2026-08-06T00:00:00.000Z',
  })}\n`);

  const run = doctor(fx.worktree, fx);
  assert.match(
    run.stdout,
    new RegExp(`FAIL  Agent Space at ${path.join(fx.spaces, ID)} is bound to ${OTHER_ID}, not ${ID}`),
  );
  const report = JSON.parse(doctor(fx.worktree, fx, ['--json']).stdout);
  const space = report.worktree.checks.find((check) => check.id === 'worktree.agent_space');
  assert.match(space.action, /doctor will not rebind it/);
});

test('doctor reports malformed and unsupported markers generically without leaking contents', () => {
  const fx = fixture();
  mkdirSync(path.dirname(markerPath(fx)), { recursive: true });
  writeFileSync(markerPath(fx), `not-json ${SECRET}\n`);
  const malformed = doctor(fx.worktree, fx);
  assert.match(malformed.stdout, new RegExp(`Agent Space marker for ${ID} .* is invalid`));
  assert.doesNotMatch(malformed.stdout, new RegExp(SECRET));
  assert.doesNotMatch(malformed.stderr, new RegExp(SECRET));

  writeFileSync(markerPath(fx), `${JSON.stringify({
    schemaVersion: SECRET,
    agentId: ID,
    createdAt: '2026-08-06T00:00:00.000Z',
  })}\n`);
  const unsupported = doctor(fx.worktree, fx);
  assert.match(unsupported.stdout, new RegExp(`Agent Space marker for ${ID} .* is invalid`));
  assert.doesNotMatch(unsupported.stdout, new RegExp(SECRET));
  assert.doesNotMatch(unsupported.stderr, new RegExp(SECRET));

  rmSync(markerPath(fx), { force: true });
  mkdirSync(markerPath(fx));
  const unreadable = doctor(fx.worktree, fx);
  assert.match(unreadable.stdout, new RegExp(`Agent Space marker for ${ID} .* is invalid`));
});

test('doctor does not echo an invalid pinned Agent ID', () => {
  const fx = fixture();
  git(fx.worktree, 'config', '--worktree', 'agentBot.agentId', SECRET);
  const run = doctor(fx.worktree, fx);
  assert.match(run.stdout, /FAIL  pinned Agent ID is invalid/);
  assert.doesNotMatch(run.stdout, new RegExp(SECRET));
  assert.doesNotMatch(run.stderr, new RegExp(SECRET));
});

test('doctor skips worktree Agent Space checks in a primary checkout', () => {
  const fx = fixture();
  git(fx.repo, 'config', 'agentBot.agentId', ID);
  const run = doctor(fx.repo, fx);
  assert.match(run.stdout, /primary checkout/);
  assert.match(run.stdout, /Agent Space root/);
  assert.doesNotMatch(run.stdout, /Agent Space marker|space\.json/);
  assert.doesNotMatch(run.stdout, /Agent ID/);
  assert.equal(existsSync(path.join(fx.spaces, ID)), false);
});
