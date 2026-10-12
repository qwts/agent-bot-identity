// The owner-decision revision-journal port (agent-comms#77, C2): disabled, no
// route. The host builds it and hands it to the journal store's revision
// completion, which reads the exact bytes of the revision-journal record the
// effect appended (slot 13's linked authoritative event) through it. The
// store never accepts those bytes from a caller. Synchronous and read-only.
//
// Custody, for `<stateDir>/soul-revisions/<agentId>/<seq>.json`:
// - the fixed ancestry (the state directory, soul-revisions/ and the agent
//   directory): each a real directory, not a symlink, owned by this uid, with
//   no group or world write;
// - the record itself: a regular file by name (no symlink), opened no-follow,
//   one link, owned by this uid, no group or world write, 1 to 16384 bytes;
//   the open file is the named one (dev/ino), and the size, inode and mtime
//   are unchanged across the read, which is bounded and exact.
// Not checked: macOS ACLs, which Node can't read without exec or native code
// (a granted ACL could let another account write the file). Holding the
// revision lock around the append and this read is the composition's job.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const OWNER_DECISION_REVISION_PORT_KIND = 'owner-decision-revision-read-v1';
export const REVISION_RECORD_MAX_BYTES = 16384;
const SOUL = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const { O_RDONLY, O_NOFOLLOW } = fs.constants;

const refuse = () => { throw Object.assign(new Error('owner decision revision record unavailable'), { code: 'owner-decision-revision-read' }); };
const owned = (stat) => stat.uid === process.getuid() && (stat.mode & 0o022) === 0;

function ownedDirectory(dir) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch { refuse(); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) refuse();
}

export function createOwnerDecisionRevisionPort({ stateDir } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('an absolute revision state directory is required');
  return Object.freeze({
    kind: OWNER_DECISION_REVISION_PORT_KIND,
    read(agentId, seq) {
      if (typeof agentId !== 'string' || !SOUL.test(agentId) || !Number.isSafeInteger(seq) || seq < 0 || seq > 9_999_999_999) refuse();
      const revisions = path.join(stateDir, 'soul-revisions'), agentDir = path.join(revisions, agentId);
      for (const dir of [stateDir, revisions, agentDir]) ownedDirectory(dir);
      const file = path.join(agentDir, `${String(seq).padStart(10, '0')}.json`);
      // The name's identity now, then the no-follow open must be that file.
      let named, fd;
      try { named = fs.lstatSync(file); } catch { refuse(); }
      try { fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW); } catch { refuse(); }
      try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || !owned(before) || before.dev !== named.dev || before.ino !== named.ino
          || before.size < 1 || before.size > REVISION_RECORD_MAX_BYTES) refuse();
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (read === 0) refuse();
          offset += read;
        }
        // Nothing changed while reading: the same size and mtime, still one
        // link, and still the file the name points to.
        const after = fs.fstatSync(fd), now = fs.lstatSync(file);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1
          || now.dev !== before.dev || now.ino !== before.ino) refuse();
        return bytes;
      } finally { fs.closeSync(fd); }
    },
  });
}
