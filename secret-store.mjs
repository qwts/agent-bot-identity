export class SecretStoreError extends Error {
  constructor(message, code = 'SECRET_STORE_ERROR') {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PROVIDER_ERROR_MESSAGES = new Map([
  ['COLLECTION_NOT_FOUND', 'secret collection was not found'],
  ['AMBIGUOUS_COLLECTION', 'secret collection name is ambiguous'],
  ['ITEM_NOT_FOUND', 'secret item was not found'],
  ['AMBIGUOUS_ITEM', 'secret item name is ambiguous'],
  ['MALFORMED_PROVIDER_DATA', 'secret provider returned malformed data'],
  ['PROVIDER_ITEM_MISMATCH', 'secret provider returned an unexpected item'],
  ['PROVIDER_UNAVAILABLE', 'secret provider is unavailable'],
  ['PROVIDER_TIMEOUT', 'secret provider request timed out'],
  ['PROVIDER_OUTPUT_LIMIT', 'secret provider response exceeded the safe output limit'],
  ['PROVIDER_START_FAILED', 'secret provider could not start'],
  ['PROVIDER_REQUEST_FAILED', 'secret provider request failed'],
]);

function requireSelector(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SecretStoreError(`--${name} is required`, 'INVALID_SELECTOR');
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new SecretStoreError(`--${name} contains a control character`, 'INVALID_SELECTOR');
  }
  return value;
}

function foldedRequestedLabel(value) {
  return value.trim().toLowerCase();
}

function foldedProviderLabel(value) {
  return value.toLowerCase();
}

function fieldLabels(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new SecretStoreError('secret provider returned malformed field data', 'MALFORMED_PROVIDER_DATA');
  }
  const labels = [];
  if (typeof candidate.path === 'string' && candidate.path.trim()) labels.push(candidate.path);
  if (typeof candidate.name === 'string' && candidate.name.trim()) labels.push(candidate.name);
  if (labels.length === 0 || typeof candidate.value !== 'string') {
    throw new SecretStoreError('secret provider returned malformed field data', 'MALFORMED_PROVIDER_DATA');
  }
  return labels;
}

export function createSecretProviderRegistry(providers) {
  if (!Array.isArray(providers)) {
    throw new SecretStoreError('secret providers must be an array', 'INVALID_PROVIDER_REGISTRY');
  }
  const registry = new Map();
  for (const provider of providers) {
    const id = provider?.id;
    if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) {
      throw new SecretStoreError('secret provider has an invalid id', 'INVALID_PROVIDER_REGISTRY');
    }
    if (typeof provider.readFields !== 'function') {
      throw new SecretStoreError(`secret provider "${id}" has no readFields method`, 'INVALID_PROVIDER_REGISTRY');
    }
    if (registry.has(id)) {
      throw new SecretStoreError(`duplicate secret provider: "${id}"`, 'INVALID_PROVIDER_REGISTRY');
    }
    registry.set(id, provider);
  }
  return registry;
}

export function selectSecretField(fields, requestedField) {
  const requested = foldedRequestedLabel(requireSelector('field', requestedField));
  if (!Array.isArray(fields)) {
    throw new SecretStoreError('secret provider returned malformed field data', 'MALFORMED_PROVIDER_DATA');
  }
  const matches = fields.filter((candidate) => {
    const labels = fieldLabels(candidate);
    return labels.some((label) => foldedProviderLabel(label) === requested);
  });
  if (matches.length === 0) {
    throw new SecretStoreError('secret field was not found', 'FIELD_NOT_FOUND');
  }
  if (matches.length > 1) {
    throw new SecretStoreError('secret field name is ambiguous', 'AMBIGUOUS_FIELD');
  }
  if (matches[0].value.length === 0) {
    throw new SecretStoreError('secret field is empty', 'EMPTY_FIELD');
  }
  return matches[0].value;
}

export function getSecret({ provider, collection, item, field, reason } = {}, { registry } = {}) {
  const providerId = requireSelector('provider', provider);
  const collectionName = requireSelector('collection', collection);
  const itemName = requireSelector('item', item);
  const fieldName = requireSelector('field', field);
  const auditReason = requireSelector('reason', reason);
  if (!(registry instanceof Map)) {
    throw new SecretStoreError('secret provider registry is unavailable', 'INVALID_PROVIDER_REGISTRY');
  }
  const adapter = registry.get(providerId);
  if (!adapter) {
    throw new SecretStoreError('unsupported secret provider', 'UNSUPPORTED_PROVIDER');
  }
  let fields;
  try {
    fields = adapter.readFields({ collection: collectionName, item: itemName, reason: auditReason });
  } catch (error) {
    const code = error instanceof SecretStoreError ? error.code : 'PROVIDER_FAILED';
    const message = PROVIDER_ERROR_MESSAGES.get(code) ?? 'secret provider failed';
    throw new SecretStoreError(message, code);
  }
  return selectSecretField(fields, fieldName);
}
