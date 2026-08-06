import { spawnSync } from 'node:child_process';
import { SecretStoreError } from '../secret-store.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
export const PROTON_ITEM_SHARES_COLLECTION = '@item-shares';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function providerError(message, code) {
  return new SecretStoreError(message, code);
}

function runPassCli(args, {
  executable = 'pass-cli',
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
} = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env,
    maxBuffer,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    // Provider output can contain decrypted item material. Report only the
    // operation class; never splice child stdout, stderr, or error text into it.
    if (result.error.code === 'ENOENT') {
      throw providerError('proton-pass provider is unavailable: pass-cli was not found', 'PROVIDER_UNAVAILABLE');
    }
    if (result.error.code === 'ETIMEDOUT') {
      throw providerError('proton-pass request timed out', 'PROVIDER_TIMEOUT');
    }
    if (result.error.code === 'ENOBUFS') {
      throw providerError('proton-pass response exceeded the safe output limit', 'PROVIDER_OUTPUT_LIMIT');
    }
    throw providerError('proton-pass provider could not start', 'PROVIDER_START_FAILED');
  }
  if (result.status !== 0) {
    throw providerError('proton-pass request failed', 'PROVIDER_REQUEST_FAILED');
  }
  return result.stdout;
}

function safeInvoke(run, args, invocation = {}) {
  try {
    const output = run(args, invocation);
    if (typeof output !== 'string') {
      throw providerError('proton-pass returned malformed output', 'MALFORMED_PROVIDER_DATA');
    }
    return output;
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    throw providerError('proton-pass request failed', 'PROVIDER_REQUEST_FAILED');
  }
}

function requireAuditReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0
    || CONTROL_CHARACTER_PATTERN.test(reason)) {
    throw providerError('proton-pass requires a valid access reason', 'INVALID_REASON');
  }
  return reason;
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw providerError('proton-pass returned malformed JSON', 'MALFORMED_PROVIDER_DATA');
  }
  if (!data || typeof data !== 'object') {
    throw providerError('proton-pass returned malformed JSON', 'MALFORMED_PROVIDER_DATA');
  }
  return data;
}

function requireList(data, key) {
  const list = Array.isArray(data) ? data : data[key];
  if (!Array.isArray(list)) {
    throw providerError('proton-pass returned malformed list data', 'MALFORMED_PROVIDER_DATA');
  }
  return list;
}

function selectUnique(list, predicate, kind) {
  const matches = list.filter(predicate);
  if (matches.length === 0) throw providerError(`${kind} was not found`, `${kind.toUpperCase()}_NOT_FOUND`);
  if (matches.length > 1) throw providerError(`${kind} name is ambiguous`, `AMBIGUOUS_${kind.toUpperCase()}`);
  return matches[0];
}

function pickString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

function extraFieldValue(entry) {
  const declaredType = pickString(entry?.field_type, entry?.fieldType, entry?.type)?.toLowerCase();
  if (declaredType && !['text', 'hidden'].includes(declaredType)) return null;
  const content = entry?.content;
  if (typeof content === 'string') return content;
  for (const kind of ['Text', 'Hidden', 'text', 'hidden']) {
    const value = content?.[kind];
    if (typeof value === 'string') return value;
    if (typeof value?.content === 'string') return value.content;
  }
  const direct = entry?.value;
  if (typeof direct === 'string') return direct;
  if (typeof direct?.text === 'string') return direct.text;
  if (typeof direct?.content === 'string') return direct.content;
  if (typeof entry?.field_value === 'string') return entry.field_value;
  if (typeof entry?.data?.value === 'string') return entry.data.value;
  if (content && typeof content === 'object' && Object.keys(content).length > 0) return null;
  throw providerError('proton-pass returned malformed field data', 'MALFORMED_PROVIDER_DATA');
}

function addExtraFields(target, entries, section = null) {
  if (entries === undefined || entries === null) return;
  if (!Array.isArray(entries)) {
    throw providerError('proton-pass returned malformed field data', 'MALFORMED_PROVIDER_DATA');
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      throw providerError('proton-pass returned malformed field data', 'MALFORMED_PROVIDER_DATA');
    }
    const name = pickString(entry?.name, entry?.field_name, entry?.fieldName, entry?.label);
    if (!name) {
      throw providerError('proton-pass returned malformed field data', 'MALFORMED_PROVIDER_DATA');
    }
    const value = extraFieldValue(entry);
    if (value === null) continue;
    target.push({ name, path: section ? `${section}.${name}` : name, value });
  }
}

function addSections(target, sections) {
  if (sections === undefined || sections === null) return;
  if (!Array.isArray(sections)) {
    throw providerError('proton-pass returned malformed section data', 'MALFORMED_PROVIDER_DATA');
  }
  for (const section of sections) {
    if (!section || typeof section !== 'object') {
      throw providerError('proton-pass returned malformed section data', 'MALFORMED_PROVIDER_DATA');
    }
    const name = pickString(section?.section_name, section?.sectionName, section?.name);
    if (!name) {
      throw providerError('proton-pass returned malformed section data', 'MALFORMED_PROVIDER_DATA');
    }
    addExtraFields(target, section?.section_fields ?? section?.fields, name);
  }
}

