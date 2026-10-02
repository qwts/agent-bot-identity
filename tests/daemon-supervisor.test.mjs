import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  disableDaemonSupervisor,
  ensureDaemonSupervisor,
  hostServiceLabel,
  inspectSupervisor,
  isInactiveSupervisorError,
  renderLaunchdPlist,
  renderSystemdUnit,
  supervisorEnvironment,
  supervisorPaths,
} from '../daemon-supervisor.mjs';

test('launchd unit is secret-free, loopback-agnostic, and keep-alive', () => {
  const plist = renderLaunchdPlist({ executable: '/home/user/.local/bin/agent-bot' });
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<string>\/home\/user\/\.local\/bin\/agent-bot<\/string>/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/s);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/s);
  assert.doesNotMatch(plist, /token|BEGIN |127\.0\.0\.1|AGENT_BOT_DAEMON_HOST|AGENT_BOT_DAEMON_PORT/);
});

test('launchd unit XML-escapes the executable path', () => {
  const plist = renderLaunchdPlist({ executable: '/tmp/a&b<c>.bin' });
  assert.match(plist, /<string>\/tmp\/a&amp;b&lt;c&gt;\.bin<\/string>/);
});

test('systemd unit restarts always and execs daemon run', () => {
  const unit = renderSystemdUnit({ executable: '/home/user/.local/bin/agent-bot' });
  assert.match(unit, /ExecStart=\/home\/user\/\.local\/bin\/agent-bot daemon run/);
  assert.match(unit, /Restart=always/);
  assert.doesNotMatch(unit, /token|127\.0\.0\.1|AGENT_BOT_DAEMON_HOST/);
  assert.equal(SYSTEMD_UNIT, 'agent-bot-daemon.service');
});

test('supervised units carry the resolved daemon state path', () => {
  const environment = supervisorEnvironment({
    env: { AGENT_BOT_DAEMON_STATE_PATH: '/tmp/custom-daemon.json' },
    home: '/u',
  });
  assert.equal(environment.AGENT_BOT_DAEMON_STATE_PATH, '/tmp/custom-daemon.json');
  const plist = renderLaunchdPlist({
    executable: '/u/.local/bin/agent-bot',
    environment,
  });
  assert.match(plist, /<key>AGENT_BOT_DAEMON_STATE_PATH<\/key>\s*<string>\/tmp\/custom-daemon\.json<\/string>/s);
  const unit = renderSystemdUnit({
    executable: '/u/.local/bin/agent-bot',
    environment,
  });
  assert.match(unit, /Environment=AGENT_BOT_DAEMON_STATE_PATH=\/tmp\/custom-daemon\.json/);
});

test('supervisor paths follow the user-level convention', () => {
  assert.equal(
    supervisorPaths('/u', 'darwin').unitPath,
    '/u/Library/LaunchAgents/dev.qwts.agent-bot.daemon.plist',
  );
  assert.equal(
    supervisorPaths('/u', 'linux').unitPath,
    '/u/.config/systemd/user/agent-bot-daemon.service',
  );
  assert.equal(supervisorPaths('/u', 'win32').kind, null);
});

test('ensure writes and loads a launchd unit without calling disable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-'));
  const commands = [];
  const result = await ensureDaemonSupervisor({
    home,
    platform: 'darwin',
    executable: join(home, '.local', 'bin', 'agent-bot'),
    env: {},
    probe: async () => ({ running: true, pid: 9, port: 1, startedAt: '2026-08-16T00:00:00.000Z' }),
    stopDetached: async () => { commands.push(['stop']); },
    exec: (command, args) => {
      commands.push([command, ...args]);
      return '';
    },
  });
  const body = readFileSync(result.unitPath, 'utf8');
  assert.match(body, /KeepAlive/);
  assert.match(body, /agent-bot/);
  assert.equal(result.applied, true);
  assert.equal(result.loaded, true);
  assert.ok(commands.some((row) => row[0] === 'launchctl' && (row[1] === 'load' || row[1] === 'bootstrap')));
  assert.equal(commands.some((row) => row.includes('disable')), false);
});

