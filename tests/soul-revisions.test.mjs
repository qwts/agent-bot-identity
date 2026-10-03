import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintAgentIdentity, readAgentIdentity, recordAgentPackageRevision } from '../agent-identity.mjs';
import { computePackageRevision, GENERATED_HARNESS_MARKER, PACKAGE_IGNORE_LIST, validateSoulPackage } from '../soul-package.mjs';
import { adoptSoulPackage, createRevisionAppender, decideSoulProposal, diffSoulPackages,
  editSoulRevision, listSoulProposals, promoteSpaceContent, proposeSoulRevision,
  revisionCommand, revisionHistory, revisionPackagePath } from '../soul-revisions.mjs';

function fixture(t, policy, { genesis = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'soul-revisions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packagePath = join(root, 'example.soul');
  mkdirSync(packagePath);
  const manifest = { formatVersion: 1, name: 'Test', description: 'Test soul', displaySeed: 'test',
    preferredHarnesses: [], revision: `sha256:${'0'.repeat(64)}`, parentRevision: null, future: { keep: true } };
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  writeFileSync(join(packagePath, 'AGENTS.md'), 'Initial instructions\n');
  writeFileSync(join(packagePath, 'unknown.bin'), Buffer.from([0, 255, 1]));
  writeFileSync(join(packagePath, 'script'), '#!/bin/sh\n');
  chmodSync(join(packagePath, 'script'), 0o755);
  mkdirSync(join(packagePath, 'empty'));
  if (policy !== undefined) writeFileSync(join(packagePath, 'policy.json'), JSON.stringify(policy));
  manifest.revision = computePackageRevision(packagePath);
  writeFileSync(join(packagePath, 'soul.json'), JSON.stringify(manifest));
  const options = { stateDir: join(root, 'state'), now: () => new Date('2026-10-01T12:00:00Z') };
  const identity = mintAgentIdentity({ ...options, appSlug: 'test-agent', packagePath: genesis ? packagePath : null });
  const initial = adoptSoulPackage(identity.id, packagePath, options);
  return { ...options, root, options, packagePath, id: identity.id, identity, initial };
}
const update = (f, path, content) => {
  mkdirSync(join(f.packagePath, path, '..'), { recursive: true });
  writeFileSync(join(f.packagePath, path), typeof content === 'string' ? content : JSON.stringify(content));
};
const propose = (f, options = {}) => proposeSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'Improve instructions', ...options });
const decide = (f, p, decision = 'approve') => decideSoulProposal(f.id, p.proposalId, decision, { ...f.options, reason: 'Reviewed changes' });

test('user edits and undo append full content-addressed packages and preserve identity', async (t) => {
  const f = fixture(t);
  const identityBytes = readFileSync(join(f.stateDir, `${f.id}.json`));
  const originalPath = revisionPackagePath(f.id, f.initial.revision, f.options);
  const originalBytes = readFileSync(join(originalPath, 'AGENTS.md'));
  update(f, 'AGENTS.md', 'New instructions');
  const edited = await editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'User customization' });
  const undone = await editSoulRevision(f.id, originalPath, { ...f.options, reason: 'Undo customization' });
  assert.deepEqual(revisionHistory(f.id, f.options).map((r) => r.parentRevision), [null, f.initial.revision, edited.revision]);
  assert.equal(new Set([f.initial.revision, edited.revision, undone.revision]).size, 3);
  for (const record of revisionHistory(f.id, f.options)) {
    assert.equal(record.author, 'user');
    assert.equal(record.at, '2026-10-01T12:00:00.000Z');
    const tree = revisionPackagePath(f.id, record.revision, f.options);
    assert.equal(validateSoulPackage(tree).revision, record.revision);
    assert.deepEqual(readFileSync(join(tree, 'unknown.bin')), Buffer.from([0, 255, 1]));
    assert.deepEqual(JSON.parse(readFileSync(join(tree, 'soul.json'))).future, { keep: true });
    assert.deepEqual(readdirSync(join(tree, 'empty')), []);
  }
  assert.deepEqual(readFileSync(join(originalPath, 'AGENTS.md')), originalBytes);
  assert.deepEqual(readFileSync(join(f.stateDir, `${f.id}.json`)), identityBytes);
  assert.equal(JSON.parse(readFileSync(join(f.packagePath, 'soul.json'))).revision, f.initial.revision, 'input untouched');
});

