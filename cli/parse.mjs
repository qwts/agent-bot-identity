import { COMMANDS } from './dispatch.mjs';

// The registered commands (cli/dispatch.mjs, #1394): the public ones, in
// registration order; any registered name, public or internal, parses.
const PUBLIC_COMMANDS = new Set(COMMANDS.names('public'));

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
  if (!COMMANDS.get(command)) {
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
