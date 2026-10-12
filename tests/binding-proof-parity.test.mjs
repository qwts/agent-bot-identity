// binding-proof.mjs is a wire contract with agent-comms (ADR-0645 §5):
// agent-comms carries a byte-for-byte copy at lib/binding-proof.mjs, and the
// broker verifies the proofs this repository signs. Nothing checked the copy
// stayed identical (#645, F10). This repository cannot read agent-comms in a
// unit test, so the test pins the digest both copies had when they were last
// compared. Changing binding-proof.mjs fails it on purpose: change
// agent-comms's copy in the same release, compare the two again, and only then
// update the digest and the commit below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// qwts/agent-comms lib/binding-proof.mjs at 0348d78 (last changed in d1ea825).
const AGENT_COMMS_DIGEST = '2a3a19c38a3d56a2e211cb1c21e11f1e25d86f102843e9f6d8bd0766373855b4';

test('binding-proof.mjs is byte-identical to the agent-comms copy it was compared with', () => {
  // A Windows checkout may rewrite line endings; the bytes that ship are LF.
  const source = readFileSync(path.join(ROOT, 'identity', 'binding-proof.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const digest = createHash('sha256').update(source, 'utf8').digest('hex');
  assert.equal(
    digest,
    AGENT_COMMS_DIGEST,
    'binding-proof.mjs changed: update agent-comms lib/binding-proof.mjs to match, then the digest here',
  );
});
