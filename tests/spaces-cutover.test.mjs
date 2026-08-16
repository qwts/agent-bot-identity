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

import { initAgentSpace } from '../agent-space.mjs';
import { displayName, populationFile, showSoul, upsertSoul } from '../agent-population.mjs';
import {
  cutoverStatePaths,
  defaultSpacesHome,
  ensureSpacesCutover,
  inspectSpacesCutover,
  rootHoldsSpaces,
} from '../spaces-cutover.mjs';
import { legacySpacesHome } from '../agent-space.mjs';

const ID = 'agent_11111111-1111-4111-8111-111111111111';
const OTHER_ID = 'agent_22222222-2222-4222-8222-222222222222';
const roots = [];

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-space-cutover-'));
  roots.push(root);
  return root;
}

function hermetic(home = scratch()) {
  return { home, env: {}, config: {} };
}

function seedSpace(id, root, { note = 'payload' } = {}) {
  initAgentSpace(id, {
    env: { AGENT_BOT_SPACES_HOME: root },
    home: path.dirname(root),
    config: {},
  });
  writeFileSync(path.join(root, id, 'note.txt'), `${note}\n`);
}

function seedCensus(id, spaceRoot, { env, home, status = 'active' } = {}) {
  return upsertSoul({
    id,
    name: displayName(id),
    appSlug: 'qwts-codex-agent',
    parentId: null,
    status,
    spacePath: path.join(spaceRoot, id),
    transcriptLocator: { provider: 'codex', id: 'thread-1' },
    lastSeen: '2026-08-16T00:00:00.000Z',
  }, { file: populationFile({ env, home }) });
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('cutover moves legacy soul dirs, rewrites the census, and is then a no-op', () => {
  const ctx = hermetic();
  const legacy = legacySpacesHome(ctx);
  const dest = defaultSpacesHome(ctx);
  seedSpace(ID, legacy, { note: 'keep-me' });
  seedCensus(ID, legacy, ctx);

  const first = ensureSpacesCutover(ctx);
  assert.equal(first.applied, true);
  assert.equal(first.moved, 1);
  assert.equal(first.from, legacy);
  assert.equal(first.to, dest);
  assert.equal(readFileSync(path.join(dest, ID, 'note.txt'), 'utf8'), 'keep-me\n');
  assert.equal(existsSync(path.join(legacy, ID)), false);
  assert.equal(showSoul(ID, { file: populationFile(ctx) }).spacePath, path.join(dest, ID));

  const record = JSON.parse(readFileSync(cutoverStatePaths(ctx).recordPath, 'utf8'));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.from, legacy);
  assert.equal(record.to, dest);
  assert.equal(record.moved, 1);
  assert.equal(existsSync(cutoverStatePaths(ctx).inProgressPath), false);

  mkdirSync(path.join(legacy, ID), { recursive: true });
  writeFileSync(path.join(legacy, ID, 'stale.txt'), 'should-not-move\n');
  const second = ensureSpacesCutover(ctx);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already-completed');
  assert.equal(existsSync(path.join(dest, ID, 'stale.txt')), false);
  assert.equal(existsSync(path.join(legacy, ID, 'stale.txt')), true);
});

test('an override skips the cutover and does not move spaces', () => {
  const ctx = hermetic();
  const legacy = legacySpacesHome(ctx);
  seedSpace(ID, legacy);
  const env = { AGENT_BOT_SPACES_HOME: path.join(ctx.home, 'pinned') };
  const result = ensureSpacesCutover({ ...ctx, env });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'override');
  assert.equal(existsSync(path.join(legacy, ID, 'space.json')), true);
  assert.equal(existsSync(defaultSpacesHome(ctx)), false);
  assert.equal(existsSync(cutoverStatePaths(ctx).recordPath), false);
});

test('a configured spacesRoot does not migrate the legacy tree', () => {
  const ctx = hermetic();
  const legacy = legacySpacesHome(ctx);
  seedSpace(ID, legacy);
  const result = ensureSpacesCutover({
    ...ctx,
    config: { settings: { spacesRoot: path.join(ctx.home, 'other-root') } },
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'override');
  assert.equal(rootHoldsSpaces(legacy), true);
  assert.equal(rootHoldsSpaces(defaultSpacesHome(ctx)), false);
});

test('both populated roots without a record fail closed', () => {
  const ctx = hermetic();
  const legacy = legacySpacesHome(ctx);
  const dest = defaultSpacesHome(ctx);
  seedSpace(ID, legacy);
  seedSpace(OTHER_ID, dest);
  assert.throws(
    () => ensureSpacesCutover(ctx),
    /both the legacy root and ~\/\.agent-space hold spaces/,
  );
  assert.equal(existsSync(path.join(legacy, ID, 'space.json')), true);
  assert.equal(existsSync(path.join(dest, OTHER_ID, 'space.json')), true);
  assert.equal(existsSync(cutoverStatePaths(ctx).recordPath), false);
  assert.equal(inspectSpacesCutover(ctx).conflict, true);
});

test('an in-progress retry discards the partial destination and finishes', () => {
  const ctx = hermetic();
  const legacy = legacySpacesHome(ctx);
  const dest = defaultSpacesHome(ctx);
  seedSpace(ID, legacy, { note: 'authoritative' });
  seedCensus(ID, legacy, ctx);
  mkdirSync(path.join(dest, ID), { recursive: true });
  writeFileSync(path.join(dest, ID, 'note.txt'), 'partial\n');
  writeFileSync(cutoverStatePaths(ctx).inProgressPath, '{}\n');

  const result = ensureSpacesCutover(ctx);
  assert.equal(result.applied, true);
  assert.equal(readFileSync(path.join(dest, ID, 'note.txt'), 'utf8'), 'authoritative\n');
  assert.equal(existsSync(path.join(legacy, ID)), false);
  assert.equal(existsSync(cutoverStatePaths(ctx).inProgressPath), false);
  assert.equal(showSoul(ID, { file: populationFile(ctx) }).spacePath, path.join(dest, ID));
});

test('stray non-soul entries do not count as a populated root', () => {
  const ctx = hermetic();
  const dest = defaultSpacesHome(ctx);
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, 'readme.txt'), 'not a soul\n');
  mkdirSync(path.join(dest, 'not-an-agent-id'), { recursive: true });
  const legacy = legacySpacesHome(ctx);
  seedSpace(ID, legacy);
  const result = ensureSpacesCutover(ctx);
  assert.equal(result.applied, true);
  assert.equal(existsSync(path.join(dest, ID, 'space.json')), true);
  assert.equal(existsSync(path.join(dest, 'readme.txt')), true);
});

test('nothing to move when the legacy tree is empty', () => {
  const ctx = hermetic();
  const result = ensureSpacesCutover(ctx);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'nothing-to-move');
  assert.equal(existsSync(cutoverStatePaths(ctx).recordPath), false);
});
