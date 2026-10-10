// The pin catalog (#583 slice 3, ADR-0583 decision 6; #322, ADR-0322): the
// runtime downloads agent-bot provisions into a soul, one pinned version per
// supported major, with the URL and SHA-256 of every archive per platform.
// Pure data and pure functions over it: no I/O. Every digest here was
// verified by downloading the archive once and hashing it; a bump replaces
// the whole pin, never one digest.
//
// Python is not an archive: uv provides it (`uv python install`), verifying
// python-build-standalone's own checksums, so the python pins carry only the
// version and uv is pinned here like any other binary.

import { createHash } from 'node:crypto';

export const RUNTIME_CATALOG_VERSION = 1;
export const RUNTIME_PLATFORMS = Object.freeze(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']);
// What soul.json may declare under `runtimes`.
export const RUNTIME_NAMES = Object.freeze(['node', 'python', 'go']);
// Provisioned when python or a uv-tool harness needs it; never declared.
export const PROVIDER_NAMES = Object.freeze(['uv']);
// `major` is the leading version components a declaration names: node and
// go pin per major, python per minor (3.12 and 3.13 are different runtimes).
const MAJOR_PARTS = Object.freeze({ node: 1, go: 1, python: 2, uv: 1 });

// `bin`: where the executables live inside the archive once its single
// top-level directory is stripped: `bin` for node and go on POSIX, `.` for
// the Windows node zip and for uv (one binary at the top).
const node = (version, sums) => Object.freeze({
  version,
  sources: Object.freeze({
    'darwin-arm64': Object.freeze({ url: `https://nodejs.org/dist/v${version}/node-v${version}-darwin-arm64.tar.gz`, sha256: sums[0], bin: 'bin' }),
    'darwin-x64': Object.freeze({ url: `https://nodejs.org/dist/v${version}/node-v${version}-darwin-x64.tar.gz`, sha256: sums[1], bin: 'bin' }),
    'linux-x64': Object.freeze({ url: `https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.gz`, sha256: sums[2], bin: 'bin' }),
    'linux-arm64': Object.freeze({ url: `https://nodejs.org/dist/v${version}/node-v${version}-linux-arm64.tar.gz`, sha256: sums[3], bin: 'bin' }),
    'win32-x64': Object.freeze({ url: `https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`, sha256: sums[4], bin: '.' }),
  }),
});
const go = (version, sums) => Object.freeze({
  version,
  sources: Object.freeze({
    'darwin-arm64': Object.freeze({ url: `https://go.dev/dl/go${version}.darwin-arm64.tar.gz`, sha256: sums[0], bin: 'bin' }),
    'darwin-x64': Object.freeze({ url: `https://go.dev/dl/go${version}.darwin-amd64.tar.gz`, sha256: sums[1], bin: 'bin' }),
    'linux-x64': Object.freeze({ url: `https://go.dev/dl/go${version}.linux-amd64.tar.gz`, sha256: sums[2], bin: 'bin' }),
    'linux-arm64': Object.freeze({ url: `https://go.dev/dl/go${version}.linux-arm64.tar.gz`, sha256: sums[3], bin: 'bin' }),
    'win32-x64': Object.freeze({ url: `https://go.dev/dl/go${version}.windows-amd64.zip`, sha256: sums[4], bin: 'bin' }),
  }),
});
const uv = (version, sums) => Object.freeze({
  version,
  sources: Object.freeze({
    'darwin-arm64': Object.freeze({ url: `https://github.com/astral-sh/uv/releases/download/${version}/uv-aarch64-apple-darwin.tar.gz`, sha256: sums[0], bin: '.' }),
    'darwin-x64': Object.freeze({ url: `https://github.com/astral-sh/uv/releases/download/${version}/uv-x86_64-apple-darwin.tar.gz`, sha256: sums[1], bin: '.' }),
    'linux-x64': Object.freeze({ url: `https://github.com/astral-sh/uv/releases/download/${version}/uv-x86_64-unknown-linux-gnu.tar.gz`, sha256: sums[2], bin: '.' }),
    'linux-arm64': Object.freeze({ url: `https://github.com/astral-sh/uv/releases/download/${version}/uv-aarch64-unknown-linux-gnu.tar.gz`, sha256: sums[3], bin: '.' }),
    'win32-x64': Object.freeze({ url: `https://github.com/astral-sh/uv/releases/download/${version}/uv-x86_64-pc-windows-msvc.zip`, sha256: sums[4], bin: '.' }),
  }),
});
const python = (version) => Object.freeze({ version, via: 'uv', sources: null });

// Digests in platform order: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.
export const RUNTIME_CATALOG = Object.freeze({
  node: Object.freeze([
    node('22.23.3', ['23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53', '8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8',
      '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af', '5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2',
      '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71']),
    node('24.21.0', ['bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057', '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
      '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff', '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
      '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541']),
  ]),
  python: Object.freeze([python('3.12.15'), python('3.13.16')]),
  go: Object.freeze([
    go('1.27.1', ['ee215d57e0ec269c60cc9ceca68e6bda321ba9ee5afe24f4b0988703c2d87d12', '8f8f52c6649542cf027bbc9b9c68d1ec042f9f34808a40413f0b8b3f66f3caa4',
      '63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445', '3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec',
      'a3911b5e0e1b1053f25ed0675f4c1c6aad1e2bfcf253df2b9be4caabd2edd95d']),
  ]),
  uv: Object.freeze([
    uv('0.12.23', ['50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544', '960da44cb4b73685206ddd250b19e0a117fa41095710c1038f081f5cb613efb4',
      '9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6', '6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f',
      '75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90']),
  ]),
});

export const SHA256_HEX = /^[0-9a-f]{64}$/;

// JSON with object keys sorted at every depth and arrays kept in order, so
// the same pins hash the same however the literal above is written.
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * The catalog release (#617, owner decision "Pin per install"): the SHA-256
 * of `{ version, catalog }` in canonical JSON. Any change to a pin, URL,
 * digest or the schema version changes it; key order does not. Nothing
 * records it yet: install receipts will carry it beside the exact version
 * resolved in a later #617 slice, and until then no catalog provenance is
 * checked or enforced.
 */
export function catalogReleaseHash({ catalog = RUNTIME_CATALOG, version = RUNTIME_CATALOG_VERSION } = {}) {
  return createHash('sha256').update(canonical({ version, catalog })).digest('hex');
}
// A declared version: a major (`24`, `3.12`, `1`), a range of one (`24.x`),
// or an exact version (`24.21.0`). No comparators: the catalog's pin is the
// only thing a range can resolve to, so `>=` would promise what it cannot keep.
const VERSION_RANGE = /^\d+(?:\.\d+){0,2}(?:\.x)?$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export function isVersionRange(value) {
  return typeof value === 'string' && VERSION_RANGE.test(value);
}

export function isExactVersion(value) {
  return typeof value === 'string' && EXACT_VERSION.test(value);
}

const parts = (version) => version.replace(/\.x$/, '').split('.').map(Number);

/** Whether a pinned version satisfies a declared range (prefix match). */
export function versionMatches(range, version) {
  if (!isVersionRange(range) || !isExactVersion(version)) return false;
  const wanted = parts(range), pinned = parts(version);
  return wanted.every((part, index) => pinned[index] === part);
}

/** The host platform key, or null when the catalog has nothing for it. */
export function hostPlatform({ platform = process.platform, arch = process.arch } = {}) {
  const key = `${platform}-${arch}`;
  return RUNTIME_PLATFORMS.includes(key) ? key : null;
}

/** The catalog pin a declared range resolves to (the newest match), or null. */
export function resolveCatalogPin(name, range, { catalog = RUNTIME_CATALOG } = {}) {
  const pins = catalog[name];
  if (!Array.isArray(pins) || !isVersionRange(range)) return null;
  const matches = pins.filter((pin) => versionMatches(range, pin.version));
  if (!matches.length) return null;
  return matches.reduce((best, pin) => (compareVersions(pin.version, best.version) > 0 ? pin : best));
}

/** The newest pin of a runtime or provider, or null. */
export function newestPin(name, { catalog = RUNTIME_CATALOG } = {}) {
  const pins = catalog[name];
  if (!Array.isArray(pins) || !pins.length) return null;
  return pins.reduce((best, pin) => (compareVersions(pin.version, best.version) > 0 ? pin : best));
}

export function compareVersions(a, b) {
  const left = parts(a), right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** The majors a runtime's catalog supports, for a message naming what a soul may declare. */
export function supportedMajors(name, { catalog = RUNTIME_CATALOG } = {}) {
  const count = MAJOR_PARTS[name] ?? 1;
  return [...new Set((catalog[name] ?? []).map((pin) => pin.version.split('.').slice(0, count).join('.')))];
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SAFE_RELATIVE = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.startsWith('/')
  && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every((part) => part && part !== '..');

/**
 * One source entry as the package or the catalog states it: an https URL, a
 * lowercase 64-hex sha256, and where the executables are once a single
 * top-level directory is stripped (`bin` or `.`). Throws naming `label`.
 */
export function validateSource(source, label, { defaultBin = 'bin' } = {}) {
  if (!object(source)) throw new Error(`${label} must be an object with url and sha256`);
  for (const key of Object.keys(source)) {
    if (!['url', 'sha256', 'bin'].includes(key)) throw new Error(`${label}.${key} is unknown (use url, sha256, bin)`);
  }
  if (typeof source.url !== 'string' || !/^https:\/\/[^\s/]+\/\S+$/.test(source.url)) throw new Error(`${label}.url must be an https URL`);
  if (typeof source.sha256 !== 'string' || !SHA256_HEX.test(source.sha256)) throw new Error(`${label}.sha256 must be 64 lowercase hex digits`);
  if (source.bin !== undefined && (source.bin !== '.' && !SAFE_RELATIVE(source.bin))) throw new Error(`${label}.bin must be a relative directory inside the archive`);
  return { url: source.url, sha256: source.sha256, bin: source.bin ?? defaultBin };
}

/**
 * A `runtimes.<name>` declaration normalized to `{ version, via, sources }`:
 * a string is a range resolved through the catalog; an object may pin exact
 * `sources` per platform (node and go), which then win over the catalog and
 * are part of the package definition. Throws with the path on anything else.
 */
export function normalizeRuntimeDeclaration(name, value, label = `runtimes.${name}`) {
  if (!RUNTIME_NAMES.includes(name)) throw new Error(`${label} is not a runtime agent-bot provisions (${RUNTIME_NAMES.join(', ')})`);
  const via = name === 'python' ? 'uv' : null;
  if (typeof value === 'string') {
    if (!isVersionRange(value)) throw new Error(`${label} must be a version or range such as "24", "24.x", "3.12" or "24.21.0"`);
    return { version: value, via, sources: null };
  }
  if (!object(value)) throw new Error(`${label} must be a version string or an object with version`);
  for (const key of Object.keys(value)) {
    if (key === 'version' || key === 'sources' || (key === 'via' && name === 'python')) continue;
    throw new Error(`${label}.${key} is unknown (use version${name === 'python' ? ', via' : ', sources'})`);
  }
  if (!isVersionRange(value.version)) throw new Error(`${label}.version must be a version or range such as "24", "24.x", "3.12" or "24.21.0"`);
  if (name === 'python' && value.via !== undefined && value.via !== 'uv') throw new Error(`${label}.via must be "uv"`);
  let sources = null;
  if (value.sources !== undefined) {
    if (name === 'python') throw new Error(`${label}.sources is not accepted: uv provides python`);
    if (!object(value.sources) || !Object.keys(value.sources).length) throw new Error(`${label}.sources must map platforms to { url, sha256 }`);
    if (!isExactVersion(value.version)) throw new Error(`${label}.version must be exact when sources are given`);
    sources = {};
    for (const [platform, source] of Object.entries(value.sources)) {
      if (!RUNTIME_PLATFORMS.includes(platform)) throw new Error(`${label}.sources.${platform} is not a platform (${RUNTIME_PLATFORMS.join(', ')})`);
      sources[platform] = validateSource(source, `${label}.sources.${platform}`, { defaultBin: name === 'node' && platform === 'win32-x64' ? '.' : 'bin' });
    }
  }
  return { version: value.version, via, sources };
}

const PACKAGE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const INSTALL_VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * A `harnesses.<name>.install` declaration (ADR-0322 decision 3), normalized:
 * `{ kind: 'archive', version, url, sha256: { platform }, bin }` where `url`
 * is one template (`{version}`, `{platform}`) or a map per platform, or
 * `{ kind: 'uv-tool', package, version, bin }`. Throws with the path.
 */
export function normalizeHarnessInstall(value, label, { defaultBin = null } = {}) {
  if (!object(value)) throw new Error(`${label} must be an object with kind`);
  if (!['archive', 'uv-tool'].includes(value.kind)) throw new Error(`${label}.kind must be archive or uv-tool`);
  const allowed = value.kind === 'archive' ? ['kind', 'version', 'url', 'sha256', 'bin'] : ['kind', 'package', 'version', 'bin'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is unknown (use ${allowed.join(', ')})`);
  }
  if (typeof value.version !== 'string' || !INSTALL_VERSION.test(value.version)) throw new Error(`${label}.version must be an exact version`);
  if (value.bin !== undefined && (typeof value.bin !== 'string' || !BIN_NAME.test(value.bin))) throw new Error(`${label}.bin must be an executable name`);
  const bin = value.bin ?? defaultBin;
  if (!bin) throw new Error(`${label}.bin must name the executable inside the install`);
  if (value.kind === 'uv-tool') {
    if (typeof value.package !== 'string' || !PACKAGE_NAME.test(value.package)) throw new Error(`${label}.package must be a PyPI package name`);
    return { kind: 'uv-tool', package: value.package, version: value.version, bin };
  }
  if (!object(value.sha256) || !Object.keys(value.sha256).length) throw new Error(`${label}.sha256 must map platforms to 64 lowercase hex digits`);
  const sha256 = {};
  for (const [platform, digest] of Object.entries(value.sha256)) {
    if (!RUNTIME_PLATFORMS.includes(platform)) throw new Error(`${label}.sha256.${platform} is not a platform (${RUNTIME_PLATFORMS.join(', ')})`);
    if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) throw new Error(`${label}.sha256.${platform} must be 64 lowercase hex digits`);
    sha256[platform] = digest;
  }
  const httpsUrl = (url, where) => {
    if (typeof url !== 'string' || !/^https:\/\/[^\s/]+\/\S+$/.test(url)) throw new Error(`${where} must be an https URL`);
    return url;
  };
  let url;
  if (object(value.url)) {
    url = {};
    for (const [platform, entry] of Object.entries(value.url)) {
      if (!Object.hasOwn(sha256, platform)) throw new Error(`${label}.url.${platform} has no sha256`);
      url[platform] = httpsUrl(entry, `${label}.url.${platform}`);
    }
    for (const platform of Object.keys(sha256)) if (!url[platform]) throw new Error(`${label}.url.${platform} is missing for its sha256`);
  } else {
    url = httpsUrl(value.url, `${label}.url`);
  }
  return { kind: 'archive', version: value.version, url, sha256, bin };
}

/** The archive source of a normalized harness install for one platform, or null. */
export function harnessInstallSource(install, platform) {
  if (install?.kind !== 'archive' || !install.sha256[platform]) return null;
  const url = typeof install.url === 'string'
    ? install.url.replaceAll('{version}', install.version).replaceAll('{platform}', platform)
    : install.url[platform];
  return { url, sha256: install.sha256[platform], bin: '.' };
}
