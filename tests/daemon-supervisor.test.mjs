import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DAEMON_RESERVE_MB,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  admitDaemonStart,
  disableDaemonSupervisor,
  ensureDaemonSupervisor,
  inspectSupervisor,
  renderLaunchdPlist,
  renderSystemdUnit,
  supervisorPaths,
} from '../daemon-supervisor.mjs';

function grantedAdmission() {
  return { granted: true, reason: 'granted', message: null };
}

test('launchd unit is secret-free, loopback-agnostic, and keep-alive', () => {
  const plist = renderLaunchdPlist({ executable: '/home/user/.local/bin/agent-bot' });
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<string>\/home\/user\/\.local\/bin\/agent-bot<\/string>/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/s);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/s);
  assert.doesNotMatch(plist, /token|BEGIN |127\.0\.0\.1|AGENT_BOT_DAEMON/);
});

test('launchd unit XML-escapes the executable path', () => {
  const plist = renderLaunchdPlist({ executable: '/tmp/a&b<c>.bin' });
  assert.match(plist, /<string>\/tmp\/a&amp;b&lt;c&gt;\.bin<\/string>/);
});

test('systemd unit restarts always and execs daemon run', () => {
  const unit = renderSystemdUnit({ executable: '/home/user/.local/bin/agent-bot' });
  assert.match(unit, /ExecStart=\/home\/user\/\.local\/bin\/agent-bot daemon run/);
  assert.match(unit, /Restart=always/);
  assert.doesNotMatch(unit, /token|127\.0\.0\.1|Environment=/);
  assert.equal(SYSTEMD_UNIT, 'agent-bot-daemon.service');
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

test('admission refuses a reserve above the derived ceiling', () => {
  assert.throws(
    () => admitDaemonStart({
      requestMb: 4096,
      readMemory: () => ({ totalMb: 8192, availableMb: 4000, swapTotalMb: 0, swapUsedMb: 0, pressureLevel: 1 }),
      listLeases: () => [],
      budgetFor: () => ({ maxRunMb: 2048, machineBudgetMb: 4096, availabilityFloorMb: 768, lightRunMb: 256 }),
      decide: () => grantedAdmission(),
    }),
    /exceeds the ENG-0138 machine cap/,
  );
});

test('admission refuses when the budget decision is denied', () => {
  assert.throws(
    () => admitDaemonStart({
      requestMb: DAEMON_RESERVE_MB,
      readMemory: () => ({ totalMb: 8192, availableMb: 100, swapTotalMb: 0, swapUsedMb: 0, pressureLevel: 1 }),
      listLeases: () => [],
      budgetFor: () => ({ maxRunMb: 2048, machineBudgetMb: 4096, availabilityFloorMb: 768, lightRunMb: 256 }),
      decide: () => ({ granted: false, reason: 'insufficient-headroom', message: 'only 100 MB is available' }),
    }),
    /was not admitted: only 100 MB is available/,
  );
});

test('ensure writes and loads a launchd unit without calling disable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-'));
  const commands = [];
  const result = await ensureDaemonSupervisor({
    home,
    platform: 'darwin',
    executable: join(home, '.local', 'bin', 'agent-bot'),
    env: {},
    admit: () => grantedAdmission(),
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
    admit: () => grantedAdmission(),
    probe: async () => ({ running: true, pid: 9, port: 1, startedAt: '2026-08-16T00:00:00.000Z' }),
    stopDetached: async () => {},
    exec: (command, args) => {
      execs.push([command, ...args]);
      if (command === 'systemctl' && args.includes('is-enabled')) return 'enabled\n';
      return '';
    },
  };
  await ensureDaemonSupervisor({ ...options, executable: '/opt/old/agent-bot' });
  await ensureDaemonSupervisor({ ...options, executable: '/opt/new/agent-bot' });
  assert.match(readFileSync(supervisorPaths(home, 'linux').unitPath, 'utf8'), /\/opt\/new\/agent-bot/);
  assert.ok(execs.some((row) => row[0] === 'systemctl' && row.includes('enable')));
  assert.equal(execs.some((row) => row.includes('disable')), false);
});

test('ensure stops a detached daemon before the supervisor takes over', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-bot-supervisor-adopt-'));
  const stops = [];
  await ensureDaemonSupervisor({
    home,
    platform: 'darwin',
    executable: join(home, '.local', 'bin', 'agent-bot'),
    env: {},
    admit: () => grantedAdmission(),
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
    admit: () => { throw new Error('should not admit'); },
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
