import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAgentBotArgs } from '../cli/parse.mjs';
import { helpText } from '../cli/output.mjs';
import { upsertSoul } from '../agent-population.mjs';
import {
  assertSopGitCommand,
  createRunGit,
  gitSubcommand,
  listSopDocuments,
  parseWorkflowToml,
  readSopLastGood,
  resolveSop,
} from '../sop.mjs';
import {
  BUNDLED_WORKFLOWS_DIR,
  WORKFLOW_USAGE,
  formatWorkflowList,
  formatWorkflowShow,
  listWorkflows,
  main as workflowMain,
  parseWorkflowArgs,
  showWorkflow,
  syncWorkflows,
} from '../workflow.mjs';

const ID = 'agent_12345678-1234-4234-8234-123456789abc';
const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const runLocal = createRunGit({ allowProtocols: 'file' });

function git(dir, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeFixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-test-'));
  t.after(() => {
    function thaw(dir) {
      if (!existsSync(dir)) return;
      try { chmodSync(dir, 0o700); } catch { /* ignore */ }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) thaw(join(dir, entry.name));
      }
    }
    thaw(home);
    rmSync(home, { recursive: true, force: true });
  });
  const soulDir = join(home, 'soul');
  const stateDir = join(home, 'state');
  const popFile = join(home, 'population.json');
  const userConfigPath = join(home, '.config', 'agent-sop', 'config.toml');
  mkdirSync(soulDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(soulDir, '.soul-state-id'), ID);
  upsertSoul({
    id: ID,
    name: 'clever-atlas-84',
    displayName: 'clever-atlas-84',
    soulDir,
    spacePath: join(home, 'space'),
    status: 'active',
  }, { file: popFile });

  const calls = [];
  const put = (p, text) => {
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };

  const src = join(home, 'sop-src');
  const bare = join(home, 'sop-bare.git');
  mkdirSync(src, { recursive: true });
  git(src, 'init', '-q', '-b', 'main');
  put(join(src, 'docs', 'sop', 'feature-lifecycle.md'), '# Feature Lifecycle\n');
  put(join(src, 'docs', 'sop', 'branch-pr-review.md'), '# Branch & PR Review\n');
  put(join(src, 'workflows', 'issue-to-pr.toml'), [
    'schema_version = 1',
    'name = "issue-to-pr"',
    'summary = "Cached SOP issue-to-pr workflow"',
    'sop = ["docs/sop/feature-lifecycle.md", "docs/sop/branch-pr-review.md"]',
    '',
    '[[steps]]',
    'id = "prepare"',
    'mode = "local-write"',
    'description = "Prepare isolated worktree"',
    '',
  ].join('\n'));
  put(join(src, 'workflows', 'pr-review-merge.toml'), [
    'schema_version = 1',
    'name = "pr-review-merge"',
    'summary = "Cached SOP pr-review-merge workflow"',
    'sop = ["docs/sop/branch-pr-review.md"]',
    '',
    '[[steps]]',
    'id = "merge"',
    'mode = "remote-write"',
    'description = "Resolve threads and merge"',
    'gate = "require-resolved-threads"',
    '',
  ].join('\n'));
  git(src, 'add', '.');
  git(src, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'initial sop');
  const commit1 = git(src, 'rev-parse', 'HEAD');
  git(home, 'clone', '--bare', '-q', src, bare);

  const options = {
    home,
    cwd: home,
    stateDir,
    env: {
      HOME: home,
      AGENT_BOT_ID: ID,
      AGENT_BOT_STATE_HOME: stateDir,
      AGENT_BOT_POPULATION_PATH: popFile,
    },
    populationOptions: { file: popFile },
    remoteUrl: () => bare,
    readOrgText: () => JSON.stringify({
      schema_version: 1,
      organization: { id: 'qwts', account: 'qwts', profile: 'governance/organization-profile.json' },
      sources: { sop: { repo: 'qwts/qwts-agent-sop', ref: commit1, entry: 'docs/sop/feature-lifecycle.md', summary: 'SOP' } },
      capabilities: {},
    }),
    runGit: (args) => {
      assertSopGitCommand(args);
      calls.push(args);
      return runLocal(args);
    },
  };

  put(userConfigPath, `schema_version = 1\n[repos]\norg = "qwts/qwts-agent-org@${commit1}"\nsop = "qwts/qwts-agent-sop@main"\n`);

  return { home, soulDir, stateDir, popFile, userConfigPath, src, bare, commit1, calls, put, options };
}

