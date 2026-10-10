import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runSpawnHooks } from '../agent-hook.mjs';
import { minimalChildEnv } from '../child-env.mjs';
import { reachMcpServerEntry } from '../daemon-mcp.mjs';
import { soulEnvironment } from '../shell-path.mjs';
import { composeTurnEnv } from '../turn-env.mjs';

test('child boundary drops ambient secrets and execution injection variables', () => {
  const source = {
    PATH: '/usr/bin', HOME: '/tmp/owner', LANG: 'en_US.UTF-8',
    AWS_SECRET_ACCESS_KEY: 'owner-secret',
    GITHUB_TOKEN: 'owner-token',
    OPENAI_API_KEY: 'owner-provider-key',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    NODE_OPTIONS: '--require /tmp/injected.js',
    NPM_CONFIG_USERCONFIG: '/tmp/owner/.npmrc',
    AGENT_BOT_TELEGRAM_TOKEN: 'bot-token', AGENT_BOT_AUTH: 'a', AGENT_BOT_CREDENTIALS: 'c', AGENT_BOT_API_KEY_FILE: '/tmp/k',
  };
  assert.deepEqual(minimalChildEnv(source), {
    PATH: '/usr/bin', HOME: '/tmp/owner', LANG: 'en_US.UTF-8',
  });
  const harness = soulEnvironment(source, { home: '/tmp/owner' });
  for (const name of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY',
    'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'NPM_CONFIG_USERCONFIG', 'AGENT_BOT_TELEGRAM_TOKEN',
    'AGENT_BOT_AUTH', 'AGENT_BOT_CREDENTIALS', 'AGENT_BOT_API_KEY_FILE']) {
    assert.equal(Object.hasOwn(harness, name), false, name);
  }
});

test('child boundary keeps the network, locale and agent-bot host configuration', () => {
  const kept = {
    PATH: '/usr/bin', HOME: '/tmp/owner', TERM: 'xterm-256color', LC_ALL: 'C', ZDOTDIR: '/tmp/owner/.config/zsh',
    HTTPS_PROXY: 'http://proxy.test:3128', https_proxy: 'http://proxy.test:3128', NO_PROXY: 'localhost',
    SSL_CERT_FILE: '/tmp/ca.pem', NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
    AGENT_BOT_TOOL_PATH: '/tmp/tools', AGENT_BOT_NPM: '/tmp/npm-cli.js', AGENT_BOT_SERVICE_LABEL: 'test.label',
    AGENT_BOT_CREDENTIAL_NAMESPACE: 'test', AGENT_BOT_CREDENTIAL_VAULT: 'vault', AGENT_BOT_KEYD_TEAM_ID: 'TEAMID', QWTS_AGENT_TEAM: 'red',
  };
  assert.deepEqual(minimalChildEnv(kept), kept);
  const harness = soulEnvironment(kept, { home: '/tmp/owner' });
  assert.equal(harness.HTTPS_PROXY, 'http://proxy.test:3128');
  assert.equal(harness.AGENT_BOT_TOOL_PATH, '/tmp/tools');
  assert.equal(harness.PATH.split(':')[0], '/tmp/tools');
});

test('on Windows the boundary matches names without case and keeps the profile', () => {
  const source = {
    Path: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    USERPROFILE: 'C:\\Users\\owner', LocalAppData: 'C:\\Users\\owner\\AppData\\Local', Agent_Bot_Tool_Path: 'C:\\tools',
    Github_Token: 'owner-token', Agent_Bot_Telegram_Token: 'bot-token',
  };
  assert.deepEqual(minimalChildEnv(source, { platform: 'win32' }), {
    PATH: 'C:\\Windows\\system32', SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    USERPROFILE: 'C:\\Users\\owner', LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local', AGENT_BOT_TOOL_PATH: 'C:\\tools',
  });
  assert.deepEqual(minimalChildEnv({ Path: '/x', path: '/y' }, { platform: 'darwin' }), {}, 'POSIX names stay exact');
});

