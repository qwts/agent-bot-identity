import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { mintAgentIdentity } from '../agent-identity.mjs';
import {
  finalizeIdentityWithPopulation,
  showSoul,
  upsertSoul,
} from '../agent-population.mjs';
import { initAgentSpace } from '../agent-space.mjs';

const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const roots = [];

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-space-retire-'));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(root, id = ID) {
  const spaces = path.join(root, 'spaces');
  const file = path.join(root, 'population.json');
  const space = initAgentSpace(id, { env: { AGENT_BOT_SPACES_HOME: spaces } });
  writeFileSync(path.join(space.path, 'belongings.md'), 'kept unless explicitly deleted\n');
  upsertSoul({
    id,
    appSlug: 'you-claude-agent',
    parentId: null,
    status: 'active',
    spacePath: space.path,
    transcriptLocator: null,
    lastSeen: '2026-08-06T12:00:00.000Z',
  }, { file });
  return { spaces, file, space };
}

function runCli(args, { spaces, file }) {
  const env = { ...process.env };
  delete env.AGENT_BOT_ID;
  delete env.QWTS_AGENT_ID;
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...env, AGENT_BOT_SPACES_HOME: spaces, AGENT_BOT_POPULATION_PATH: file },
  });
}

test('retire tombstones by default: census marked, space kept on disk', () => {
  const context = fixture(scratch());
  const retired = runCli(['space', 'retire', ID], context);
  assert.equal(retired.status, 0, retired.stderr);
  assert.match(retired.stdout, new RegExp(`retired ${ID} \\(space kept at `));
  assert.equal(showSoul(ID, { file: context.file }).status, 'retired');
  assert.equal(existsSync(path.join(context.space.path, 'belongings.md')), true);
  assert.equal(existsSync(path.join(context.space.path, 'space.json')), true);
});

test('retire --delete-space removes only a marked, correctly bound space', () => {
  const context = fixture(scratch());
  const retired = runCli(['space', 'retire', ID, '--delete-space', '--json'], context);
  assert.equal(retired.status, 0, retired.stderr);
  assert.deepEqual(JSON.parse(retired.stdout), {
    agentId: ID,
    status: 'retired',
    spacePath: context.space.path,
    spaceDeleted: true,
  });
  assert.equal(existsSync(context.space.path), false);
  assert.equal(showSoul(ID, { file: context.file }).status, 'retired');
});

test('retire --delete-space fails closed on a mismatched marker and mutates nothing', () => {
  const context = fixture(scratch());
  writeFileSync(path.join(context.space.path, 'space.json'), `${JSON.stringify({
    schemaVersion: 1,
    agentId: OTHER_ID,
    createdAt: '2026-08-06T00:00:00.000Z',
  })}\n`);

  const refused = runCli(['space', 'retire', ID, '--delete-space'], context);
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /refusing to delete/);
  assert.equal(existsSync(context.space.path), true, 'the directory is kept');
  assert.equal(showSoul(ID, { file: context.file }).status, 'active', 'the census is untouched');
});

test('retire fails closed on unknown and invalid Agent IDs', () => {
  const context = fixture(scratch());

  const unknown = runCli(['space', 'retire', OTHER_ID], context);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, new RegExp(`no population record for ${OTHER_ID}`));

  const invalid = runCli(['space', 'retire', 'not-an-id-secret-sentinel'], context);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid Agent ID in this context/);
  assert.doesNotMatch(invalid.stderr, /secret-sentinel/);

  const missing = runCli(['space', 'retire'], context);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /requires exactly one Agent ID/);

  assert.equal(showSoul(ID, { file: context.file }).status, 'active');
});

test('identity finalize does not retire the soul or touch its space', () => {
  const root = scratch();
  const stateDir = path.join(root, 'identities');
  const spaces = path.join(root, 'spaces');
  const file = path.join(root, 'population.json');

  const identity = mintAgentIdentity({
    appSlug: 'you-claude-agent',
    transcript: { provider: 'claude', id: 'session-1' },
    stateDir,
  });
  const space = initAgentSpace(identity.id, { env: { AGENT_BOT_SPACES_HOME: spaces } });
  writeFileSync(path.join(space.path, 'belongings.md'), 'finalize must not delete this\n');
  upsertSoul({
    id: identity.id,
    appSlug: 'you-claude-agent',
    parentId: null,
    status: 'active',
    spacePath: space.path,
    transcriptLocator: { provider: 'claude', id: 'session-1' },
    lastSeen: '2026-08-06T12:00:00.000Z',
  }, { file });

  const finalized = finalizeIdentityWithPopulation(identity.id, { file, stateDir });
  assert.equal(finalized.status, 'finalized');
  const soul = showSoul(identity.id, { file });
  assert.equal(soul.status, 'finalized');
  assert.notEqual(soul.status, 'retired');
  assert.equal(existsSync(path.join(space.path, 'belongings.md')), true);
});