test('a second ensure refreshes the unit to a new entrypoint and keeps it loaded', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-refresh-'));
  const execs = [];
  const options = {
    home,
    platform: 'linux',
    env: {},
    probe: async () => ({ running: true, pid: 9, port: 1, startedAt: '2026-08-16T00:00:00.000Z' }),
    stopDetached: async () => {},
    exec: (command, args) => {
      execs.push([command, ...args]);
      if (command === 'systemctl' && args.includes('is-enabled')) return 'enabled\n';
      return '';
    },
  };
  await ensureDaemonSupervisor({ ...options, executable: '/opt/old/agent-bot' });
  const afterFirst = execs.filter((row) => row[0] === 'systemctl' && row.includes('restart')).length;
  await ensureDaemonSupervisor({ ...options, executable: '/opt/new/agent-bot' });
  assert.match(readFileSync(supervisorPaths(home, 'linux').unitPath, 'utf8'), /\/opt\/new\/agent-bot/);
  assert.ok(execs.some((row) => row[0] === 'systemctl' && row.includes('enable')));
  assert.ok(execs.filter((row) => row[0] === 'systemctl' && row.includes('restart')).length > afterFirst);
  assert.equal(execs.some((row) => row.includes('disable')), false);
});

test('a no-op update still restarts the already-loaded supervisor', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-restart-'));
  const execs = [];
  const options = {
    home,
    platform: 'linux',
    env: {},
    executable: '/opt/agent-bot',
    probe: async () => ({ running: true, pid: 9, port: 1, startedAt: '2026-08-16T00:00:00.000Z' }),
    stopDetached: async () => {},
    exec: (command, args) => {
      execs.push([command, ...args]);
      if (command === 'systemctl' && args.includes('is-enabled')) return 'enabled\n';
      return '';
    },
  };
  await ensureDaemonSupervisor(options);
  await ensureDaemonSupervisor(options);
  assert.equal(execs.filter((row) => row[0] === 'systemctl' && row.includes('restart')).length, 2);
});

test('ensure stops a detached daemon before the supervisor takes over', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-adopt-'));
  const stops = [];
  await ensureDaemonSupervisor({
    home,
    platform: 'darwin',
    executable: join(home, '.local', 'bin', 'agent-bot'),
    env: {},
    probe: async () => ({ running: true, pid: 11, port: 2, startedAt: '2026-08-16T00:00:00.000Z' }),
    stopDetached: async () => { stops.push('stopped'); },
    exists: () => false,
    exec: () => '',
  });
  assert.deepEqual(stops, ['stopped']);
});

test('unsupported platforms skip the supervisor', async () => {
  const result = await ensureDaemonSupervisor({
    home: '/u',
    platform: 'win32',
  });
  assert.deepEqual(result, { applied: false, reason: 'unsupported-platform', platform: 'win32' });
});

test('inspect reports an unloaded unit as not loaded', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-inspect-'));
  const info = inspectSupervisor({
    home,
    platform: 'darwin',
    exists: (path) => path.endsWith('.plist'),
    exec: () => { throw Object.assign(new Error('not loaded'), { status: 1 }); },
  });
  assert.equal(info.applied, true);
  assert.equal(info.loaded, false);
});

test('disable unloads the unit, removes it, and stops the daemon', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-disable-'));
  const commands = [];
  const unitPath = supervisorPaths(home, 'darwin').unitPath;
  const result = await disableDaemonSupervisor({
    home,
    platform: 'darwin',
    env: {},
    exists: (path) => path === unitPath,
    remove: (path) => { commands.push(['rm', path]); },
    probe: async () => ({ running: true, pid: 3, port: 4 }),
    stop: async () => { commands.push(['stop']); },
    exec: (command, args) => {
      commands.push([command, ...args]);
      return '';
    },
  });
  assert.equal(result.unloaded, true);
  assert.ok(commands.some((row) => row[0] === 'launchctl'));
  assert.ok(commands.some((row) => row[0] === 'rm'));
  assert.ok(commands.some((row) => row[0] === 'stop'));
});

test('inactive supervisor errors are the only unload failures that are ignored', () => {
  assert.equal(isInactiveSupervisorError({ stderr: 'Unit file agent-bot-daemon.service does not exist.\n' }), true);
  assert.equal(isInactiveSupervisorError({ message: 'Could not find service' }), true);
  assert.equal(isInactiveSupervisorError({ stderr: 'Failed to connect to user bus\n' }), false);
});

test('disable surfaces an unexpected systemd unload failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-disable-fail-'));
  const unitPath = supervisorPaths(home, 'linux').unitPath;
  await assert.rejects(
    () => disableDaemonSupervisor({
      home,
      platform: 'linux',
      env: {},
      exists: (path) => path === unitPath,
      remove: () => { throw new Error('must not remove the unit after a failed unload'); },
      probe: async () => ({ running: false }),
      stop: async () => { throw new Error('must not stop after a failed unload'); },
      exec: (command, args) => {
        if (command === 'systemctl' && args.includes('disable')) {
          throw Object.assign(new Error('Failed to connect to user bus'), {
            stderr: 'Failed to connect to user bus\n',
            status: 1,
          });
        }
        return '';
      },
    }),
    /Failed to connect to user bus/,
  );
});

// #302: host-supplied service label and the host's own runtime.

