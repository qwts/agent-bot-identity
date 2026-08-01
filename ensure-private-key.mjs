#!/usr/bin/env node

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAgentSlug } from './resolve-agent.mjs';

export const AGENT_IDENTITIES_VAULT = 'Agent Identities';

function requireSlug(slug) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(slug ?? '')) {
    throw new Error(`invalid GitHub App slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

export function privateKeyPath(slug, home = homedir()) {
  return join(home, '.config', requireSlug(slug), 'private-key.pem');
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  let force = false;
  let explicit = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') {
      force = true;
    } else if (arg === '--app') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--app requires a slug');
      explicit = next;
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (explicit) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      explicit = arg;
    }
  }
  return { force, explicit };
}

function pickString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

export function parsePassItemView(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`pass-cli item view returned non-JSON: ${error.message}`);
  }
  const item = data?.item && typeof data.item === 'object' ? data.item : data;
  const shareId = pickString(data?.shareId, data?.share_id, item?.shareId, item?.share_id);
  const itemId = pickString(data?.itemId, data?.item_id, item?.id, item?.itemId, item?.item_id);
  const source = Array.isArray(data?.attachments)
    ? data.attachments
    : Array.isArray(item?.attachments)
      ? item.attachments
      : [];
  if (!shareId || !itemId) throw new Error('pass-cli item view JSON lacked share-id or item-id');
  const attachments = source
    .map((entry) => ({
      id: pickString(entry?.id, entry?.attachmentId, entry?.attachment_id),
      name: pickString(
        entry?.name,
        entry?.fileName,
        entry?.filename,
        entry?.content?.name,
        entry?.content?.fileName,
      ) ?? '',
    }))
    .filter((entry) => entry.id);
  return { shareId, itemId, attachments };
}

export function selectPrivateKeyAttachment(attachments) {
  const exact = attachments?.find((entry) => entry.name === 'private-key.pem');
  if (exact) return exact;
  const pem = (attachments ?? []).filter((entry) => entry.name.toLowerCase().endsWith('.pem'));
  if (pem.length === 1) return pem[0];
  throw new Error('pass-cli item has no unambiguous private-key.pem attachment');
}

function runPass(args) {
  try {
    return execFileSync('pass-cli', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n').trim();
    throw new Error(`pass-cli failed: ${detail}`);
  }
}

export function ensurePrivateKey({
  slug,
  force = false,
  home = homedir(),
  run = runPass,
  exists = existsSync,
  mkdir = mkdirSync,
  chmod = chmodSync,
} = {}) {
  const path = privateKeyPath(slug, home);
  if (!force && exists(path)) return { path, downloaded: false };
  const view = run([
    'item',
    'view',
    '--vault-name',
    AGENT_IDENTITIES_VAULT,
    '--item-title',
    requireSlug(slug),
    '--output',
    'json',
  ]);
  const { shareId, itemId, attachments } = parsePassItemView(view);
  const attachment = selectPrivateKeyAttachment(attachments);
  mkdir(dirname(path), { recursive: true });
  run([
    'item',
    'attachment',
    'download',
    '--share-id',
    shareId,
    '--item-id',
    itemId,
    '--attachment-id',
    attachment.id,
    '--output',
    path,
  ]);
  chmod(path, 0o600);
  return { path, downloaded: true };
}

export function main(argv = process.argv.slice(2)) {
  const { force, explicit } = parseCliArgs(argv);
  const slug = resolveAgentSlug({ explicit });
  if (!slug) throw new Error('no App resolves; pass --app, set GH_AGENT_APP, or configure a pin');
  const result = ensurePrivateKey({ slug, force });
  process.stdout.write(`${result.downloaded ? 'fetched' : 'already present'} ${result.path}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ensure-private-key: ${error.message}\n`);
    process.exit(1);
  }
}
