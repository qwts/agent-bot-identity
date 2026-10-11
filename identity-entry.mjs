// Identity's record entry (#645, F6; owner decision D4, F6 answers Q1 and Q2).
// Other modules reach identity's record operations by running this file as a
// child process, through identityOp in daemon-client.mjs, instead of
// importing agent-identity.mjs. It takes one operation name as its argument
// and one JSON object on stdin, and writes one JSON object to stdout:
//
//   {"result": ...}                                  exit 0
//   {"error": {"code": "...", "message": "..."}}     exit 1
//
// Inputs are data only. Options that are functions in-process take a data
// form here: `now` is an ISO timestamp and `id` fixes the minted Agent ID.
// The child runs with the caller's environment, so the state root, the
// add-on gate and transcript discovery resolve exactly as they would
// in-process. Operations that take a callback run under the identity lock
// (retire, finalize, initialize-app, record-package-revision) are not here.

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  currentAgentId,
  discoverTranscript,
  ensureAgentIdentity,
  mintAgentIdentity,
  readAgentIdentity,
} from './agent-identity.mjs';
import { mintBindToken } from './agent-binding.mjs';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid-input' });
}

function only(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('input must be a JSON object');
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw invalid(`unexpected input: ${extra.join(', ')}`);
  return input;
}

function text(name, value) {
  if (typeof value !== 'string' || value === '') throw invalid(`${name} must be a non-empty string`);
  return value;
}

function stateDirOption(stateDir) {
  if (stateDir === undefined) return {};
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw invalid('stateDir must be an absolute path');
  return { stateDir };
}

function nowOption(now) {
  if (now === undefined) return {};
  const at = new Date(text('now', now));
  // Only the canonical form, so the wire cannot carry a time the caller did
  // not mean (a bare date, a local time).
  if (Number.isNaN(at.getTime()) || at.toISOString() !== now) throw invalid('now must be an ISO timestamp (toISOString form)');
  return { now: () => new Date(at) };
}

function idOption(id) {
  if (id === undefined) return {};
  const fixed = text('id', id);
  return { idFactory: () => fixed };
}

// Copies the listed data fields through unchanged; agent-identity validates
// their values as it does for an in-process caller.
function fields(input, names) {
  return Object.fromEntries(names.filter((name) => input[name] !== undefined).map((name) => [name, input[name]]));
}

const MINT_FIELDS = ['appSlug', 'botUid', 'harness', 'transcript', 'team', 'squad', 'type', 'level',
  'parentId', 'subjects', 'artifacts', 'useGithub', 'packageRevision'];
const ENSURE_FIELDS = ['currentId', 'appSlug', 'botUid', 'harness', 'transcript', 'fields', 'subjects', 'useGithub'];

export const IDENTITY_OPS = Object.freeze({
  read(input) {
    const { id, stateDir } = only(input, ['id', 'stateDir']);
    return readAgentIdentity(text('id', id), stateDirOption(stateDir));
  },
  // One child for many records. A record that cannot be read is reported in
  // its place, so one bad record does not hide the others.
  'read-many'(input) {
    const { ids, stateDir } = only(input, ['ids', 'stateDir']);
    if (!Array.isArray(ids)) throw invalid('ids must be an array');
    const options = stateDirOption(stateDir);
    return ids.map((id) => {
      try {
        return { id, record: readAgentIdentity(text('id', id), options) };
      } catch (error) {
        return { id, error: { code: error.code === 'invalid-input' ? error.code : 'operation-failed', message: error.message } };
      }
    });
  },
  current(input) {
    only(input, []);
    return currentAgentId();
  },
  'discover-transcript'(input) {
    only(input, []);
    return discoverTranscript();
  },
  mint(input) {
    only(input, [...MINT_FIELDS, 'stateDir', 'now', 'id']);
    // A genesis-derived ID comes from the package revision, so a fixed id
    // would be ignored; refuse the pair rather than drop one silently.
    if (input.id !== undefined && input.packageRevision != null) throw invalid('id and packageRevision cannot both be given');
    return mintAgentIdentity({
      ...fields(input, MINT_FIELDS),
      ...stateDirOption(input.stateDir),
      ...nowOption(input.now),
      ...idOption(input.id),
    });
  },
  ensure(input) {
    only(input, [...ENSURE_FIELDS, 'stateDir', 'now', 'id']);
    return ensureAgentIdentity({
      ...fields(input, ENSURE_FIELDS),
      ...stateDirOption(input.stateDir),
      ...nowOption(input.now),
      ...idOption(input.id),
    });
  },
  'mint-bind-token'(input) {
    const { gitDir, worktree, agentId, now } = only(input, ['gitDir', 'worktree', 'agentId', 'now']);
    return mintBindToken({ gitDir: text('gitDir', gitDir), worktree, agentId, ...nowOption(now) });
  },
});

// Runs one operation in this process. The child entry below and the parity
// tests both go through it.
export function runIdentityOp(op, input) {
  if (!Object.hasOwn(IDENTITY_OPS, op)) {
    throw Object.assign(new Error(`unknown identity operation: ${JSON.stringify(op)}`), { code: 'unknown-op' });
  }
  return IDENTITY_OPS[op](input) ?? null;
}

function errorPayload(error) {
  const code = ['invalid-input', 'unknown-op'].includes(error?.code) ? error.code : 'operation-failed';
  return {
    error: {
      code,
      message: String(error?.message ?? error),
      ...(Number.isInteger(error?.statusCode) ? { statusCode: error.statusCode } : {}),
    },
  };
}

// Reads stdin as a stream: a synchronous read of fd 0 can fail with EAGAIN
// when the parent has not written yet and the pipe is non-blocking.
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let output;
  try {
    let input;
    try {
      input = JSON.parse(await readStdin());
    } catch {
      throw invalid('stdin must be one JSON object');
    }
    output = { result: runIdentityOp(process.argv[2], input) };
  } catch (error) {
    output = errorPayload(error);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.error) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