test('workflow is a public CLI command and --help works with zero network or config reads', () => {
  assert.equal(parseAgentBotArgs(['workflow', '--remote']).command, 'workflow');
  assert.match(helpText(), /^ {2}workflow +Resolve deterministic workflows/m);
  assert.match(WORKFLOW_USAGE, /1\. soul/);
  assert.match(WORKFLOW_USAGE, /2\. sop-cache/);
  assert.match(WORKFLOW_USAGE, /3\. bundled/);

  const res = spawnSync(process.execPath, [CLI, 'workflow', '--help'], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', AGENT_BOT_BINDING: '' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, WORKFLOW_USAGE);
});

test('bundled workflows ship valid schema_version = 1 TOML with sop arrays and ordered steps', () => {
  const names = readdirSync(BUNDLED_WORKFLOWS_DIR).filter((f) => f.endsWith('.toml')).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(names, ['issue-to-pr', 'pr-review-merge', 'release', 'workspace-cleanup']);
  for (const name of names) {
    const raw = readFileSync(join(BUNDLED_WORKFLOWS_DIR, `${name}.toml`), 'utf8');
    const parsed = parseWorkflowToml(raw, name);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.name, name);
    assert.ok(parsed.summary.length > 0);
    assert.ok(parsed.sop.length > 0);
    assert.ok(parsed.steps.length > 0);
  }
});

test('parseWorkflowArgs and parseWorkflowToml validate inputs and fail closed on invalid schemas', () => {
  assert.deepEqual(parseWorkflowArgs(['show', 'issue-to-pr', '--source', 'bundled', '--soul', ID, '--json']), {
    help: false,
    json: true,
    remote: false,
    soul: ID,
    source: 'bundled',
    command: 'show',
    name: 'issue-to-pr',
  });
  assert.throws(() => parseWorkflowArgs(['unknown']), /unknown workflow subcommand/);
  assert.throws(() => parseWorkflowArgs(['show']), /requires a workflow <name>/);
  assert.throws(() => parseWorkflowArgs(['show', '../escape']), /invalid workflow name/);
  assert.throws(() => parseWorkflowArgs(['list', '--source', 'soul']), /--source is only supported with workflow show/);
  assert.throws(() => parseWorkflowArgs(['sync', '--remote']), /workflow sync always queries remote/);

  // Legacy minimal workflow TOML (`sop = ["one.md"]`) remains valid.
  const minimal = parseWorkflowToml('sop = ["docs/sop/branch-pr-review.md"]\n', 'minimal');
  assert.deepEqual(minimal.sop, ['docs/sop/branch-pr-review.md']);
  assert.deepEqual(minimal.steps, []);

  // Invalid mode or missing step fields fail closed.
  assert.throws(() => parseWorkflowToml('sop = ["a.md"]\n[[steps]]\nid = "s1"\nmode = "exec"\ndescription = "bad"\n'), /step mode must be one of/);
  assert.throws(() => parseWorkflowToml('sop = ["a.md"]\n[[steps]]\nid = "s1"\nmode = "read-only"\n'), /requires description/);
  // schema_version = 1 requires name and summary.
  assert.throws(() => parseWorkflowToml('schema_version = 1\nsummary = "s"\nsop = ["a.md"]\n', 'w'), /requires name/);
  assert.throws(() => parseWorkflowToml('schema_version = 1\nname = "w"\nsop = ["a.md"]\n', 'w'), /requires summary/);
});

