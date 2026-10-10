import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintAgentIdentity } from '../agent-identity.mjs';
import { upsertSoul } from '../agent-population.mjs';
import { loadRecordPath, loadSkill, unloadSkill } from '../skill-workspace.mjs';
import { main } from '../cli/soul-skill.mjs';

const put = (file, bytes, mode) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); if (mode) chmodSync(file, mode); };
const git = (args, cwd) => execFileSync('git', args, { cwd, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
const skill = '---\nname: demo\ndescription: A load fixture\n---\nSee references/guide.md.\n';

function fixture(t) {
  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'skill-workspace-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, AGENT_BOT_STATE_HOME: path.join(home, 'state'), AGENT_BOT_SOULS_HOME: path.join(home, 'souls'), AGENT_BOT_POPULATION_PATH: path.join(home, 'population.json') };
  const options = { home, env, stateDir: env.AGENT_BOT_STATE_HOME, file: env.AGENT_BOT_POPULATION_PATH, now: () => new Date('2026-10-10T01:02:03.004Z') };
  const soul = path.join(home, 'souls/example.soul');
  const { id } = mintAgentIdentity({ ...options, appSlug: 'test-agent' });
  put(path.join(soul, '.soul-state/agent-id'), `${id}\n`);
  upsertSoul({ id, name: 'example', status: 'active', soulDir: soul, spacePath: path.join(home, 'space'), roles: ['test'], harness: 'claude', app: 'test-agent' }, { file: options.file });
  put(path.join(soul, 'skills/demo/SKILL.md'), skill);
  put(path.join(soul, 'skills/demo/references/guide.md'), 'guide\n');
  put(path.join(soul, 'skills/demo/scripts/run'), '#!/bin/sh\nexit 0\n', 0o755);
  const repo = path.join(soul, 'worktrees/repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  put(path.join(repo, 'README.md'), 'repo\n');
  git(['add', 'README.md'], repo);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init'], repo);
  const exclude = path.join(repo, '.git/info/exclude');
  const status = (cwd = repo) => git(['status', '--porcelain', '--untracked-files=all'], cwd);
  const run = async (argv, extra = { markers: () => [] }) => {
    const out = [], err = [];
    const code = await main(argv, { ...options, ...extra, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
    return { code, out: out.join(''), err: err.join(''), json: out.length ? JSON.parse(out.join('')) : null };
  };
  return { home, options, soul, id, repo, exclude, status, run };
}

test('load copies an installed skill into the worktree and keeps it out of commits', async t => {
  const f = fixture(t);
  const result = await f.run(['load', 'demo', '--soul', f.id, '--workspace', 'repo', '--json']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual({ ...result.json, notCaptured: undefined }, { name: 'demo', workspace: 'repo', harness: 'claude', destination: '.claude/skills/demo', files: 3, excluded: 'added', notCaptured: undefined });
  assert.equal(readFileSync(path.join(f.repo, '.claude/skills/demo/SKILL.md'), 'utf8'), skill);
  assert.ok(lstatSync(path.join(f.repo, '.claude/skills/demo/scripts/run')).mode & 0o100, 'executable bit kept');
  assert.match(readFileSync(f.exclude, 'utf8'), /# agent-bot soul skill load\n\/\.claude\/skills\/demo\/\n$/);
  assert.equal(f.status(), '', 'nothing to commit');
  assert.equal(existsSync(path.join(f.repo, '.gitignore')), false, 'the tracked .gitignore is never written');
  const record = JSON.parse(readFileSync(loadRecordPath(f.soul, 'repo', 'demo'), 'utf8'));
  assert.deepEqual(Object.keys(record.files).sort(), ['SKILL.md', 'references/guide.md', 'scripts/run']);
  assert.equal(record.destination, '.claude/skills/demo');
});

test('unload removes the copy and the exclude line it added', async t => {
  const f = fixture(t);
  const before = readFileSync(f.exclude, 'utf8');
  loadSkill('demo', f.id, { ...f.options, workspace: 'repo' });
  const result = await f.run(['unload', 'demo', '--soul', f.id, '--workspace', 'repo', '--json']);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.json.exclude, 'removed');
  assert.equal(existsSync(path.join(f.repo, '.claude/skills/demo')), false);
  assert.equal(readFileSync(f.exclude, 'utf8'), before, 'exclude file restored');
  assert.equal(existsSync(loadRecordPath(f.soul, 'repo', 'demo')), false);
  assert.throws(() => unloadSkill('demo', f.id, { ...f.options, workspace: 'repo' }), { code: 'skill-not-loaded' });
});

test('unload refuses a copy edited in the workspace and leaves it in place', t => {
  const f = fixture(t);
  loadSkill('demo', f.id, { ...f.options, workspace: 'repo' });
  writeFileSync(path.join(f.repo, '.claude/skills/demo/SKILL.md'), `${skill}edited\n`);
  put(path.join(f.repo, '.claude/skills/demo/notes.md'), 'new\n');
  assert.throws(() => unloadSkill('demo', f.id, { ...f.options, workspace: 'repo' }), error => error.code === 'skill-load-modified' && /SKILL\.md, notes\.md/.test(error.message));
  assert.match(readFileSync(path.join(f.repo, '.claude/skills/demo/SKILL.md'), 'utf8'), /edited/);
  assert.ok(existsSync(loadRecordPath(f.soul, 'repo', 'demo')));
});

test('load refuses anything already at the destination, including a tracked skill', t => {
  const f = fixture(t);
  put(path.join(f.repo, '.claude/skills/demo/SKILL.md'), 'the repo\'s own\n');
  git(['add', '.'], f.repo);
  const before = readFileSync(f.exclude, 'utf8');
  assert.throws(() => loadSkill('demo', f.id, { ...f.options, workspace: 'repo' }), { code: 'skill-load-exists' });
  assert.equal(readFileSync(path.join(f.repo, '.claude/skills/demo/SKILL.md'), 'utf8'), 'the repo\'s own\n');
  assert.equal(readFileSync(f.exclude, 'utf8'), before);
  assert.equal(existsSync(loadRecordPath(f.soul, 'repo', 'demo')), false);
});

test('a folder git already ignores is left to the repository', t => {
  const f = fixture(t);
  put(path.join(f.repo, '.gitignore'), '.claude/\n');
  const before = readFileSync(f.exclude, 'utf8');
  assert.equal(loadSkill('demo', f.id, { ...f.options, workspace: 'repo' }).excluded, 'already-ignored');
  assert.equal(readFileSync(f.exclude, 'utf8'), before);
  assert.equal(unloadSkill('demo', f.id, { ...f.options, workspace: 'repo' }).exclude, 'kept');
  assert.equal(readFileSync(f.exclude, 'utf8'), before);
});

test('the harness picks the skills folder; one without skills is refused', t => {
  const f = fixture(t);
  assert.equal(loadSkill('demo', f.id, { ...f.options, workspace: 'repo', harness: 'gemini' }).destination, '.gemini/skills/demo');
  assert.ok(existsSync(path.join(f.repo, '.gemini/skills/demo/SKILL.md')));
  assert.throws(() => unloadSkill('demo', f.id, { ...f.options, workspace: 'repo' }), { code: 'skill-harness-mismatch' });
  assert.throws(() => loadSkill('demo', f.id, { ...f.options, workspace: 'other', harness: 'codex' }), { code: 'skill-harness-unsupported' });
  assert.throws(() => loadSkill('demo', f.id, { ...f.options, workspace: 'repo', harness: 'nope' }), { code: 'skill-harness-invalid' });
});

test('load refuses unsafe workspaces, linked folders and missing skills', t => {
  const f = fixture(t);
  assert.throws(() => loadSkill('demo', f.id, { ...f.options, workspace: '..' }), { code: 'skill-workspace-invalid' });
  assert.throws(() => loadSkill('demo', f.id, { ...f.options, workspace: 'a/b' }), { code: 'skill-workspace-invalid' });
  assert.throws(() => loadSkill('demo', f.id, { ...f.options, workspace: 'missing' }), { code: 'skill-workspace-not-found' });
  mkdirSync(path.join(f.soul, 'worktrees/plain'));
  assert.throws(() => loadSkill('demo', f.id, { ...f.options, workspace: 'plain' }), { code: 'skill-workspace-not-git' });
  assert.throws(() => loadSkill('absent', f.id, { ...f.options, workspace: 'repo' }), { code: 'skill-not-installed' });
  const outside = path.join(f.home, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(f.repo, '.claude'));
  assert.throws(() => loadSkill('demo', f.id, { ...f.options, workspace: 'repo' }), { code: 'skill-path-unsafe' });
  assert.equal(existsSync(path.join(outside, 'skills')), false, 'nothing written through the link');
});

test('worktrees of one repository share the exclude line until the last unload', t => {
  const f = fixture(t);
  const second = path.join(f.soul, 'worktrees/second');
  git(['worktree', 'add', '-q', '--detach', second], f.repo);
  loadSkill('demo', f.id, { ...f.options, workspace: 'repo' });
  loadSkill('demo', f.id, { ...f.options, workspace: 'second' });
  assert.equal(f.status(second), '');
  assert.equal(unloadSkill('demo', f.id, { ...f.options, workspace: 'repo' }).exclude, 'kept');
  assert.equal(f.status(second), '', 'still ignored for the other worktree');
  assert.equal(unloadSkill('demo', f.id, { ...f.options, workspace: 'second' }).exclude, 'removed');
  assert.doesNotMatch(readFileSync(f.exclude, 'utf8'), /\.claude\/skills\/demo/);
});

test('a soul may load only into its own worktrees', async t => {
  const f = fixture(t);
  const refused = await f.run(['load', 'demo', '--soul', f.id, '--workspace', 'repo', '--json'],
    { markers: () => ['Agent ID'], assertSoulTarget: () => { throw new Error('a soul may load skills only into its own worktrees'); } });
  assert.equal(refused.code, 1);
  assert.match(refused.json.error.message, /only into its own/);
  assert.equal(existsSync(path.join(f.repo, '.claude')), false);
  const own = await f.run(['load', 'demo', '--soul', f.id, '--workspace', 'repo', '--json'], { markers: () => ['Agent ID'], assertSoulTarget: target => assert.equal(target, f.id) });
  assert.equal(own.code, 0, own.err);
  assert.equal((await f.run(['load', 'demo', '--soul', f.id])).code, 2, 'workspace is required');
});
