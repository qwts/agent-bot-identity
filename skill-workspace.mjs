// Progressive skill loading (#603). An installed skill lives in the soul's
// `skills/<name>/`; `load` copies it into one of the soul's workspaces at the
// harness's skills folder while the work needs it, and `unload` takes it out
// again. The copy is kept out of commits through the repository's local
// `info/exclude`, never its tracked `.gitignore` (owner direction on #603: a
// repo's harness folders stay ignored unless there is an overwhelming reason).
// Nothing here changes the soul package, so no revision is recorded.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateAgentId } from './agent-identity.mjs';
import { soulDirectory } from './agent-population.mjs';
import { harnessSkillsDirectory } from './soul-builder.mjs';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKSPACE = /^[A-Za-z0-9._-]{1,128}$/;
const EXCLUDE_NOTE = '# agent-bot soul skill load';
const FILES_MAX = 2000;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const exists = file => { try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const git = (args, cwd) => execFileSync('git', args, { cwd, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();

// Load records sit in the soul's runtime state, not its package.
export const loadRecordPath = (soul, workspace, name) => path.join(soul, '.soul-state', 'skill-loads', workspace, `${name}.json`);

function select(name, agentId, { workspace, harness = 'claude', ...options }) {
  validateAgentId(agentId);
  if (typeof name !== 'string' || name.length > 64 || !NAME.test(name)) fail('skill-name-invalid', 'select an installed skill by its name');
  if (typeof workspace !== 'string' || !WORKSPACE.test(workspace) || workspace === '.' || workspace === '..') fail('skill-workspace-invalid', 'select one of the soul\'s workspaces by its folder name under worktrees/');
  const skills = harnessSkillsDirectory(harness);
  if (skills === undefined) fail('skill-harness-invalid', `${harness} is not a known harness`);
  if (skills === null) fail('skill-harness-unsupported', `${harness} has no skills folder to load into`);
  const soul = soulDirectory(agentId, { ...options, readOnly: true });
  const link = path.join(soul, 'worktrees', workspace);
  if (!exists(link)) fail('skill-workspace-not-found', `worktrees/${workspace} is not in this soul`);
  const root = realpathSync(link);
  let toplevel;
  try { toplevel = realpathSync(git(['rev-parse', '--show-toplevel'], root)); } catch { toplevel = null; }
  if (toplevel !== root) fail('skill-workspace-not-git', `worktrees/${workspace} is not the top of a git checkout`);
  const relative = `${skills}${name}`;
  return { soul, root, relative, destination: path.join(root, ...relative.split('/')), harness, workspace, name };
}

// Every folder between the workspace and the destination is a real folder,
// so the copy cannot follow a link out of the workspace.
function safeParents(root, relative) {
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    const stat = exists(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('skill-path-unsafe', `${path.relative(root, current)} is not a real folder`);
  }
}

// The live skill's regular files, refusing links so nothing outside the soul is read.
function readSkill(directory) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail('skill-path-unsafe', `skills/${path.basename(directory)}/${relative} is a link`);
      if (entry.isDirectory()) walk(file, relative);
      else if (entry.isFile()) {
        if (files.length >= FILES_MAX) fail('skill-load-too-large', `the skill has more than ${FILES_MAX} files`);
        const bytes = readFileSync(file);
        files.push({ path: relative, bytes, mode: lstatSync(file).mode & 0o111 ? '100755' : '100644' });
      } else fail('skill-path-unsafe', `skills/${path.basename(directory)}/${relative} is not a regular file`);
    }
  };
  walk(directory, '');
  return files;
}

