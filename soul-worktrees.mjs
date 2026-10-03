// Repository checkouts are discoverable from the soul (ADR-0332 decision 6).
import { chmodSync, lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Select a destination; the caller creates the git worktree there, then links
// it with linkWorktree when linked=true. Never leave a link to a failed add.
export function placeWorktree(agentId, name, {
  repoCommonDir, maxPathLength = 900, stat = statSync, ...options
} = {}) {
  const directory = ensureWorktrees(agentId, options);
  const destination = path.join(directory, sanitizeWorktreeName(name));
  const linked = stat(path.dirname(directory)).dev !== stat(repoCommonDir).dev
    || destination.length > maxPathLength;
  if (!linked) return { path: destination, linked: false };
  const temporary = path.resolve(options.env?.TMPDIR ?? process.env.TMPDIR ?? tmpdir(), 'agent-bot', agentId);
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  chmodSync(temporary, 0o700);
  return { path: path.join(temporary, sanitizeWorktreeName(name)), linked: true };
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