test('default ask stores immutable proposal and diff; explicit approval applies reviewed bytes', (t) => {
  const f = fixture(t);
  update(f, 'AGENTS.md', 'Proposed');
  const p = propose(f);
  assert.equal(p.status, 'pending');
  assert.deepEqual(p.diff, [{ path: 'AGENTS.md', change: 'modified' }]);
  assert.equal(revisionHistory(f.id, f.options).length, 1);
  update(f, 'AGENTS.md', 'Changed after proposal');
  const r = decide(f, p);
  assert.equal(r.author, 'soul'); assert.equal(r.approvedBy, 'user');
  assert.equal(readFileSync(join(revisionPackagePath(f.id, r.revision, f.options), 'AGENTS.md'), 'utf8'), 'Proposed');
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'approved');
  assert.throws(() => decide(f, p), /not pending/);
});

test('rejection appends a decision without rewriting proposal or changing head', (t) => {
  const f = fixture(t);
  update(f, 'AGENTS.md', 'Proposed'); const p = propose(f);
  const journal = join(f.stateDir, 'soul-revisions', f.id);
  const before = readFileSync(join(journal, '0000000001.json'));
  decide(f, p, 'reject');
  assert.deepEqual(readFileSync(join(journal, '0000000001.json')), before);
  assert.equal(listSoulProposals(f.id, f.options)[0].status, 'rejected');
  assert.equal(revisionHistory(f.id, f.options).length, 1);
  assert.throws(() => decide(f, p), /not pending/);
});

test('auto only applies when every changed path matches permitted globs', (t) => {
  const f = fixture(t, { mode: 'auto', paths: ['notes', 'notes/**', 'AGENTS.?d'] });
  update(f, 'notes/one.md', 'learned');
  let p = propose(f);
  assert.equal(p.status, 'approved'); assert.equal(p.decision.approval, 'auto');
  assert.equal(p.decision.author, 'soul');
  update(f, 'AGENTS.md', 'allowed'); p = propose(f); assert.equal(p.status, 'approved');
  update(f, 'other.txt', 'outside allowlist'); p = propose(f); assert.equal(p.status, 'pending');
  assert.equal(revisionHistory(f.id, f.options).length, 3);
});

test('auto includes deletions, execute bits, and directories in its diff', (t) => {
  const f = fixture(t, { mode: 'auto', paths: ['AGENTS.md'] });
  chmodSync(join(f.packagePath, 'script'), 0o644);
  rmSync(join(f.packagePath, 'unknown.bin'));
  rmSync(join(f.packagePath, 'empty'), { recursive: true });
  const p = propose(f);
  assert.equal(p.status, 'pending');
  assert.deepEqual(p.diff, [{ path: 'empty', change: 'removed' }, { path: 'script', change: 'modified' }, { path: 'unknown.bin', change: 'removed' }]);
});

test('never refuses proposals, including a proposal to relax the policy', (t) => {
  const f = fixture(t, { mode: 'never' });
  update(f, 'policy.json', { mode: 'auto', paths: ['**'] });
  const p = propose(f); assert.equal(p.status, 'rejected');
  assert.throws(() => decide(f, p), /not pending/);
  assert.equal(revisionHistory(f.id, f.options).length, 1);
});

