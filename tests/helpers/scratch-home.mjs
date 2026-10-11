// Preloaded by `npm test` (--import) into every test process: HOME points at
// a fresh empty directory, and the XDG roots and AGENT_BOT_CONFIG are unset,
// so they resolve under that HOME too. A test that resolves config without
// naming a home then reads nothing from the machine's real ~/.config: a
// developer's installed profile (a keyd Team ID, App mappings, feature
// gates) must never change results. The XDG roots are unset rather than set
// because fixtures override HOME alone and expect them to follow it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const home = mkdtempSync(join(tmpdir(), 'agent-bot-test-home-'));
process.env.HOME = home;
for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'AGENT_BOT_CONFIG']) {
  delete process.env[name];
}
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
