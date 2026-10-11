// Organization profile acquisition (org module, #645). The schema, validator
// and runtime-config projection live in organization-profile-schema.mjs and
// are re-exported here, so existing importers keep working.
import { readFileSync } from 'node:fs';
import { OrganizationProfileError, parseOrganizationProfile } from './organization-profile-schema.mjs';

export * from './organization-profile-schema.mjs';

function fail(code, message) {
  throw new OrganizationProfileError(code, message);
}

export function readOrganizationProfile({
  sourcePath,
  read = readFileSync,
  stdin = 0,
} = {}) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    fail('profile-read-failed', 'organization profile source is required');
  }
  let raw;
  try {
    raw = read(sourcePath === '-' ? stdin : sourcePath, 'utf8');
  } catch (error) {
    // A fetch that failed before it wrote anything (#975) is named as such.
    if (error?.code === 'ENOENT') fail('profile-file-missing', 'organization profile file does not exist');
    fail('profile-read-failed', 'organization profile could not be read');
  }
  // `gh api … > file` with an expired gh login leaves an empty file (#975).
  if (typeof raw === 'string' && raw.trim() === '') fail('profile-file-empty', 'organization profile file is empty');
  return parseOrganizationProfile(raw);
}