for (const file of ['policy.json', 'tools.json', 'mcp.json', 'config/mcp-servers.json', 'mcpServers.json',
  'config/mcpServers/main.json', 'soul.json']) {
  test(`${file} changes always require user review despite auto **`, (t) => {
    const f = fixture(t, { mode: 'auto', paths: ['**'] });
    if (file === 'soul.json') {
      const manifest = JSON.parse(readFileSync(join(f.packagePath, file))); manifest.tools = ['new']; update(f, file, manifest);
    } else update(f, file, file === 'policy.json' ? { mode: 'auto', paths: ['**'], extension: true } : { extra: 'tool' });
    const p = propose(f); assert.equal(p.status, 'pending'); assert.equal(p.requiresUser, true);
    assert.equal(decide(f, p).approval, 'user');
  });
}

test('policy removal also requires review; tool removal is conservatively reviewed', async (t) => {
  const f = fixture(t, { mode: 'auto', paths: ['**'] });
  update(f, 'tools.json', { tools: ['one'] });
  await editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'User installs tool' });
  rmSync(join(f.packagePath, 'policy.json')); rmSync(join(f.packagePath, 'tools.json'));
  const p = propose(f); assert.equal(p.status, 'pending'); assert.equal(p.requiresUser, true);
});

test('stale approvals cannot overwrite later revisions; stale proposals may be rejected', async (t) => {
  const f = fixture(t);
  update(f, 'AGENTS.md', 'Proposal'); const p = propose(f);
  update(f, 'AGENTS.md', 'User edit');
  await editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'User wins' });
  assert.throws(() => decide(f, p), /stale/);
  decide(f, p, 'reject');
  await assert.rejects(editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'stale edit', expectedParent: f.initial.revision }), /stale/);
  assert.throws(() => propose(f, { expectedParent: f.initial.revision }), /stale/);
});

test('legacy adoption and genesis initialization use the same chain without changing IDs', (t) => {
  const f = fixture(t, undefined, { genesis: false });
  assert.equal(readAgentIdentity(f.id, f.options).genesis, null);
  assert.throws(() => adoptSoulPackage(f.id, f.packagePath, f.options), /already/);
  const other = mintAgentIdentity({ ...f.options, appSlug: 'test-agent', packagePath: f.packagePath });
  update(f, 'AGENTS.md', 'Wrong genesis');
  assert.throws(() => adoptSoulPackage(other.id, f.packagePath, f.options), /genesis/);
  assert.equal(revisionHistory(other.id, f.options).length, 0);
});

test('revision appender plugs into #284 and refuses hash-only, wrong-parent, and soul bypasses', async (t) => {
  const f = fixture(t);
  update(f, 'AGENTS.md', 'Changed');
  const manifest = JSON.parse(readFileSync(join(f.packagePath, 'soul.json')));
  manifest.parentRevision = f.initial.revision;
  update(f, 'soul.json', manifest); manifest.revision = computePackageRevision(f.packagePath); update(f, 'soul.json', manifest);
  const appendRevision = createRevisionAppender(f.packagePath, { ...f.options, reason: 'Host edit' });
  await recordAgentPackageRevision(f.id, f.packagePath, { ...f.options, appendRevision });
  assert.equal(revisionHistory(f.id, f.options).at(-1).revision, manifest.revision);
  await assert.rejects(recordAgentPackageRevision(f.id, f.packagePath, { ...f.options, appendRevision }), /stale/);
  assert.throws(() => appendRevision({ agentId: f.id, revision: f.initial.revision }), /changed/);
  assert.throws(() => createRevisionAppender(f.packagePath, { reason: 'bypass', author: 'soul' }), /propose/);
});

test('invalid policies and packages fail closed without advancing history', (t) => {
  for (const policy of [{ mode: 'unknown' }, { mode: 'auto', paths: '**' }, { mode: 'auto', paths: ['../**'] }, { mode: 'auto', paths: ['[ab]'] }]) {
    const f = fixture(t, policy); update(f, 'AGENTS.md', 'Change');
    assert.throws(() => propose(f), /policy|glob/); assert.equal(revisionHistory(f.id, f.options).length, 1);
  }
  const f = fixture(t); symlinkSync(join(f.root, 'elsewhere'), join(f.packagePath, 'link'));
  assert.throws(() => propose(f), /unsupported/);
  assert.throws(() => proposeSoulRevision(f.id, f.packagePath, f.options), /reason/);
});

