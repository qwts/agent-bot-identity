// Owner-approval consent gate for credential operations run in the owner's
// account with no stated bot identity — the ENG-0353 direction, ahead of the
// recorded delegation marker the record describes.
//
// A stated identity is the exception, not the rule: GH_AGENT_APP, a checkout
// pin, an agent account, or harness env markers all resolve to a configured
// App through the same resolver every consumer uses, and in those contexts
// the mint is an ordinary bot operation. What the gate covers is the unmarked
// explicit request — `agent-bot mint-token --app <slug>` typed in the owner's
// account with nothing else saying who the caller is. That path must be
// confirmed through the macOS authorization dialog, the same consent
// ceremony managed-machine's SSH enrollment uses: osascript runs a
// non-mutating /usr/bin/true under administrator privileges, so it is a
// consent proof, never an execution context.
//
// GH_APP_ID with caller-supplied key material is a different credential path
// entirely (CI/overrides): the caller already holds the App's private key,
// so no dialog adds protection.

import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { accountHarness, accountName } from './detect-harness.mjs';
import { resolveAgentSlug } from './resolve-agent.mjs';
import { loadConfig } from './config.mjs';

// The App slug an unflagged invocation would resolve, or null — the "markers
// present" test: GH_AGENT_APP, pin, agent account, or detected harness env.
export function ambientSlug({ env = process.env, cwd = process.cwd(), config, account, git } = {}) {
  const cfg = config ?? loadConfig({ env });
  return resolveAgentSlug({ env, cwd, config: cfg, account, git });
}

export function explicitAppArg(argv = []) {
  const flag = argv.indexOf('--app');
  return flag !== -1 ? argv[flag + 1] ?? null : null;
}

// True when a mint must be confirmed by the owner through the OS dialog:
// the account is not an agent account, the caller did not supply its own App
// key material, no ambient identity resolves, and an explicit --app names a
// managed App config to mint.
export function ownerApprovalRequired({
  argv = process.argv,
  env = process.env,
  cwd = process.cwd(),
  config,
  account,
  git,
} = {}) {
  const cfg = config ?? loadConfig({ env });
  const acct = account ?? accountName(env);
  if (accountHarness(cfg, acct)) return false;
  if (env.GH_APP_ID && (env.GH_APP_PRIVATE_KEY || env.GH_APP_PRIVATE_KEY_PATH)) return false;
  if (ambientSlug({ env, cwd, config: cfg, account: acct, git })) return false;
  return Boolean(explicitAppArg(argv));
}

// Raise the macOS authorization dialog naming the operation; any dismissal,
// cancellation, or unavailable dialog fails closed — no approval, no mint.
export function requireOwnerApproval({
  prompt,
  platform = process.platform,
  run = (argv) => execFileSync('/usr/bin/osascript', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
} = {}) {
  if (platform !== 'darwin') {
    throw new Error('owner approval needs the macOS authorization dialog — refusing on this platform');
  }
  try {
    run([
      '-e', 'on run argv',
      '-e', 'do shell script "/usr/bin/true" with prompt (item 1 of argv as text) with administrator privileges',
      '-e', 'end run',
      prompt,
    ]);
  } catch (error) {
    const detail = `${error.stderr ?? ''} ${error.message ?? ''}`.trim();
    throw new Error(
      /-128|User canceled|cancelled/i.test(detail)
        ? 'owner approval was cancelled — no token minted'
        : `owner approval could not be completed${detail ? ` (${detail})` : ''} — no token minted`,
      { cause: error },
    );
  }
}
