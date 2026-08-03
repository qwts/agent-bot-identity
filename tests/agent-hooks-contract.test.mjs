import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANONICAL_EVENTS } from '../hook-dialects.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(repo, 'agent-hooks');

// The failure this file exists to prevent: a hook that looks installed and
// never fires. A typo'd directory name or a forgotten chmod +x both produce
// exactly that, silently, and neither shows up in any other test.

test('every agent-hooks subdirectory is a canonical event', () => {
  if (!existsSync(dir)) return;
  const dirs = readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory());
  for (const name of dirs) {
    assert.ok(
      CANONICAL_EVENTS.includes(name),
      `agent-hooks/${name} is not a canonical event — hooks there would never fire`,
    );
  }
});

test('every hook in the folder is executable', () => {
  if (!existsSync(dir)) return;
  for (const event of readdirSync(dir)) {
    const eventDir = path.join(dir, event);
    if (!statSync(eventDir).isDirectory()) continue;
    for (const name of readdirSync(eventDir)) {
      if (name.startsWith('.') || name.endsWith('.md')) continue;
      const stat = statSync(path.join(eventDir, name));
      assert.ok(
        (stat.mode & 0o111) !== 0,
        `agent-hooks/${event}/${name} is not executable — it would be skipped at runtime`,
      );
    }
  }
});