test('retired souls and corrupt stored snapshots fail closed', async (t) => {
  const f = fixture(t); update(f, 'AGENTS.md', 'Change'); const p = propose(f);
  writeFileSync(join(f.stateDir, `${f.id}.json`), JSON.stringify({ ...f.identity, status: 'retired' }));
  assert.throws(() => propose(f), /retired/); assert.throws(() => decide(f, p), /retired/);
  await assert.rejects(editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'edit' }), /retired/);
  const g = fixture(t); const q = propose(g);
  const tree = revisionPackagePath(g.id, q.revision, g.options); writeFileSync(join(tree, 'AGENTS.md'), 'tampered');
  assert.throws(() => decide(g, q), /mismatch/); assert.equal(revisionHistory(g.id, g.options).length, 1);
});

test('explicit Agent Space promotion records provenance and follows ask/auto/user flow', async (t) => {
  const f = fixture(t); const space = join(f.root, 'space'); mkdirSync(space);
  writeFileSync(join(space, 'lesson.md'), 'Learned lesson');
  const options = { ...f.options, reason: 'Keep lesson', resolveSpace: () => space };
  assert.equal(revisionHistory(f.id, f.options).length, 1);
  const p = await promoteSpaceContent(f.id, 'lesson.md', 'knowledge/lesson.md', options);
  assert.equal(p.status, 'pending'); assert.match(p.reason, new RegExp(`Agent Space ${f.id}/lesson.md`));
  assert.equal(revisionHistory(f.id, f.options).length, 1); decide(f, p);
  assert.equal(readFileSync(join(space, 'lesson.md'), 'utf8'), 'Learned lesson');
  const edited = await promoteSpaceContent(f.id, 'lesson.md', 'user.md', { ...options, actor: 'user' });
  assert.equal(edited.author, 'user'); assert.match(edited.reason, /lesson.md/);
  const g = fixture(t, { mode: 'auto', paths: ['lesson.md'] });
  const auto = await promoteSpaceContent(g.id, 'lesson.md', 'lesson.md', { ...g.options, reason: 'Promote', resolveSpace: () => space });
  assert.equal(auto.status, 'approved');
});

test('promotion rejects traversal, symlinks, directories and invalid actors', async (t) => {
  const f = fixture(t); const space = join(f.root, 'space'); mkdirSync(space);
  writeFileSync(join(space, 'lesson'), 'Safe'); symlinkSync(f.packagePath, join(space, 'link'));
  const options = { ...f.options, reason: 'Promote', resolveSpace: () => space };
  for (const [source, dest] of [['../outside', 'x'], ['lesson', '../x'], ['/etc/passwd', 'x'], ['link/AGENTS.md', 'x'], ['link', 'x']]) {
    await assert.rejects(promoteSpaceContent(f.id, source, dest, options));
  }
  await assert.rejects(promoteSpaceContent(f.id, 'lesson', 'x', { ...options, actor: 'other' }), /actor/);
});

