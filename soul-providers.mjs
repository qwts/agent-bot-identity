// Providers per harness (#583 slice 4, ADR-0583 decision 7). Pure data and
// validation, no I/O: the package reader validates with it, the builder
// renders with it, the descriptor and the launch read it.
//
// A soul says, per harness, which model provider that harness talks to:
//
//   "harnesses": { "codex": { "provider": { "id": "github",
//     "baseUrl": "https://models.github.ai/inference", "credential": "gh-models" } } },
//   "credentials": { "secrets": { "gh-models": { "store": "keychain" } } }
//
// `id` is one this module knows how to render for that harness; `baseUrl`
// is the endpoint (required for the OpenAI-compatible ids); `envKey` is the
// variable the harness reads the secret from; `wireApi` is Codex's wire
// protocol; `credential` names a declared secret. The secret's value is
// never in soul.json, a generated file, a journal or a log: `soul secret`
// stores it in the soul's own store and the launch injects it into that
// one harness process (soul-secrets.mjs, wake-plane.mjs).

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const PROVIDERS_SCHEMA_VERSION = 1;
export const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
export const SECRET_NAME = /^[a-z][a-z0-9-]{0,63}$/;
export const PROVIDER_KEYS = Object.freeze(['id', 'baseUrl', 'envKey', 'wireApi', 'credential']);
// Where a provider secret may live: the readable per-soul stores. keyd never
// returns a value, and a harness needs the value in its environment.
export const SECRET_STORES = Object.freeze(['keychain', 'file', 'pass-cli']);
export const CODEX_WIRE_APIS = Object.freeze(['chat', 'responses']);
// A secret's variable may not take over one the launch itself routes.
const RESERVED_ENV = Object.freeze(['HOME', 'PATH', 'TMPDIR', 'USER', 'SHELL', 'CODEX_HOME', 'CODEX_CONFIG', 'CLAUDE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'GOROOT', 'GOPATH', 'GOMODCACHE', 'GOCACHE']);
const RESERVED_PREFIXES = Object.freeze(['AGENT_BOT_', 'QWTS_', 'XDG_', 'UV_']);

// Per harness: the file the builder renders into and the ids it can spell.
// `baseUrl` says whether an endpoint is `required` (an OpenAI-compatible
// endpoint has no default) or `optional` (the harness's built-in provider,
// overridable); `envKey` is the default variable; `wireApi` (Codex) the
// default wire protocol; `npm` (OpenCode) the provider package.
export const PROVIDERS = Object.freeze({
  codex: Object.freeze({
    file: '.codex/config.toml',
    ids: Object.freeze({
      openai: Object.freeze({ name: 'OpenAI', envKey: 'OPENAI_API_KEY', baseUrl: 'optional', wireApi: 'responses', default: true }),
      github: Object.freeze({ name: 'GitHub', envKey: 'GITHUB_TOKEN', baseUrl: 'required', wireApi: 'chat' }),
      'openai-compatible': Object.freeze({ name: 'OpenAI-compatible', envKey: 'OPENAI_API_KEY', baseUrl: 'required', wireApi: 'chat' }),
    }),
  }),
  claude: Object.freeze({
    file: '.claude/settings.json',
    ids: Object.freeze({
      anthropic: Object.freeze({ name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', baseUrl: 'optional', default: true }),
      'anthropic-compatible': Object.freeze({ name: 'Anthropic-compatible', envKey: 'ANTHROPIC_API_KEY', baseUrl: 'required' }),
    }),
  }),
  opencode: Object.freeze({
    file: 'opencode.json',
    ids: Object.freeze({
      openai: Object.freeze({ name: 'OpenAI', envKey: 'OPENAI_API_KEY', baseUrl: 'optional', default: true }),
      anthropic: Object.freeze({ name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', baseUrl: 'optional' }),
      github: Object.freeze({ name: 'GitHub', envKey: 'GITHUB_TOKEN', baseUrl: 'required', npm: '@ai-sdk/openai-compatible' }),
      'openai-compatible': Object.freeze({ name: 'OpenAI-compatible', envKey: 'OPENAI_API_KEY', baseUrl: 'required', npm: '@ai-sdk/openai-compatible' }),
    }),
  }),
});
export const PROVIDER_HARNESSES = Object.freeze(Object.keys(PROVIDERS));

export function providerIds(harness) {
  return Object.keys(PROVIDERS[harness]?.ids ?? {});
}

// https anywhere, http only to this machine: a key must not cross the
// network in clear, and the URL carries no credentials of its own.
function baseUrlOrThrow(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be an absolute https URL`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute https URL`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(`${label} must use https (http only for localhost)`);
  if (url.username || url.password) throw new Error(`${label} must not carry credentials; secrets never go in soul.json`);
  if (url.hash) throw new Error(`${label} must not carry a fragment`);
  if (/[\x00-\x1f\x7f\s]/.test(value)) throw new Error(`${label} must not contain whitespace or control characters`);
  return value;
}

export function envKeyOrThrow(value, label) {
  if (typeof value !== 'string' || !ENV_KEY.test(value)) throw new Error(`${label} must match ^[A-Z][A-Z0-9_]*$`);
  if (RESERVED_ENV.includes(value) || RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new Error(`${label} ${value} is reserved for the launch itself`);
  }
  return value;
}

export function secretNameOrThrow(value, label = 'secret name') {
  if (typeof value !== 'string' || !SECRET_NAME.test(value)) throw new Error(`${label} must use lowercase letters, digits and single hyphens (1-64 characters)`);
  return value;
}

/**
 * One harness's provider declaration, normalized: defaults filled in, every
 * key present, anything unknown or wrong refused with its path. The
 * result is `{ id, name, baseUrl, envKey, wireApi, credential }`.
 */
export function normalizeProvider(harness, value, label = `soul.json harnesses.${harness}.provider`) {
  const table = PROVIDERS[harness];
  if (!table) throw new Error(`${label}: ${harness} has no provider rendering (${PROVIDER_HARNESSES.join(', ')})`);
  if (!object(value)) throw new Error(`${label} must be an object with an id`);
  const unknown = Object.keys(value).filter((key) => !PROVIDER_KEYS.includes(key));
  if (unknown.length) throw new Error(`${label} accepts only ${PROVIDER_KEYS.join(', ')} (found ${unknown.join(', ')}); secrets never go in soul.json`);
  if (typeof value.id !== 'string' || !Object.hasOwn(table.ids, value.id)) {
    throw new Error(`${label}.id must be one of ${providerIds(harness).join(', ')} for ${harness}`);
  }
  const spec = table.ids[value.id];
  const provider = { id: value.id, name: spec.name, baseUrl: null, envKey: spec.envKey, wireApi: spec.wireApi ?? null, credential: null };
  if (value.baseUrl !== undefined) provider.baseUrl = baseUrlOrThrow(value.baseUrl, `${label}.baseUrl`);
  else if (spec.baseUrl === 'required') throw new Error(`${label}.baseUrl is required for ${value.id} (the endpoint has no default)`);
  if (value.envKey !== undefined) provider.envKey = envKeyOrThrow(value.envKey, `${label}.envKey`);
  if (value.wireApi !== undefined) {
    if (harness !== 'codex') throw new Error(`${label}.wireApi is only accepted for codex`);
    if (!CODEX_WIRE_APIS.includes(value.wireApi)) throw new Error(`${label}.wireApi must be one of ${CODEX_WIRE_APIS.join(', ')}`);
    provider.wireApi = value.wireApi;
  }
  if (value.credential !== undefined) provider.credential = secretNameOrThrow(value.credential, `${label}.credential`);
  return provider;
}

/**
 * `credentials.secrets`: `{ <name>: { store? } }`, names only. Returns the
 * normalized map `{ <name>: { store } }` with `store` null for the platform
 * default.
 */
export function validateSecretsDeclaration(secrets, label = 'soul.json credentials.secrets') {
  if (!object(secrets)) throw new Error(`${label} must be an object of name: { store } entries`);
  const result = {};
  for (const [name, entry] of Object.entries(secrets)) {
    secretNameOrThrow(name, `${label} key ${JSON.stringify(name)}`);
    if (!object(entry)) throw new Error(`${label}.${name} must be an object with an optional store`);
    const unknown = Object.keys(entry).filter((key) => key !== 'store');
    if (unknown.length) throw new Error(`${label}.${name} accepts only store (found ${unknown.join(', ')}); secrets never go in soul.json`);
    if (entry.store !== undefined && !SECRET_STORES.includes(entry.store)) {
      throw new Error(`${label}.${name}.store must be one of ${SECRET_STORES.join(', ')}${entry.store === 'keyd' ? ' (keyd never returns a value, which a harness needs in its environment)' : ''}`);
    }
    result[name] = { store: entry.store ?? null };
  }
  return result;
}

/**
 * Every provider and secret a manifest declares, normalized, with what
 * could not be read as `invalid[]` (the descriptor reports it; a launch of
 * that harness refuses on it). Never throws.
 */
export function declaredProviders(manifest) {
  const providers = {}, invalid = [];
  let secrets = {};
  if (manifest?.credentials !== undefined && object(manifest.credentials) && manifest.credentials.secrets !== undefined) {
    try { secrets = validateSecretsDeclaration(manifest.credentials.secrets); }
    catch (error) { invalid.push({ path: 'credentials.secrets', message: error.message }); }
  }
  if (object(manifest?.harnesses)) {
    for (const [harness, settings] of Object.entries(manifest.harnesses)) {
      if (!object(settings) || settings.provider === undefined) continue;
      try {
        const provider = normalizeProvider(harness, settings.provider);
        if (provider.credential && !Object.hasOwn(secrets, provider.credential)) {
          throw new Error(`soul.json harnesses.${harness}.provider.credential names credentials.secrets.${provider.credential}, which is not declared`);
        }
        providers[harness] = provider;
      } catch (error) { invalid.push({ path: `harnesses.${harness}.provider`, message: error.message }); }
    }
  }
  return { providers, secrets, invalid };
}

// --- rendering (the non-secret parts only) ---------------------------------

/** Codex: the root key and the `[model_providers.<id>]` table, as Codex documents them. */
export function codexProviderConfig(provider) {
  const table = { name: provider.name };
  if (provider.baseUrl !== null) table.base_url = provider.baseUrl;
  table.env_key = provider.envKey;
  table.wire_api = provider.wireApi;
  return { model_provider: provider.id, table };
}

/** Claude: launch-time only, except the endpoint, which its settings `env` carries. */
export function claudeProviderEnv(provider) {
  return provider.baseUrl === null ? {} : { ANTHROPIC_BASE_URL: provider.baseUrl };
}

/**
 * OpenCode: its `provider.<id>` block. A built-in id (openai, anthropic)
 * renders only what differs from its defaults; an OpenAI-compatible id
 * renders the package, name, endpoint and the `{env:…}` key reference.
 */
export function opencodeProviderConfig(provider) {
  const spec = PROVIDERS.opencode.ids[provider.id];
  const options = {};
  if (provider.baseUrl !== null) options.baseURL = provider.baseUrl;
  if (spec.npm || provider.envKey !== spec.envKey) options.apiKey = `{env:${provider.envKey}}`;
  const block = {};
  if (spec.npm) { block.npm = spec.npm; block.name = provider.name; }
  if (Object.keys(options).length) block.options = options;
  return Object.keys(block).length ? { [provider.id]: block } : null;
}

/** Whether the builder has anything to write for this provider (Codex always has the root key). */
export function providerRenders(harness, provider) {
  if (harness === 'codex') return true;
  if (harness === 'claude') return provider.baseUrl !== null;
  if (harness === 'opencode') return opencodeProviderConfig(provider) !== null;
  return false;
}

export const secretSetCommand = (agentId, name) => `agent-bot soul secret ${agentId} set ${name}`;