test('cachedDocuments extracts workflows/*.toml with 0444 permissions and records sop-last-good.json', (t) => {
  const f = makeFixture(t);
  const report = resolveSop(f.options);
  listSopDocuments(report, f.options);

  const cacheWf = join(f.stateDir, 'sop-cache', f.commit1, 'workflows', 'issue-to-pr.toml');
  assert.equal(existsSync(cacheWf), true);
  assert.equal(statSync(cacheWf).mode & 0o777, 0o444);

  const lastGood = readSopLastGood(f.options);
  assert.equal(lastGood.sop.repository, 'qwts/qwts-agent-sop');
  assert.equal(lastGood.sop.commit, f.commit1);

  // Simulate an older sop-cache directory created before workflows/ extraction existed:
  // `workflow sync` (includeWorkflows: true) rebuilds the cache so workflows/ is populated.
  const cacheDir = join(f.stateDir, 'sop-cache', f.commit1);
  chmodSync(cacheDir, 0o700);
  chmodSync(join(cacheDir, 'workflows'), 0o700);
  rmSync(join(cacheDir, 'workflows'), { recursive: true, force: true });
  chmodSync(cacheDir, 0o555);
  assert.equal(existsSync(join(cacheDir, 'workflows')), false);

  const repaired = syncWorkflows(f.options);
  assert.equal(repaired.synced, true);
  assert.deepEqual(repaired.workflows, ['issue-to-pr', 'pr-review-merge']);
  assert.equal(existsSync(cacheWf), true);

  // If a soul config selects a foreign repository, offline workflow resolution
  // withholds sop-cache until owner trust is accepted, and propagates malformed soul config errors.
  f.put(join(f.soulDir, 'agent-sop.toml'), `schema_version = 1\n[repos]\norg = "other/org@${f.commit1}"\nsop = "other/sop@${f.commit1}"\n`);
  const untrusted = listWorkflows({
    ...f.options,
    runGit: () => assert.fail('offline list must not invoke git'),
  });
  assert.equal(untrusted.cache, null);
  assert.ok(untrusted.workflows.every((w) => w.activeSource === 'bundled'));

  // Malformed soul agent-sop.toml fails closed instead of silently falling through to user config.
  f.put(join(f.soulDir, 'agent-sop.toml'), 'not valid toml\n');
  assert.throws(() => listWorkflows({
    ...f.options,
    runGit: () => assert.fail('offline list must not invoke git'),
  }));
});

test('offline workflow resolution follows soul -> sop-cache -> bundled with zero git calls and reports shadowedSources', (t) => {
  const f = makeFixture(t);

  // 1. Fresh machine before any sync: falls back to bundled with zero git calls.
  f.calls.length = 0;
  const freshList = listWorkflows({
    ...f.options,
    runGit: () => assert.fail('offline list must not invoke git'),
  });
  assert.equal(freshList.cache, null);
  assert.deepEqual(
    freshList.workflows.map((w) => [w.name, w.activeSource, w.shadowedSources]),
    [
      ['issue-to-pr', 'bundled', []],
      ['pr-review-merge', 'bundled', []],
      ['release', 'bundled', []],
      ['workspace-cleanup', 'bundled', []],
    ],
  );

  // 2. Sync populates sop-cache and sop-last-good.json.
  const synced = syncWorkflows(f.options);
  assert.equal(synced.synced, true);
  assert.equal(synced.commit, f.commit1);
  assert.deepEqual(synced.workflows, ['issue-to-pr', 'pr-review-merge']);

  // 3. Add a soul workflow override for workspace-cleanup.
  f.put(join(f.soulDir, 'workflows', 'workspace-cleanup.toml'), [
    'schema_version = 1',
    'name = "workspace-cleanup"',
    'summary = "Soul-specific workspace cleanup override"',
    'sop = ["docs/sop/branch-pr-review.md"]',
    '',
    '[[steps]]',
    'id = "custom-audit"',
    'mode = "read-only"',
    'description = "Custom soul cleanup step"',
    '',
  ].join('\n'));

  // 4. Offline list now resolves soul -> sop-cache -> bundled with zero git calls.
  const layered = listWorkflows({
    ...f.options,
    runGit: () => assert.fail('offline list must not invoke git'),
  });
  assert.equal(layered.cache.commit, f.commit1);
  const byName = Object.fromEntries(layered.workflows.map((w) => [w.name, w]));
  assert.equal(byName['workspace-cleanup'].activeSource, 'soul');
  assert.deepEqual(byName['workspace-cleanup'].shadowedSources, ['bundled']);
  assert.equal(byName['issue-to-pr'].activeSource, 'sop-cache');
  assert.deepEqual(byName['issue-to-pr'].shadowedSources, ['bundled']);
  assert.equal(byName.release.activeSource, 'bundled');
  assert.deepEqual(byName.release.shadowedSources, []);

  // 5. showWorkflow returns active tier by default and supports --source to inspect shadowed tier.
  const shownActive = showWorkflow('issue-to-pr', {
    ...f.options,
    runGit: () => assert.fail('offline show must not invoke git'),
  });
  assert.equal(shownActive.activeSource, 'sop-cache');
  assert.equal(shownActive.summary, 'Cached SOP issue-to-pr workflow');
  assert.deepEqual(shownActive.shadowedSources, ['bundled']);

  const shownBundled = showWorkflow('issue-to-pr', {
    ...f.options,
    source: 'bundled',
    runGit: () => assert.fail('offline show --source bundled must not invoke git'),
  });
  assert.equal(shownBundled.activeSource, 'bundled');
  assert.deepEqual(shownBundled.shadowedSources, ['sop-cache']);
  assert.match(formatWorkflowShow(shownBundled), /source: +bundled/);
});

