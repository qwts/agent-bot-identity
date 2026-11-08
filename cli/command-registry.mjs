// The agent-bot command registry (HQ plan Stage 0 row 9, #1394). Each command
// registers once: its name, whether it is public or internal, and how it runs.
// The parser accepts exactly the registered names, and the dispatcher resolves
// every invocation here before it runs anything. This is the in-place seam
// for plugin registration in HQ (plan §4.2, `ctx.commands.register(cmd)`): a
// command declares, and the dispatcher owns parsing and launch. Like the
// daemon's route registry (route-registry.mjs, row 8), it refuses what it
// does not know.
//
// A command is { name, visibility, module | run, help?, usage?, prepend?,
// env?, subcommands? }:
//
// - name: the word after `agent-bot`.
// - visibility: 'public' (listed in help) or 'internal' (called by hooks,
//   helpers and generated configuration, never by a person).
// - module: the file, relative to the repository root, that runs the
//   command in a child process. Or
// - run(parsed): a function that answers the command itself.
// - help: text printed when the first argument is --help or -h.
// - usage: the error for arguments that match no subcommand. Without it,
//   such arguments go to the command's module.
// - prepend, env: arguments put before the command's own, and variables
//   added to the child's environment, when the command's module runs.
// - subcommands: a list of { words, module, drop?, prepend?, follow?, env? }.
//   An invocation whose arguments start with `words` runs `module` with its
//   arguments minus the first `drop` (0 by default), after `prepend`.
//   `follow` keeps the dispatcher interruptible while the child runs. The
//   longest matching `words` wins, so `soul env migrate` is not `soul env`.
//
// A name has one declaration, and so does a subcommand's words. `close()`
// ends registration, as HQ closes it after init (§4.4).

export const COMMAND_VISIBILITY = Object.freeze(['public', 'internal']);

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const WORD = /^[a-z][a-z0-9-]*$/;
const MODULE = /^(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9.-]*\.mjs$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const HELP_FLAGS = new Set(['--help', '-h']);
const COMMAND_KEYS = new Set(['name', 'visibility', 'module', 'run', 'help', 'usage', 'prepend', 'env', 'subcommands']);
const SUBCOMMAND_KEYS = new Set(['words', 'module', 'drop', 'prepend', 'follow', 'env']);

