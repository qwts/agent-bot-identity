import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  backfillTranscriptLocators,
  defaultTranscriptStores,
  formatBackfillReport,
  scanTranscriptStores,
} from '../agent-backfill.mjs';
import { displayName, showSoul, upsertSoul } from '../agent-population.mjs';

const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const BOUND_ID = 'agent_11111111-1111-4111-8111-111111111111';
const CLAUDE_ID = 'agent_22222222-2222-4222-8222-222222222222';
const CODEX_ID = 'agent_33333333-3333-4333-8333-333333333333';
const AMBIGUOUS_ID = 'agent_44444444-4444-4444-8444-444444444444';
const UNFOUND_ID = 'agent_55555555-5555-4555-8555-555555555555';
const RETIRED_ID = 'agent_66666666-6666-4666-8666-666666666666';
const CLAUDE_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODEX_THREAD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-backfill-'));
  roots.push(root);
  return root;
}

// A workstation in miniature: one claude project store, one codex rollout
// store, transcripts that mention agent IDs the way setup-worktree output
// lands in a session file.
function plantStores(root) {
  const claudeRoot = path.join(root, '.claude', 'projects');
  const codexRoot = path.join(root, '.codex', 'sessions');
  const project = path.join(claudeRoot, '-Users-test-repo');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(project, `${CLAUDE_SESSION}.jsonl`),
    `{"output":"worktree configured as ${CLAUDE_ID} (transcript pending)"}\n`
    + `{"output":"also mentions ${AMBIGUOUS_ID} while spawning"}\n`,
  );
  writeFileSync(
    path.join(project, `${OTHER_SESSION}.jsonl`),
    `{"output":"another session that also mentions ${AMBIGUOUS_ID}"}\n`,
  );
  // A stray non-transcript file is ignored, as is a file with no UUID stem.
  writeFileSync(path.join(project, 'notes.txt'), CLAUDE_ID);
  writeFileSync(path.join(project, 'no-uuid-here.jsonl'), CODEX_ID);
  const day = path.join(codexRoot, '2026', '08', '12');
  mkdirSync(day, { recursive: true });
  writeFileSync(
    path.join(day, `rollout-2026-08-12T10-00-00-${CODEX_THREAD}.jsonl`),
    `{"output":"worktree configured as ${CODEX_ID}, twice: ${CODEX_ID}"}\n`,
  );
  return [
    { provider: 'claude', root: claudeRoot },
    { provider: 'codex', root: codexRoot },
  ];
}

function soulRow(id, overrides = {}) {
  return {
    id,
    name: displayName(id),
    appSlug: 'qwts-codex-agent',
    parentId: null,
    status: 'active',
    spacePath: `/spaces/${id}`,
    transcriptLocator: null,
    lastSeen: '2026-08-06T12:00:00.000Z',
    ...overrides,
  };
}

function plantPopulation(root) {
  const file = path.join(root, 'population.json');
  upsertSoul(soulRow(BOUND_ID, { transcriptLocator: { provider: 'claude', id: 'already-bound' } }), { file });
  upsertSoul(soulRow(CLAUDE_ID), { file });
  upsertSoul(soulRow(CODEX_ID), { file });
  upsertSoul(soulRow(AMBIGUOUS_ID), { file });
  upsertSoul(soulRow(UNFOUND_ID), { file });
  upsertSoul(soulRow(RETIRED_ID, { status: 'retired' }), { file });
  return file;
}

test('default stores are the claude and codex transcript homes', () => {
  assert.deepEqual(defaultTranscriptStores('/home/test'), [
    { provider: 'claude', root: '/home/test/.claude/projects' },
    { provider: 'codex', root: '/home/test/.codex/sessions' },
  ]);
});

test('scan maps each Agent ID to the distinct sessions that mention it', () => {
  const root = scratch();
  const stores = plantStores(root);
  const { sightings, scanned } = scanTranscriptStores(stores);
  // notes.txt and the stem with no UUID never count as transcripts.
  assert.equal(scanned, 3);
  assert.deepEqual([...sightings.get(CLAUDE_ID).values()], [
    { provider: 'claude', id: CLAUDE_SESSION },
  ]);
  // Repeated mentions inside one file stay one sighting.
  assert.deepEqual([...sightings.get(CODEX_ID).values()], [
    { provider: 'codex', id: CODEX_THREAD },
  ]);
  assert.equal(sightings.get(AMBIGUOUS_ID).size, 2);
  assert.equal(sightings.has(UNFOUND_ID), false);
  // A store that does not exist is simply empty, not an error.
  const empty = scanTranscriptStores([{ provider: 'claude', root: path.join(root, 'missing') }]);
  assert.equal(empty.scanned, 0);
});