function addStandardPasswords(target, typedContent) {
  if (!typedContent || typeof typedContent !== 'object') return;
  for (const type of ['Login', 'login', 'Wifi', 'wifi']) {
    const content = typedContent[type];
    if (typeof content?.password === 'string') {
      target.push({ name: 'password', path: 'password', value: content.password });
    }
  }
}

function collectFields(payload) {
  const item = payload.item && typeof payload.item === 'object' ? payload.item : payload;
  const itemData = item.content && typeof item.content === 'object' ? item.content : {};
  const typedContent = itemData.content && typeof itemData.content === 'object' ? itemData.content : {};
  const fields = [];
  addStandardPasswords(fields, typedContent);
  addExtraFields(fields, itemData.extra_fields);

  for (const typed of Object.values(typedContent)) {
    if (!typed || typeof typed !== 'object') continue;
    addSections(fields, typed.sections);
    addSections(fields, typed.extra_sections);
    for (const key of [
      'extra_personal_details', 'extra_address_details', 'extra_contact_details', 'extra_work_details',
    ]) addExtraFields(fields, typed[key]);
  }
  return fields;
}

function isActiveState(value) {
  return typeof value === 'string' && value.toLowerCase() === 'active';
}

function validateResolvedItem(payload, { shareId, itemId = null, itemTitle }) {
  const item = payload.item && typeof payload.item === 'object' ? payload.item : payload;
  const resolvedId = pickString(item.id, item.item_id, item.itemId);
  const resolvedShareId = pickString(item.share_id, item.shareId);
  const resolvedTitle = pickString(item.content?.title, item.title);
  if (!resolvedId || !resolvedShareId || !resolvedTitle || !isActiveState(item.state)) {
    throw providerError('proton-pass returned malformed item identity data', 'MALFORMED_PROVIDER_DATA');
  }
  if ((itemId && resolvedId !== itemId)
    || resolvedShareId !== shareId
    || resolvedTitle !== itemTitle) {
    throw providerError('proton-pass returned a different item than requested', 'PROVIDER_ITEM_MISMATCH');
  }
  return resolvedId;
}

export function createProtonPassAdapter(options = {}) {
  const run = options.run ?? ((args, invocation = {}) => runPassCli(args, { ...options, ...invocation }));
  return Object.freeze({
    id: 'proton-pass',
    readFields({ collection, item, reason }) {
      const auditReason = requireAuditReason(reason);
      let shareId;
      let itemId = null;
      let viewArgs;

      if (collection === PROTON_ITEM_SHARES_COLLECTION) {
        // Proton hides an item's parent vault for least-privilege item grants.
        // Treat direct shares as an explicit virtual collection rather than
        // silently ignoring an unverifiable collection selector.
        const shareData = parseJson(safeInvoke(run, [
          'share', 'list', '--only-items', 'true', '--output', 'json',
        ]));
        const share = selectUnique(
          requireList(shareData, 'shares'),
          (candidate) => candidate?.name === item,
          'item',
        );
        shareId = pickString(share.id, share.share_id, share.shareId);
        const shareType = pickString(share.share_type, share.shareType)?.toLowerCase();
        if (!shareId || shareType !== 'item') {
          throw providerError('proton-pass returned malformed item-share data', 'MALFORMED_PROVIDER_DATA');
        }
        viewArgs = [
          'item', 'view', '--share-id', shareId, '--item-title', item, '--output', 'json',
        ];
      } else {
        // pass-cli's name resolver accepts the first duplicate. Resolve stable
        // IDs from non-secret summaries so the common contract can fail ambiguity.
        const vaultData = parseJson(safeInvoke(run, ['vault', 'list', '--output', 'json']));
        const vault = selectUnique(
          requireList(vaultData, 'vaults'),
          (candidate) => candidate?.name === collection,
          'collection',
        );
        shareId = pickString(vault.share_id, vault.shareId);
        if (!shareId) {
          throw providerError('proton-pass returned malformed collection data', 'MALFORMED_PROVIDER_DATA');
        }

        const itemData = parseJson(safeInvoke(run, [
          'item', 'list', '--share-id', shareId, '--filter-state', 'active', '--output', 'json',
        ]));
        const selectedItem = selectUnique(
          requireList(itemData, 'items'),
          (candidate) => pickString(candidate?.title, candidate?.content?.title) === item,
          'item',
        );
        itemId = pickString(selectedItem.id, selectedItem.item_id, selectedItem.itemId);
        const itemShareId = pickString(selectedItem.share_id, selectedItem.shareId);
        if (!itemId || itemShareId !== shareId || !isActiveState(selectedItem.state)) {
          throw providerError('proton-pass returned malformed item data', 'MALFORMED_PROVIDER_DATA');
        }
        viewArgs = [
          'item', 'view', '--share-id', shareId, '--item-id', itemId, '--output', 'json',
        ];
      }

      // Read the full item once so every matching label is visible. Delegating a
      // field lookup to pass-cli would again select the first unqualified match.
      const view = parseJson(safeInvoke(run, viewArgs, {
        env: { ...(options.env ?? process.env), PROTON_PASS_AGENT_REASON: auditReason },
      }));
      validateResolvedItem(view, { shareId, itemId, itemTitle: item });
      return collectFields(view);
    },
  });
}

export const protonPassAdapter = createProtonPassAdapter();
