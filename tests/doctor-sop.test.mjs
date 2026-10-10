import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stateDirectory } from '../agent-identity.mjs';
import { buildReadinessReport, sopPersonaCheck } from '../readiness.mjs';
import { personaBlockNotice } from '../sandbox.mjs';

// Doctor's SOP section (#613): a legacy or stale persona record gets the
// `agent-bot sop persona` hint; one that refuses every launch fails doctor.
// Scratch HOME and state only.
const COMMIT = 'b'.repeat(40);

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'doctor-sop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, 'state') };
  const config = path.join(home, '.config', 'agent-sop', 'config.toml');
  const record = path.join(stateDirectory({ env, home }), 'sop-persona.json');
  const select = (spec) => {
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, `schema_version = 1\n[repos]\norg = "local/org@main"\nsop = "${spec}"\n`);
  };
  const write = (extra) => {
    mkdirSync(path.dirname(record), { recursive: true });
    writeFileSync(record, JSON.stringify({ schemaVersion: 1, recordedAt: '2026-10-09T00:00:00.000Z', configPath: config,
      org: { repository: 'local/org', commit: COMMIT }, sop: { repository: 'local/sop', commit: COMMIT },
      persona: 'schema_version = 1\n[persona]\nsandbox = "unrestricted"\n', ...extra }));
  };
  return { home, env, select, write };
}

test('doctor reports no SOP as not applicable and a current record as ready (#613)', (t) => {
  const f = fixture(t);
  const none = sopPersonaCheck({ home: f.home, env: f.env });
  assert.equal(none.id, 'sop.persona');
  assert.equal(none.status, 'not_applicable');
  f.select('local/sop@main');
  f.write({ selection: { org: 'local/org@main', sop: 'local/sop@main' } });
  const ready = sopPersonaCheck({ home: f.home, env: f.env });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.action, null);
  assert.deepEqual(ready.evidence, { state: 'recorded', repository: 'local/sop', commit: COMMIT, recorded_at: '2026-10-09T00:00:00.000Z' });
});

test('doctor hints agent-bot sop persona for a legacy, stale or missing persona record (#613)', (t) => {
  const f = fixture(t);
  f.select('local/sop@main');
  const unrecorded = sopPersonaCheck({ home: f.home, env: f.env });
  assert.equal(unrecorded.status, 'failed');
  assert.match(unrecorded.message, /every soul launch, wake, task and turn is refused/);
  assert.equal(unrecorded.code, 'sop-persona-unrecorded');
  assert.equal(unrecorded.action, 'run: agent-bot sop persona');

  f.write({}); // from before selections were kept
  const legacy = sopPersonaCheck({ home: f.home, env: f.env });
  assert.equal(legacy.status, 'warning');
  assert.equal(legacy.code, 'sop-persona-legacy');
  assert.equal(legacy.action, 'run: agent-bot sop persona');

  f.write({ selection: { org: 'local/org@main', sop: 'local/sop@main' } });
  f.select('local/sop@release');
  const stale = sopPersonaCheck({ home: f.home, env: f.env });
  assert.equal(stale.status, 'warning');
  assert.equal(stale.code, 'sop-persona-stale');
  assert.equal(stale.action, 'run: agent-bot sop persona');
  assert.equal(stale.evidence.state, 'stale');

  writeFileSync(path.join(stateDirectory({ env: f.env, home: f.home }), 'sop-persona.json'), '{ not json');
  const broken = sopPersonaCheck({ home: f.home, env: f.env });
  assert.equal(broken.status, 'failed');
  assert.equal(broken.code, 'sop-persona-unavailable');
  assert.match(broken.action, /agent-bot sop persona/);
});

test('doctor reports a recorded but invalid persona.toml as unavailable, as launches refuse it (#613)', (t) => {
  const f = fixture(t);
  f.select('local/sop@main');
  f.write({ selection: { org: 'local/org@main', sop: 'local/sop@main' }, persona: 'schema_version = 1\n[persona]\nsandbox = "bogus"\n' });
  const invalid = sopPersonaCheck({ home: f.home, env: f.env });
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.code, 'sop-persona-unavailable');
  assert.match(invalid.message, /persona\.toml.*invalid/);
  assert.equal(invalid.action, 'fix persona.toml in the SOP, then run: agent-bot sop persona');
  assert.equal(invalid.evidence.state, 'recorded');
});

test('an unrecorded persona mapping makes doctor not ready and leads with the repair (#613)', (t) => {
  const f = fixture(t);
  f.select('local/sop@main');
  const report = buildReadinessReport({ command: 'doctor', scope: 'machine', machineChecks: [sopPersonaCheck({ home: f.home, env: f.env })] });
  assert.equal(report.ready, false);
  assert.equal(report.machine.status, 'not_ready');
  assert.equal(report.first_actionable_failure.check_id, 'sop.persona');
  assert.equal(report.first_actionable_failure.code, 'sop-persona-unrecorded');
  assert.equal(report.first_actionable_failure.action, 'run: agent-bot sop persona');
});

test('the daemon start and install notice names a persona policy that refuses every launch (#613)', (t) => {
  const f = fixture(t);
  assert.equal(personaBlockNotice({ home: f.home, env: f.env }), null, 'no SOP selected');
  f.select('local/sop@main');
  assert.equal(personaBlockNotice({ home: f.home, env: f.env }),
    'agent-bot: persona-policy-unavailable: every soul launch, wake, task and turn is refused because the selected SOP\'s persona mapping is not recorded; run `agent-bot sop persona` to record the selected SOP\'s mapping');
  f.write({ selection: { org: 'local/org@main', sop: 'local/sop@main' }, persona: 'schema_version = 1\n[persona]\nsandbox = "bogus"\n' });
  assert.match(personaBlockNotice({ home: f.home, env: f.env }), /^agent-bot: persona-policy-unavailable: .*; fix persona\.toml in the SOP, then run `agent-bot sop persona`$/);
  f.write({ selection: { org: 'local/org@main', sop: 'local/sop@main' } });
  assert.equal(personaBlockNotice({ home: f.home, env: f.env }), null, 'recorded');
  f.select('local/sop@release');
  assert.equal(personaBlockNotice({ home: f.home, env: f.env }), null, 'stale asks the owner instead of refusing');
});
