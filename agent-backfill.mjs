#!/usr/bin/env node

// Historical provenance backfill (#91). Census rows written before binding
// existed carry transcriptLocator: null forever — the conversation that
// produced them is over and will never call bind. But the workstation's own
// transcript stores still hold the evidence: a worktree's setup output names
// its Agent ID inside the session file that created it. This module scans
// those stores and repairs rows whose ID appears in exactly one transcript.
//
// Fail-visibly, never guess: an ID found in several transcripts (a
// supervising session that spawned many worktrees mentions them all) is
// reported as ambiguous and left untouched, and an ID found nowhere is
// reported as unfound. Both remain visible as PARENT '?' in population
// output rather than acquiring invented provenance.
//
// Results carry only {provider, id} locators — never transcript content,
// absolute paths, or anything else from inside the session files (#31).

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { listSouls, populationFile, upsertSoul } from './agent-population.mjs';

const AGENT_ID_PATTERN = /agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// The stores this workstation's harnesses actually write. The session
// identifier is recovered from the file name alone — the trailing UUID of a
// codex rollout, the stem of a claude session — so no transcript needs to be
// parsed, only searched.
export function defaultTranscriptStores(home = homedir()) {
  return [
    { provider: 'claude', root: path.join(home, '.claude', 'projects') },
    { provider: 'codex', root: path.join(home, '.codex', 'sessions') },
  ];
}

function sessionIdFromFilename(filename) {
  const stem = filename.slice(0, -'.jsonl'.length);
  const uuids = stem.match(UUID_PATTERN);
  return uuids ? uuids[uuids.length - 1] : null;
}

function transcriptFiles(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true, recursive: true });
  } catch {
    // A store that does not exist on this machine is simply empty.
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

// One pass over every transcript, one Map out: Agent ID -> distinct locators
// it appears in. Files are read whole but one at a time, so peak memory is a
// single session file.
export function scanTranscriptStores(stores) {
  const sightings = new Map();
  let scanned = 0;
  for (const { provider, root } of stores) {
    for (const file of transcriptFiles(root)) {
      const sessionId = sessionIdFromFilename(path.basename(file));
      if (!sessionId) continue;
      let contents;
      try {
        contents = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      scanned += 1;
      const ids = contents.match(AGENT_ID_PATTERN);
      if (!ids) continue;
      for (const id of new Set(ids)) {
        let locators = sightings.get(id);
        if (!locators) {
          locators = new Map();
          sightings.set(id, locators);
        }
        locators.set(`${provider}:${sessionId}`, { provider, id: sessionId });
      }
    }
  }
  return { sightings, scanned };
}

// Repair pass. `apply: false` reports what would change without writing —
// the operator sees the exact repairs before any census mutation.
export function backfillTranscriptLocators({
  file = populationFile(),
  home = homedir(),
  stores = defaultTranscriptStores(home),
  apply = false,
} = {}) {
  const { sightings, scanned } = scanTranscriptStores(stores);
  const updated = [];
  const ambiguous = [];
  const unfound = [];
  for (const soul of listSouls({ file })) {
    if (soul.transcriptLocator !== null) continue;
    // Tombstones keep their gaps: retirement froze the record, and inventing
    // provenance for a soul nobody can bind again helps no one.
    if (soul.status === 'retired') continue;
    const locators = [...(sightings.get(soul.id)?.values() ?? [])];
    if (locators.length === 1) {
      const repaired = { id: soul.id, name: soul.name, transcriptLocator: locators[0] };
      if (apply) {
        // lastSeen is preserved: a backfill is a repair, not a sighting.
        upsertSoul({ ...soul, transcriptLocator: locators[0] }, { file });
      }
      updated.push(repaired);
    } else if (locators.length === 0) {
      unfound.push({ id: soul.id, name: soul.name });
    } else {
      ambiguous.push({ id: soul.id, name: soul.name, candidates: locators.length });
    }
  }
  return { applied: apply, scanned, updated, ambiguous, unfound };
}

export function formatBackfillReport(report) {
  const lines = [];
  const verb = report.applied ? 'repaired' : 'would repair';
  for (const soul of report.updated) {
    lines.push(`${verb}\t${soul.name}\t${soul.id}\t${soul.transcriptLocator.provider}:${soul.transcriptLocator.id}`);
  }
  for (const soul of report.ambiguous) {
    lines.push(`ambiguous\t${soul.name}\t${soul.id}\tappears in ${soul.candidates} transcripts; left untouched`);
  }
  for (const soul of report.unfound) {
    lines.push(`unfound\t${soul.name}\t${soul.id}\tno local transcript names it`);
  }
  lines.push(
    `${report.applied ? 'repaired' : 'repairable'} ${report.updated.length}, `
    + `ambiguous ${report.ambiguous.length}, unfound ${report.unfound.length} `
    + `(${report.scanned} transcripts scanned)`,
  );
  return `${lines.join('\n')}\n`;
}
