// Cap launchd's shared stdout/stderr log without changing system settings.
import { constants, chmodSync, copyFileSync, fchmodSync, fstatSync, ftruncateSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DAEMON_LOG_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export function daemonLogMaxBytes(env = process.env) {
  const value = env.AGENT_BOT_DAEMON_LOG_MAX_BYTES;
  const bytes = Number(value);
  return /^\d+$/.test(value ?? '') && Number.isSafeInteger(bytes) && bytes > 0
    ? bytes : DEFAULT_DAEMON_LOG_MAX_BYTES;
}

export function daemonLogPath(home = homedir()) {
  return join(home, 'Library', 'Logs', 'agent-bot', 'daemon.log');
}

// Each daemon keeps one checker, including its once-only error report.
export function createDaemonLogCheck({
  fd = 2,
  logPath = daemonLogPath(),
  env = process.env,
  log = (line) => writeSync(2, `${line}\n`),
} = {}) {
  const maxBytes = daemonLogMaxBytes(env);
  let reported = false;
  return () => {
    try {
      const live = fstatSync(fd);
      // Pipes (including journald), terminals and /dev/null are untouched.
      if (!live.isFile() || live.size <= maxBytes) return false;
      const named = statSync(logPath);
      // Never truncate a different file supplied by a foreground caller.
      if (live.dev !== named.dev || live.ino !== named.ino) return false;
      fchmodSync(fd, 0o600);
      const backup = `${logPath}.1`;
      // Replace only this generation. Unlink rather than follow a stale
      // symlink/hard link, and create exclusively so neither can be copied over.
      try { unlinkSync(backup); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // Renaming would leave launchd's open descriptors writing to .1.
      // Copy first, then truncate the same live inode: O_APPEND makes both
      // stdout and stderr resume at its new end (offset zero).
      copyFileSync(logPath, backup, constants.COPYFILE_EXCL);
      chmodSync(backup, 0o600);
      ftruncateSync(fd, 0);
      return true;
    } catch (error) {
      if (!reported) {
        reported = true;
        try { log(`agent-daemon: log cap check failed: ${error.message}`); } catch { /* logging must also be best-effort */ }
      }
      return false;
    }
  };
}
