// Removing a persona account, under the owner's keep-by-default decision on
// #750 (agent-bot sandbox remove ACCOUNT, without --dry-run). Run from the
// owner's account, after `sandbox export --verify` has verified a copy there.
//
// Only one thing is removed: the account's broker pairing (and the daemon
// pairing that goes with it), and only once the newest export is verified
// again, is complete, and holds every soul the broker's census has joined
// from the account. Census rows are kept as they are: the broker shows them
// `left` once the pairing is gone, and the local census is not touched, so
// each soul stays identifiable and comes back under its own ID (the reading
// recorded on #750). Harness sign-ins are listed; deleting the macOS account
// is printed for the owner to do by hand. Nothing else is deleted.
//
// The pairing step asks its own owner gate. A failure stops; running the
// command again reads the broker afresh and carries on, so a pairing already
// gone is not revoked twice.
import { homedir } from 'node:os';
import { appendAuditReceipt } from './agent-principals.mjs';
import { verifySandboxExport } from './sandbox-export.mjs';

function fail(code, message, action = null) { throw Object.assign(new Error(message), { code, action }); }

function pairingsOf(exec, account) {
  let text;
  try { text = String(exec('agent-comms', ['account', 'pairings']) ?? ''); }
  catch (error) { fail('sandbox-remove-broker-unreadable', `the broker's pairings could not be read: ${error.message}`, 'start the broker, then run this again'); }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* checked below */ }
  if (!Array.isArray(parsed?.pairings)) fail('sandbox-remove-broker-unreadable', 'the broker returned no pairings list', 'start the broker, then run this again');
  // Only the fields the plan needs: a pairing row can carry a secret.
  return parsed.pairings.filter((row) => row?.account === account).map((row) => ({ account: row.account, kind: row.kind ?? 'account', uid: row.uid ?? null, state: row.state ?? null }));
}

/**
 * `inventory` is `sandboxRemovalInventory(account)`, read just before. Returns
 * what each category got; throws, with the rerun as its action, on a refusal
 * or a failure.
 */
export async function runSandboxRemoval(inventory, { gate, exec, principal = null, env = process.env, home = homedir(), cwd = process.cwd(),
  now = () => new Date(), verify = verifySandboxExport } = {}) {
  const { account, owner } = inventory;
  const rerun = `agent-bot sandbox remove ${account}`;
  const receipt = (decision, detail) => appendAuditReceipt({ event: 'sandbox-remove', operation: 'remove', decision, detail }, { env, home, now });
  if (!inventory.supported) fail('sandbox-remove-unsupported', 'persona accounts need macOS; there is nothing to remove');
  const category = (id) => inventory.categories.find((entry) => entry.id === id);
  const census = category('census');
  if (!census?.known) fail('sandbox-remove-broker-unreadable', 'the broker\'s census could not be read, so the export cannot be checked against it', 'start the broker, then run this again');

  // The export: verified again now, every category done, every joined soul in it.
  const verified = await verify(account, { env, home, cwd, owner, now });
  const skipped = Object.entries(verified.categories).filter(([, state]) => state?.state === 'skipped').map(([name]) => name);
  if (skipped.length) {
    fail('sandbox-remove-export-incomplete', `the verified export left out ${skipped.join(', ')}`, `in ${account}, run agent-bot sandbox export --for ${owner} without --skip, copy it over and verify it`);
  }
  const exported = new Set([...verified.souls, ...verified.unexported]);
  const missing = census.items.map((row) => row.agentId).filter((id) => id && !exported.has(id));
  if (missing.length) {
    fail('sandbox-remove-soul-not-exported', `the verified export does not hold ${missing.join(', ')}, joined from ${account}`, `in ${account}, export again, copy it over and verify it`);
  }

  const result = { account, owner, export: verified.dir, categories: [] };
  const done = (id, state, extra = {}) => result.categories.push({ id, state, ...extra });
  for (const id of ['souls', 'workspaces', 'transcripts']) done(id, 'exported', { verified: verified.dir });

  // Pairings: the only removal. Read afresh, so a rerun skips what is gone.
  const pairings = pairingsOf(exec, account);
  if (pairings.length === 0) done('pairings', 'already-removed');
  else {
    await gate(`revoke ${account}'s broker pairing${pairings.some((row) => row.kind === 'daemon') ? ' and its daemon pairing' : ''}, after the export verified in ${verified.dir}`, { principal, env, cwd });
    try {
      // `account revoke` drops the account pairing and its daemon pairing together.
      if (pairings.some((row) => row.kind === 'account')) exec('agent-comms', ['account', 'revoke', account]);
      else exec('agent-comms', ['account', 'revoke', account, '--kind', 'daemon']);
      const left = pairingsOf(exec, account);
      if (left.length) fail('sandbox-remove-pairing-kept', `the broker still lists ${left.length} pairing(s) for ${account}`);
    } catch (error) {
      receipt('failed', `pairings: ${error.code ?? 'error'}: ${error.message}`);
      throw Object.assign(error, { code: error.code ?? 'sandbox-remove-failed', action: error.action ?? `run ${rerun} again; nothing else was changed` });
    }
    done('pairings', 'removed', { count: pairings.length });
  }

  done('census', 'kept', { count: census.items.length, note: 'rows stay as they are; the broker shows them left, and each soul comes back under its own ID' });
  const signIns = category('harness-sign-ins')?.items ?? [];
  done('harness-sign-ins', 'listed', { items: signIns, note: 'agent-bot never removes a harness sign-in' });
  const macos = category('macos-account');
  done('macos-account', 'manual', macos?.items?.length
    ? { command: `sudo /usr/sbin/sysadminctl -deleteUser ${account} -keepHome`, note: 'agent-bot never runs it; -keepHome keeps the home folder' }
    : { note: `${account} does not exist on this Mac` });
  receipt('removed', `pairings ${result.categories.find((entry) => entry.id === 'pairings').state}; export ${verified.dir}`);
  return result;
}

export function formatSandboxRemovalResult(result) {
  const lines = [`persona account ${result.account}: export verified in ${result.export}`];
  for (const entry of result.categories) {
    lines.push(`${entry.id}: ${entry.state}${entry.count ? ` (${entry.count})` : ''}`);
    for (const item of entry.items ?? []) lines.push(`  ${item.path} (${item.state})`);
    if (entry.command) lines.push(`  ${entry.command}`);
    if (entry.note) lines.push(`  ${entry.note}`);
  }
  return `${lines.join('\n')}\n`;
}
