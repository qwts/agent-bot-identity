import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSoulHomes, soulHomePath } from '../soul-home.mjs';

const agentId = 'agent_33333333-3333-4333-8333-333333333333';

function fakeBindings() {
  const bound = [];
  return { bound, bind: (entry) => { bound.push(entry); return 'secret'; },
    findAgent: (id) => { const entry = bound.findLast((b) => b.agentId === id);
      return entry ? { agentId: id, worktree: entry.worktree, file: path.join(entry.gitDir, 'agent-binding.json') } : null; } };
}

test('provisions a git home from the package once, then rebinds it', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'soul-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'pkg');
  mkdirSync(path.join(pkg, 'skills', 'hello'), { recursive: true });
  writeFileSync(path.join(pkg, 'AGENTS.md'), 'be kind\n');
  writeFileSync(path.join(pkg, 'skills', 'hello', 'SKILL.md'), 'hi\n');
  const bindings = fakeBindings();
  const provision = createSoulHomes({ stateDir: path.join(root, 'state'), bindings });
  const home = soulHomePath(path.join(root, 'state'), agentId);
  const first = provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.equal(first.worktree, home);
  assert.equal(readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), 'be kind\n');
  assert.equal(readFileSync(path.join(home, 'skills', 'hello', 'SKILL.md'), 'utf8'), 'hi\n');
  assert.equal(bindings.bound[0].gitDir, realpathSync(path.join(home, '.git')));
  writeFileSync(path.join(home, 'AGENTS.md'), 'grown\n');
  provision({ agentId, harness: 'claude', packagePath: pkg });
  assert.equal(readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), 'grown\n', 'an existing home is never overwritten');
  assert.equal(bindings.bound.length, 2);
});

test('rejects an invalid agent ID before touching the disk', () => {
  assert.throws(() => soulHomePath('/state', '../x'));
});
