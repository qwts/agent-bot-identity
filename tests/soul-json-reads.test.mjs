import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { soulShownName } from '../agent-population.mjs';
import { templateProviderId } from '../team-start.mjs';

// #1104: soul.json reads on the daemon's paths go through readManifestText,
// so a FIFO cannot hang them and a symlink is never followed.
function soul(t, manifest) {
  const dir = mkdtempSync(path.join(tmpdir(), 'soul-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (manifest) writeFileSync(path.join(dir, 'soul.json'), JSON.stringify(manifest));
  return dir;
}
const MANIFEST = { name: 'Billy', harnesses: { claude: { provider: { id: 'anthropic' } } } };

test('a FIFO soul.json reads as no manifest, without waiting on it', (t) => {
  const dir = soul(t);
  const made = spawnSync('mkfifo', [path.join(dir, 'soul.json')]);
  if (made.status !== 0) { t.skip('mkfifo is not available'); return; }
  const started = Date.now();
  assert.equal(soulShownName({ name: 'handle' }, dir), 'handle');
  assert.equal(templateProviderId(dir, 'claude'), null);
  assert.ok(Date.now() - started < 2000, 'nothing waited on the FIFO');
});

test('a symlinked soul.json is not followed', (t) => {
  const outside = soul(t, MANIFEST);
  const dir = soul(t);
  symlinkSync(path.join(outside, 'soul.json'), path.join(dir, 'soul.json'));
  assert.equal(soulShownName({ name: 'handle' }, dir), 'handle');
  assert.equal(templateProviderId(dir, 'claude'), null);
});

test('a regular soul.json still reads', (t) => {
  const dir = soul(t, MANIFEST);
  assert.equal(soulShownName({ name: 'handle' }, dir), 'Billy');
  assert.equal(templateProviderId(dir, 'claude'), 'anthropic');
});