test('workflow --remote compares local soul and sop-cache against live remote SOP commit', (t) => {
  const f = makeFixture(t);
  syncWorkflows(f.options);

  // Add soul override for workspace-cleanup
  f.put(join(f.soulDir, 'workflows', 'workspace-cleanup.toml'), [
    'schema_version = 1',
    'name = "workspace-cleanup"',
    'summary = "Soul override"',
    'sop = ["docs/sop/branch-pr-review.md"]',
    '',
  ].join('\n'));
  // Also put workspace-cleanup on remote so soul overrides remote
  f.put(join(f.src, 'workflows', 'workspace-cleanup.toml'), [
    'schema_version = 1',
    'name = "workspace-cleanup"',
    'summary = "Remote workspace cleanup"',
    'sop = ["docs/sop/branch-pr-review.md"]',
    '',
  ].join('\n'));
  // Update issue-to-pr on remote so sop-cache is stale
  f.put(join(f.src, 'workflows', 'issue-to-pr.toml'), [
    'schema_version = 1',
    'name = "issue-to-pr"',
    'summary = "Updated remote issue-to-pr workflow"',
    'sop = ["docs/sop/feature-lifecycle.md"]',
    '',
  ].join('\n'));
  // Add a remote-only workflow not yet in sop-cache
  f.put(join(f.src, 'workflows', 'incident-triage.toml'), [
    'schema_version = 1',
    'name = "incident-triage"',
    'summary = "Emergency rollback and security response"',
    'sop = ["docs/sop/branch-pr-review.md"]',
    '',
  ].join('\n'));
  git(f.src, 'add', '.');
  git(f.src, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'remote workflow updates');
  const commit2 = git(f.src, 'rev-parse', 'HEAD');
  git(f.bare, 'fetch', f.src, 'main:main');

  const remoteList = listWorkflows({ ...f.options, remote: true });
  assert.equal(remoteList.cache.commit, f.commit1);
  assert.equal(remoteList.remote.commit, commit2);
  const statusByName = Object.fromEntries(remoteList.workflows.map((w) => [w.name, [w.activeSource, w.statusVsRemote]]));
  assert.deepEqual(statusByName['workspace-cleanup'], ['soul', 'soul overrides remote']);
  assert.deepEqual(statusByName['issue-to-pr'], ['sop-cache', 'stale (remote updated)']);
  assert.deepEqual(statusByName['pr-review-merge'], ['sop-cache', 'up-to-date']);
  assert.deepEqual(statusByName['incident-triage'], ['remote-only', 'not cached locally']);
  assert.deepEqual(statusByName.release, ['bundled', 'bundled only']);

  const formatted = formatWorkflowList(remoteList, { remote: true });
  assert.match(formatted, /SOUL: clever-atlas-84/);
  assert.match(formatted, /STATUS VS REMOTE/);
  assert.match(formatted, /incident-triage +remote-only +not cached locally/);

  // Inspect the remote version of issue-to-pr directly via --source remote
  const remoteShow = showWorkflow('issue-to-pr', { ...f.options, source: 'remote' });
  assert.equal(remoteShow.activeSource, 'remote');
  assert.equal(remoteShow.commit, commit2);
  assert.equal(remoteShow.summary, 'Updated remote issue-to-pr workflow');

  // Escaping symlinks in soul workflows are refused
  f.put(join(f.home, 'outside.toml'), 'sop = ["a.md"]\n');
  symlinkSync(join(f.home, 'outside.toml'), join(f.soulDir, 'workflows', 'escape.toml'));
  assert.throws(() => listWorkflows(f.options), /symlink escapes/);

  // CLI main JSON output
  rmSync(join(f.soulDir, 'workflows', 'escape.toml'));
  let out = '';
  const code = workflowMain(['list', '--json'], { ...f.options, writeStdout: (tOut) => { out += tOut; }, writeStderr: () => {} });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).workflows.length, 4);
});