test('CLI exposes JSON history/proposals and guards all user actions through host authorization seam', async (t) => {
  const f = fixture(t); update(f, 'AGENTS.md', 'CLI proposal');
  const p = await revisionCommand(['propose', f.id, f.packagePath, 'CLI change'], { ...f.options, assertSoulTarget: () => {} });
  assert.equal(p.status, 'pending');
  const deny = { ...f.options, assertUser: () => { throw new Error('user authorization denied'); } };
  for (const args of [['edit', f.id, f.packagePath, 'reason'], ['adopt', f.id, f.packagePath, 'reason'],
    ['approve', f.id, p.proposalId, 'reason'], ['reject', f.id, p.proposalId, 'reason']]) {
    await assert.rejects(revisionCommand(args, deny), /authorization denied/);
  }
  await revisionCommand(['approve', f.id, p.proposalId, 'Reviewed'], { ...f.options, assertUser: () => {} });
  const cli = new URL('../agent-bot.mjs', import.meta.url).pathname;
  for (const cmd of ['history', 'list']) {
    const result = spawnSync(process.execPath, [cli, 'soul', 'revision', cmd, f.id], { encoding: 'utf8', env: { ...process.env, AGENT_BOT_STATE_HOME: f.stateDir } });
    assert.equal(result.status, 0, result.stderr); assert.ok(Array.isArray(JSON.parse(result.stdout)));
  }
  const denied = spawnSync(process.execPath, [cli, 'soul', 'revision', 'edit', f.id, f.packagePath, 'reason'], {
    encoding: 'utf8', env: { ...process.env, AGENT_BOT_ID: f.id, AGENT_BOT_STATE_HOME: f.stateDir },
  });
  assert.equal(denied.status, 1); assert.match(denied.stderr, /owner only/);
  await assert.rejects(revisionCommand(['propose', f.id], f.options), /usage/);
});

test('concurrent edits either append a linear chain or fail stale without lost writes', async (t) => {
  const f = fixture(t); const second = join(f.root, 'second.soul'); cpSync(f.packagePath, second, { recursive: true });
  update(f, 'AGENTS.md', 'One'); writeFileSync(join(second, 'AGENTS.md'), 'Two');
  const outcomes = await Promise.allSettled([editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'One' }),
    editSoulRevision(f.id, second, { ...f.options, reason: 'Two' })]);
  const history = revisionHistory(f.id, f.options);
  assert.equal(history.length, 1 + outcomes.filter((o) => o.status === 'fulfilled').length);
  for (let i = 1; i < history.length; i++) assert.equal(history[i].parentRevision, history[i - 1].revision);
  for (const o of outcomes.filter((o) => o.status === 'rejected')) assert.match(o.reason.message, /stale/);
});


test('self-consistent tampering cannot replace a content-addressed proposal snapshot', (t) => {
  const f = fixture(t); update(f, 'AGENTS.md', 'Proposal'); const p = propose(f);
  const tree = revisionPackagePath(f.id, p.revision, f.options);
  writeFileSync(join(tree, 'AGENTS.md'), 'Substituted');
  const manifest = JSON.parse(readFileSync(join(tree, 'soul.json')));
  manifest.revision = computePackageRevision(tree); writeFileSync(join(tree, 'soul.json'), JSON.stringify(manifest));
  assert.throws(() => decide(f, p), /hash mismatch/);
  assert.throws(() => revisionPackagePath(f.id, p.revision, f.options), /hash mismatch/);
});

