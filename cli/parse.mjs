const PUBLIC_COMMANDS = new Set([
  'setup-worktree',
  'mint-token',
  'doctor',
  'identity',
  'space',
  'install',
  'update',
  'install-gh-shim',
  'ensure-private-key',
  'signed-commit',
  'secret',
]);

const INTERNAL_COMMANDS = new Set([
  'credential',
  'worktree-token',
  'claude-worktree-create',
  'hook',
  // Called by every harness's generated hook config, never by a person.
  'agent-hook',
]);

export function parseAgentBotArgs(argv) {
  const args = [...argv];
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { kind: 'help' };
  }
  if (args[0] === '--version' || args[0] === '-v') {
    if (args.length !== 1) throw new Error('--version does not accept arguments');
    return { kind: 'version' };
  }
  const command = args.shift();
  if (!PUBLIC_COMMANDS.has(command) && !INTERNAL_COMMANDS.has(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  if (command === 'hook') {
    const hook = args.shift();
    if (!hook || hook.startsWith('-')) throw new Error('hook requires a hook name');
    return { kind: 'command', command, hook, args };
  }
  return { kind: 'command', command, args };
}

export { PUBLIC_COMMANDS };
