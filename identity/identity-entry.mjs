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
// `ensure` with `fieldsFromEnv` reads the team, squad, type, level and parent
// from the caller's AGENT_BOT_* variables, as `agent-bot identity ensure`
// always has, and `fields` then overrides them.
// The child runs with the caller's environment, so the state root, the
// add-on gate and transcript discovery resolve exactly as they would
// in-process. Retire and finalize take no callback: a caller that keeps a
// second store in step writes its own store first and this record last
// (owner decision on #645, revert option 1), so identity never restores a
// record a caller hands it; initialize-app works the same way.
// Record-package-revision stays in-process and is not here.

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  bindAgentTranscript,
  currentAgentId,
  discoverTranscript,
  ensureAgentIdentity,
  finalizeAgentIdentity,
  identityFieldsFromEnv,
  initializeAgentApp,
  mintAgentIdentity,
  readAgentIdentity,
  recordAgentEvidence,
  retireAgentIdentity,
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
  // pinOnly skips the Agent ID variables, for a caller that has already
  // looked in its own environment and wants only the checkout pin.
  current(input) {
    const { pinOnly = false } = only(input, ['pinOnly']);
    if (typeof pinOnly !== 'boolean') throw invalid('pinOnly must be a boolean');
    return pinOnly ? currentAgentId({ env: {} }) : currentAgentId();
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
    only(input, [...ENSURE_FIELDS, 'fieldsFromEnv', 'stateDir', 'now', 'id']);
    if (input.fieldsFromEnv !== undefined && typeof input.fieldsFromEnv !== 'boolean') throw invalid('fieldsFromEnv must be a boolean');
    const fromEnv = input.fieldsFromEnv ? { fields: { ...identityFieldsFromEnv(), ...(input.fields ?? {}) } } : {};
    return ensureAgentIdentity({
      ...fields(input, ENSURE_FIELDS),
      ...fromEnv,
      ...stateDirOption(input.stateDir),
      ...nowOption(input.now),
      ...idOption(input.id),
    });
  },
  'bind-transcript'(input) {
    const { id, transcript, stateDir, now } = only(input, ['id', 'transcript', 'stateDir', 'now']);
    return bindAgentTranscript(text('id', id), transcript, { ...stateDirOption(stateDir), ...nowOption(now) });
  },
  'record-evidence'(input) {
    only(input, ['id', 'subjects', 'artifacts', 'stateDir', 'now']);
    return recordAgentEvidence(text('id', input.id), {
      ...fields(input, ['subjects', 'artifacts']),
      ...stateDirOption(input.stateDir),
      ...nowOption(input.now),
    });
  },
  retire(input) {
    const { id, stateDir, now } = only(input, ['id', 'stateDir', 'now']);
    return retireAgentIdentity(text('id', id), { ...stateDirOption(stateDir), ...nowOption(now) });
  },
  finalize(input) {
    const { id, transcriptSha256, stateDir, now } = only(input, ['id', 'transcriptSha256', 'stateDir', 'now']);
    return finalizeAgentIdentity(text('id', id), {
      ...(transcriptSha256 === undefined ? {} : { transcriptSha256 }),
      ...stateDirOption(stateDir), ...nowOption(now),
    });
  },
  // Fills absent App metadata on a soul being joined. The caller has
  // already recorded the App in the census and puts that back if this fails.
  'initialize-app'(input) {
    const { id, appSlug, stateDir, now, config } = only(input, ['id', 'appSlug', 'stateDir', 'now', 'config']);
    if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) {
      throw invalid('config must be a JSON object');
    }
    return initializeAgentApp(text('id', id), text('appSlug', appSlug), {
      ...stateDirOption(stateDir),
      ...nowOption(now),
      ...(config === undefined ? {} : { config }),
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
      // A git failure's exit status, which some callers tell apart.
      ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
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

// Run directly, from here or through the shim at its old path (#645, step 6).
if (process.argv[1] && [import.meta.url, new URL('../identity-entry.mjs', import.meta.url).href]
  .includes(pathToFileURL(process.argv[1]).href)) await main();