test('CLI denies cross-soul proposals even if their policy would auto-apply', (t) => {
  const f = fixture(t, { mode: 'auto', paths: ['**'] }); update(f, 'AGENTS.md', 'Cross-soul');
  const other = mintAgentIdentity({ ...f.options, appSlug: 'test-agent' });
  const result = spawnSync(process.execPath, [new URL('../agent-bot.mjs', import.meta.url).pathname,
    'soul', 'revision', 'propose', f.id, f.packagePath, 'Unauthorized'], {
    encoding: 'utf8', env: { ...process.env, AGENT_BOT_ID: other.id, AGENT_BOT_STATE_HOME: f.stateDir },
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /only to its own package/);
  assert.equal(revisionHistory(f.id, f.options).length, 1);
});

test('CLI denies soul actions from an unbound caller', (t) => {
  const f = fixture(t, { mode: 'auto', paths: ['**'] }); update(f, 'AGENTS.md', 'Unbound');
  // No Agent ID and no harness markers: an owner shell, where both lookups are null.
  const env = { PATH: process.env.PATH, HOME: f.stateDir, AGENT_BOT_STATE_HOME: f.stateDir, GIT_CONFIG_GLOBAL: '/dev/null' };
  const result = spawnSync(process.execPath, [new URL('../agent-bot.mjs', import.meta.url).pathname,
    'soul', 'revision', 'propose', f.id, f.packagePath, 'Unbound'], { encoding: 'utf8', env, cwd: f.stateDir });
  assert.equal(result.status, 1); assert.match(result.stderr, /only to its own package/);
  assert.equal(revisionHistory(f.id, f.options).length, 1);
});

for (const change of ['add', 'modify', 'remove', 'mode']) {
  test(`bin ${change} cannot auto-approve and uses the existing owner gate`, async (t) => {
    const f = fixture(t, { mode: 'auto', paths: ['**'] });
    if (change !== 'add') {
      update(f, 'bin/run', 'original');
      await editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'Install tool' });
    }
    if (change === 'remove') rmSync(join(f.packagePath, 'bin'), { recursive: true });
    else if (change === 'mode') chmodSync(join(f.packagePath, 'bin/run'), 0o755);
    else update(f, 'bin/run', 'new code');
    const before = revisionHistory(f.id, f.options).length;
    const p = propose(f);
    assert.equal(p.requiresUser, true);
    assert.equal(p.status, 'pending');
    assert.equal(revisionHistory(f.id, f.options).length, before);
    const args = ['approve', f.id, p.proposalId, 'Reviewed tool'];
    await assert.rejects(revisionCommand(args, { ...f.options, assertUser: () => {
      throw new Error('owner denied');
    } }), /owner denied/);
    assert.equal(revisionHistory(f.id, f.options).length, before);
    let calls = 0;
    const approved = await revisionCommand(args, { ...f.options, assertUser: (action) => {
      assert.equal(action, `soul revision approve ${f.id}`);
      calls++;
      return { method: 'consent' };
    } });
    assert.equal(calls, 1);
    assert.equal(approved.approval, 'user');
    assert.deepEqual(approved.authorization, { method: 'consent' });
  });
}

test('v2 snapshots and proposal diffs exclude working state but include marked harness files', async (t) => {
  const f = fixture(t, { mode: 'auto', paths: ['**'] });
  const manifest = JSON.parse(readFileSync(join(f.packagePath, 'soul.json')));
  update(f, 'soul.json', { ...manifest, formatVersion: 2, ignore: PACKAGE_IGNORE_LIST });
  await editSoulRevision(f.id, f.packagePath, { ...f.options, reason: 'Upgrade format' });
  const before = revisionPackagePath(f.id, revisionHistory(f.id, f.options).at(-1).revision, f.options);
  mkdirSync(join(f.packagePath, 'worktrees'));
  symlinkSync('missing', join(f.packagePath, 'worktrees/checkout'));
  update(f, '.soul-state/cache', 'private state');
  assert.deepEqual(diffSoulPackages(before, f.packagePath), []);
  const revision = computePackageRevision(f.packagePath);
  const markedFiles = ['CLAUDE.md', '.claude/x.md', '.codex/nested/generated.md'];
  for (const path of markedFiles) update(f, path, `${GENERATED_HARNESS_MARKER}\noutput`);
  assert.notEqual(computePackageRevision(f.packagePath), revision);
  update(f, '.codex/authored.md', 'authored');
  const p = propose(f);
  assert.deepEqual(p.diff, ['.claude', '.claude/x.md', '.codex', '.codex/authored.md',
    '.codex/nested', '.codex/nested/generated.md', 'CLAUDE.md'].map((path) => ({ path, change: 'added' })));
  const stored = revisionPackagePath(f.id, p.revision, f.options);
  for (const path of ['worktrees', '.soul-state']) assert.equal(existsSync(join(stored, path)), false);
  assert.equal(readFileSync(join(stored, '.codex/authored.md'), 'utf8'), 'authored');
  for (const path of markedFiles) assert.equal(readFileSync(join(stored, path), 'utf8'), `${GENERATED_HARNESS_MARKER}\noutput`);
  assert.equal(existsSync(join(f.packagePath, '.soul-state/cache')), true, 'source working state survives');
});
