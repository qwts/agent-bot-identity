import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Use the shell shipped with the same Git that runs our hooks. Windows cannot
// spawn a shebang script directly, and System32 bash may select an unrelated WSL.
export function windowsGitShell({ run = execFileSync, exists = existsSync } = {}) {
  const execPath = run('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
  const shell = path.resolve(execPath, '../../../usr/bin/sh.exe');
  if (!path.isAbsolute(execPath) || !exists(shell)) throw new Error('git-for-windows-shell-unavailable');
  return shell;
}

export function gitShellEnvironment(shell, env = process.env) {
  const child = { ...env };
  const selected = child.PATH ?? child.Path ?? Object.entries(child).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const key of Object.keys(child)) if (key.toLowerCase() === 'path') delete child[key];
  child.PATH = `${path.dirname(shell)};${selected}`;
  return child;
}

// Leave room for a native bound-daemon operation (60s), the broker request
// (10s), and interpreter startup without cutting off the inner deadline.
export function cliCommandTimeout(platform = process.platform) {
  return platform === 'win32' ? 90_000 : 30_000;
}

// CLI shell launchers need the same explicit interpreter as Git hooks. Keep
// the shell program constant and pass command/arguments as positional values.
export function execCliFile(command, args, options, callback) {
  if (process.platform !== 'win32') return execFile(command, args, options, callback);
  const shell = windowsGitShell();
  return execFile(shell, ['-c', 'exec "$@"', 'agent-bot-tool', command, ...args],
    { ...options, windowsHide: true, env: gitShellEnvironment(shell, options.env) }, callback);
}
