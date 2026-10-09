// Portable origin evidence for retained skill bytes (#312). This is a bounded
// projection of an already verified library snapshot, never a fetch capability.
import { skillSourceUrl } from './skill-remote.mjs';
import { githubSkillSource } from './skill-github.mjs';

const fail = () => { throw Object.assign(new Error('Invalid portable skill source provenance.'), { code: 'skill-provenance-invalid' }); };
const exact = (value, fields, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && fields.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...fields, ...optional].includes(key));
const digest = value => typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value);
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const date = value => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const repositoryFields = ['provider', 'owner', 'repo', 'ref', 'path', 'commit', 'tree'];
const url = value => { try { return skillSourceUrl(value) === value; } catch { return false; } };

export function validateSkillSourceProvenance(value) {
  if (!exact(value, ['schemaVersion', 'basis', 'digest', 'capturedAt', 'source', 'locations', 'repository'])
    || value.schemaVersion !== 1 || value.basis !== 'accepted-snapshot' || !digest(value.digest) || !date(value.capturedAt)
    || !Array.isArray(value.locations) || value.locations.length > 1001) fail();
  if (value.source?.kind === 'local') {
    if (!exact(value.source, ['kind']) || value.locations.length || value.repository !== null) fail();
  } else if (!exact(value.source, ['kind', 'url']) || value.source.kind !== 'https' || !url(value.source.url)) fail();
  const paths = new Set();
  for (const location of value.locations) {
    if (!exact(location, ['path', 'url', 'resolvedUrl', 'sha256', 'mode'], ['gitBlob']) || !relative(location.path)
      || paths.has(location.path) || !url(location.url) || !url(location.resolvedUrl) || !digest(location.sha256)
      || !['100644', '100755'].includes(location.mode) || location.gitBlob !== undefined && !commit(location.gitBlob)) fail();
    paths.add(location.path);
  }
  if (value.repository !== null) {
    const repository = value.repository;
    let selected;
    try { selected = githubSkillSource(value.source.url); } catch { fail(); }
    if (!selected || !exact(repository, repositoryFields) || repository.provider !== 'github'
      || !commit(repository.commit) || !commit(repository.tree)
      || ['owner', 'repo', 'ref', 'path'].some(key => repository[key] !== selected[key])) fail();
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) fail();
  return value;
}

// `paths` names the accepted files actually retained in the soul, so a selected
// local adaptation never receives upstream URLs as evidence about its own bytes.
// Copy known fields only: metadata extensions and local host paths stay behind.
export function projectSkillSourceProvenance(snapshot, paths) {
  const selected = new Set(paths), remote = snapshot.source.kind === 'https';
  const value = { schemaVersion: 1, basis: 'accepted-snapshot', digest: snapshot.manifest.digest,
    capturedAt: snapshot.capturedAt, source: remote ? { kind: 'https', url: snapshot.source.url } : { kind: 'local' },
    locations: remote ? snapshot.locations.filter(location => selected.has(location.path)).map(location => {
      const file = snapshot.manifest.files[location.path];
      return { path: location.path, url: location.url, resolvedUrl: location.resolvedUrl, sha256: file.sha256, mode: file.mode,
        ...(location.gitBlob === undefined ? {} : { gitBlob: location.gitBlob }) };
    }) : [],
    repository: snapshot.repository ? Object.fromEntries(repositoryFields.map(key => [key, snapshot.repository[key]])) : null };
  return validateSkillSourceProvenance(value);
}
