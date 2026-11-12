// Is the account this process runs in an administrator account (#1408)?
//
// The local web UI shows a warning when it is: anything that takes over an
// administrator account is one password prompt from root, so daily work and
// HQ belong in a standard account, with a separate administrator account for
// installs. Today HQ runs in the owner's daily account, so its own account is
// the one to check. When HQ moves to the HQ account (agent-bot-hq#88) this
// check has to follow the owner's account instead.
//
// The answer comes from the host (`id`), never from configuration. When the
// host cannot be asked the result is `checked: false` and no warning is
// shown: a missing check is not evidence of a safe setup, and it is not
// evidence of an unsafe one either.
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import process from 'node:process';

// Membership of one of these lets an account become root with its own
// password: `admin` on macOS, `sudo` (Debian family), `wheel` (Red Hat
// family) and `admin` (older Ubuntu) on Linux.
const ADMIN_GROUPS = {
  darwin: ['admin'],
  linux: ['sudo', 'wheel', 'admin'],
};

function hostGroups(name) {
  const out = execFileSync('/usr/bin/id', ['-Gn', name], {
    encoding: 'utf8', timeout: 5_000, env: {}, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.trim().split(/\s+/).filter(Boolean);
}

export function hostAccount({
  platform = process.platform,
  user = userInfo,
  groups = hostGroups,
} = {}) {
  const adminGroups = ADMIN_GROUPS[platform];
  if (!adminGroups) return { checked: false, account: null, admin: false, reason: null };
  let info;
  try {
    info = user();
  } catch {
    return { checked: false, account: null, admin: false, reason: null };
  }
  const account = info.username;
  if (info.uid === 0) return { checked: true, account, admin: true, reason: 'root' };
  let member;
  try {
    member = groups(account);
  } catch {
    return { checked: false, account, admin: false, reason: null };
  }
  const group = adminGroups.find((name) => member.includes(name));
  return group
    ? { checked: true, account, admin: true, reason: `group ${group}` }
    : { checked: true, account, admin: false, reason: null };
}
