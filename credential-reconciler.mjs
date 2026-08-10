import { homedir } from 'node:os';
import { ensurePrivateKey } from './ensure-private-key.mjs';
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
  };
  const code = error?.code ?? 'credential-restore-failed';
  return {
    status: 'failed',
    code,
    action: actions[code] ?? 'repair the App credential in the configured provider and retry',
  };
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
      action: 'set the account owner or installation ID explicitly and retry',
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
  const requested = slugs ?? [];
  if (requested.some((slug) =>
    typeof slug !== 'string'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(slug))) {
    throw new Error('invalid GitHub App slug in credential roster');
  }
  const roster = [...new Set(requested)].sort();
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