test('dry run reports every repair without touching the census', () => {
  const root = scratch();
  const stores = plantStores(root);
  const file = plantPopulation(root);
  const report = backfillTranscriptLocators({ file, stores, apply: false });
  assert.equal(report.applied, false);
  assert.deepEqual(report.updated.map((soul) => soul.id).sort(), [CLAUDE_ID, CODEX_ID]);
  assert.deepEqual(report.ambiguous.map((soul) => soul.id), [AMBIGUOUS_ID]);
  assert.equal(report.ambiguous[0].candidates, 2);
  assert.deepEqual(report.unfound.map((soul) => soul.id), [UNFOUND_ID]);
  // Nothing was written: the rows are exactly as planted.
  assert.equal(showSoul(CLAUDE_ID, { file }).transcriptLocator, null);
  assert.equal(showSoul(CODEX_ID, { file }).transcriptLocator, null);
});

test('apply repairs unambiguous rows and leaves everything else honest (#91)', () => {
  const root = scratch();
  const stores = plantStores(root);
  const file = plantPopulation(root);
  const report = backfillTranscriptLocators({ file, stores, apply: true });
  assert.equal(report.applied, true);
  assert.deepEqual(showSoul(CLAUDE_ID, { file }).transcriptLocator, {
    provider: 'claude',
    id: CLAUDE_SESSION,
  });
  assert.deepEqual(showSoul(CODEX_ID, { file }).transcriptLocator, {
    provider: 'codex',
    id: CODEX_THREAD,
  });
  // A backfill is a repair, not a sighting: lastSeen is untouched.
  assert.equal(showSoul(CLAUDE_ID, { file }).lastSeen, '2026-08-06T12:00:00.000Z');
  // Ambiguity and absence never turn into invented provenance.
  assert.equal(showSoul(AMBIGUOUS_ID, { file }).transcriptLocator, null);
  assert.equal(showSoul(UNFOUND_ID, { file }).transcriptLocator, null);
  // Tombstones keep their gaps.
  assert.equal(showSoul(RETIRED_ID, { file }).transcriptLocator, null);
  // Already-bound rows are never revisited.
  assert.equal(showSoul(BOUND_ID, { file }).transcriptLocator.id, 'already-bound');
});

test('the report names each repair and totals the rest', () => {
  const root = scratch();
  const stores = plantStores(root);
  const file = plantPopulation(root);
  const text = formatBackfillReport(backfillTranscriptLocators({ file, stores, apply: false }));
  assert.match(text, new RegExp(`would repair\t.*\t${CLAUDE_ID}\tclaude:${CLAUDE_SESSION}`));
  assert.match(text, new RegExp(`ambiguous\t.*\t${AMBIGUOUS_ID}\tappears in 2 transcripts`));
  assert.match(text, new RegExp(`unfound\t.*\t${UNFOUND_ID}\tno local transcript names it`));
  assert.match(text, /repairable 2, ambiguous 1, unfound 1 \(3 transcripts scanned\)/);
});

test('population backfill CLI round-trips through HOME-derived stores', () => {
  const root = scratch();
  plantStores(root);
  const file = plantPopulation(root);
  const env = { ...process.env, HOME: root, AGENT_BOT_POPULATION_PATH: file };
  const dry = spawnSync(process.execPath, [CLI, 'population', 'backfill', '--dry-run'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would repair/);
  assert.equal(showSoul(CLAUDE_ID, { file }).transcriptLocator, null);

  const applied = spawnSync(process.execPath, [CLI, 'population', 'backfill', '--json'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(applied.status, 0, applied.stderr);
  const report = JSON.parse(applied.stdout);
  assert.equal(report.applied, true);
  assert.equal(showSoul(CLAUDE_ID, { file }).transcriptLocator.id, CLAUDE_SESSION);
});
