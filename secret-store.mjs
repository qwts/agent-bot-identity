export class SecretStoreError extends Error {
  constructor(message, code = 'SECRET_STORE_ERROR') {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function requireSelector(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SecretStoreError(`--${name} is required`, 'INVALID_SELECTOR');
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new SecretStoreError(`--${name} contains a control character`, 'INVALID_SELECTOR');
  }
  return value;
}

function foldedLabel(value) {
  return value.trim().toLowerCase();
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
  const requested = foldedLabel(requireSelector('field', requestedField));
  if (!Array.isArray(fields)) {
    throw new SecretStoreError('secret provider returned malformed field data', 'MALFORMED_PROVIDER_DATA');
  }
  const matches = fields.filter((candidate) => {
    const labels = fieldLabels(candidate);
    return labels.some((label) => foldedLabel(label) === requested);
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

export function getSecret({ provider, collection, item, field } = {}, { registry } = {}) {
  const providerId = requireSelector('provider', provider);
  const collectionName = requireSelector('collection', collection);
  const itemName = requireSelector('item', item);
  const fieldName = requireSelector('field', field);
  if (!(registry instanceof Map)) {
    throw new SecretStoreError('secret provider registry is unavailable', 'INVALID_PROVIDER_REGISTRY');
  }
  const adapter = registry.get(providerId);
  if (!adapter) {
    throw new SecretStoreError(`unsupported secret provider: "${providerId}"`, 'UNSUPPORTED_PROVIDER');
  }
  let fields;
  try {
    fields = adapter.readFields({ collection: collectionName, item: itemName });
  } catch (error) {
    if (error instanceof SecretStoreError) throw error;
    throw new SecretStoreError(`secret provider "${providerId}" failed`, 'PROVIDER_FAILED');
  }
  return selectSecretField(fields, fieldName);
}
