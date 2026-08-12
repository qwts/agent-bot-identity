// Secret-free Agent Space export packs (suitcase handoff).
//
// A pack is one deterministic JSON document — manifest fields plus base64
// file entries — so moving a soul's belongings between machines needs no
// external archiver and can never smuggle an unlisted file. Export fails
// closed when a known secret filename is present in the space; the only
// removals are the documented regenerable-cache exclusions below, and those
// are reported explicitly rather than dropped silently.
//
// The optional gist transport (opt-in, issue #45) uploads a pack as a secret
// gist through the bound App's token-minting path. The slug is resolved
// territory-aware — the same question setup-worktree and worktree-token ask —
// never by trusting an inherited GH_AGENT_APP across territory (issue #20).
// Organization policy may forbid unsanctioned gists; nothing here runs unless
// the operator passes --gist or imports a gist reference.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { validateAgentId } from './agent-identity.mjs';
import { apiBase, loadConfig } from './config.mjs';
import { mint } from './mint-token.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';

export const PACK_SCHEMA_VERSION = 1;
export const PACK_FILE_SUFFIX = '.agent-space-pack.json';

// Deny-list: filenames that indicate credential material. Matching is on the
// lowercased basename of every file AND directory in the space. Export and
// import both fail closed when one is present — a pack must never become the
// vehicle that moves a token cache or private key between machines.
export const SECRET_NAME_PATTERNS = [
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.keystore$/,
  /^private-key/,
  /^id_rsa/,
  /^id_ed25519/,
  /^id_ecdsa/,
  /^id_dsa/,
  /token/,
  /^\.netrc$/,
  /^\.npmrc$/,
  /^\.env$/,
  /^\.env\./,
  /secret/,
  /credential/,
  /password/,
];

// Documented exclusion rule: regenerable local artifacts that are removed
// from the pack explicitly (and reported by the exporter) instead of failing
// the export. `.agent-bot-token.json` is the worktree-token cache name — a
// short-lived credential cache that must never travel, and that the runtime
// re-mints on demand. Temp files are atomic-write leftovers.
export const PACK_EXCLUDED_NAMES = [
  /^\.agent-bot-token\.json$/,
  /^\.ds_store$/,
  /\.tmp$/,
];

function matchesAny(patterns, name) {
  const basename = name.toLowerCase();
  return patterns.some((pattern) => pattern.test(basename));
}

export function isExcludedPackName(name) {
  return matchesAny(PACK_EXCLUDED_NAMES, name);
}

export function isSecretPackName(name) {
  // Exclusions are checked first: the token cache would otherwise trip the
  // deny-list, but its removal is the documented rule, not a leak.
  return !isExcludedPackName(name) && matchesAny(SECRET_NAME_PATTERNS, name);
}

export function packFileName(agentId) {
  return `${validateAgentId(agentId)}${PACK_FILE_SUFFIX}`;
}

function validEntryPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4096) {
    return false;
  }
  if (candidate.includes('\\') || path.isAbsolute(candidate)) return false;
  for (const character of candidate) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return candidate
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Content hash over pack entries: for each entry in path order, the relative
// path and the SHA-256 of its decoded bytes. Deterministic, so two exports of
// an unchanged space produce the same hash.
export function packContentHash(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.path}\n${sha256Hex(Buffer.from(entry.data, 'base64'))}\n`);
  }
  return hash.digest('hex');
}

// Walk a space directory and classify every name. Throws on symlinks and
// other non-regular files: a pack records file bytes, and pretending a
// symlink is its target (or dropping it silently) would both be lies.
export function collectSpaceEntries(root) {
  const files = [];
  const excluded = [];
  const secrets = [];
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (isExcludedPackName(name)) {
        excluded.push(relative);
        continue;
      }
      const secret = isSecretPackName(name);
      const stat = lstatSync(path.join(directory, name));
      if (stat.isDirectory()) {
        if (secret) {
          secrets.push(`${relative}/`);
          continue;
        }
        walk(path.join(directory, name), relative);
      } else if (stat.isFile()) {
        if (secret) {
          secrets.push(relative);
          continue;
        }
        files.push(relative);
      } else {
        throw new Error(`refusing to pack non-regular file at ${relative}`);
      }
    }
  };
  walk(root, '');
  return { files, excluded, secrets };
}

export function buildSpacePack(root, agentId, { now = () => new Date() } = {}) {
  const id = validateAgentId(agentId);
  const { files, excluded, secrets } = collectSpaceEntries(root);
  if (secrets.length > 0) {
    throw new Error(
      `refusing to export: known secret filename(s) in the space: ${secrets.join(', ')} — ` +
        'remove them from the space before exporting; packs must stay secret-free',
    );
  }
  const entries = files.map((relative) => ({
    path: relative,
    data: readFileSync(path.join(root, relative)).toString('base64'),
  }));
  const pack = {
    schemaVersion: PACK_SCHEMA_VERSION,
    agentId: id,
    createdAt: now().toISOString(),
    contentHash: packContentHash(entries),
    entries,
  };
  return { pack, excluded };
}

export function serializePack(pack) {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

// Parse and fully validate a pack document. Packs may arrive from another
// machine or a gist, so nothing from an invalid document is ever reflected
// into an error message.
export function parsePack(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('pack is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pack must be an object');
  }
  if (parsed.schemaVersion !== PACK_SCHEMA_VERSION) {
    throw new Error('pack has an unsupported schemaVersion');
  }
  let agentId;
  try {
    agentId = validateAgentId(parsed.agentId);
  } catch {
    throw new Error('pack has an invalid Agent ID');
  }
  let createdAt;
  try {
    createdAt = new Date(parsed.createdAt).toISOString();
  } catch {
    throw new Error('pack has an invalid createdAt');
  }
  if (createdAt !== parsed.createdAt) throw new Error('pack has an invalid createdAt');
  if (!Array.isArray(parsed.entries)) throw new Error('pack entries must be an array');
  const seen = new Set();
  const entries = parsed.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('pack entry must be an object');
    }
    if (!validEntryPath(entry.path)) throw new Error('pack entry has an unsafe path');
    if (seen.has(entry.path)) throw new Error('pack entry paths must be unique');
    seen.add(entry.path);
    for (const segment of entry.path.split('/')) {
      if (isSecretPackName(segment) || isExcludedPackName(segment)) {
        throw new Error('pack contains a known secret or excluded filename; refusing to accept it');
      }
    }
    if (
      typeof entry.data !== 'string'
      || entry.data.length % 4 !== 0
      || !BASE64_PATTERN.test(entry.data)
    ) {
      throw new Error('pack entry data must be base64');
    }
    return { path: entry.path, data: entry.data };
  });
  if (typeof parsed.contentHash !== 'string' || packContentHash(entries) !== parsed.contentHash) {
    throw new Error('pack content hash does not match its manifest');
  }
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    agentId,
    createdAt,
    contentHash: parsed.contentHash,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Optional gist transport (issue #45). Opt-in only; org policy may forbid
// unsanctioned gists. Only the pack (already secret-free by construction)
// travels, and only the pointer `gist:<id>` is ever recorded locally.

const GIST_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

export function gistHandoffPointer(id) {
  if (typeof id !== 'string' || !GIST_ID_PATTERN.test(id)) {
    throw new Error('gist id must be alphanumeric');
  }
  return `gist:${id}`;
}

// Returns a gist id for `gist:<id>` references and gist URLs, null for
// anything that should be treated as a local pack path. Malformed gist
// references throw instead of degrading into a nonexistent-file error.
export function parseGistReference(text) {
  if (typeof text !== 'string') return null;
  if (text.startsWith('gist:')) {
    const id = text.slice('gist:'.length);
    if (!GIST_ID_PATTERN.test(id)) throw new Error('invalid gist reference');
    return id;
  }
  if (!/^https?:\/\//.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('invalid gist reference');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const looksLikeGist = url.hostname.startsWith('gist.') || segments.includes('gists');
  const id = segments.at(-1) ?? '';
  if (!looksLikeGist || !GIST_ID_PATTERN.test(id)) throw new Error('invalid gist reference');
  return id;
}

// Mint through the bound App with a territory-aware slug (issue #20): the
// same resolution setup-worktree and worktree-token use, so an inherited
// GH_AGENT_APP cannot mint across territory, and mint() is always called
// with an explicitly resolved slug.
async function mintGistToken({ env, cwd, config, mintToken }) {
  const slug = resolveAgentSlug({ env, cwd, config, worktree: true });
  if (!slug) {
    throw new Error(
      'gist handoff requires a resolvable bot identity: run from bot territory or configure the harness App mapping',
    );
  }
  try {
    const grant = await mintToken({ slug, env });
    return { slug, token: grant.token };
  } catch (error) {
    throw new Error(`gist handoff could not mint a token for ${slug}: ${error.message}`);
  }
}

function gistHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'agent-bot-identity',
  };
}

export async function uploadPackToGist(pack, {
  env = process.env,
  cwd = process.cwd(),
  config,
  fetchImpl = fetch,
  mintToken = mint,
} = {}) {
  const cfg = config ?? loadConfig({ env });
  const { token } = await mintGistToken({ env, cwd, config: cfg, mintToken });
  const response = await fetchImpl(`${apiBase(cfg)}/gists`, {
    method: 'POST',
    headers: { ...gistHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      description: `agent-bot Agent Space pack for ${pack.agentId}`,
      public: false,
      files: { [packFileName(pack.agentId)]: { content: serializePack(pack) } },
    }),
  });
  if (!response.ok) {
    if ([401, 403, 404].includes(response.status)) {
      throw new Error(
        `gist creation was refused (HTTP ${response.status}) — the App token lacks gist access. ` +
          'Grant the GitHub App the "Gists" account permission (org policy may forbid gists) ' +
          'or export to a file pack instead',
      );
    }
    throw new Error(`gist upload failed (HTTP ${response.status})`);
  }
  const body = await response.json().catch(() => ({}));
  if (typeof body.id !== 'string' || !GIST_ID_PATTERN.test(body.id)) {
    throw new Error('gist upload did not return a usable gist id');
  }
  return {
    id: body.id,
    url: typeof body.html_url === 'string' ? body.html_url : null,
  };
}

export async function downloadPackFromGist(gistId, {
  env = process.env,
  cwd = process.cwd(),
  config,
  fetchImpl = fetch,
  mintToken = mint,
} = {}) {
  if (!GIST_ID_PATTERN.test(gistId)) throw new Error('invalid gist reference');
  const cfg = config ?? loadConfig({ env });
  const { token } = await mintGistToken({ env, cwd, config: cfg, mintToken });
  const response = await fetchImpl(`${apiBase(cfg)}/gists/${gistId}`, {
    headers: gistHeaders(token),
  });
  if (!response.ok) {
    throw new Error(
      `gist ${gistId} could not be fetched (HTTP ${response.status}) — it may not exist, ` +
        'or the App token lacks gist access',
    );
  }
  const body = await response.json().catch(() => ({}));
  const files = body.files && typeof body.files === 'object' ? Object.values(body.files) : [];
  const packs = files.filter(
    (file) => file && typeof file.filename === 'string' && file.filename.endsWith(PACK_FILE_SUFFIX),
  );
  if (packs.length !== 1) {
    throw new Error(`gist ${gistId} does not contain exactly one Agent Space pack file`);
  }
  if (packs[0].truncated) {
    throw new Error(`gist ${gistId} pack file is truncated; download it manually and import the file`);
  }
  if (typeof packs[0].content !== 'string') {
    throw new Error(`gist ${gistId} pack file has no inline content`);
  }
  return parsePack(packs[0].content);
}
