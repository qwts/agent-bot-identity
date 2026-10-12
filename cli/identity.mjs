#!/usr/bin/env node
// `agent-bot identity`: the identity command line. It lives in cli because it
// composes other modules: a local `spawn --package` hashes a soul package
// (soul) and `finalize` reconciles the population census. agent-identity.mjs
// keeps the library and the git hooks' entry (current, show, record) (#645).
// Identity's record operations run in identity's entry, through identityOp,
// and `spawn` asks the daemon through daemon-client.mjs (#645, F13).
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { identityOp, spawnIdentity } from '../daemon-client.mjs';
import { stateDirectory } from '../state-paths.mjs';
import { finalizeIdentityWithPopulation } from '../agent-population.mjs';
import { harnessForSlug, isGateEnabled, loadConfig } from '../config.mjs';
import { readAppMetadata, resolveAgentSlug } from '../identity-cli.mjs';
import { computePackageRevision } from '../soul-package.mjs';

// The same parsing as the git hooks' entry in agent-identity.mjs.
function parseIdentityArgs(argv) {
  const [command = 'current', ...tokens] = argv.slice(2);
  const positional = [];
  let childCommand = null;
  const flags = new Map();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--') { childCommand = tokens.slice(index + 1); break; }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    // --reuse-pending is accepted for older launchers; reusing a pinned soul
    // when no transcript is in view is the default since #192.
    if (token === '--json' || token === '--reuse-pending') {
      flags.set(token.slice(2), ['true']);
      continue;
    }
    const value = tokens[++index];
    if (!value) throw new Error(`${token} requires a value`);
    const key = token.slice(2);
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  const one = (name) => flags.get(name)?.at(-1) ?? null;
  return { command, childCommand, positional, flags, one, json: flags.has('json') };
}

