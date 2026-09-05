import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  appIdPath,
  ensurePrivateKey,
  inspectProtonPassSession,
  privateKeyPath,
  STORE_UNAVAILABLE_CODES,
  validateIssuer,
  validatePrivateKey,
} from './ensure-private-key.mjs';
import { mint } from './mint-token.mjs';

export class CredentialReconciliationError extends Error {
  constructor(phase, results) {
    const failures = results.filter((result) => result.local.status === 'failed'
      || result.live.status === 'failed');
    const detail = failures
      .map((result) => {
        const failure = result.local.status === 'failed' ? result.local : result.live;
        return `[${result.slug}] ${failure.code}: ${failure.action}`;
      })
      .join('\n');
    super(`credential reconciliation failed during ${phase}\n${detail}`);
    this.name = 'CredentialReconciliationError';
    this.phase = phase;
    this.results = results;
  }
}

function localFailure(error) {
  const actions = {
    'missing-item': 'add one active provider item titled with the App slug and retry',
    'ambiguous-item': 'keep exactly one active provider item titled with the App slug and retry',
    'missing-issuer': 'add the App ID/client ID to the provider item and retry',
    'ambiguous-issuer': 'keep exactly one app-id attachment on the provider item and retry',
    'malformed-issuer': 'replace the provider App ID/client ID with a valid GitHub issuer and retry',
    'missing-private-key': 'add one private-key.pem attachment to the provider item and retry',
    'ambiguous-private-key': 'keep exactly one private-key.pem attachment on the provider item and retry',
    'malformed-private-key': 'replace the provider private-key.pem attachment with a valid key and retry',
    'unreadable-issuer': 'repair permissions on the local app-id file and retry',
    'unreadable-private-key': 'repair permissions on the local private-key.pem file and retry',
    'provider-failure': 'restore provider access and retry credential reconciliation',
    'provider-unavailable': 'install pass-cli and retry credential reconciliation',
    'provider-session-required': 'unlock the secret store with: pass-cli login',
    'provider-locked': 'unlock the secret store with: pass-cli session unlock',
    'credential-transaction-invalid': 'inspect the App credential directory and repair its transaction marker',
    'credential-transaction-pending': 'run explicit credential reconciliation to recover the interrupted publication',
    'credential-transaction-recovery-failed': 'repair App credential file permissions and retry recovery',
  };
  const code = error?.code ?? 'credential-restore-failed';
  return {
    status: 'failed',
    code,
    action: actions[code] ?? 'repair the App credential in the configured provider and retry',
  };
}

// Local files that are already present cannot be repaired by unlocking the
// store. Only deficiencies whose next step is a provider read are store-gated.
const LOCAL_CODES_REPAIRED_BY_STORE = new Set([
  'missing-item',
  'missing-issuer',
  'missing-private-key',
]);

function applyStoreGateToLocalFailures(results, session) {
  if (session?.status !== 'failed' || !STORE_UNAVAILABLE_CODES.includes(session.code)) {
    return;
  }
  const gate = localFailure({ code: session.code });
  for (const result of results) {
    if (result.local.status !== 'failed') continue;
    if (!LOCAL_CODES_REPAIRED_BY_STORE.has(result.local.code)) continue;
    result.local = {
      ...result.local,
      ...gate,
      evidence: result.local.evidence ?? { components: [] },
    };
  }
}

function fillUnprocessedRoster(results, roster, error) {
  const seen = new Set(results.map((result) => result.slug));
  const gate = localFailure(error);
  for (const slug of roster) {
    if (seen.has(slug)) continue;
    results.push({
      slug,
      local: { ...gate },
      live: { status: 'skipped' },
    });
  }
}

function validateRoster(slugs = []) {
  if (slugs.some((slug) =>
    typeof slug !== 'string'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(slug))) {
    throw new Error('invalid GitHub App slug in credential roster');
  }
  return [...new Set(slugs)].sort();
}

function inspectComponent({ component, path, read, validate }) {
  let value;
  try {
    value = read(path, 'utf8');
  } catch (error) {
    return {
      component,
      status: error?.code === 'ENOENT' ? 'missing' : 'unreadable',
    };
  }
  return {
    component,
    status: validate(value) ? 'ready' : 'malformed',
  };
}

function componentFailure(component) {
  const suffix = component.component === 'app-id' ? 'issuer' : 'private-key';
  const code = `${component.status}-${suffix}`;
  return localFailure({ code });
}