test('a host label names the launchd and systemd units; the default is unchanged', () => {
  const env = { AGENT_BOT_SERVICE_LABEL: 'app.geniusbar.agent-bot' };
  assert.deepEqual(supervisorPaths('/u', 'darwin', env), {
    platform: 'darwin',
    kind: 'launchd',
    label: 'app.geniusbar.agent-bot',
    unitPath: '/u/Library/LaunchAgents/app.geniusbar.agent-bot.plist',
  });
  assert.equal(supervisorPaths('/u', 'linux', env).unitPath, '/u/.config/systemd/user/app.geniusbar.agent-bot.service');
  assert.equal(supervisorPaths('/u', 'darwin', {}).label, LAUNCHD_LABEL);
  assert.equal(supervisorPaths('/u', 'darwin', { AGENT_BOT_SERVICE_LABEL: '' }).label, LAUNCHD_LABEL);
  assert.equal(hostServiceLabel({}), null);
  assert.equal(supervisorEnvironment({ env, home: '/u' }).AGENT_BOT_SERVICE_LABEL, 'app.geniusbar.agent-bot');
  assert.equal('AGENT_BOT_SERVICE_LABEL' in supervisorEnvironment({ env: {}, home: '/u' }), false);
});

test('an unsafe host label is a usage error', () => {
  for (const label of ['../evil', 'a b', '-lead', 'x;rm', 'gui/501/x']) {
    assert.throws(() => supervisorPaths('/u', 'darwin', { AGENT_BOT_SERVICE_LABEL: label }), { code: 'usage', message: /^usage: AGENT_BOT_SERVICE_LABEL/ });
  }
});

test('host program arguments stay literal in launchd and systemd units', () => {
  const programArguments = ['/Applications/Genius Bar.app/node', '/tmp/$(touch x)/`id`/50%/a"b\\c/agent-bot.mjs', 'daemon', 'run'];
  const plist = renderLaunchdPlist({ programArguments, label: 'app.geniusbar.agent-bot' });
  assert.match(plist, /<string>app\.geniusbar\.agent-bot<\/string>/);
  assert.match(plist, /<string>\/Applications\/Genius Bar\.app\/node<\/string>\s*<string>\/tmp\/\$\(touch x\)\/`id`\/50%\/a&quot;b\\c\/agent-bot\.mjs<\/string>\s*<string>daemon<\/string>\s*<string>run<\/string>/);
  const unit = renderSystemdUnit({ programArguments });
  const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));
  assert.equal(execStart,
    'ExecStart="/Applications/Genius Bar.app/node" "/tmp/$$(touch x)/`id`/50%%/a\\"b\\\\c/agent-bot.mjs" "daemon" "run"');
  assert.throws(() => renderLaunchdPlist({ programArguments: [] }), /non-empty/);
  assert.throws(() => renderSystemdUnit({ programArguments: ['/node', ''] }), /non-empty/);
});

test('install-style ensure rewrites only on change and reports it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-install-'));
  const execs = [];
  const options = {
    home,
    platform: 'darwin',
    env: { AGENT_BOT_SERVICE_LABEL: 'app.geniusbar.agent-bot' },
    reloadUnchanged: false,
    probe: async () => ({ running: true, pid: 9, port: 1, startedAt: '2026-08-16T00:00:00.000Z' }),
    stopDetached: async () => {},
    exec: (command, args) => {
      execs.push([command, ...args]);
      return '';
    },
  };
  const bootstraps = () => execs.filter((row) => row[1] === 'bootstrap').length;
  const first = await ensureDaemonSupervisor({ ...options, programArguments: ['/old/node', '/old/agent-bot.mjs', 'daemon', 'run'] });
  assert.equal(first.label, 'app.geniusbar.agent-bot');
  assert.equal(first.unitPath, join(home, 'Library', 'LaunchAgents', 'app.geniusbar.agent-bot.plist'));
  assert.equal(first.refreshed, true);
  assert.equal(bootstraps(), 1);
  assert.ok(execs.some((row) => row.includes('gui/' + (process.getuid?.() ?? '501') + '/app.geniusbar.agent-bot')));
  const body = readFileSync(first.unitPath, 'utf8');
  assert.match(body, /<key>AGENT_BOT_SERVICE_LABEL<\/key>\s*<string>app\.geniusbar\.agent-bot<\/string>/);

  const again = await ensureDaemonSupervisor({ ...options, programArguments: ['/old/node', '/old/agent-bot.mjs', 'daemon', 'run'] });
  assert.equal(again.refreshed, false);
  assert.equal(again.loaded, true);
  assert.equal(bootstraps(), 1, 'an unchanged, loaded unit is not reloaded');

  const moved = await ensureDaemonSupervisor({ ...options, programArguments: ['/new/node', '/new/agent-bot.mjs', 'daemon', 'run'] });
  assert.equal(moved.refreshed, true);
  assert.equal(bootstraps(), 2);
  assert.match(readFileSync(first.unitPath, 'utf8'), /\/new\/agent-bot\.mjs/);
});

