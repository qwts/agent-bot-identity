import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { buildGhShim } from '../gh-shim.mjs';

const root = mkdtempSync(join(tmpdir(), 'gh-shim-test-'));
const testHome = join(root, 'home');
mkdirSync(testHome);
after(() => rmSync(root, { recursive: true, force: true }));

function runShim({
  slug = '',
  agentSlug = '',
  agentEnv = {},
  token = '',
  cachedToken = '',
  mintedToken = '',
  tokenLogin = 'explicit-token-owner',
  args = ['whoami'],
  tokenToolAvailable = true,
  expandedQuery = '',
  siblingBackup = false,
  realExit = 64,
  desktopUserOutput = '{"login":"ordinary-user"}',
  desktopUserStatus = 0,
  fallbackUserOutput = '{"login":"app-agent[bot]","type":"Bot"}',
  prViewOutput = '{"author":{"login":"app/app-agent"}}',
  prViewStatus = 0,
  enrichedPrOutput = '',
  psOutput = null,
  lsofOutput = null,
  explicitReal = false,
  realIsShim = false,
} = {}) {
  const shimDir = join(root, `shim-${Math.random()}`);
  const realDir = join(root, `real-${Math.random()}`);
  mkdirSync(shimDir);
  mkdirSync(realDir);

  const tokenTool = join(root, `token-${Math.random()}.mjs`);
  if (tokenToolAvailable) {
    writeFileSync(
      tokenTool,
      `import { readFileSync } from 'node:fs';
if (process.argv.length === 2) process.stdout.write(${JSON.stringify(cachedToken)});
if (process.argv.includes('--slug')) process.stdout.write(${JSON.stringify(slug)});
if (process.argv.includes('--agent-slug')) process.stdout.write(${JSON.stringify(agentSlug)});
if (process.argv.includes('--mint-app')) process.stdout.write(${JSON.stringify(mintedToken)});
if (process.argv.includes('--expand-gh-inbox-query')) process.stdout.write(${JSON.stringify(expandedQuery)});
if (process.argv.includes('--enrich-gh-pr-view')) {
  const input = readFileSync(0, 'utf8');
  process.stdout.write(${JSON.stringify(enrichedPrOutput)} || input);
}`,
    );
  }

  const shimOptions = {};
  if (psOutput !== null) {
    const psStub = join(shimDir, 'ps-stub');
    writeFileSync(psStub, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(psOutput)}\n`);
    chmodSync(psStub, 0o755);
    shimOptions.psPath = psStub;
  }
  if (lsofOutput !== null) {
    const lsofStub = join(shimDir, 'lsof-stub');
    writeFileSync(lsofStub, `#!/bin/sh\nprintf 'n%s\\n' ${JSON.stringify(lsofOutput)}\n`);
    chmodSync(lsofStub, 0o755);
    shimOptions.lsofPath = lsofStub;
  }

  const shim = join(shimDir, 'gh');
  writeFileSync(shim, buildGhShim(tokenTool, shimOptions));
  chmodSync(shim, 0o755);

  const siblingName = siblingBackup === true ? 'gh.bak' : siblingBackup;
  const real = siblingName ? join(shimDir, siblingName) : join(realDir, 'gh');
  writeFileSync(
    real,
    realIsShim ? buildGhShim(tokenTool) : `#!/bin/sh
if [ "$1 $2" = "api graphql" ] && [ "$#" -ne 10 ]; then echo ${JSON.stringify(tokenLogin)}; exit 0; fi
if [ "$1 $2 $3 $4" = "api user --jq .login" ]; then echo human-owner; exit 0; fi
if [ "$1 $2 $3 $4" = "api user --hostname github.com" ]; then
  printf '%s\\n' ${JSON.stringify(desktopUserOutput)}
  exit ${desktopUserStatus}
fi
if [ "$1" = "api" ] && [ "$2" = ${JSON.stringify(`users/${agentSlug}[bot]`)} ] &&
   [ "$3 $4" = "--hostname github.com" ]; then
  printf '%s\\n' ${JSON.stringify(fallbackUserOutput)}
  exit 0
fi
if [ "$1 $2" = "pr view" ] && [ "$#" -eq 7 ]; then
  printf '%s\\n' ${JSON.stringify(prViewOutput)}
  exit ${prViewStatus}
fi
if [ "$#" -eq 10 ]; then
  for arg in "$@"; do printf '<%s>\\n' "$arg"; done
  exit 0
fi
if [ "$1 $2" = "pr list" ]; then
  for arg in "$@"; do printf '<%s>\\n' "$arg"; done
  exit 0
fi
if [ "$1 $2 $3 $4" = "auth token --hostname github.com" ]; then
  echo human-oauth-token
  exit 0
fi
if [ "$1" = "passthrough" ]; then
  shift
  for arg in "$@"; do printf 'arg=<%s>\\n' "$arg"; done
  printf 'env=<%s>\\n' "$PASSTHROUGH_SENTINEL" >&2
fi
exit ${realExit}
`,
  );
  chmodSync(real, 0o755);

  return spawnSync('/bin/sh', [shim, ...args], {
    encoding: 'utf8',
    env: {
      ...(explicitReal ? {
        AGENT_BOT_REAL_GH: explicitReal === 'directory' ? realDir : real,
      } : {}),
      GH_TOKEN: token,
      HOME: testHome,
      PATH: [shimDir, realDir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      ...agentEnv,
    },
  });
}

function runWhoami(options = {}) {
  const result = runShim(options);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('generated shim contains valid shell parameter expansions', () => {
  const shim = buildGhShim('/tmp/agent-bot');
  assert.match(shim, /\$\{AGENT_SLUG:-detected agent\}/);
  assert.match(shim, /\$\{TERRITORY_SLUG\}\[bot\]/);
  assert.doesNotMatch(shim, /\$\\\{/);
  assert.doesNotMatch(shim, /\x7f/);
  assert.doesNotMatch(shim, /agent-bot-gh-trace|\/usr\/bin\/logger/);
  assert.match(shim, /CODEX_DESKTOP_PARENT[\s\S]+\/Applications\/ChatGPT\.app/);
  assert.match(shim, /TOKEN_REQUIRES_NODE=1[\s\S]+token_tool_available/);
  assert.match(buildGhShim(), /TOKEN_REQUIRES_NODE=""[\s\S]+token_tool_available/);
  assert.match(shim, /\/usr\/bin\/head -c 512/);
  assert.match(shim, /\[ -f "\$REAL" \] && \[ -x "\$REAL" \]/);
});

test('a matching explicit bot token is accepted in bot territory', () => {
  assert.equal(
    runWhoami({
      slug: 'you-codex-agent',
      token: 'explicit-token',
      tokenLogin: 'you-codex-agent[bot]',
    }),
    'you-codex-agent[bot] — explicit GH_TOKEN',
  );
});

test('an explicit human token is rejected in bot territory', () => {
  const result = runShim({
    slug: 'you-codex-agent',
    token: 'explicit-token',
    tokenLogin: 'human-owner',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected you-codex-agent\[bot\].*identity crossover/);
});

test('bot territory reports its local slug without an explicit token', () => {
  assert.equal(runWhoami({ slug: 'you-codex-agent' }), 'you-codex-agent[bot] — bot territory');
});

test('human territory asks stock gh for its login', () => {
  assert.equal(runWhoami(), 'human-owner — human territory, gh is stock');
});

test('an agent outside bot territory cannot query or write through stock gh', () => {
  for (const args of [['whoami'], ['issue', 'create', '--title', 'forbidden']]) {
    const result = runShim({
      agentSlug: 'you-codex-agent',
      args,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside bot territory.*refusing stock human gh/);
  }
});

test('configured harnesses retain their own App identity in bot territory and fail outside it', () => {
  const harnesses = [
    ['claude-agent', { CLAUDECODE: '1' }],
    ['cursor-agent', { CURSOR_AGENT: '1' }],
    ['copilot-agent', { COPILOT_AGENT: '1' }],
    ['devin-agent', { DEVIN_AGENT: '1' }],
    ['windsurf-agent', { WINDSURF_AGENT: '1' }],
    ['codex-agent', { CODEX_SANDBOX: 'seatbelt' }],
  ];
  for (const [slug, agentEnv] of harnesses) {
    assert.equal(runWhoami({
      slug,
      agentEnv,
      token: 'explicit-token',
      tokenLogin: `${slug}[bot]`,
    }), `${slug}[bot] — explicit GH_TOKEN`);
    const outside = runShim({ agentEnv, args: ['issue', 'create', '--title', 'forbidden'] });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /outside bot territory.*refusing stock human gh/);
  }
});

test('any non-empty GH_AGENT_APP is agent context and cannot use human gh outside bot territory', () => {
  const result = runShim({
    agentEnv: { GH_AGENT_APP: 'custom-model-bot' },
    args: ['issue', 'create', '--title', 'forbidden'],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside bot territory.*refusing stock human gh/);
});

test('an agent fails closed when the installed token-helper path is stale', () => {
  const result = runShim({
    agentEnv: { CODEX_SANDBOX: 'seatbelt' },
    args: ['issue', 'create', '--title', 'forbidden'],
    tokenToolAvailable: false,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /token helper or Node is unavailable.*refusing stock human gh/);
});

test('Codex desktop passes through unchanged without a configured App mapping', () => {
  const args = [
    'pr', 'list', '--head', 'codex/topic', '--author', '@me', '--state', 'all',
    '--json', 'number,url,state,headRefName', '--repo', 'qwts/example',
  ];
  const result = runShim({
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1', CODEX_SANDBOX: 'seatbelt' },
    args,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), args.map((arg) => `<${arg}>`));
});

test('Codex desktop broadens only the native PR inbox searchQuery argument', () => {
  const original = 'searchQuery=is:pr is:merged author:@me sort:updated-desc';
  const expanded = 'searchQuery=is:pr is:merged sort:updated-desc';
  const args = [
    'api', 'graphql', '-f', 'query=query($searchQuery:String!){search(query:$searchQuery){issueCount}}',
    '-f', original, '-F', 'first=50', '--hostname', 'github.com',
  ];
  const result = runShim({
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    token: 'explicit-token',
    tokenLogin: 'you-codex-agent[bot]',
    args,
    expandedQuery: expanded,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout.trim().split('\n'),
    args.map((arg, index) => `<${index === 5 ? expanded : arg}>`),
  );
});

test('Codex desktop trusts a token minted by its configured local App helper', () => {
  const result = runShim({
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    mintedToken: 'locally-minted-token',
    tokenLogin: 'would-fail-if-reverified',
    args: ['api', 'user', '--hostname', 'github.com'],
    desktopUserOutput: '{"login":"you-codex-agent[bot]","type":"Bot"}',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /you-codex-agent\[bot\]/);
});

test('Codex desktop reuses the private worktree token cache before minting', () => {
  const result = runShim({
    slug: 'you-codex-agent',
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    cachedToken: 'cached-worktree-token',
    mintedToken: '',
    tokenLogin: 'would-fail-if-reverified',
    args: ['api', 'user', '--hostname', 'github.com'],
    desktopUserOutput: '{"login":"you-codex-agent[bot]","type":"Bot"}',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /you-codex-agent\[bot\]/);
});

test('Codex desktop never reuses another harness territory token', () => {
  const result = runShim({
    slug: 'you-claude-agent',
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    cachedToken: 'foreign-worktree-token',
    mintedToken: '',
    args: ['api', 'user', '--hostname', 'github.com'],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /token mint returned empty.*refusing stock human gh/);
});

test('a Cellar replacement delegates directly to its sibling gh.bak', () => {
  const result = runShim({ args: ['--version'], siblingBackup: true, realExit: 73 });
  assert.equal(result.status, 73, result.stderr);
});

test('a managed desktop interposer delegates to its preserved sibling gh', () => {
  const result = runShim({
    args: ['--version'], siblingBackup: 'gh.agent-bot-real', realExit: 74,
  });
  assert.equal(result.status, 74, result.stderr);
});

test('recursive sibling, PATH, and explicit real-gh chains fail closed', () => {
  for (const options of [
    { siblingBackup: 'gh.agent-bot-real', realIsShim: true },
    { realIsShim: true },
    { explicitReal: true, realIsShim: true },
  ]) {
    const result = runShim({ ...options, args: ['--version'] });
    assert.equal(result.status, 127);
    assert.match(result.stderr, /agent-bot shim.*recursive dispatch/);
  }
});

test('an explicit real-gh directory fails closed', () => {
  const result = runShim({ explicitReal: 'directory', args: ['--version'] });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /AGENT_BOT_REAL_GH is not executable/);
});

test('human passthrough preserves arguments, environment, output streams, and exit status', () => {
  const result = runShim({
    args: ['passthrough', 'space value', '', '--flag=value'],
    agentEnv: { PASSTHROUGH_SENTINEL: 'preserved' },
    realExit: 79,
  });
  assert.equal(result.status, 79);
  assert.equal(result.stdout, 'arg=<space value>\narg=<>\narg=<--flag=value>\n');
  assert.equal(result.stderr, 'env=<preserved>\n');
});

test('Codex desktop removes only the author filter from its exact branch PR query', () => {
  const args = [
    'pr', 'list', '--head', 'codex/topic', '--author', '@me', '--state', 'all',
    '--json', 'number,url,state,headRefName', '--repo', 'qwts/example',
  ];
  const result = runShim({
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    token: 'explicit-token',
    tokenLogin: 'you-codex-agent[bot]',
    args,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    '<pr>', '<list>', '<--head>', '<codex/topic>', '<--state>', '<all>',
    '<--json>', '<number,url,state,headRefName>', '<--repo>', '<qwts/example>',
  ]);

  const nearMiss = runShim({
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    token: 'explicit-token',
    tokenLogin: 'you-codex-agent[bot]',
    args: [...args.slice(0, 5), 'someone-else', ...args.slice(6)],
  });
  assert.match(nearMiss.stdout, /<--author>\n<someone-else>/);
});

test('Codex desktop preserves a successful REST user identity probe', () => {
  const user = '{"login":"native-user","type":"User"}';
  const result = runShim({
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    token: 'explicit-token',
    tokenLogin: 'you-codex-agent[bot]',
    args: ['api', 'user', '--hostname', 'github.com'],
    desktopUserOutput: user,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), user);
});

test('Codex desktop falls back from REST user to the App bot user object', () => {
  const appUser = '{"login":"you-codex-agent[bot]","id":42,"type":"Bot"}';
  const result = runShim({
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    token: 'explicit-token',
    tokenLogin: 'you-codex-agent[bot]',
    args: ['api', 'user', '--hostname', 'github.com'],
    desktopUserOutput: '{"message":"Resource not accessible by integration"}',
    desktopUserStatus: 1,
    fallbackUserOutput: appUser,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), appUser);
  assert.doesNotMatch(result.stdout + result.stderr, /Resource not accessible/);
});

test('Codex desktop enriches only the native PR detail JSON response', () => {
  const original = '{"author":{"is_bot":true,"login":"app/you-codex-agent"}}';
  const enriched = '{"author":{"is_bot":true,"login":"app/you-codex-agent","avatarUrl":"https://avatars.githubusercontent.com/in/42"}}';
  const args = [
    'pr', 'view', '801', '--json',
    'additions,author,comments,commits,reviews',
    '--repo', 'github.com/example/image-trail',
  ];
  const result = runShim({
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    token: 'explicit-token',
    tokenLogin: 'you-codex-agent[bot]',
    args,
    prViewOutput: original,
    enrichedPrOutput: enriched,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), enriched);

  const ordinary = runShim({
    args,
    prViewOutput: original,
    enrichedPrOutput: enriched,
  });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(ordinary.stdout.trim(), original);
});

test('Codex desktop preserves a failed native PR detail status', () => {
  const result = runShim({
    agentSlug: 'you-codex-agent',
    agentEnv: { AGENT_BOT_CODEX_DESKTOP: '1' },
    token: 'explicit-token',
    tokenLogin: 'you-codex-agent[bot]',
    args: [
      'pr', 'view', '999', '--json', 'author', '--repo', 'github.com/example/image-trail',
    ],
    prViewOutput: '{"message":"not found"}',
    prViewStatus: 1,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), '{"message":"not found"}');
});

const CLAUDE_BUNDLE = '/Applications/Claude.app/Contents/MacOS/Claude';
// The app exports the agent markers into its own children, so its housekeeping
// probe looks exactly like an agent shell by environment alone.
const DESKTOP_ENV = {
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
  AI_AGENT: 'claude-code_2-1-229_agent',
};
const PROBE = ['auth', 'token', '--hostname', 'github.com'];

test('the liveness probe reaches stock gh when the kernel confirms the parent', () => {
  const result = runShim({
    agentEnv: DESKTOP_ENV,
    args: PROBE,
    psOutput: CLAUDE_BUNDLE,
    lsofOutput: CLAUDE_BUNDLE,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'human-oauth-token');
  assert.doesNotMatch(result.stderr, /outside bot territory/);
});

test('a forged parent argv cannot unlock the probe', () => {
  // ps reads the process arguments, which any caller can set when it execs.
  // The kernel-mapped text file tells the truth, and it must win.
  const result = runShim({
    agentEnv: DESKTOP_ENV,
    args: PROBE,
    psOutput: CLAUDE_BUNDLE,
    lsofOutput: '/bin/bash',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside bot territory.*refusing stock human gh/);
});

test('no environment variable can unlock the probe', () => {
  // Regression: an env override here would let any agent print the human's
  // OAuth token from outside territory.
  const result = runShim({
    agentEnv: { ...DESKTOP_ENV, AGENT_BOT_CLAUDE_DESKTOP: '1' },
    args: PROBE,
    psOutput: '/bin/sh',
    lsofOutput: '/bin/sh',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside bot territory.*refusing stock human gh/);
});

test('only the probe argv passes, even from a confirmed Claude Desktop parent', () => {
  const result = runShim({
    agentEnv: DESKTOP_ENV,
    args: ['issue', 'create', '--title', 'forbidden'],
    psOutput: CLAUDE_BUNDLE,
    lsofOutput: CLAUDE_BUNDLE,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside bot territory.*refusing stock human gh/);
});

test('the shim confirms Claude Desktop against the kernel, with no env override', () => {
  const shim = buildGhShim('/tmp/token-tool.mjs');
  assert.match(shim, /CLAUDE_DESKTOP_PARENT[\s\S]+\/Applications\/Claude\.app/);
  assert.match(shim, /CLAUDE_DESKTOP_TEXT[\s\S]+\/Applications\/Claude\.app/);
  assert.doesNotMatch(shim, /AGENT_BOT_CLAUDE_DESKTOP/);
});
