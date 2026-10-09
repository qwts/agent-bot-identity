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
  } catch {
    fail('profile-read-failed', 'organization profile could not be read');
  }
  return parseOrganizationProfile(raw);
}
