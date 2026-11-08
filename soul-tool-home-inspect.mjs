// The tool homes of a soul, inspected without changing anything (#1386).
// soul-env.mjs describes them in the environment descriptor and
// soul-env-migrate.mjs decides and migrates with them, so this reader sits
// below both of them, which keeps the two out of an import cycle (HQ plan
// §2.4, C4). soul-env-migrate.mjs re-exports inspectToolHomes.
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { readMigrationJournal } from './soul-migration-journal.mjs';
import { readToolHomeRecord } from './soul-tool-home-record.mjs';
import { adoptStepId, hostToolStore, toolHomeDecision, toolHomeEnv, toolHomeFiles, toolHomeFor, toolHomeRelative } from './soul-tool-homes.mjs';

function lstat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return null; throw error; }
}

// Presence of a regular file, never through a link: a linked sign-in would
// be adopted from wherever it points.
const fileState = (file) => (lstat(file)?.isFile() ? 'present' : 'missing');

/**
 * The tool homes of a soul for the given harnesses, by existence only:
 * `{ harness, path, home, routing, containment, reason, choice, hostPath,
 * signIn, hostSignIn, adopted, note, files[] }`. `containment` is
 * `toolHomeDecision` over what is found and the soul's recorded `choice`
 * (#617, null without one), and `routing` the variables the next launch
 * sets (none unless contained). Never reads a sign-in file's contents; an
 * unusable tool-homes record is `tool-home-record-invalid`.
 * On macOS a host Claude sign-in lives in the keychain, which no file
 * shows and nothing here reads, so its absent file is `unknown`, not
 * `missing`: a signed-in host is never mistaken for one with nothing to
 * lose.
 */
export function inspectToolHomes(soulDir, harnesses, { env = process.env, home = env.HOME ?? homedir(), platform = process.platform } = {}) {
  const journal = readMigrationJournal(soulDir);
  const record = readToolHomeRecord(soulDir);
  return harnesses.map((harness) => {
    const routed = toolHomeEnv(soulDir, harness);
    const row = toolHomeFor(harness);
    const files = toolHomeFiles(soulDir, harness, { env, home }).map((file) => ({ kind: file.kind, path: file.path, soul: fileState(file.soulPath), host: fileState(file.hostPath) }));
    const signIns = files.filter((file) => file.kind === 'sign-in');
    const state = (side) => (!row.routable || !signIns.length ? 'unknown' : signIns.every((file) => file[side] === 'present') ? 'present' : 'missing');
    const signIn = state('soul');
    let hostSignIn = state('host');
    if (hostSignIn === 'missing' && row.note && platform === 'darwin') hostSignIn = 'unknown';
    const adopted = journal.some((step) => step.id === adoptStepId(harness) && (step.status === 'done' || step.status === 'skipped'));
    const choice = (row.routable && record?.harnesses[harness]) || null;
    const decision = toolHomeDecision(harness, { signIn, hostSignIn, adopted, choice });
    return { harness, path: toolHomeRelative(harness), home: routed.home, routing: decision.containment === 'soul' ? routed.routing : [], containment: decision.containment,
      reason: decision.reason, choice, hostPath: hostToolStore(harness, { env, home }), signIn, hostSignIn, adopted, note: row.note, files };
  });
}