test('turn keeps the daemon-composed binding and only the explicitly routed soul secret', () => {
  const turn = composeTurnEnv({
    agentId: 'test-soul', harness: 'codex',
    baseEnv: {
      PATH: '/usr/bin', LANG: 'C', HTTPS_PROXY: 'http://proxy.test:3128',
      AWS_SECRET_ACCESS_KEY: 'host', OPENAI_API_KEY: 'host', GITHUB_TOKEN: 'owner', NODE_OPTIONS: '--require evil',
    },
    env: { AGENT_BOT_BINDING: '/tmp/tree/.git/binding.json', AGENT_BOT_REACH_CORRELATION: 'thread-1' },
    runtimeEnvFor: () => ({ UV_CACHE_DIR: '/tmp/soul-cache' }),
    providerEnvFor: () => ({ envKey: 'OPENAI_API_KEY', env: { OPENAI_API_KEY: 'soul-only' } }),
  });
  assert.equal(turn.turnEnv.PATH, '/usr/bin');
  assert.equal(turn.turnEnv.LANG, 'C');
  assert.equal(turn.turnEnv.HTTPS_PROXY, 'http://proxy.test:3128');
  assert.equal(turn.turnEnv.UV_CACHE_DIR, '/tmp/soul-cache');
  assert.equal(turn.turnEnv.AGENT_BOT_BINDING, '/tmp/tree/.git/binding.json');
  assert.equal(turn.mcpEnv.AGENT_BOT_BINDING, '/tmp/tree/.git/binding.json');
  assert.equal(turn.turnEnv.AGENT_BOT_REACH_CORRELATION, 'thread-1');
  assert.equal(turn.turnEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(turn.turnEnv.GITHUB_TOKEN, undefined);
  assert.equal(turn.turnEnv.NODE_OPTIONS, undefined);
  assert.equal(turn.turnEnv.OPENAI_API_KEY, undefined);
  assert.equal(turn.harnessEnv.OPENAI_API_KEY, 'soul-only');
  assert.equal(turn.mcpEnv.OPENAI_API_KEY, undefined);
});

// Made-up values only: nothing here names a real state file or token.
const STATE_PATH = '/tmp/made-up-host/daemon.json';

test('the daemon state path never crosses the child boundary (#785)', () => {
  const source = { PATH: '/usr/bin', HOME: '/tmp/made-up-host', AGENT_BOT_DAEMON_STATE_PATH: STATE_PATH, AGENT_BOT_TOOL_PATH: '/tmp/tools' };
  assert.deepEqual(minimalChildEnv(source), { PATH: '/usr/bin', HOME: '/tmp/made-up-host', AGENT_BOT_TOOL_PATH: '/tmp/tools' });
  assert.deepEqual(minimalChildEnv({ Path: 'C:\\bin', Agent_Bot_Daemon_State_Path: 'C:\\state\\daemon.json' }, { platform: 'win32' }),
    { PATH: 'C:\\bin' }, 'any Windows spelling is withheld');
  assert.equal(soulEnvironment(source, { home: '/tmp/made-up-host' }).AGENT_BOT_DAEMON_STATE_PATH, undefined);
  const turn = composeTurnEnv({ agentId: 'test-soul', harness: 'codex', baseEnv: source });
  for (const name of ['turnEnv', 'mcpEnv', 'harnessEnv']) assert.equal(turn[name].AGENT_BOT_DAEMON_STATE_PATH, undefined, name);
  // The reach server finds the daemon on the soul's binding, so its entry
  // carries no state path either.
  const entry = reachMcpServerEntry({ agentId: 'agent_0f554a21-0b41-884e-b9ed-fd1d10fa5a4a', env: { ...turn.mcpEnv, AGENT_BOT_DAEMON_STATE_PATH: STATE_PATH },
    binding: '/tmp/tree/.git/agent-binding.json' });
  assert.equal(entry.env.some(({ name }) => name === 'AGENT_BOT_DAEMON_STATE_PATH'), false);
});

test('spawn hooks and agent-comms join run inside the child boundary (#785)', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'child-env-spawn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const hooks = path.join(root, 'hooks');
  mkdirSync(bin);
  mkdirSync(path.join(hooks, 'spawn'), { recursive: true });
  const dump = (file) => `#!/bin/sh\nenv > ${JSON.stringify(path.join(root, file))}\n`;
  writeFileSync(path.join(bin, 'agent-comms'), dump('comms.env'), { mode: 0o755 });
  writeFileSync(path.join(hooks, 'spawn', '10-dump'), dump('hook.env'), { mode: 0o755 });
  const warning = await runSpawnHooks({
    agentId: 'agent_child', parent: 'agent_parent', binding: path.join(root, 'binding.json'), name: 'worker', harness: 'codex', cwd: root,
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: root, AGENT_BOT_HOOKS_DIR: hooks, AGENT_HOOK_TIMEOUT_MS: '5000',
      AGENT_BOT_DAEMON_STATE_PATH: STATE_PATH, GITHUB_TOKEN: 'made-up-owner-token', NODE_OPTIONS: '--require /tmp/made-up.js',
    },
  });
  assert.equal(warning, null);
  for (const file of ['comms.env', 'hook.env']) {
    const seen = Object.fromEntries(readFileSync(path.join(root, file), 'utf8').split('\n').filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.equal(seen.AGENT_BOT_BINDING, path.join(root, 'binding.json'), file);
    assert.equal(seen.QWTS_AGENT_ID, 'agent_child', file);
    assert.equal(seen.AGENT_BOT_PARENT_ID, 'agent_parent', file);
    assert.equal(seen.AGENT_HOOK_TIMEOUT_MS, '5000', file);
    for (const name of ['AGENT_BOT_DAEMON_STATE_PATH', 'GITHUB_TOKEN', 'NODE_OPTIONS']) assert.equal(seen[name], undefined, `${file}: ${name}`);
  }
});