function excludeFile(root) {
  const file = git(['rev-parse', '--git-path', 'info/exclude'], root);
  return path.resolve(root, file);
}
const excludeLine = relative => `/${relative}/`;
function readLines(file) {
  try { return readFileSync(file, 'utf8').split('\n'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/**
 * Copies the soul's installed `skills/<name>/` into `worktrees/<workspace>/`
 * at the harness's skills folder (`.claude/skills/<name>/` by default), adds
 * that folder to the repository's local exclude list unless git already
 * ignores it, and records the copied hashes so `unload` removes only what it
 * placed. Refuses when anything already sits at the destination.
 */
export function loadSkill(name, agentId, { now = () => new Date(), ...options } = {}) {
  const target = select(name, agentId, options);
  const source = path.join(target.soul, 'skills', name), stat = exists(source);
  if (!stat) fail('skill-not-installed', `skills/${name} is not in this soul; install it first`);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('skill-path-unsafe', `skills/${name} is not a real folder`);
  const files = readSkill(source);
  if (!files.some(file => file.path === 'SKILL.md')) fail('skill-entrypoint-missing', `skills/${name} has no SKILL.md`);
  const recordFile = loadRecordPath(target.soul, target.workspace, name);
  if (exists(recordFile)) fail('skill-load-exists', `${name} is already loaded in worktrees/${target.workspace}; unload it first`);
  safeParents(target.root, target.relative);
  if (exists(target.destination)) fail('skill-load-exists', `${target.relative} already exists in worktrees/${target.workspace}`);
  // Already ignored only when git ignores every file the copy places; a rule
  // that matches SKILL.md (or *.md) alone would leave the rest committable.
  const paths = files.map(file => `${target.relative}/${file.path}`);
  let ignored;
  try {
    const listed = execFileSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], { cwd: target.root, env: { PATH: process.env.PATH }, input: paths.join('\0'), stdio: ['pipe', 'pipe', 'ignore'] });
    const matched = new Set(listed.toString('utf8').split('\0').filter(Boolean));
    ignored = paths.every(item => matched.has(item));
  } catch { ignored = false; /* exit 1: nothing ignored */ }
  // Stage beside the destination, then rename, so a harness never sees half a skill.
  const parent = path.dirname(target.destination);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const staging = path.join(parent, `.${name}.loading-${process.pid}-${Date.now()}`);
  try {
    for (const file of files) {
      const out = path.join(staging, ...file.path.split('/'));
      mkdirSync(path.dirname(out), { recursive: true, mode: 0o755 });
      writeFileSync(out, file.bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 });
      chmodSync(out, file.mode === '100755' ? 0o755 : 0o644);
    }
    renameSync(staging, target.destination);
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  let excluded = ignored ? 'already-ignored' : 'added';
  if (!ignored) {
    try {
      const file = excludeFile(target.root), lines = readLines(file), line = excludeLine(target.relative);
      if (!lines.includes(line)) {
        mkdirSync(path.dirname(file), { recursive: true });
        const text = lines.join('\n');
        writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_NOTE}\n${line}\n`);
      } else excluded = 'already-ignored';
    } catch (error) {
      rmSync(target.destination, { recursive: true, force: true });
      throw Object.assign(new Error(`could not keep ${target.relative} out of commits: ${error.message}`), { code: 'skill-load-exclude-failed' });
    }
  }
  const record = { schemaVersion: 1, name, workspace: target.workspace, harness: target.harness, destination: target.relative,
    excluded, files: Object.fromEntries(files.map(file => [file.path, { mode: file.mode, size: file.bytes.length, sha256: sha256(file.bytes) }])),
    loadedAt: now().toISOString() };
  mkdirSync(path.dirname(recordFile), { recursive: true, mode: 0o700 });
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { name, workspace: target.workspace, harness: target.harness, destination: target.relative, files: files.length, excluded };
}

// The files now at the destination, compared with what load placed.
function changedFiles(destination, recorded) {
  const changed = [];
  const seen = new Set();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) { walk(file, relative); continue; }
      seen.add(relative);
      const expected = recorded[relative];
      if (!expected || !entry.isFile() || sha256(readFileSync(file)) !== expected.sha256) changed.push(relative);
    }
  };
  walk(destination, '');
  for (const relative of Object.keys(recorded)) if (!seen.has(relative)) changed.push(relative);
  return changed.sort();
}

/**
 * Removes a skill `load` placed in `worktrees/<workspace>/`, and the exclude
 * line it added once no other load of the same folder still needs it. Refuses
 * when the copy was edited there, so work is never lost: copy the change into
 * the soul's skill (a revision) first, or move the folder aside.
 */
export function unloadSkill(name, agentId, options = {}) {
  const target = select(name, agentId, options);
  const recordFile = loadRecordPath(target.soul, target.workspace, name);
  if (!exists(recordFile)) fail('skill-not-loaded', `${name} was not loaded in worktrees/${target.workspace}`);
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  if (record.destination !== target.relative) fail('skill-harness-mismatch', `${name} was loaded at ${record.destination}; unload it with --harness ${record.harness}`);
  safeParents(target.root, target.relative);
  const stat = exists(target.destination);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('skill-path-unsafe', `${target.relative} is not a real folder`);
    const changed = changedFiles(target.destination, record.files);
    if (changed.length) fail('skill-load-modified', `${target.relative} was changed in the workspace (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', ...' : ''}); keep the change in the soul's skill or move the folder aside, then unload`);
    rmSync(target.destination, { recursive: true });
  }
  // The line goes once no load in a worktree sharing this exclude file
  // (worktrees of one repository do) still has the folder, and only when the
  // line is one load added, under its note; a line the user wrote stays.
  let exclude = 'kept';
  {
    const file = excludeFile(target.root);
    const others = readdirSync(path.join(target.soul, '.soul-state', 'skill-loads'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== target.workspace)
      .some(entry => {
        try {
          const other = JSON.parse(readFileSync(loadRecordPath(target.soul, entry.name, name), 'utf8'));
          return other.destination === target.relative
            && excludeFile(realpathSync(path.join(target.soul, 'worktrees', entry.name))) === file;
        } catch { return false; }
      });
    if (!others) {
      const lines = readLines(file), line = excludeLine(target.relative);
      const at = lines.indexOf(line);
      if (at > 0 && lines[at - 1] === EXCLUDE_NOTE) {
        lines.splice(at - 1, 2);
        writeFileSync(file, lines.join('\n'));
        exclude = 'removed';
      }
    }
  }
  rmSync(recordFile);
  return { name, workspace: target.workspace, harness: record.harness, destination: target.relative, removed: Boolean(stat), exclude };
}
