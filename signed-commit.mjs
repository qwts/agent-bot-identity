#!/usr/bin/env node
// Replay a linear range of local commits through GitHub's Git Data API. The
// resulting commits are signed by GitHub and attributed to the App identity
// resolved for this worktree. The remote ref update uses a two-point lease;
// an unexpected push before or during replay fails closed.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { apiBase, githubHost, loadConfig } from './config.mjs';
import { mint } from './mint-token.mjs';
import { resolveAgentSlug, territoryHarness } from './resolve-agent.mjs';

const MAX_BUFFER = 256 * 1024 * 1024;

export function parseSignedCommitArgs(argv) {
  const options = { base: null, branch: null, repo: null, dryRun: false, allowDefaultBranch: false };
  const values = new Map([['--base', 'base'], ['--branch', 'branch'], ['--repo', 'repo']]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (values.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[values.get(arg)] = value;
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-default-branch') options.allowDefaultBranch = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.repo && !/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
    throw new Error('--repo must be owner/name');
  }
  return options;
}

export function repositoryFromRemote(remote, expectedHost = 'github.com') {
  const escaped = expectedHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = remote.match(new RegExp(`^(?:https?://${escaped}/|git@${escaped}:)([^/\\s]+/[^/\\s]+?)(?:\\.git)?$`, 'i'));
  if (!match) throw new Error(`origin is not a repository on ${expectedHost} — pass --repo owner/name`);
  return match[1];
}

export function assertLease(remoteSha, trackingSha, branch) {
  if (remoteSha === null) return;
  if (remoteSha !== trackingSha) {
    throw new Error(
      `${branch} on the remote is at ${remoteSha.slice(0, 8)}, but this checkout last saw ` +
      `${trackingSha ? trackingSha.slice(0, 8) : 'no remote branch'} — someone else pushed. Nothing was written.\n` +
      `Recover with: git fetch origin ${branch} && git rebase origin/${branch}`,
    );
  }
}

export function encodeRefPath(ref) {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function git(args, { cwd, encoding = 'utf8' } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding,
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitTrim(args, cwd) {
  return git(args, { cwd }).trim();
}

function tryGit(args, cwd) {
  try { return gitTrim(args, cwd); } catch { return null; }
}

function localDefaultBranch(cwd) {
  const symbolic = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (symbolic?.startsWith('origin/')) return symbolic.slice('origin/'.length);
  return 'main';
}

export function signedCommitHelp() {
  return `Usage: agent-bot signed-commit [options]\n\n` +
    `Options:\n` +
    `  --base <ref>             First parent of the range (default: merge-base with remote default)\n` +
    `  --branch <name>          Remote branch (default: current branch)\n` +
    `  --repo <owner/name>      Repository (default: origin URL)\n` +
    `  --dry-run                Preview locally without minting or network access\n` +
    `  --allow-default-branch   Permit rewriting the default branch\n`;
}

function changedEntries(sha, parent, cwd) {
  const raw = gitTrim(['diff', '--name-status', '-M', '-z', parent, sha], cwd);
  if (!raw) return [];
  const fields = raw.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    const pathA = fields[i++];
    const pathB = /^[RC]/.test(status) ? fields[i++] : null;
    if (status.startsWith('D')) entries.push({ path: pathA, mode: '100644', type: 'blob', sha: null });
    if (status.startsWith('R')) entries.push({ path: pathA, mode: '100644', type: 'blob', sha: null });
    if (status.startsWith('D')) continue;
    const path = pathB ?? pathA;
    const meta = gitTrim(['ls-tree', sha, '--', path], cwd);
    if (!meta) throw new Error(`could not read ${path} from ${sha.slice(0, 8)}`);
    const [mode, type] = meta.split(/\s+/);
    if (type === 'commit') throw new Error(`${path} is a submodule — submodule bumps are not supported`);
    entries.push({ path, mode, type: 'blob', content: git(['show', `${sha}:${path}`], { cwd, encoding: 'buffer' }) });
  }
  return entries;
}

function makeApi({ base, token, fetchImpl }) {
  return async (path, method = 'GET', body) => {
    const response = await fetchImpl(`${base}/${path.replace(/^\/+/, '')}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'agent-bot-identity',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`${method} ${path} -> ${response.status}: ${result.message ?? 'unknown error'}`);
      error.status = response.status;
      throw error;
    }
    return result;
  };
}

export async function runSignedCommit(options, {
  cwd = process.cwd(), env = process.env, fetchImpl = fetch, mintImpl = mint,
  stdout = process.stdout, stderr = process.stderr,
} = {}) {
  if (options.help) { stdout.write(signedCommitHelp()); return { dryRun: true, help: true }; }
  if (gitTrim(['status', '--porcelain'], cwd)) {
    throw new Error('working tree is dirty — commit or stash first, so the signed commit matches what you tested');
  }
  const config = loadConfig({ env });
  const host = githubHost(config);
  const repo = options.repo ?? repositoryFromRemote(gitTrim(['remote', 'get-url', 'origin'], cwd), host);
  const branch = options.branch ?? gitTrim(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === 'HEAD') throw new Error('detached HEAD — pass --branch <name>');

  let defaultBranch = localDefaultBranch(cwd);
  let api = null;
  if (!options.dryRun) {
    if (!territoryHarness(cwd)) {
      throw new Error('refusing signed publishing outside bot territory');
    }
    const slug = resolveAgentSlug({ env, cwd, config, worktree: true });
    if (!slug) throw new Error('no agent App identity resolved for this worktree');
    const { token } = await mintImpl({ slug, env });
    api = makeApi({ base: apiBase(config), token, fetchImpl });
    const metadata = await api(`repos/${repo}`);
    defaultBranch = metadata.default_branch;
  }
  if (branch === defaultBranch && !options.allowDefaultBranch) {
    throw new Error(`refusing to rewrite the default branch (${defaultBranch}) — pass --allow-default-branch if intended`);
  }
  let base = options.base ? gitTrim(['rev-parse', options.base], cwd) : null;
  if (!base) {
    for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
      base = tryGit(['merge-base', ref, 'HEAD'], cwd);
      if (base) break;
    }
  }
  if (!base) throw new Error(`could not find a merge-base with ${defaultBranch} — pass --base <ref>`);
  const head = gitTrim(['rev-parse', 'HEAD'], cwd);
  if (base === head) throw new Error('nothing to sign — HEAD is already at the base');
  const commits = gitTrim(['rev-list', '--reverse', `${base}..${head}`], cwd).split('\n').filter(Boolean);
  for (const sha of commits) {
    const parents = gitTrim(['rev-list', '--parents', '-n', '1', sha], cwd).split(/\s+/).slice(1);
    if (parents.length > 1) throw new Error(`${sha.slice(0, 8)} is a merge commit — rebase into linear history first`);
  }

  const refName = `heads/${branch}`;
  const refPath = encodeRefPath(refName);
  const readRemote = async () => {
    try { return (await api(`repos/${repo}/git/ref/${refPath}`)).object.sha; }
    catch (error) { if (error.status === 404) return null; throw error; }
  };
  const remoteBefore = options.dryRun ? null : await readRemote();
  if (!options.dryRun) {
    const tracking = tryGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], cwd);
    assertLease(remoteBefore, tracking, branch);
  }
  stdout.write(`repo    ${repo}\nbranch  ${branch}\nbase    ${base.slice(0, 8)}\n`);
  stdout.write(`remote  ${options.dryRun ? '(not checked — dry run)' : remoteBefore?.slice(0, 8) ?? '(new branch)'}\n`);
  stdout.write(`commits ${commits.length}\n\n`);

  let localParent = base;
  let apiParent = base;
  let apiTree = gitTrim(['rev-parse', `${base}^{tree}`], cwd);
  for (const sha of commits) {
    const message = git(['log', '-1', '--format=%B', sha], { cwd }).trim();
    const subject = gitTrim(['log', '-1', '--format=%s', sha], cwd);
    const entries = changedEntries(sha, localParent, cwd);
    stdout.write(`${sha.slice(0, 8)} ${subject}\n`);
    for (const entry of entries) stdout.write(`  ${entry.sha === null ? 'delete' : `write ${entry.mode}`} ${entry.path}\n`);
    if (entries.length === 0) stdout.write('  (empty commit — replayed, not dropped)\n');
    if (options.dryRun) { localParent = sha; continue; }
    const treeEntries = [];
    for (const entry of entries) {
      if (entry.sha === null) treeEntries.push(entry);
      else {
        const blob = await api(`repos/${repo}/git/blobs`, 'POST', {
          content: entry.content.toString('base64'), encoding: 'base64',
        });
        treeEntries.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: blob.sha });
      }
    }
    const treeSha = treeEntries.length
      ? (await api(`repos/${repo}/git/trees`, 'POST', { base_tree: apiTree, tree: treeEntries })).sha
      : apiTree;
    const created = await api(`repos/${repo}/git/commits`, 'POST', {
      message, tree: treeSha, parents: [apiParent],
    });
    if (!created.verification?.verified) {
      throw new Error(`${created.sha.slice(0, 8)} came back unsigned (${created.verification?.reason ?? 'unknown'})`);
    }
    const localTree = gitTrim(['rev-parse', `${sha}^{tree}`], cwd);
    if (localTree !== treeSha) {
      throw new Error(`tree mismatch on ${sha.slice(0, 8)}: local ${localTree.slice(0, 8)} vs signed ${treeSha.slice(0, 8)}`);
    }
    stdout.write(`  -> ${created.sha.slice(0, 8)} verified (${created.verification.reason})\n`);
    localParent = sha;
    apiParent = created.sha;
    apiTree = treeSha;
  }
  if (options.dryRun) { stdout.write('\ndry run — nothing was created or pushed\n'); return { dryRun: true, commits }; }

  const remoteNow = await readRemote();
  if (remoteNow !== remoteBefore) {
    throw new Error(`${branch} moved on the remote during replay — nothing was pushed`);
  }
  if (remoteBefore === null) {
    await api(`repos/${repo}/git/refs`, 'POST', { ref: `refs/${refName}`, sha: apiParent });
  } else {
    await api(`repos/${repo}/git/refs/${refPath}`, 'PATCH', { sha: apiParent, force: true });
  }
  stdout.write(`\n${branch} -> ${apiParent}\n`);
  try {
    git(['fetch', 'origin', branch, '--quiet'], { cwd });
    git(['reset', '--hard', apiParent, '--quiet'], { cwd });
    stdout.write('local branch reset to the signed history\n');
  } catch (error) {
    stderr.write(`PUSH SUCCEEDED — ${branch} is at ${apiParent}; local reset failed: ${error.message}\n`);
    throw error;
  }
  return { dryRun: false, commits, sha: apiParent };
}

async function main() {
  await runSignedCommit(parseSignedCommitArgs(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`signed-commit: ${error.message}\n`);
    process.exitCode = 1;
  });
}
