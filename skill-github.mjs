// Public GitHub directory acquisition. Ref resolution happens once; every
// retained file is fetched at that commit and checked against its Git blob ID.
import { createHash } from 'node:crypto';
import { captureRemoteSkill, readRemoteSkillDocument, skillSourceUrl, withSkillTransport } from './skill-remote.mjs';

const SHA = /^[a-f0-9]{40}$/;
const EXCLUDED = new Set(['.git', '.hg', '.svn', 'node_modules', '.ds_store']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function part(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(value)
    || /[. ]$/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail('skill-path-unsafe', 'repository path is not a safe portable path');
  return value;
}
export function githubSkillSource(input) {
  const url = new URL(skillSourceUrl(input));
  if (url.hostname !== 'github.com') return null;
  const encoded = url.pathname.replace(/\/$/, '').split('/').slice(1);
  if (encoded[2] !== 'tree') fail('skill-source-unsupported', 'select a GitHub /owner/repo/tree/ref/skill-directory URL, or a direct raw SKILL.md URL');
  let pieces;
  try { pieces = encoded.map(value => decodeURIComponent(value)); }
  catch { fail('skill-source-unsupported', 'repository URL contains an invalid escape'); }
  const [owner, repo, , ref, ...directory] = pieces;
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner ?? '') || !/^[a-z0-9_.-]{1,100}$/i.test(repo ?? '') || ['.', '..'].includes(repo)
    || typeof ref !== 'string' || !ref || ref.length > 255 || /[\s\\~^:?*\[\x00-\x1f\x7f]/.test(ref) || ref.includes('..') || ref.includes('@{')
    || ref.split('/').some(value => !value || value.startsWith('.') || value.endsWith('.') || value.endsWith('.lock')) || directory.length > 16) {
    fail('skill-source-unsupported', 'select an explicit repository ref; encode slashes inside a ref as %2F rather than guessing a branch from the directory');
  }
  directory.forEach(part);
  if (directory.some(value => EXCLUDED.has(value.toLowerCase()))) fail('skill-path-unsafe', 'selected repository directory is excluded from acquisition');
  return { owner, repo, ref, path: directory.join('/'), url: url.href };
}
export function acquireGithubSkill(input, id, options = {}) {
  const source = githubSkillSource(input);
  if (!source) fail('skill-source-unsupported', 'this repository adapter supports public github.com tree URLs');
  return withSkillTransport(options, async context => {
    const api = `https://api.github.com/repos/${source.owner}/${source.repo}`;
    const resolved = await readRemoteSkillDocument(`${api}/commits/${encodeURIComponent(source.ref)}`, context, { accept: 'application/vnd.github.sha', allowedHosts: ['api.github.com'] });
    const commit = resolved.bytes.toString('utf8').trim();
    if (!SHA.test(commit) || /^[a-f0-9]{40}$/i.test(source.ref) && source.ref.toLowerCase() !== commit) fail('skill-repository-invalid', 'repository ref did not resolve to a full commit SHA');
    const rawRoot = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${commit}/`;
    const base = rawRoot + (source.path ? `${source.path.split('/').map(encodeURIComponent).join('/')}/` : '');
    async function tree(sha, { exact = true, portable = true } = {}) {
      const response = await readRemoteSkillDocument(`${api}/git/trees/${sha}`, context, { accept: 'application/vnd.github+json', allowedHosts: ['api.github.com'] });
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)); }
      catch { fail('skill-repository-invalid', 'repository tree response is invalid'); }
      if (!value || !SHA.test(value.sha ?? '') || exact && value.sha !== sha || !Array.isArray(value.tree)
        || value.tree.length > 4000 || value.truncated !== false) fail('skill-repository-invalid', 'repository tree is invalid, incomplete or exceeds the entry bound');
      const names = new Set();
      for (const item of value.tree) {
        if (typeof item?.path !== 'string' || !item.path || /[\/\x00]/.test(item.path)) fail('skill-repository-invalid', 'repository tree entry has no valid Git filename');
        // Ancestors are navigation only: unrelated repository filenames never
        // become local payload paths. Enforce portability inside the selected
        // directory, while still rejecting malformed/duplicate ancestor entries.
        if (portable) part(item.path);
        const key = portable ? item.path.normalize('NFC').toLowerCase() : item.path;
        if (names.has(key) || !SHA.test(item.sha ?? '') || !['blob', 'tree', 'commit'].includes(item.type)) fail('skill-repository-invalid', 'repository tree contains conflicting or invalid entries');
        names.add(key);
      }
      return value;
    }
    const components = source.path.split('/').filter(Boolean);
    let selected = await tree(commit, { exact: false, portable: components.length === 0 });
    for (const [index, component] of components.entries()) {
      const next = selected.tree.find(item => item.path === component);
      if (!next || next.type !== 'tree' || next.mode !== '040000') fail('skill-source-unsupported', 'selected repository path is not a real directory');
      selected = await tree(next.sha, { portable: index === components.length - 1 });
    }
    const rootTree = selected.sha, entries = [], locations = [], issues = [], excluded = [], names = new Set();
    const rootEntry = selected.tree.find(item => item.path === 'SKILL.md');
    if (!rootEntry || rootEntry.type !== 'blob' || !['100644', '100755'].includes(rootEntry.mode)) fail('skill-entry-invalid', 'repository directory has no regular SKILL.md');
    const reason = error => typeof error.code === 'string' && /^skill-[a-z-]+$/.test(error.code) ? error.code : 'skill-fetch-unavailable';
    async function file(item, filePath) {
      if (entries.length >= context.limits.files) fail('skill-limit', 'repository file limit exceeded');
      if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > context.limits.fileBytes) fail('skill-limit', 'repository file exceeds the byte bound');
      const url = base + filePath.split('/').map(encodeURIComponent).join('/');
      const fetched = await readRemoteSkillDocument(url, context, { allowedHosts: ['raw.githubusercontent.com'] });
      const actual = createHash('sha1').update(Buffer.from(`blob ${fetched.bytes.length}\0`)).update(fetched.bytes).digest('hex');
      if (fetched.bytes.length !== item.size || actual !== item.sha) fail('skill-repository-blob-mismatch', 'repository bytes do not match the pinned Git blob');
      entries.push({ path: filePath, bytes: fetched.bytes, mode: item.mode });
      locations.push({ path: filePath, url, resolvedUrl: fetched.resolvedUrl, gitBlob: item.sha });
      if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(fetched.bytes.subarray(0, 128).toString('utf8'))) issues.push({ target: filePath, reason: 'skill-repository-lfs-pointer' });
    }
    // Root failure publishes no import. All later failures retain it and are
    // explicit repository-entry outcomes, not invented Markdown references.
    await file(rootEntry, 'SKILL.md');
    const pending = [{ tree: selected, prefix: '', depth: 0 }];
    let visited = 0, truncated = false;
    for (const directory of pending) {
      for (const item of directory.tree.tree) {
        if (++visited > 4000 || issues.length >= context.limits.references) { truncated = true; break; }
        const relative = directory.prefix ? `${directory.prefix}/${item.path}` : item.path;
        const normalized = relative.normalize('NFC').toLowerCase();
        if (names.has(normalized)) fail('skill-path-unsafe', 'repository paths collide after portable normalization');
        names.add(normalized);
        if (EXCLUDED.has(item.path.toLowerCase())) { excluded.push(relative); continue; }
        if (relative === 'SKILL.md') continue;
        try {
          if (relative.length > 1024 || relative.split('/').length > 16) fail('skill-limit', 'repository path exceeds the payload depth/length bound');
          if (item.type === 'tree' && item.mode === '040000') {
            if (directory.depth >= context.limits.depth) fail('skill-depth-limit', 'repository directory depth limit exceeded');
            pending.push({ tree: await tree(item.sha), prefix: relative, depth: directory.depth + 1 });
          } else if (item.type === 'blob' && ['100644', '100755'].includes(item.mode)) await file(item, relative);
          else fail('skill-repository-entry-unsupported', 'repository symlinks, submodules and special modes are not captured');
        } catch (error) { issues.push({ target: relative, reason: reason(error), ...(error.retryAt ? { retryAt: error.retryAt } : {}) }); }
      }
      if (truncated) break;
    }
    if (truncated) { issues.push({ reason: 'skill-repository-entry-limit' }); context.referencesExhausted = true; }
    return captureRemoteSkill(source.url, id, context, { base, scope: rawRoot, entries, locations, issues, excluded,
      repository: { provider: 'github', owner: source.owner, repo: source.repo, ref: source.ref, path: source.path, commit, tree: rootTree } });
  });
}
