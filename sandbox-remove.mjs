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
import { ownerCredentialRequired, soulMarkers } from './owner-action.mjs';
import { populationFile, showSoul } from './agent-population.mjs';
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
export async function runSandboxRemoval(inventory, options = {}) {
  const { env = process.env, home = homedir(), now = () => new Date() } = options;
  try { return await removal(inventory, options); }
  catch (error) {
    // Every stop leaves a receipt: a refusal before anything changed, the
    // owner declining, or a failure part way.
    const decision = error.stage === 'gate' ? 'declined' : error.stage === 'revoke' ? 'failed' : 'refused';
    appendAuditReceipt({ event: 'sandbox-remove', operation: 'remove', decision, detail: `${inventory?.account ?? '?'}: ${error.code ?? 'error'}: ${error.message}` }, { env, home, now });
    throw error;
  }
}

const EXPORTED = ['souls', 'workspaces', 'transcripts'];

/**
 * Removal is owner only. A caller carrying a soul's markers is refused here,
 * before the broker is read or the export verified (verify writes
 * verified.json), and on a rerun with nothing left to revoke too.
 */
export function refuseSoulCaller(account, { env = process.env, home = homedir(), cwd = process.cwd(), now = () => new Date(), markers = soulMarkers } = {}) {
  const found = markers({ env, cwd });
  if (!found.length) return;
  const error = ownerCredentialRequired(`sandbox remove ${account} is owner only; this caller has a soul's ${found.join(', ')}`);
  appendAuditReceipt({ event: 'sandbox-remove', operation: 'remove', decision: 'refused', detail: `${account}: ${error.code}: ${error.message}` }, { env, home, now });
  throw error;
}

// The persona account wrote the manifest, so its claims are checked against
// what the owner's side can see, never taken as proof. Run once before the
// gate and again, on a fresh read, right before the revoke.
function checkExport(inventory, verified, { env, home, now }) {
  const { account, owner } = inventory;
  const again = `in ${account}, run agent-bot sandbox export --for ${owner}, copy it over and verify it`;
  if (!inventory.supported) fail('sandbox-remove-unsupported', 'persona accounts need macOS; there is nothing to remove');
  const category = (id) => inventory.categories.find((entry) => entry.id === id);
  const census = category('census');
  const souls = category('souls');
  // The souls to account for come from this (owner's) side: the local census
  // rows that run as the account, and the broker's rows joined from it.
  if (!census?.known || !souls?.known) fail('sandbox-remove-census-unreadable', 'the local or broker census could not be read, so the export cannot be checked against it', 'start the broker, then run this again');
  const required = souls.items.map((row) => row.agentId).filter(Boolean);
  const broker = new Map(census.items.filter((row) => row.agentId).map((row) => [row.agentId, row]));
  const file = populationFile({ env, home });
  const local = (id) => { try { return showSoul(id, { file }); } catch { return null; } };
  const unconfirmed = [];
  for (const name of EXPORTED) {
    const state = verified.categories?.[name]?.state;
    if (state === 'exported') continue;
    if (state !== 'empty') fail('sandbox-remove-export-incomplete', `the verified export has ${name} ${state ?? 'missing'}`, `${again}, without --skip`);
    if (name === 'souls' && required.length) fail('sandbox-remove-export-incomplete', `the export says souls is empty, but ${required.length} soul(s) run as ${account}`, again);
    // Another account's home is unreadable from here: an empty workspaces
    // or transcripts is confirmed only when its default paths read absent.
    const items = category(name)?.items ?? [];
    if (name !== 'souls' && !(items.length && items.every((item) => item.state === 'absent'))) unconfirmed.push(name);
  }
  const archived = new Set(verified.souls);
  const claimed = new Set(verified.unexported);
  for (const id of required) {
    if (archived.has(id)) continue;
    // "Never ran" is believed only when nothing here saw the soul run: the
    // broker has no row for it and the local census never sighted it.
    if (!claimed.has(id)) fail('sandbox-remove-soul-not-exported', `the verified export does not hold ${id}, which runs as ${account}`, again);
    if (broker.has(id) || local(id)?.lastSightedAt) fail('sandbox-remove-soul-not-exported', `the export lists ${id} as never run, but it has run`, again);
  }
  // Freshness: a soul live now, or sighted after the export finished, may
  // have changed since, so that export no longer holds its life.
  // The persona account wrote completedAt, so it is capped by when the copy
  // reached this side, and one in the future is refused, never clamped.
  const claimedAt = Date.parse(verified.completedAt ?? '');
  const copiedAt = Date.parse(verified.copiedAt ?? '');
  if (!Number.isFinite(claimedAt)) fail('sandbox-remove-export-incomplete', 'the verified export has no completion time', again);
  if (!Number.isFinite(copiedAt)) fail('sandbox-remove-export-incomplete', 'when the export was copied here cannot be read', again);
  const completed = Math.min(claimedAt, copiedAt);
  if (claimedAt > now().getTime() || completed > now().getTime()) {
    fail('sandbox-remove-export-future', `the export says it finished at ${verified.completedAt}, which is later than now`, again);
  }
  const live = [...broker.values()].filter((row) => row.presence === 'joined' || row.presence === 'watching').map((row) => row.agentId);
  if (live.length) fail('sandbox-remove-export-stale', `${live.join(', ')} ${live.length === 1 ? 'is' : 'are'} running as ${account} now`, `stop ${live.length === 1 ? 'it' : 'them'}, then ${again}`);
  const later = required.filter((id) => Date.parse(local(id)?.lastSightedAt ?? '') > completed);
  if (later.length) fail('sandbox-remove-export-stale', `${later.join(', ')} ran after the export finished at ${new Date(completed).toISOString()}`, again);
  return { completed, unconfirmed, census, category };
}