test('disable and inspect use the host label', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-host-disable-'));
  const env = { AGENT_BOT_SERVICE_LABEL: 'app.geniusbar.agent-bot' };
  const unitPath = supervisorPaths(home, 'darwin', env).unitPath;
  const commands = [];
  const result = await disableDaemonSupervisor({
    home,
    platform: 'darwin',
    env,
    exists: (path) => path === unitPath,
    remove: (path) => { commands.push(['rm', path]); },
    probe: async () => ({ running: false }),
    stop: async () => {},
    exec: (command, args) => {
      commands.push([command, ...args]);
      return '';
    },
  });
  assert.equal(result.label, 'app.geniusbar.agent-bot');
  assert.ok(commands.some((row) => row[0] === 'launchctl' && row.some((arg) => arg.endsWith('/app.geniusbar.agent-bot'))));
  assert.deepEqual(commands.find((row) => row[0] === 'rm'), ['rm', unitPath]);
  assert.equal(commands.some((row) => row.some((arg) => String(arg).includes(LAUNCHD_LABEL))), false);
  const info = inspectSupervisor({ home, env, platform: 'darwin', exists: () => false });
  assert.equal(info.label, 'app.geniusbar.agent-bot');
});

test('daemon install registers this runtime under the host label and is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-daemon-install-'));
  const cli = fileURLToPath(new URL('../agent-bot.mjs', import.meta.url));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: join(home, '.local', 'state'),
    AGENT_BOT_SUPERVISOR_SKIP_LOAD: '1',
    AGENT_BOT_SERVICE_LABEL: 'app.geniusbar.agent-bot',
  };
  const run = () => spawnSync(process.execPath, [cli, 'daemon', 'install', '--json'], { env, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(first.stdout);
  const unitPath = process.platform === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', 'app.geniusbar.agent-bot.plist')
    : join(home, '.config', 'systemd', 'user', 'app.geniusbar.agent-bot.service');
  assert.deepEqual(summary, {
    label: process.platform === 'darwin' ? 'app.geniusbar.agent-bot' : 'app.geniusbar.agent-bot.service',
    unitPath,
    changed: true,
    loaded: true,
  });
  const body = readFileSync(unitPath, 'utf8');
  assert.ok(body.includes(process.execPath));
  assert.ok(body.includes(cli));
  assert.equal(JSON.parse(run().stdout).changed, false);
  const bad = spawnSync(process.execPath, [cli, 'daemon', 'install'], {
    env: { ...env, AGENT_BOT_SERVICE_LABEL: '../x' }, encoding: 'utf8',
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /usage: AGENT_BOT_SERVICE_LABEL/);
});

test('the supervised daemon keeps the host npm only when it is an absolute path (ADR-0276)', () => {
  assert.equal(supervisorEnvironment({ env: { AGENT_BOT_NPM: '/App/npm/bin/npm-cli.js' }, home: '/u' }).AGENT_BOT_NPM, '/App/npm/bin/npm-cli.js');
  assert.equal('AGENT_BOT_NPM' in supervisorEnvironment({ env: { AGENT_BOT_NPM: 'npm-cli.js' }, home: '/u' }), false);
  assert.equal(supervisorEnvironment({ env: { AGENT_BOT_EXECUTOR: '1' }, home: '/u' }).AGENT_BOT_EXECUTOR, '1');
  assert.equal('AGENT_BOT_EXECUTOR' in supervisorEnvironment({ env: { AGENT_BOT_EXECUTOR: 'yes' }, home: '/u' }), false);
});

test('souls get the host tools first on PATH, and the unit keeps the tool path (ADR-0276)', async () => {
  const { soulEnvironment } = await import('../agent-daemon.mjs');
  assert.equal(soulEnvironment({ AGENT_BOT_TOOL_PATH: '/App/bin', PATH: '/usr/bin:/bin' }).PATH, '/App/bin:/usr/bin:/bin');
  assert.equal(soulEnvironment({ AGENT_BOT_TOOL_PATH: 'bin', PATH: '/usr/bin' }).PATH, '/usr/bin');
  assert.equal(soulEnvironment({ PATH: '/usr/bin' }).PATH, '/usr/bin');
  assert.equal(supervisorEnvironment({ env: { AGENT_BOT_TOOL_PATH: '/App/bin' }, home: '/u' }).AGENT_BOT_TOOL_PATH, '/App/bin');
});
