import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentBotArgs } from '../cli/parse.mjs';
import {
  SOP_GIT_COMMANDS,
  USAGE,
  assertSopGitCommand,
  configPathFor,
  createRunGit,
  sopGitEnv,
  formatSopReport,
  gitSubcommand,
  loadSopConfig,
  main as sopMain,
  parseOrgPins,
  parseTomlSubset,
  resolveSop as sopResolve,
} from '../sop.mjs';

const noSoul = { currentAgentId: () => null, readBinding: () => null };
const resolveSop = (options) => sopResolve({ ...noSoul, ...options });
const main = (argv, deps) => sopMain(argv, { ...noSoul, ...deps });

const localRunGit = createRunGit({ allowProtocols: 'file' });
const CLI = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
const ORG = '11'.repeat(20);
const SOP = '22'.repeat(20);
const COMMS = '33'.repeat(20);
const TAG = '44'.repeat(20);
const BOT = '55'.repeat(20);
const DEV = '66'.repeat(20);

function orgJson(extra = {}) {
  return JSON.stringify({
    schema_version: 1,
    organization: {
      id: 'acme',
      account: 'acme',
      profile: 'governance/organization-profile.json',
    },
    sources: {
      sop: {
        repo: 'acme/sop',
        ref: SOP,
        entry: 'README.md',
        summary: 'The SOP.',
      },
    },
    capabilities: {
      'agent-bot': {
        repo: 'acme/bot',
        ref: BOT,
        entry: 'skills/agent-bot/SKILL.md',
        summary: 'Runtime.',
      },
    },
    ...extra,
  });
}

function fakeGit(refs, body = orgJson()) {
  const calls = [];
  const runGit = (args) => {
    calls.push(args);
    const blob = args.join('\0');
    if (blob.includes('evil.sh') || blob.includes('$(rm -rf /)')) throw new Error('executed fetched content');
    const sub = gitSubcommand(args);
    if (sub === 'ls-remote') {
      const queries = args.slice(args.indexOf('ls-remote') + 2);
      const lines = queries.filter((query) => refs[query]).map((query) => `${refs[query]}\t${query}`);
      return { status: 0, stdout: lines.length ? `${lines.join('\n')}\n` : '', stderr: '' };
    }
    if (sub === 'cat-file') return { status: 0, stdout: body, stderr: '' };
    if (sub === 'fetch') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, runGit };
}

function subcommands(calls) {
  return calls.map((args) => gitSubcommand(args));
}

const HEADS = {
  'refs/heads/main': ORG,
  'refs/tags/v1': TAG,
  [`refs/tags/v1^{}`]: COMMS,
  'refs/heads/dev': DEV,
};

