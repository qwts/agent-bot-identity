import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  ensureDaemonSupervisor,
  supervisorPaths,
} from '../daemon-supervisor.mjs';

const CELLAR_NODE = '/opt/homebrew/Cellar/node/26.10.0_1/bin/node';
const CELLAR_ENTRY = '/opt/homebrew/Cellar/agent-bot/0.10.2/libexec/agent-bot.mjs';
const OPT_NODE = '/opt/homebrew/opt/node/bin/node';
const OPT_ENTRY = '/opt/homebrew/opt/agent-bot/libexec/agent-bot.mjs';

function harness(home) {
  return {
    home,
    platform: 'darwin',
    env: {},
    probe: async () => ({ running: true, pid: 9, port: 1, startedAt: '2026-08-16T00:00:00.000Z' }),
    stopDetached: async () => {},
    exec: () => '',
  };
}

test('#321: daemon install writes stable opt paths, never versioned Cellar paths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daemon-opt-'));
  const options = harness(home);
  const first = await ensureDaemonSupervisor({
    ...options,
    programArguments: [CELLAR_NODE, CELLAR_ENTRY, 'daemon', 'run'],
  });
  const body = readFileSync(first.unitPath, 'utf8');
  assert.doesNotMatch(body, /Cellar/);
  assert.match(body, new RegExp(OPT_NODE.replaceAll('/', '\\/')));
  assert.match(body, new RegExp(OPT_ENTRY.replaceAll('/', '\\/').replaceAll('.', '\\.')));
  assert.equal(first.refreshed, true);
  // Idempotent: the same Homebrew runtime repairs nothing twice.
  const second = await ensureDaemonSupervisor({
    ...options,
    programArguments: [CELLAR_NODE, CELLAR_ENTRY, 'daemon', 'run'],
  });
  assert.equal(second.refreshed, false);
  assert.doesNotMatch(readFileSync(second.unitPath, 'utf8'), /Cellar/);
});

test('#321: install reports changed:true on a unit that pins Cellar paths, repairing it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daemon-opt-repair-'));
  const options = harness(home);
  const unitPath = supervisorPaths(home, 'darwin', {}).unitPath;
  mkdirSync(dirname(unitPath), { recursive: true });
  // Simulate the pre-fix unit: versioned keg paths that brew cleanup deletes.
  writeFileSync(unitPath, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>dev.qwts.agent-bot.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${CELLAR_NODE}</string>
    <string>${CELLAR_ENTRY}</string>
    <string>daemon</string><string>run</string>
  </array>
</dict></plist>\n`);
  const repaired = await ensureDaemonSupervisor({
    ...options,
    reloadUnchanged: false,
    programArguments: [CELLAR_NODE, CELLAR_ENTRY, 'daemon', 'run'],
  });
  assert.equal(repaired.refreshed, true);
  const body = readFileSync(unitPath, 'utf8');
  assert.doesNotMatch(body, /Cellar/);
  assert.ok(body.includes(OPT_NODE));
  assert.ok(body.includes(OPT_ENTRY));
});

test('#321: app-bundle paths are left untouched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daemon-bundle-'));
  const options = harness(home);
  const bundleNode = '/Applications/GeniusBar.app/Contents/Resources/node';
  const bundleEntry = '/Applications/GeniusBar.app/Contents/Resources/agent-bot.mjs';
  const first = await ensureDaemonSupervisor({
    ...options,
    programArguments: [bundleNode, bundleEntry, 'daemon', 'run'],
  });
  const body = readFileSync(first.unitPath, 'utf8');
  assert.ok(body.includes(bundleNode));
  assert.ok(body.includes(bundleEntry));
  assert.equal(first.refreshed, true);
  const second = await ensureDaemonSupervisor({
    ...options,
    programArguments: [bundleNode, bundleEntry, 'daemon', 'run'],
  });
  assert.equal(second.refreshed, false);
});
