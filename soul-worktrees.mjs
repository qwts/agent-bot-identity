// Repository checkouts are discoverable from the soul (ADR-0332 decision 6).
import { chmodSync, lstatSync, mkdirSync, readlinkSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { soulDirectory } from './agent-population.mjs';
import { ensureSoulDirectory } from './soul-home.mjs';

export function sanitizeWorktreeName(name) {
  if (typeof name !== 'string') throw new Error('worktree name must be text');
  return name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 100) || 'worktree';
}

export function soulWorktreePath(agentId, name, options = {}) {
  return path.join(soulDirectory(agentId, options), 'worktrees', sanitizeWorktreeName(name));
}

function ensureWorktrees(agentId, options) {
  const directory = path.join(ensureSoulDirectory(agentId, null, options), 'worktrees');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

// Select a durable destination; the caller creates the git worktree there.
export function placeWorktree(agentId, name, {
  repoCommonDir, maxPathLength = 900, stat = statSync, ...options
} = {}) {
  const soul = soulDirectory(agentId, { ...options, readOnly: true });
  const destination = path.join(soul, 'worktrees', sanitizeWorktreeName(name));
  // New souls may not have a directory yet. Check the closest existing parent
  // before provisioning anything, so placement refusals have no side effects.
  let ancestor = soul;
  let device;
  for (;;) {
    try { device = stat(ancestor).dev; break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  if (device !== stat(repoCommonDir).dev) {
    throw new Error('soul and repository are on different devices; move the repository to the soul device, or create a durable linked git worktree on the repository device and link it from the soul worktrees directory (linkWorktree). No TMPDIR fallback');
  }
  if (destination.length > maxPathLength) throw new Error('soul worktree path is too long; use a shorter name or move the soul to a shorter registered path. No TMPDIR fallback');
  ensureWorktrees(agentId, options);
  return { path: destination, linked: false };
}

export function linkWorktree(agentId, checkoutPath, options = {}) {
  const checkout = realpathSync(checkoutPath);
  const directory = ensureWorktrees(agentId, options);
  const relative = path.relative(realpathSync(directory), checkout);
  if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return checkout;
  const name = sanitizeWorktreeName(options.name ?? path.basename(checkoutPath));
  for (let suffix = 1; ; suffix++) {
    const ending = suffix === 1 ? '' : `-${suffix}`;
    const link = path.join(directory, `${name.slice(0, 100 - ending.length)}${ending}`);
    try {
      symlinkSync(checkout, link, 'dir');
      return link;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A dangling link still occupies its name. Resolve relative links too,
      // and never replace a different checkout or an ordinary directory.
      try {
        if (lstatSync(link).isSymbolicLink()
            && (path.resolve(directory, readlinkSync(link)) === checkout || realpathSync(link) === checkout)) return link;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

// Location only validates an already-resolved identity. Resolve both sides to
// avoid prefix/symlink escapes, and require a direct worktrees/<name> entry.
export function assertWorktreeArea(agentId, checkoutPath, options = {}) {
  const directory = path.join(soulDirectory(agentId, { ...options, readOnly: true }), 'worktrees');
  const checkout = realpathSync(checkoutPath);
  let entries = [];
  try { entries = readdirSync(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of entries) {
    try {
      if (realpathSync(path.join(directory, name)) === checkout) return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`refusing primary checkout or directory outside the session soul's work area; use agent-bot setup-worktree --name NAME to create ${directory}/<name>, or use an existing checkout linked from that soul`);
}