function refuse(message) {
  throw Object.assign(new Error(`command registry: ${message}`), { code: 'command-registry-invalid' });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkModule(label, module) {
  if (typeof module !== 'string' || !MODULE.test(module)) refuse(`${label}: module must be a relative .mjs path`);
}

function checkLaunch(label, { prepend, env, follow }) {
  if (prepend !== undefined && (!Array.isArray(prepend) || prepend.length === 0
    || !prepend.every((arg) => typeof arg === 'string' && arg !== ''))) {
    refuse(`${label}: prepend is a list of arguments`);
  }
  if (env !== undefined && (!plainObject(env) || Object.keys(env).length === 0
    || !Object.entries(env).every(([key, value]) => ENV_NAME.test(key) && typeof value === 'string'))) {
    refuse(`${label}: env maps variable names to strings`);
  }
  if (follow !== undefined && follow !== true) refuse(`${label}: follow is true or absent`);
}

function subcommand(name, value) {
  if (!plainObject(value)) refuse(`${name}: a subcommand is an object`);
  const { words, module, drop = 0, prepend, follow, env } = value;
  if (!Array.isArray(words) || words.length === 0 || !words.every((word) => typeof word === 'string' && WORD.test(word))) {
    refuse(`${name}: subcommand words must be a list of lowercase words`);
  }
  const label = `${name} ${words.join(' ')}`;
  for (const key of Object.keys(value)) if (!SUBCOMMAND_KEYS.has(key)) refuse(`${label} has an unknown field ${key}`);
  checkModule(label, module);
  if (!Number.isInteger(drop) || drop < 0 || drop > words.length) refuse(`${label}: drop is 0 to ${words.length}`);
  checkLaunch(label, { prepend, env, follow });
  return Object.freeze({
    words: Object.freeze([...words]), module, drop,
    ...(prepend ? { prepend: Object.freeze([...prepend]) } : {}),
    ...(follow ? { follow } : {}),
    ...(env ? { env: Object.freeze({ ...env }) } : {}),
  });
}

function starts(args, words) {
  return words.every((word, index) => args[index] === word);
}

export function createCommandRegistry() {
  const commands = new Map();
  let closed = false;

  function register(command) {
    if (closed) refuse(`${command?.name}: registration is closed`);
    if (!plainObject(command)) refuse('a command is an object');
    const { name, visibility, module, run, help, usage, prepend, env, subcommands } = command;
    if (typeof name !== 'string' || !NAME.test(name)) refuse(`command name ${JSON.stringify(name)} must match ${NAME}`);
    for (const key of Object.keys(command)) if (!COMMAND_KEYS.has(key)) refuse(`${name} has an unknown field ${key}`);
    if (commands.has(name)) refuse(`${name} is already registered`);
    if (!COMMAND_VISIBILITY.includes(visibility)) refuse(`${name} needs a visibility, one of ${COMMAND_VISIBILITY.join(', ')}`);
    if ((module === undefined) === (run === undefined)) refuse(`${name} needs a module or a run function, not both`);
    if (run !== undefined) {
      if (typeof run !== 'function') refuse(`${name}: run must be a function`);
      const extra = ['help', 'usage', 'prepend', 'env', 'subcommands'].find((key) => command[key] !== undefined);
      if (extra) refuse(`${name}: ${extra} goes with a module, and run answers it itself`);
    } else {
      checkModule(name, module);
    }
    for (const [key, text] of [['help', help], ['usage', usage]]) {
      if (text !== undefined && (typeof text !== 'string' || text.trim() === '')) refuse(`${name}: ${key} is text`);
    }
    checkLaunch(name, { prepend, env });
    if (subcommands !== undefined && (!Array.isArray(subcommands) || subcommands.length === 0)) refuse(`${name}: subcommands is a list`);
    if (usage !== undefined && subcommands === undefined) refuse(`${name}: usage goes with subcommands`);
    const routes = (subcommands ?? []).map((value) => subcommand(name, value));
    const seen = new Set();
    for (const route of routes) {
      const key = route.words.join(' ');
      if (seen.has(key)) refuse(`${name} ${key} is already registered`);
      seen.add(key);
    }
    commands.set(name, Object.freeze({
      name, visibility,
      ...(module !== undefined ? { module } : { run }),
      ...(help !== undefined ? { help } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(prepend ? { prepend: Object.freeze([...prepend]) } : {}),
      ...(env ? { env: Object.freeze({ ...env }) } : {}),
      // Longest words first, so the first match is the longest.
      subcommands: Object.freeze([...routes].sort((a, b) => b.words.length - a.words.length)),
    }));
  }

  // The declaration for a name, or null.
  function get(name) {
    return commands.get(name) ?? null;
  }

  // What an invocation does, or null for an unregistered command:
  //   { kind: 'help', text }       print text, exit 0;
  //   { kind: 'usage', text }      fail with text;
  //   { kind: 'run', run }         call run(parsed);
  //   { kind: 'module', module, args, follow, env }  run module with args.
  function resolve(name, args = []) {
    const command = commands.get(name);
    if (!command) return null;
    if (command.run) return { kind: 'run', run: command.run };
    if (command.help !== undefined && HELP_FLAGS.has(args[0])) return { kind: 'help', text: command.help };
    const route = command.subcommands.find((entry) => starts(args, entry.words));
    if (route) {
      return {
        kind: 'module', module: route.module, args: [...(route.prepend ?? []), ...args.slice(route.drop)],
        follow: route.follow === true, env: route.env ?? null,
      };
    }
    if (command.usage !== undefined) return { kind: 'usage', text: command.usage };
    return { kind: 'module', module: command.module, args: [...(command.prepend ?? []), ...args], follow: false, env: command.env ?? null };
  }

  return Object.freeze({
    register,
    get,
    resolve,
    // Names in registration order, of one visibility or all.
    names: (visibility) => [...commands.values()].filter((command) => !visibility || command.visibility === visibility).map((command) => command.name),
    // Command name -> its module, in registration order.
    modules: () => new Map([...commands.values()].filter((command) => command.module).map((command) => [command.name, command.module])),
    entries: () => [...commands.values()],
    close() { closed = true; },
  });
}