function printIdentityRecord(record, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${record.id}\n`);
}

function childIdentityEnv(result, env = process.env) {
  return { ...env, AGENT_BOT_BINDING: result.binding, AGENT_BOT_ID: result.agentId,
    QWTS_AGENT_ID: result.agentId, AGENT_BOT_PARENT_ID: result.parent, QWTS_AGENT_PARENT_ID: result.parent };
}

function harnessForApp(appSlug) {
  return harnessForSlug(appSlug, loadConfig());
}

// Only the flags given; the entry fills the rest from the environment.
function definedFields(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value != null));
}

function gitConfig(args, { cwd = process.cwd() } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function botUidForSlug(slug, home = homedir()) {
  try {
    return readAppMetadata(slug, { home }).botUid ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseIdentityArgs(process.argv);
  const stateDir = stateDirectory();
  const currentAgentId = () => identityOp('current', {});
  const targetId = () => args.positional[0] ?? currentAgentId();

  switch (args.command) {
    case 'ensure': {
      // The shared resolver (ENG-0079): --app, GH_AGENT_APP, the pin, the
      // account, then harness detection. Explicit inputs win wherever the
      // process runs. With github-identity off, no App is required (#280).
      const githubOn = isGateEnabled('github-identity', { env: process.env, home: homedir() });
      const appSlug = githubOn ? resolveAgentSlug({ explicit: args.one('app') }) : null;
      if (githubOn && !appSlug) throw new Error('no GitHub App identity resolves in this context');
      const identity = identityOp('ensure', {
        currentId: currentAgentId(),
        appSlug,
        botUid: appSlug ? botUidForSlug(appSlug) : null,
        harness: appSlug ? harnessForApp(appSlug) : args.one('harness'),
        useGithub: githubOn,
        transcript: args.one('transcript')
          ? { provider: args.one('provider') ?? 'custom', id: args.one('transcript') }
          : identityOp('discover-transcript', {}),
        fieldsFromEnv: true,
        fields: definedFields({
          team: args.one('team'),
          squad: args.one('squad'),
          type: args.one('type'),
          level: args.one('level'),
          parentId: args.one('parent'),
        }),
        subjects: args.flags.get('subject') ?? [],
        stateDir,
      });
      gitConfig(['config', 'extensions.worktreeConfig', 'true']);
      gitConfig(['config', '--worktree', 'agentBot.agentId', identity.id]);
      printIdentityRecord(identity, args.json);
      break;
    }
    case 'spawn': {
      if (args.childCommand && !args.childCommand.length) throw new Error('spawn -- requires a command');
      const result = await spawnIdentity({
        options: {
          name: args.one('name'), harness: args.one('harness'),
          packagePath: args.one('package') ? path.resolve(args.one('package')) : null,
          parent: args.one('parent'), app: args.one('app'),
          transcript: args.one('transcript')
            ? { provider: args.one('provider') ?? 'custom', id: args.one('transcript') } : null,
          team: args.one('team'), squad: args.one('squad'), type: args.one('type'),
          level: args.one('level'), subjects: args.flags.get('subject') ?? [],
        },
      });
      if (!result) {
        // No binding means no daemon to vouch: mint a claimed identity locally,
        // as before ADR-0008.
        if (args.childCommand) throw new Error('spawn -- requires a parent binding');
        const parentId = args.one('parent') ?? currentAgentId();
        const parent = parentId ? identityOp('read', { id: parentId, stateDir }) : null;
        const requestedApp = args.one('app');
        const parentApp = parent?.github?.appSlug ?? null;
        // A parent with no github field does not gain one by the gate being
        // on. An explicit --app opts that child into the add-on.
        const githubOn = isGateEnabled('github-identity', { env: process.env, home: homedir() })
          && (!parent || parent.github != null || Boolean(requestedApp));
        const appSlug = githubOn ? (requestedApp ?? parentApp ?? resolveAgentSlug()) : null;
        if (githubOn && !appSlug) throw new Error('spawn requires an App identity or a resolvable parent');
        const identity = identityOp('mint', {
          appSlug,
          botUid: githubOn ? (parent?.github?.botUid ?? botUidForSlug(appSlug)) : null,
          harness: parent?.harness ?? args.one('harness') ?? (githubOn ? harnessForApp(appSlug) : null),
          useGithub: githubOn,
          transcript: args.one('transcript')
            ? { provider: args.one('provider') ?? 'custom', id: args.one('transcript') }
            : identityOp('discover-transcript', {}),
          team: args.one('team') ?? parent?.team,
          squad: args.one('squad') ?? parent?.squad,
          type: args.one('type') ?? 'agent',
          level: args.one('level'),
          parentId,
          packageRevision: args.one('package') ? computePackageRevision(path.resolve(args.one('package'))) : null,
          subjects: args.flags.get('subject') ?? [],
          stateDir,
        });
        printIdentityRecord(identity, args.json);
      } else if (args.childCommand) {
        const [command, ...argv] = args.childCommand;
        const child = spawnSync(command, argv, {
          stdio: 'inherit', env: childIdentityEnv(result),
        });
        if (child.error) throw new Error(`spawn command failed: ${child.error.message}`);
        process.exitCode = child.status ?? 1;
      } else process.stdout.write(`${JSON.stringify(result)}\n`);
      break;
    }
    case 'bind': {
      const id = targetId();
      if (!id) throw new Error('bind requires an Agent ID');
      const transcriptId = args.one('transcript');
      if (!transcriptId) throw new Error('bind requires --transcript');
      printIdentityRecord(identityOp('bind-transcript', {
        id,
        transcript: { provider: args.one('provider') ?? 'custom', id: transcriptId, sha256: args.one('sha256') },
        stateDir,
      }), args.json);
      break;
    }
    case 'record': {
      const id = targetId();
      if (!id) throw new Error('record requires an Agent ID');
      printIdentityRecord(identityOp('record-evidence', {
        id,
        subjects: args.flags.get('subject') ?? [],
        artifacts: args.flags.get('artifact') ?? [],
        stateDir,
      }), args.json);
      break;
    }
    case 'finalize': {
      const id = targetId();
      if (!id) throw new Error('finalize requires an Agent ID');
      // The coordinator owns the cross-store lock.
      const identity = finalizeIdentityWithPopulation(id, {
        transcriptSha256: args.one('sha256'),
        stateDir,
      });
      printIdentityRecord(identity, args.json);
      break;
    }
    case 'show': {
      const id = targetId();
      if (!id) throw new Error('show requires an Agent ID');
      printIdentityRecord(identityOp('read', { id, stateDir }), true);
      break;
    }
    case 'current': {
      const id = currentAgentId();
      if (!id) return;
      if (args.json) printIdentityRecord(identityOp('read', { id, stateDir }), true);
      else process.stdout.write(`${id}\n`);
      break;
    }
    default:
      throw new Error('usage: agent-bot identity <ensure|spawn|bind|record|finalize|show|current|migrate-credentials>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`agent-identity: ${error.message}`);
    process.exit(1);
  });
}