// Read-only counterpart to ensurePrivateKey. It deliberately does not recover
// interrupted transactions or contact a provider: doctor must report those
// states without changing the machine it is diagnosing.
export function inspectLocalAppCredential({
  slug,
  home = homedir(),
  read = readFileSync,
  exists = existsSync,
  validateKey = validatePrivateKey,
} = {}) {
  const issuerPath = appIdPath(slug, home);
  const keyPath = privateKeyPath(slug, home);
  const journal = join(dirname(issuerPath), '.agent-bot-credential-transaction.json');
  if (exists(journal)) {
    return {
      status: 'failed',
      code: 'credential-transaction-pending',
      action: localFailure({ code: 'credential-transaction-pending' }).action,
      evidence: { components: [] },
    };
  }
  const components = [
    inspectComponent({ component: 'app-id', path: issuerPath, read, validate: validateIssuer }),
    inspectComponent({ component: 'private-key', path: keyPath, read, validate: validateKey }),
  ];
  const deficiency = components.find((component) => component.status !== 'ready');
  if (deficiency) {
    return {
      ...componentFailure(deficiency),
      evidence: { components },
    };
  }
  return {
    status: 'ready',
    restored: [],
    evidence: { components },
  };
}

// Diagnose a complete roster with the same fail-closed live boundary as the
// repairing reconciler. One local failure suppresses every mint; when local
// state is complete, all Apps are live-tested and no token enters the result.
export async function inspectAppCredentials({
  slugs,
  home = homedir(),
  inspect = inspectLocalAppCredential,
  inspectSession = inspectProtonPassSession,
  verify = async (slug) => mint({ slug }),
} = {}) {
  const roster = validateRoster(slugs ?? []);
  const results = roster.map((slug) => ({
    slug,
    local: inspect({ slug, home }),
    live: { status: 'skipped', code: 'local-roster-incomplete' },
  }));
  if (results.some((result) => result.local.status === 'failed')) {
    applyStoreGateToLocalFailures(results, inspectSession());
    return results;
  }
  if (verify === null) {
    for (const result of results) {
      result.live = { status: 'skipped', code: 'verification-not-run' };
    }
    return results;
  }

  for (const result of results) {
    try {
      const grant = await verify(result.slug);
      if (!grant || typeof grant.token !== 'string' || grant.token.length === 0) {
        throw new Error('live verification returned no token');
      }
      result.live = {
        status: 'ready',
        installationId: Number(grant.installation_id),
        expiresAt: grant.expires_at,
      };
    } catch (error) {
      result.live = liveFailure(error);
    }
  }
  return results;
}

function liveFailure(error) {
  const message = String(error?.message ?? '');
  if (/401|bad credentials|jwt/i.test(message)) {
    return {
      status: 'failed',
      code: 'credential-mismatch',
      action: 'the App ID and private key do not match or the key was revoked; replace the provider credential',
    };
  }
  if (/not installed/i.test(message)) {
    return {
      status: 'failed',
      code: 'app-not-installed',
      action: 'install the GitHub App on the configured account and retry',
    };
  }
  if (/installed on \d+ accounts|installation/i.test(message)) {
    return {
      status: 'failed',
      code: 'ambiguous-installation',
      action: 'set "owner" to one of the accounts the App is installed on (or GH_APP_INSTALLATION_ID) and retry',
    };
  }
  return {
    status: 'failed',
    code: 'live-verification-failed',
    action: 'live App verification failed; check network access and run agent-bot doctor for this App',
  };
}

export async function reconcileAppCredentials({
  slugs,
  home = homedir(),
  provider,
  prepare = ensurePrivateKey,
  verify = async (slug) => mint({ slug }),
  onVerified = () => {},
} = {}) {
  const roster = validateRoster(slugs ?? []);
  const results = [];
  for (const slug of roster) {
    try {
      const prepared = await prepare({ slug, home, provider });
      results.push({
        slug,
        local: {
          status: prepared.localStatus ?? (prepared.restored?.length ? 'restored' : 'ready'),
          restored: [...(prepared.restored ?? [])],
        },
        live: { status: 'pending' },
      });
    } catch (error) {
      results.push({
        slug,
        local: localFailure(error),
        live: { status: 'skipped' },
      });
      if (STORE_UNAVAILABLE_CODES.includes(error?.code)) {
        fillUnprocessedRoster(results, roster, error);
        throw new CredentialReconciliationError('local preparation', results);
      }
    }
  }
  if (results.some((result) => result.local.status === 'failed')) {
    throw new CredentialReconciliationError('local preparation', results);
  }

  for (const result of results) {
    try {
      const grant = await verify(result.slug);
      if (!grant || typeof grant.token !== 'string' || grant.token.length === 0) {
        throw new Error('live verification returned no token');
      }
      onVerified(result.slug, grant);
      result.live = {
        status: 'ready',
        installationId: Number(grant.installation_id),
        expiresAt: grant.expires_at,
      };
    } catch (error) {
      result.live = liveFailure(error);
    }
  }
  if (results.some((result) => result.live.status === 'failed')) {
    throw new CredentialReconciliationError('live verification', results);
  }
  return results;
}