async function removal(inventory, { gate, exec, principal = null, env = process.env, home = homedir(), cwd = process.cwd(),
  now = () => new Date(), verify = verifySandboxExport, reread = () => inventory } = {}) {
  const { account, owner } = inventory;
  const rerun = `agent-bot sandbox remove ${account}`;
  const receipt = (decision, detail) => appendAuditReceipt({ event: 'sandbox-remove', operation: 'remove', decision, detail }, { env, home, now });
  if (!inventory.supported) fail('sandbox-remove-unsupported', 'persona accounts need macOS; there is nothing to remove');
  const verified = await verify(account, { env, home, cwd, owner, now });
  const { completed, unconfirmed, census, category } = checkExport(inventory, verified, { env, home, now });

  const result = { account, owner, export: verified.dir, completedAt: verified.completedAt, categories: [] };
  const done = (id, state, extra = {}) => result.categories.push({ id, state, ...extra });
  for (const id of EXPORTED) done(id, verified.categories[id].state, { verified: verified.dir });

  // Pairings: the only removal. Read afresh, so a rerun skips what is gone.
  const pairings = pairingsOf(exec, account);
  if (pairings.length === 0) done('pairings', 'already-removed');
  else {
    const age = Math.round((now().getTime() - completed) / 60_000);
    const daemon = pairings.some((row) => row.kind === 'daemon');
    const action = `revoke ${account}'s broker pairing${daemon ? ' and its daemon pairing' : ''}, after the export verified in ${verified.dir} (finished ${age} minute(s) ago)`
      + (unconfirmed.length ? `; the export says ${unconfirmed.join(' and ')} ${unconfirmed.length === 1 ? 'is' : 'are'} empty, which cannot be checked from this account` : '');
    try { await gate(action, { principal, env, cwd }); }
    catch (error) { throw Object.assign(error, { stage: 'gate' }); }
    // The verify and the prompt take time: the censuses and the pairings are
    // read again, and the checks repeated, right before the revoke.
    const fresh = reread();
    if (fresh?.account !== account) fail('sandbox-remove-census-unreadable', 'the account could not be read again before the revoke');
    checkExport(fresh, verified, { env, home, now });
    if (pairingsOf(exec, account).length === 0) fail('sandbox-remove-pairing-changed', `${account}'s pairing went away while you were asked; nothing was revoked`, `run ${rerun} again`);
    try {
      // `account revoke` drops the account pairing and its daemon pairing together.
      if (pairings.some((row) => row.kind === 'account')) exec('agent-comms', ['account', 'revoke', account]);
      else exec('agent-comms', ['account', 'revoke', account, '--kind', 'daemon']);
      const left = pairingsOf(exec, account);
      if (left.length) fail('sandbox-remove-pairing-kept', `the broker still lists ${left.length} pairing(s) for ${account}`);
    } catch (error) {
      throw Object.assign(error, { stage: 'revoke', code: error.code ?? 'sandbox-remove-failed', action: error.action ?? `run ${rerun} again; nothing else was changed` });
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
