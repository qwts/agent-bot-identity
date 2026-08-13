import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  bindAgentTranscript,
  currentAgentId,
  discoverTranscript,
  ensureAgentIdentity,
  finalizeAgentIdentity,
  identityFieldsFromEnv,
  mintAgentIdentity,
  readAgentIdentity,
  recordAgentEvidence,
  reclaimStaleLock,
  validateIdentity,
  withLock,
} from '../agent-identity.mjs';
import { displayName, showSoul, upsertSoul } from '../agent-population.mjs';
import { startMockGitHubApp } from './helpers/mock-github-app.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-identity-'));
  roots.push(root);
  return root;
}

function id(number) {
  return `agent_00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function mintOptions(stateDir, overrides = {}) {
  return {
    appSlug: 'you-codex-agent',
    botUid: '308462948',
    harness: 'codex',
    transcript: { provider: 'codex', id: 'thread-1' },
    stateDir,
    idFactory: () => id(1),
    now: () => new Date('2026-07-25T18:00:00.000Z'),
    ...overrides,
  };
}

test('discovers explicit, Codex, and Claude transcript locators without storing transcript content', () => {
  assert.deepEqual(discoverTranscript({
    AGENT_BOT_TRANSCRIPT_PROVIDER: 'provider',
    AGENT_BOT_TRANSCRIPT_ID: 'transcript-1',
    CODEX_THREAD_ID: 'ignored',
  }), { provider: 'provider', id: 'transcript-1' });
  assert.deepEqual(discoverTranscript({ CODEX_THREAD_ID: 'codex-1' }), {
    provider: 'codex',
    id: 'codex-1',
  });
  assert.deepEqual(discoverTranscript({ CLAUDE_SESSION_ID: 'claude-1' }), {
    provider: 'claude',
    id: 'claude-1',
  });
  assert.equal(discoverTranscript({}), null);
});

test('keeps team metadata structured and honest when launchers provide none', () => {
  assert.deepEqual(identityFieldsFromEnv({}), {
    team: null,
    squad: null,
    type: 'agent',
    level: null,
    parentId: null,
  });
  assert.deepEqual(identityFieldsFromEnv({
    AGENT_BOT_TEAM: 'you-codex',
    AGENT_BOT_SQUAD: 'sol',
    AGENT_BOT_TYPE: 'agent',
    AGENT_BOT_LEVEL: 'high',
    AGENT_BOT_PARENT_ID: id(9),
  }), {
    team: 'you-codex',
    squad: 'sol',
    type: 'agent',
    level: 'high',
    parentId: id(9),
  });
});

test('mints a private transcript-bound record with a credential provider but no credential', () => {
  const stateDir = state();
  const record = mintAgentIdentity(mintOptions(stateDir, {
    team: 'you-codex',
    squad: 'sol',
    level: 'high',
    subjects: ['github:example/repo#81'],
  }));

  assert.equal(record.id, id(1));
  assert.equal(record.github.actor, 'you-codex-agent[bot]');
  assert.equal(record.github.credentialProvider, 'worktree-token');
  assert.deepEqual(record.transcript, { provider: 'codex', id: 'thread-1', sha256: null });
  assert.deepEqual(record.subjects, ['github:example/repo#81']);
  assert.equal('token' in record.github, false);
  assert.deepEqual(validateIdentity(record), []);
  assert.equal(statSync(path.join(stateDir, `${record.id}.json`)).mode & 0o777, 0o600);
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
});

test('a corrupt audit record is warned about but cannot brick new identity setup', () => {
  const stateDir = state();
  writeFileSync(path.join(stateDir, `${id(99)}.json`), '{"half-written":');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const record = ensureAgentIdentity(mintOptions(stateDir, {
      transcript: { provider: 'codex', id: 'healthy-thread' },
      idFactory: () => id(1),
    }));
    assert.equal(record.transcript.id, 'healthy-thread');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignoring invalid registry record/);
});

test('a corrupt currently pinned identity is replaced during setup', () => {
  const stateDir = state();
  const corruptId = id(99);
  writeFileSync(path.join(stateDir, `${corruptId}.json`), '{"half-written":');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const record = ensureAgentIdentity(mintOptions(stateDir, {
      currentId: corruptId,
      transcript: { provider: 'codex', id: 'repair-thread' },
      idFactory: () => id(1),
    }));
    assert.equal(record.id, id(1));
    assert.equal(record.transcript.id, 'repair-thread');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((message) => /ignoring invalid current identity/.test(message)));
});

test('initial publication is exclusive and leaves no partial target or temp file', () => {
  const stateDir = state();
  mintAgentIdentity(mintOptions(stateDir));
  assert.throws(
    () => mintAgentIdentity(mintOptions(stateDir)),
    /could not allocate a unique Agent ID/,
  );
  assert.deepEqual(readdirSync(stateDir), [`${id(1)}.json`]);
});

test('reuses one identity within a transcript, binds a pending record, and rotates on conversation change', () => {
  const stateDir = state();
  let next = 1;
  const idFactory = () => id(next++);
  const first = ensureAgentIdentity(mintOptions(stateDir, { idFactory }));
  const same = ensureAgentIdentity(mintOptions(stateDir, {
    currentId: first.id,
    idFactory,
  }));
  assert.equal(same.id, first.id);

  const anotherWorktree = ensureAgentIdentity(mintOptions(stateDir, {
    currentId: null,
    subjects: ['github:example/repo#81'],
    idFactory,
  }));
  assert.equal(anotherWorktree.id, first.id);
  assert.deepEqual(anotherWorktree.subjects, ['github:example/repo#81']);

  const pending = mintAgentIdentity(mintOptions(stateDir, {
    transcript: null,
    idFactory,
  }));
  const nextPending = ensureAgentIdentity(mintOptions(stateDir, {
    currentId: pending.id,
    transcript: null,
    idFactory,
  }));
  assert.notEqual(nextPending.id, pending.id);
  const explicitlyReused = ensureAgentIdentity(mintOptions(stateDir, {
    currentId: nextPending.id,
    transcript: null,
    reusePending: true,
    idFactory,
  }));
  assert.equal(explicitlyReused.id, nextPending.id);

  const bound = ensureAgentIdentity(mintOptions(stateDir, {
    currentId: pending.id,
    transcript: { provider: 'codex', id: 'thread-pending' },
    idFactory,
  }));
  assert.equal(bound.id, pending.id);
  assert.equal(bound.transcript.id, 'thread-pending');

  const nextConversation = ensureAgentIdentity(mintOptions(stateDir, {
    currentId: first.id,
    transcript: { provider: 'codex', id: 'thread-2' },
    idFactory,
  }));
  assert.notEqual(nextConversation.id, first.id);
  assert.equal(readAgentIdentity(first.id, { stateDir }).transcript.id, 'thread-1');
  assert.equal(nextConversation.transcript.id, 'thread-2');
});

test('a transcript binding is immutable and an App change gets a new execution identity', () => {
  const stateDir = state();
  let next = 1;
  const idFactory = () => id(next++);
  const first = mintAgentIdentity(mintOptions(stateDir, { idFactory }));
  assert.throws(
    () => bindAgentTranscript(first.id, { provider: 'codex', id: 'different' }, { stateDir }),
    /already bound/,
  );

  const repinned = ensureAgentIdentity(mintOptions(stateDir, {
    currentId: first.id,
    appSlug: 'you-claude-fable-agent',
    idFactory,
  }));
  assert.notEqual(repinned.id, first.id);
  assert.equal(repinned.github.appSlug, 'you-claude-fable-agent');
});

test('child identities point to their parent without sharing the parent transcript', () => {
  const stateDir = state();
  const parent = mintAgentIdentity(mintOptions(stateDir));
  const child = mintAgentIdentity(mintOptions(stateDir, {
    parentId: parent.id,
    transcript: { provider: 'codex', id: 'child-thread' },
    idFactory: () => id(2),
  }));
  assert.equal(child.parentId, parent.id);
  assert.equal(child.transcript.id, 'child-thread');
  assert.equal(readAgentIdentity(parent.id, { stateDir }).transcript.id, 'thread-1');
});

test('evidence is deduplicated and finalization can seal a transcript digest', () => {
  const stateDir = state();
  const record = mintAgentIdentity(mintOptions(stateDir));
  const evidenced = recordAgentEvidence(record.id, {
    subjects: ['github:example/repo#81', 'github:example/repo#81'],
    artifacts: ['commit:abc', 'commit:abc'],
    stateDir,
  });
  assert.deepEqual(evidenced.subjects, ['github:example/repo#81']);
  assert.deepEqual(evidenced.artifacts, ['commit:abc']);

  const digest = 'a'.repeat(64);
  const finalized = finalizeAgentIdentity(record.id, { transcriptSha256: digest, stateDir });
  assert.equal(finalized.status, 'finalized');
  assert.equal(finalized.transcript.sha256, digest);
  assert.ok(finalized.finalizedAt);
});

test('identity finalize synchronizes a registered population row', () => {
  const root = state();
  const stateDir = path.join(root, 'identities');
  const populationPath = path.join(root, 'population.json');
  const record = mintAgentIdentity(mintOptions(stateDir));
  upsertSoul({
    id: record.id,
    appSlug: record.github.appSlug,
    parentId: record.parentId,
    status: record.status,
    spacePath: path.join(root, 'spaces', record.id),
    transcriptLocator: record.transcript,
    lastSeen: '2000-01-01T00:00:00.000Z',
  }, { file: populationPath });
  const cli = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'agent-identity.mjs',
  );

  const finalized = spawnSync(process.execPath, [cli, 'finalize', record.id], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_BOT_STATE_HOME: stateDir,
      AGENT_BOT_POPULATION_PATH: populationPath,
    },
  });

  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(readAgentIdentity(record.id, { stateDir }).status, 'finalized');
  assert.equal(showSoul(record.id, { file: populationPath }).status, 'finalized');
  assert.notEqual(
    showSoul(record.id, { file: populationPath }).lastSeen,
    '2000-01-01T00:00:00.000Z',
  );

  const second = mintAgentIdentity(mintOptions(stateDir, {
    transcript: { provider: 'codex', id: 'thread-2' },
    idFactory: () => id(2),
  }));
  upsertSoul({
    id: second.id,
    appSlug: second.github.appSlug,
    parentId: second.parentId,
    status: second.status,
    spacePath: path.join(root, 'spaces', second.id),
    transcriptLocator: second.transcript,
    lastSeen: '2000-01-01T00:00:00.000Z',
  }, { file: populationPath });
  writeFileSync(populationPath, 'not valid JSON\n');

  const failed = spawnSync(process.execPath, [cli, 'finalize', second.id], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_BOT_STATE_HOME: stateDir,
      AGENT_BOT_POPULATION_PATH: populationPath,
    },
  });

  assert.notEqual(failed.status, 0);
  assert.equal(readAgentIdentity(second.id, { stateDir }).status, 'active');
});

test('concurrent evidence writers do not lose one another', async () => {
  const stateDir = state();
  const record = mintAgentIdentity(mintOptions(stateDir));
  const staleLock = path.join(stateDir, `${record.id}.json.lock`);
  mkdirSync(staleLock);
  utimesSync(staleLock, new Date(0), new Date(0));
  const cli = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'agent-identity.mjs',
  );
  const writes = Array.from({ length: 12 }, (_, index) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        'record',
        record.id,
        '--subject',
        `subject:${index}`,
      ], {
        env: { ...process.env, AGENT_BOT_STATE_HOME: stateDir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`identity writer exited ${code}: ${stderr}`));
      });
    }));
  await Promise.all(writes);

  assert.equal(readAgentIdentity(record.id, { stateDir }).subjects.length, 12);
});

test('ensure corrects a cross-territory GH_AGENT_APP to the territory App (#20)', () => {
  // Same policy as mint-token's appConfig: without --app the resolution is
  // territory-aware, so a launcher-inherited GH_AGENT_APP cannot bind a
  // foreign App's identity to a worktree another harness owns.
  const root = state();
  const stateDir = path.join(root, 'identities');
  const repo = path.join(root, '.codex', 'worktrees', 'session', 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  const configPath = path.join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ prefix: 'you' }));
  const emptyGitConfig = path.join(root, 'gitconfig');
  writeFileSync(emptyGitConfig, '');
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (/^(CODEX|CLAUDE|AI_AGENT|QWTS_AGENT|AGENT_BOT)/.test(key)) delete cleanEnv[key];
  }
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-identity.mjs');
  const ensured = spawnSync(process.execPath, [cli, 'ensure', '--json'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      HOME: home,
      AGENT_BOT_CONFIG: configPath,
      AGENT_BOT_STATE_HOME: stateDir,
      GH_AGENT_APP: 'you-claude-agent',
      CODEX_THREAD_ID: 'thread-territory',
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  assert.equal(ensured.status, 0, ensured.stderr);
  assert.equal(JSON.parse(ensured.stdout).github.appSlug, 'you-codex-agent');
});

test('concurrent setup in separate worktrees shares one conversation identity', async () => {
  const stateDir = state();
  const moduleUrl = pathToFileURL(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'agent-identity.mjs',
  )).href;
  const source = `
    import { ensureAgentIdentity } from ${JSON.stringify(moduleUrl)};
    const record = ensureAgentIdentity({
      appSlug: 'you-codex-agent',
      transcript: { provider: 'codex', id: 'shared-thread' },
      stateDir: process.env.AGENT_BOT_STATE_HOME,
    });
    process.stdout.write(record.id);
  `;
  const allocations = Array.from({ length: 12 }, () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
        env: { ...process.env, AGENT_BOT_STATE_HOME: stateDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`identity allocator exited ${code}: ${stderr}`));
      });
    }));
  const ids = await Promise.all(allocations);

  assert.equal(new Set(ids).size, 1);
  assert.equal(readdirSync(stateDir).filter((name) => name.endsWith('.json')).length, 1);
});

test('current identity prefers the child process environment over worktree config', () => {
  const root = state();
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['config', 'agentBot.agentId', id(1)], { cwd: root });
  assert.equal(currentAgentId({ env: {}, cwd: root }), id(1));
  assert.equal(currentAgentId({ env: { AGENT_BOT_ID: id(2) }, cwd: root }), id(2));
});

test('setup-worktree binds CODEX_THREAD_ID and rotates when a new conversation reuses the worktree', (t) => {
  const root = state();
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  const stateDir = path.join(root, 'state');
  const spacesDir = path.join(root, 'spaces');
  const populationPath = path.join(root, 'population.json');
  const globalConfig = path.join(root, 'gitconfig');
  const app = 'you-codex-agent';
  const github = startMockGitHubApp(root);
  t.after(() => github.stop());
  mkdirSync(path.join(home, '.config', app), { recursive: true });
  mkdirSync(path.join(home, '.config', 'agent-bot'), { recursive: true });
  writeFileSync(path.join(home, '.config', app, 'bot-uid'), '308462948\n');
  writeFileSync(path.join(home, '.config', app, 'app-id'), '12345\n');
  writeFileSync(path.join(home, '.config', app, 'private-key.pem'), github.privateKeyPem);
  writeFileSync(path.join(home, '.config', 'agent-bot', 'config.json'), JSON.stringify({
    apiBase: github.apiBase,
    owner: 'test-owner',
  }));
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  writeFileSync(path.join(repo, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: repo });

  writeFileSync(globalConfig, `[agentBot]\n\tagentId = ${id(99)}\n`);
  const cleanEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
  for (const key of Object.keys(cleanEnv)) {
    if (/^(CODEX|CLAUDE|AI_AGENT|QWTS_AGENT|AGENT_BOT)/.test(key)) delete cleanEnv[key];
  }
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'topic', worktree], {
    cwd: repo,
    env: cleanEnv,
  });
  execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], {
    cwd: worktree,
    env: cleanEnv,
  });

  const setup = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'setup-worktree.mjs',
  );
  const runSetup = (thread) => execFileSync(process.execPath, [setup, app], {
    cwd: worktree,
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      HOME: home,
      AGENT_BOT_STATE_HOME: stateDir,
      AGENT_BOT_SPACES_HOME: spacesDir,
      AGENT_BOT_POPULATION_PATH: populationPath,
      AGENT_BOT_PARENT_ID: id(42),
      CODEX_THREAD_ID: thread,
    },
  });

  const firstSetup = runSetup('thread-1');
  assert.match(firstSetup, /space created/);
  const firstId = execFileSync('git', ['config', '--get', 'agentBot.agentId'], {
    cwd: worktree,
    env: cleanEnv,
    encoding: 'utf8',
  }).trim();
  assert.notEqual(firstId, id(99), 'a global Agent ID cannot impersonate this worktree');
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'agentBot.app'], {
      cwd: worktree,
      env: cleanEnv,
      encoding: 'utf8',
    }).trim(),
    app,
    'the resolved App is persisted so later GitHub writes cannot fall back to the harness App',
  );
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'core.hooksPath'], {
      cwd: worktree,
      env: cleanEnv,
      encoding: 'utf8',
    }).trim(),
    path.join(home, '.local', 'share', 'agent-bot', 'hooks'),
  );
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'agentBot.chainedHooksPath'], {
      cwd: worktree,
      env: cleanEnv,
      encoding: 'utf8',
    }).trim(),
    '.husky/_',
  );
  assert.equal(readAgentIdentity(firstId, { stateDir }).transcript.id, 'thread-1');
  assert.match(execFileSync('git', ['config', 'user.email'], {
    cwd: worktree,
    env: cleanEnv,
    encoding: 'utf8',
  }), /308462948/);
  assert.equal(
    JSON.parse(readFileSync(path.join(spacesDir, firstId, 'space.json'), 'utf8')).agentId,
    firstId,
  );
  const firstPopulation = JSON.parse(readFileSync(populationPath, 'utf8'));
  assert.deepEqual(firstPopulation.souls[firstId], {
    id: firstId,
    name: displayName(firstId),
    appSlug: app,
    parentId: id(42),
    status: 'active',
    spacePath: path.join(spacesDir, firstId),
    transcriptLocator: { provider: 'codex', id: 'thread-1' },
    lastSeen: firstPopulation.souls[firstId].lastSeen,
  });
  assert.equal(
    new Date(firstPopulation.souls[firstId].lastSeen).toISOString(),
    firstPopulation.souls[firstId].lastSeen,
  );

  firstPopulation.souls[firstId].lastSeen = '2000-01-01T00:00:00.000Z';
  writeFileSync(populationPath, `${JSON.stringify(firstPopulation, null, 2)}\n`);

  const repeatedSetup = runSetup('thread-1');
  assert.match(repeatedSetup, /space ready/);
  assert.equal(
    execFileSync('git', ['config', '--get', 'agentBot.agentId'], {
      cwd: worktree,
      env: cleanEnv,
      encoding: 'utf8',
    }).trim(),
    firstId,
  );
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'agentBot.chainedHooksPath'], {
      cwd: worktree,
      env: cleanEnv,
      encoding: 'utf8',
    }).trim(),
    '.husky/_',
    'idempotent setup retains the displaced repository hooks path',
  );
  const repeatedPopulation = JSON.parse(readFileSync(populationPath, 'utf8'));
  assert.deepEqual(Object.keys(repeatedPopulation.souls), [firstId]);
  assert.notEqual(repeatedPopulation.souls[firstId].lastSeen, '2000-01-01T00:00:00.000Z');

  finalizeAgentIdentity(firstId, { stateDir });
  repeatedPopulation.souls[firstId].status = 'active';
  writeFileSync(populationPath, `${JSON.stringify(repeatedPopulation, null, 2)}\n`);
  runSetup('thread-1');
  assert.equal(
    JSON.parse(readFileSync(populationPath, 'utf8')).souls[firstId].status,
    'finalized',
    'setup projects the resolved identity status instead of reviving a finalized soul',
  );

  const savedSpaces = `${spacesDir}.saved`;
  renameSync(spacesDir, savedSpaces);
  writeFileSync(spacesDir, 'not a directory\n');
  assert.throws(() => runSetup('thread-with-broken-space-root'));
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'agentBot.agentId'], {
      cwd: worktree,
      env: cleanEnv,
      encoding: 'utf8',
    }).trim(),
    firstId,
    'space initialization failure must not partially bind the new Agent ID',
  );
  rmSync(spacesDir, { force: true });
  renameSync(savedSpaces, spacesDir);

  const savedPopulation = `${populationPath}.saved`;
  renameSync(populationPath, savedPopulation);
  writeFileSync(populationPath, 'not valid JSON\n');
  assert.throws(() => runSetup('thread-with-broken-population'));
  assert.equal(
    execFileSync('git', ['config', '--worktree', '--get', 'agentBot.agentId'], {
      cwd: worktree,
      env: cleanEnv,
      encoding: 'utf8',
    }).trim(),
    firstId,
    'population registration failure must not partially bind the new Agent ID',
  );
  rmSync(populationPath, { force: true });
  renameSync(savedPopulation, populationPath);

  runSetup('thread-2');
  const secondId = execFileSync('git', ['config', '--get', 'agentBot.agentId'], {
    cwd: worktree,
    env: cleanEnv,
    encoding: 'utf8',
  }).trim();
  assert.notEqual(secondId, firstId);
  assert.equal(readAgentIdentity(secondId, { stateDir }).transcript.id, 'thread-2');
  assert.equal(
    JSON.parse(readFileSync(path.join(spacesDir, secondId, 'space.json'), 'utf8')).agentId,
    secondId,
  );
  assert.equal(
    JSON.parse(readFileSync(path.join(spacesDir, firstId, 'space.json'), 'utf8')).agentId,
    firstId,
    'rotating the worktree identity does not retire the prior soul space',
  );
  const rotatedPopulation = JSON.parse(readFileSync(populationPath, 'utf8'));
  assert.deepEqual(Object.keys(rotatedPopulation.souls).sort(), [firstId, secondId].sort());
  assert.deepEqual(rotatedPopulation.souls[secondId].transcriptLocator, {
    provider: 'codex',
    id: 'thread-2',
  });
});

// --- lock safety (issue #15) -------------------------------------------------
// Both of these fail deterministically against the previous implementation; the
// 12-writer concurrency test above only fails intermittently, which is why the
// bug survived so long.

test('releasing a lock never deletes a successor that reclaimed it', () => {
  const root = state();
  const lock = path.join(root, 'takeover.lock');
  let successorToken = null;

  withLock(lock, 'takeover', () => {
    // Stand in for the reclaim race: while we are inside the critical section,
    // another waiter judges this lock stale, carries it off, and acquires its
    // own at the same path.
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock, { mode: 0o700 });
    successorToken = 'successor';
    writeFileSync(path.join(lock, 'owner'), successorToken, 'utf8');
  });

  // The old release removed whatever sat at the path, so the successor's lock
  // vanished while it was still working — one stolen lock became a cascade.
  assert.equal(readFileSync(path.join(lock, 'owner'), 'utf8'), successorToken);
});

test('reclaiming refuses to carry off a lock that is not the one judged stale', () => {
  const root = state();
  const lock = path.join(root, 'fresh.lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(path.join(lock, 'owner'), 'live-holder', 'utf8');

  // What a reclaimer holds is a reading taken *before* this lock existed: a
  // stale directory that has since been released, with a different inode.
  reclaimStaleLock(lock, { ino: statSync(lock).ino + 1_000_000, mtimeMs: 0 });

  assert.equal(readFileSync(path.join(lock, 'owner'), 'utf8'), 'live-holder');
});

test('a genuinely stale lock is still reclaimed', () => {
  const root = state();
  const lock = path.join(root, 'stale.lock');
  mkdirSync(lock, { mode: 0o700 });
  utimesSync(lock, new Date(0), new Date(0));

  const observed = statSync(lock);
  reclaimStaleLock(lock, observed);

  assert.throws(() => statSync(lock), /ENOENT/);
});

test('a lock is never left behind when stamping its owner fails', () => {
  const root = state();
  const lock = path.join(root, 'unstampable.lock');
  // A directory where the owner file cannot be created stands in for any
  // failure between mkdir and stamp. An unstamped lock belongs to nobody and
  // would block every writer until the staleness window expired.
  assert.throws(() => withLock(lock, 'unstampable', () => {
    mkdirSync(path.join(lock, 'owner'));
    throw new Error('unreachable');
  }));
  assert.throws(() => statSync(lock), /ENOENT/);
});

test('reclaim and release cannot run at the same time', () => {
  const root = state();
  const lock = path.join(root, 'serialized.lock');
  const takeover = `${lock}.takeover`;
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(path.join(lock, 'owner'), 'live-holder', 'utf8');
  utimesSync(lock, new Date(0), new Date(0));

  // Somebody else holds the takeover mutex, so this stale lock must be left
  // alone rather than swapped out from under its holder.
  mkdirSync(takeover, { mode: 0o700 });
  try {
    assert.equal(reclaimStaleLock(lock, statSync(lock)), false);
    assert.equal(readFileSync(path.join(lock, 'owner'), 'utf8'), 'live-holder');
  } finally {
    rmSync(takeover, { recursive: true, force: true });
  }

  // With the mutex free, the same stale lock is collected.
  assert.equal(reclaimStaleLock(lock, statSync(lock)), true);
  assert.throws(() => statSync(lock), /ENOENT/);
});

test('a takeover mutex left by a dead process does not wedge the lock forever', () => {
  const root = state();
  const lock = path.join(root, 'wedged.lock');
  const takeover = `${lock}.takeover`;
  mkdirSync(lock, { mode: 0o700 });
  utimesSync(lock, new Date(0), new Date(0));
  mkdirSync(takeover, { mode: 0o700 });
  utimesSync(takeover, new Date(0), new Date(0));

  assert.equal(reclaimStaleLock(lock, statSync(lock)), true);
  assert.throws(() => statSync(lock), /ENOENT/);
});