test('the config path is ~/.config/agent-sop/config.toml', () => {
  assert.equal(configPathFor('/home/example'), '/home/example/.config/agent-sop/config.toml');
  let seen = null;
  const report = resolveSop({
    home: '/home/example',
    readFile(path) {
      seen = path;
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    runGit() {
      throw new Error('git was called');
    },
  });
  assert.equal(seen, '/home/example/.config/agent-sop/config.toml');
  assert.equal(report.inEffect, false);
  assert.equal(report.message, 'No SOP is in effect.');
  assert.equal(formatSopReport(report), 'No SOP is in effect.\n');
});

test('ENG-0355 config.toml parses org, sop, and comms and nothing else', () => {
  const text = [
    'schema_version = 1',
    '',
    '[repos]',
    'org   = "qwts/qwts-agent-org@main"   # required',
    'sop   = "qwts/qwts-agent-sop@main"   # optional: otherwise org.json pins it',
    "comms = 'owner/comms-repo@ref'       # optional",
    '',
  ].join('\n');
  assert.deepEqual(loadSopConfig(text), {
    schemaVersion: 1,
    repos: {
      org: { repo: 'qwts/qwts-agent-org', ref: 'main' },
      sop: { repo: 'qwts/qwts-agent-sop', ref: 'main' },
      comms: { repo: 'owner/comms-repo', ref: 'ref' },
    },
  });
  assert.deepEqual(parseTomlSubset('msg = "hash # inside" # outside\n').root, { msg: 'hash # inside' });
  assert.equal(parseTomlSubset('msg = "a\\"b\\n"\n').root.msg, 'a"b\n');
  assert.throws(() => loadSopConfig('schema_version = 1\n[repos]\norg = "acme/org@main"\n[extra]\nx = 1\n'), /unsupported table \[extra\]/);
  assert.throws(() => loadSopConfig('schema_version = 2\n[repos]\norg = "acme/org@main"\n'), /schema_version must be the integer 1/);
  assert.throws(() => loadSopConfig('schema_version = "1"\n[repos]\norg = "acme/org@main"\n'), /got "1"/);
  assert.throws(() => loadSopConfig('[repos]\norg = "acme/org@main"\n'), /schema_version must be the integer 1/);
  assert.throws(() => loadSopConfig('schema_version = 1\n'), /missing \[repos\] table/);
  assert.throws(() => loadSopConfig('schema_version = 1\n[repos]\nsop = "acme/sop@main"\n'), /repos\.org is required/);
  assert.throws(() => loadSopConfig('schema_version = 1\n[repos]\norg = "acme/org@main"\nextra = "x"\n'), /unsupported repos\.extra/);
  assert.throws(() => loadSopConfig('schema_version = 1\nbots = ["a"]\n'), /arrays and inline tables are not supported/);
  assert.throws(() => loadSopConfig('schema_version = true\n'), /booleans are not supported/);
  assert.throws(() => loadSopConfig('schema_version = 1\nschema_version = 1\n'), /duplicate key schema_version/);
  assert.throws(() => loadSopConfig('schema_version = 1\n[repos]\norg = "https://github.com/acme/org@main"\n'), /repos\.org must be owner\/name@ref/);
  assert.throws(() => loadSopConfig('schema_version = 1\n[repos]\norg = "acme/org/extra@main"\n'), /repos\.org must be owner\/name@ref/);
  assert.throws(() => loadSopConfig('schema_version = 1\n[repos]\norg = "acme/org@abc1234"\n'), /repos\.org must be a branch, a tag, or a 40-hex commit/);
  assert.throws(() => loadSopConfig('schema_version = 1\n[repos]\norg = "acme/org@main;rm"\n'), /repos\.org must be owner\/name@ref/);
  assert.throws(() => loadSopConfig('schema_version = 1\n[[repos]]\n'), /only \[table\] headers are supported/);
});

test('a missing config file is no SOP and exits 0; a broken file fails before git', () => {
  const captured = {};
  const absent = main([], {
    home: '/nowhere',
    readFile(path) {
      assert.equal(path, '/nowhere/.config/agent-sop/config.toml');
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    runGit() {
      throw new Error('git was called');
    },
    writeStdout(text) {
      captured.stdout = text;
    },
    writeStderr(text) {
      captured.stderr = text;
    },
  });
  assert.equal(absent, 0);
  assert.equal(captured.stdout, 'No SOP is in effect.\n');
  assert.equal(captured.stderr, undefined);

  let json = '';
  const coded = main(['--json'], {
    home: '/nowhere',
    readFile() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    writeStdout(text) {
      json = text;
    },
    writeStderr() {},
  });
  assert.equal(coded, 0);
  assert.deepEqual(JSON.parse(json), {
    inEffect: false,
    message: 'No SOP is in effect.',
    configPath: '/nowhere/.config/agent-sop/config.toml',
    selection: { source: 'none', path: null },
  });

  let stderr = '';
  const broken = main(['--config', '/tmp/does-not-exist-sop.toml'], {
    readFile() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    runGit() {
      throw new Error('git was called');
    },
    writeStdout() {
      throw new Error('stdout');
    },
    writeStderr(text) {
      stderr = text;
    },
  });
  assert.equal(broken, 1);
  assert.match(stderr, /no such file/);

  stderr = '';
  const bad = main([], {
    home: '/nowhere',
    readFile() {
      return 'schema_version = 1\n[repos]\norg = 1\n';
    },
    runGit() {
      throw new Error('git was called');
    },
    writeStdout() {
      throw new Error('stdout');
    },
    writeStderr(text) {
      stderr = text;
    },
  });
  assert.equal(bad, 1);
  assert.match(stderr, /^agent-bot sop: repos\.org must be owner\/name@ref\n$/);
});

test('resolves branch and tag refs, reports pins, and does not execute them', () => {
  const summary = 'line1\n$(rm -rf /)';
  const body = JSON.stringify({
    schema_version: 1,
    organization: { id: 'acme', account: 'acme', profile: 'governance/organization-profile.json' },
    sources: { sop: { repo: 'acme/sop', ref: SOP, entry: 'evil.sh', summary } },
    capabilities: { 'agent-bot': { repo: 'acme/bot', ref: BOT, entry: 'skills/agent-bot/SKILL.md', summary: 'Runtime.' } },
  });
  const git = fakeGit(HEADS, body);
  const configText = [
    'schema_version = 1',
    '[repos]',
    'org = "acme/org@main"',
    'comms = "acme/comms@v1"',
    '',
  ].join('\n');
  const report = resolveSop({ configText, configPath: '/cfg/config.toml', runGit: git.runGit });
  assert.deepEqual(report, {
    inEffect: true,
    configPath: '/cfg/config.toml',
    selection: { source: 'user', path: '/cfg/config.toml' },
    schemaVersion: 1,
    repositories: {
      org: { repository: 'acme/org', ref: 'main', commit: ORG, selected: 'config' },
      sop: { repository: 'acme/sop', ref: SOP, commit: SOP, selected: 'org.json' },
      comms: { repository: 'acme/comms', ref: 'v1', commit: COMMS, selected: 'config' },
    },
    orgJson: {
      repository: 'acme/org',
      commit: ORG,
      schemaVersion: 1,
      organization: { id: 'acme', account: 'acme', profile: 'governance/organization-profile.json' },
      sources: {
        sop: { repository: 'acme/sop', ref: SOP, commit: SOP, entry: 'evil.sh', summary },
      },
      capabilities: {
        'agent-bot': {
          repository: 'acme/bot',
          ref: BOT,
          commit: BOT,
          entry: 'skills/agent-bot/SKILL.md',
          summary: 'Runtime.',
        },
      },
    },
    read: [{ repository: 'acme/org', commit: ORG, path: 'org.json' }],
  });
  assert.deepEqual(subcommands(git.calls), ['ls-remote', 'init', 'remote', 'config', 'config', 'fetch', 'cat-file', 'ls-remote']);
  assert.ok(git.calls.every((args) => SOP_GIT_COMMANDS.includes(gitSubcommand(args))));
  assert.equal(git.calls.filter((args) => gitSubcommand(args) === 'fetch').length, 1);
  assert.ok(git.calls.some((args) => args.includes(ORG) && gitSubcommand(args) === 'fetch'));
  assert.ok(git.calls.every((args) => !args.includes('README.md') && !args.includes('evil.sh')));
  assert.ok(git.calls.some((args) => args.at(-1) === 'FETCH_HEAD:org.json'));
  const urls = git.calls.filter((args) => gitSubcommand(args) === 'ls-remote').map((args) => args[args.indexOf('ls-remote') + 1]);
  assert.deepEqual(urls, ['https://github.com/acme/org.git', 'https://github.com/acme/comms.git']);
  assert.equal(formatSopReport(report), [
    'SOP in effect',
    '',
    'org:',
    '  repository: acme/org',
    `  ref: main`,
    `  commit: ${ORG}`,
    '  selected: config',
    '',
    'sop:',
    '  repository: acme/sop',
    `  ref: ${SOP}`,
    `  commit: ${SOP}`,
    '  selected: org.json',
    '',
    'comms:',
    '  repository: acme/comms',
    '  ref: v1',
    `  commit: ${COMMS}`,
    '  selected: config',
    '',
    `org.json at acme/org@${ORG} (reported, not applied):`,
    '  organization: acme',
    '  account: acme',
    '  profile: governance/organization-profile.json',
    `  source sop: acme/sop@${SOP}`,
    '    entry: evil.sh',
    '    summary: line1 $(rm -rf /)',
    `  capability agent-bot: acme/bot@${BOT}`,
    '    entry: skills/agent-bot/SKILL.md',
    '    summary: Runtime.',
    '',
  ].join('\n'));

  let stdout = '';
  const code = main(['--json', '--config', '/cfg/config.toml'], {
    readFile() {
      return configText;
    },
    runGit: git.runGit,
    writeStdout(text) {
      stdout = text;
    },
    writeStderr(text) {
      throw new Error(text);
    },
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).orgJson.sources.sop.summary, summary);
  assert.equal(JSON.parse(stdout).repositories.comms.commit, COMMS);
});

test('a config sop ref overrides the org.json pin and a branch wins over a same-named tag', () => {
  const git = fakeGit({
    ...HEADS,
    'refs/heads/v1': DEV,
  });
  const report = resolveSop({
    configText: `schema_version = 1\n[repos]\norg = "acme/org@${ORG.toUpperCase()}"\nsop = "acme/sop@v1"\n`,
    runGit: git.runGit,
  });
  assert.equal(report.repositories.org.commit, ORG);
  assert.equal(report.repositories.org.ref, ORG.toUpperCase());
  assert.deepEqual(report.repositories.sop, {
    repository: 'acme/sop',
    ref: 'v1',
    commit: DEV,
    selected: 'config',
  });
  assert.equal(report.orgJson.sources.sop.commit, SOP);
  assert.notEqual(report.repositories.sop.commit, report.orgJson.sources.sop.commit);
  assert.equal(report.repositories.comms, null);
  assert.match(formatSopReport(report), /^comms:\n {2}none\n/m);
  const remoteLookups = git.calls.filter((args) => gitSubcommand(args) === 'ls-remote');
  assert.equal(remoteLookups.length, 1);
  assert.equal(remoteLookups[0][remoteLookups[0].indexOf('ls-remote') + 1], 'https://github.com/acme/sop.git');
});

test('a lightweight tag resolves to its commit and a missing ref fails', () => {
  const git = fakeGit({ 'refs/heads/main': ORG, 'refs/tags/light': COMMS });
  const report = resolveSop({
    configText: 'schema_version = 1\n[repos]\norg = "acme/org@main"\ncomms = "acme/comms@light"\n',
    runGit: git.runGit,
  });
  assert.equal(report.repositories.comms.commit, COMMS);

  const missing = fakeGit({ 'refs/heads/main': ORG });
  assert.throws(() => resolveSop({
    configText: 'schema_version = 1\n[repos]\norg = "acme/org@missing"\n',
    runGit: missing.runGit,
  }), /no commit for acme\/org@missing/);

  const failed = fakeGit({});
  failed.runGit = (args) => {
    if (gitSubcommand(args) === 'ls-remote') return { status: 2, stdout: '', stderr: 'fatal: could not read' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(() => resolveSop({
    configText: 'schema_version = 1\n[repos]\norg = "acme/org@main"\n',
    runGit: failed.runGit,
  }), /could not resolve acme\/org@main: fatal: could not read/);
});

test('org.json pins are reported and rejected when they are not commits', () => {
  assert.throws(() => parseOrgPins('{"schema_version":1,}'), /not valid JSON/);
  assert.throws(() => parseOrgPins('{"schema_version":1,"schema_version":1}'), /duplicate key schema_version/);
  const moved = JSON.parse(orgJson());
  moved.sources.sop.ref = 'main';
  assert.throws(() => parseOrgPins(JSON.stringify(moved)), /sources\.sop\.ref must be a 40-hex commit/);
  moved.sources.sop.ref = SOP;
  moved.extra = true;
  assert.throws(() => parseOrgPins(JSON.stringify(moved)), /unknown field "extra"/);
  delete moved.extra;
  moved.organization.profile = '../secret';
  assert.throws(() => parseOrgPins(JSON.stringify(moved)), /organization\.profile must be a relative path/);
  delete moved.organization.profile;
  moved.organization.profile = 'governance/organization-profile.json';
  moved.capabilities.ci = { repo: 'acme/ci', ref: BOT, entry: 'README.md', summary: 'CI.', run: 'evil.sh' };
  assert.throws(() => parseOrgPins(JSON.stringify(moved)), /unknown field "run"/);

  const git = fakeGit(HEADS, JSON.stringify(moved));
  assert.throws(() => resolveSop({
    configText: 'schema_version = 1\n[repos]\norg = "acme/org@main"\n',
    runGit: git.runGit,
  }), /unknown field "run"/);
  assert.ok(!subcommands(git.calls).includes('checkout'));
  assert.ok(!subcommands(git.calls).includes('clone'));

  const absent = fakeGit(HEADS);
  absent.runGit = (args) => {
    if (gitSubcommand(args) === 'cat-file') return { status: 128, stdout: '', stderr: 'fatal: path not in tree' };
    if (gitSubcommand(args) === 'ls-remote') return { status: 0, stdout: `${ORG}\trefs/heads/main\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(() => resolveSop({
    configText: 'schema_version = 1\n[repos]\norg = "acme/org@main"\n',
    runGit: absent.runGit,
  }), new RegExp(`org\\.json is not in acme/org@${ORG}`));

  const huge = fakeGit(HEADS);
  huge.runGit = (args) => {
    if (gitSubcommand(args) === 'cat-file') {
      return { status: null, stdout: '', stderr: '', error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } };
    }
    if (gitSubcommand(args) === 'ls-remote') return { status: 0, stdout: `${ORG}\trefs/heads/main\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(() => resolveSop({
    configText: 'schema_version = 1\n[repos]\norg = "acme/org@main"\n',
    runGit: huge.runGit,
  }), /exceeds 1 MiB/);
});

test('git is refused for clone, checkout, global config, and any file other than org.json', () => {
  assert.throws(() => assertSopGitCommand(['clone', 'https://github.com/acme/org.git']), /does not clone, check out, or execute/);
  assert.throws(() => assertSopGitCommand(['-C', '/tmp/x', 'checkout', 'main']), /does not clone, check out, or execute/);
  assert.throws(() => assertSopGitCommand(['config', '--global', 'core.hooksPath', '/tmp']), /outside the temporary read/);
  assert.throws(() => assertSopGitCommand(['-C', '/tmp/x', 'cat-file', 'blob', 'FETCH_HEAD:evil.sh']), /other than org.json/);
  assert.doesNotThrow(() => assertSopGitCommand(['-c', 'core.hooksPath=/dev/null', 'ls-remote', 'https://github.com/acme/org.git', 'refs/heads/main']));
});

test('a local repository resolves through git ls-remote and only org.json is read', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bot-sop-it-'));
  const src = join(root, 'src');
  const bare = join(root, 'bare.git');
  const marker = join(root, 'executed');
  try {
    mkdirSync(src);
    writeFileSync(join(src, 'org.json'), `${orgJson()}\n`);
    writeFileSync(join(src, 'evil.sh'), `#!/bin/sh\necho executed > '${marker}'\n`, { mode: 0o755 });
    writeFileSync(join(src, '.gitattributes'), '* filter=sop-evil\n');
    const git = (dir, ...args) => {
      const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    spawnSync('git', ['init', '-q', '-b', 'main', src], { encoding: 'utf8' });
    git(src, 'add', 'org.json', 'evil.sh', '.gitattributes');
    git(src, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    git(src, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'tag', '-a', 'v1', '-m', 'ann');
    const commit = git(src, 'rev-parse', 'HEAD');
    const tagObject = git(src, 'rev-parse', 'v1');
    const peeled = git(src, 'rev-parse', 'v1^{commit}');
    assert.notEqual(tagObject, peeled);
    spawnSync('git', ['clone', '--bare', '-q', src, bare], { encoding: 'utf8' });
    const calls = [];
    let scratch = null;
    const report = resolveSop({
      configText: 'schema_version = 1\n[repos]\norg = "local/org@main"\nsop = "local/org@v1"\n',
      remoteUrl: (repo) => {
        assert.equal(repo, 'local/org');
        return bare;
      },
      runGit(args) {
        calls.push(args);
        return localRunGit(args);
      },
      makeTemp() {
        scratch = mkdtempSync(join(root, 'read-'));
        return scratch;
      },
    });
    assert.equal(report.repositories.org.commit, commit);
    assert.equal(report.repositories.sop.commit, peeled);
    assert.equal(report.repositories.sop.selected, 'config');
    assert.equal(report.orgJson.sources.sop.commit, SOP);
    assert.equal(report.repositories.comms, null);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(scratch), false);
    assert.ok(calls.every((args) => SOP_GIT_COMMANDS.includes(gitSubcommand(args))));
    assert.ok(calls.some((args) => gitSubcommand(args) === 'ls-remote' && args.includes('refs/tags/v1^{}')));
    assert.ok(calls.every((args) => gitSubcommand(args) !== 'cat-file' || args.at(-1) === 'FETCH_HEAD:org.json'));
    assert.equal(calls.filter((args) => gitSubcommand(args) === 'fetch').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the sop command is routed and a missing default file exits 0', () => {
  assert.deepEqual(parseAgentBotArgs(['sop', '--json']), { kind: 'command', command: 'sop', args: ['--json'] });
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-sop-home-'));
  try {
    const help = spawnSync(process.execPath, [CLI, 'sop', '--help'], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', AGENT_BOT_BINDING: '' },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout, USAGE);

    const none = spawnSync(process.execPath, [CLI, 'sop'], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', AGENT_BOT_BINDING: '' },
    });
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, 'No SOP is in effect.\n');

    const json = spawnSync(process.execPath, [CLI, 'sop', '--json'], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', AGENT_BOT_BINDING: '' },
    });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).inEffect, false);

    const usage = spawnSync(process.execPath, [CLI, 'sop', '--json', '--help'], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', AGENT_BOT_BINDING: '' },
    });
    assert.equal(usage.status, 2, usage.stderr);
    assert.equal(usage.stdout, '');
    assert.match(usage.stderr, /unexpected arguments/);

    mkdirSync(join(home, '.config', 'agent-sop'), { recursive: true });
    writeFileSync(join(home, '.config', 'agent-sop', 'config.toml'), 'schema_version = true\n');
    const bad = spawnSync(process.execPath, [CLI, 'sop'], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home, AGENT_BOT_ID: '', QWTS_AGENT_ID: '', AGENT_BOT_BINDING: '' },
    });
    assert.equal(bad.status, 1, bad.stdout);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /booleans are not supported/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('git runs hermetically: no ambient overrides, no system or global config, https only', () => {
  const env = sopGitEnv({
    PATH: '/bin', HOME: '/home/u', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.ext::sh -c evil.insteadOf',
    GIT_CONFIG_VALUE_0: 'https://github.com/', GIT_DIR: '/elsewhere', GIT_SSH_COMMAND: 'evil',
  });
  assert.deepEqual(env, {
    PATH: '/bin', HOME: '/home/u', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'https', GIT_TERMINAL_PROMPT: '0',
  });
});

test('the human report strips terminal control characters from org.json values', () => {
  const body = orgJson({
    organization: { id: 'acme\u001b[2J', account: 'acme\u009b31m', profile: 'p\u0007.json' },
  });
  const git = fakeGit({ 'refs/heads/main': ORG }, body.replace('The SOP.', 'The \\u001b]0;pwned\\u0007SOP.'));
  const report = resolveSop({
    configText: 'schema_version = 1\n[repos]\norg = "acme/org@main"\n',
    configPath: '/cfg/config.toml',
    runGit: git.runGit,
    makeTemp: () => mkdtempSync(join(tmpdir(), 'sop-ctl-')),
  });
  const text = formatSopReport(report);
  assert.match(text, /acme\[2J/);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});
