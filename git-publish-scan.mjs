// Which repositories a shell command commits or pushes to (#749). The
// installed runner's unbound-bot check asks this before the command runs, and
// for a session that stated a bot identity it must not be talked out of an
// answer: `git -C /elsewhere commit --no-verify` skips the target's own
// pre-commit hook, so the pre-command check is the only guard left.
//
// This is a POSIX-shell lexer and a small evaluator, not a shell. It removes
// quotes and backslashes the way sh does, follows `cd`, `git -C`,
// `--git-dir`, `--work-tree`, GIT_DIR / GIT_WORK_TREE, the common wrappers,
// `sh -c`, `eval` and command substitutions, and reports every `git commit`
// and `git push` with the directory it runs in. `merge`, `rebase`,
// `cherry-pick`, `revert`, `am` and `commit-tree` write commits too, and
// cherry-pick, revert and commit-tree run no pre-commit hook at all, so they
// are reported the same way. What it cannot follow it says so: a target it
// cannot place is `cwd: null`, and a command word it cannot read (a
// variable, a substitution, a glob) makes the scan `ambiguous`. The caller
// fails closed on either, but only for a session that stated a bot. Git
// aliases cannot shadow builtins, so a subcommand that is not a known
// builtin is returned as an alias candidate for the caller to look up.
//
// `skipsHooks` says the command would run without the git backstop, and
// `bypasses` lists the repositories it would do that in:
// `--no-verify` (or `commit -n`), a `core.hooksPath` override for the
// invocation (`-c`, `--config-env`, GIT_CONFIG_PARAMETERS, GIT_CONFIG_KEY_n,
// or an `include.path` that could set it), or a `git config` write of
// `core.hooksPath`. Values the scan cannot read (`git commit $FLAGS`) and
// relocated global config (GIT_CONFIG_GLOBAL, HOME) are not seen.
// `opaqueExecution` marks a script file, stdin-fed shell, interpreter or
// task runner whose git the scan cannot read, and `opaque` lists the
// directory each runs in (null when the scan cannot place it). The caller
// refuses it only for a stated bot that is not bound there; a bound bot
// keeps its prior behaviour, and since opaque code can override
// `core.hooksPath` the git hooks are not a guaranteed backstop for it.

import { dirname, isAbsolute, resolve } from 'node:path';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'yash', 'busybox']);
const SHELL_OPERAND_OPTIONS = new Set(['--rcfile', '--init-file', '-o', '+o', '-O', '+O']);
// Code loaded through a script, stdin, or task runner is not visible to this
// lexical scanner. Treat it as opaque, never as evidence that no Git ran.
const OPAQUE_EXECUTORS = new Set(['node', 'nodejs', 'python', 'python2', 'python3',
  'perl', 'ruby', 'php', 'lua', 'make', 'gmake', 'just', 'npm', 'npx', 'pnpm',
  'yarn', 'bun', 'deno', 'tsx', 'ts-node', 'gradle', 'mvn', 'ant', 'rake']);
// Subcommands that write commits; `push` publishes them.
const COMMITTING = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'commit-tree']);
// Sequencer controls that write no commit, per subcommand.
const NO_COMMIT = {
  merge: new Set(['--abort', '--quit']),
  rebase: new Set(['--abort', '--quit', '--show-current-patch', '--edit-todo']),
  'cherry-pick': new Set(['--abort', '--quit']),
  revert: new Set(['--abort', '--quit']),
  am: new Set(['--abort', '--quit', '--show-current-patch']),
};
// Subcommands whose `--no-verify` skips a hook the backstop runs in.
const VERIFYING = new Set(['commit', 'merge', 'rebase', 'am', 'push']);
// `git commit` short options whose value follows (attached or as the next
// word), so a cluster stops there: `-nm x` is -n -m x, `-mn` is -m n.
const COMMIT_VALUE_SHORT = 'mFCctSu';
// Options whose value is the next word, per subcommand, so a message of
// `-n` is not read as one. (On commit `-s` and `-o` are flags.)
const VALUE_OPTS = {
  commit: new Set(['-m', '-F', '-C', '-c', '-t', '--message', '--file', '--reuse-message', '--reedit-message',
    '--template', '--author', '--date', '--fixup', '--squash', '--trailer', '--cleanup', '--pathspec-from-file']),
  merge: new Set(['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--cleanup',
    '--into-name']),
  rebase: new Set(['-s', '-X', '-x', '--exec', '--onto', '--strategy', '--strategy-option', '--empty']),
  am: new Set(['-C', '-p', '--directory', '--exclude', '--include', '--patch-format', '--resolvemsg']),
  push: new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']),
};
const HOOKS_PATH = /^core\.hookspath$/i;
// Config keys that can set core.hooksPath by pulling in another file.
const HOOKS_PATH_BY_INCLUDE = /^(include\.path|includeif\..*\.path)$/i;
const setsHooksPath = (key) => HOOKS_PATH.test(key) || HOOKS_PATH_BY_INCLUDE.test(key);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function', '{', '}', '!', '[[', ']]', 'in']);
// Builtins a git alias may not shadow. Anything else may be an alias.
const GIT_BUILTINS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file '
  + 'check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick '
  + 'clean clone column commit commit-graph commit-tree config count-objects credential describe '
  + 'diff diff-files diff-index diff-tree difftool fetch fetch-pack filter-branch fmt-merge-msg '
  + 'for-each-ref format-patch fsck gc get-tar-commit-id grep hash-object help index-pack init '
  + 'interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base '
  + 'merge-file merge-tree mergetool mktag mktree mv name-rev notes pack-objects pack-refs prune '
  + 'pull push range-diff read-tree rebase reflog remote repack replace request-pull rerere reset '
  + 'restore rev-list rev-parse revert rm send-email shortlog show show-branch show-ref sparse-checkout '
  + 'stash status stripspace submodule switch symbolic-ref tag update-index update-ref var '
  + 'verify-commit verify-pack verify-tag version whatchanged worktree write-tree').split(' '));

// ---- lexer -----------------------------------------------------------------

// A word is a list of parts: { lit } literal text, { v } a variable, { dyn }
// something only the shell can know (a substitution, `$?`, a glob).
function lex(text) {
  const tokens = [];
  const subs = [];
  let parts = null;
  let i = 0;
  const heredocs = [];
  const lit = (s) => { parts ??= []; parts.push({ lit: s }); };
  const dyn = () => { parts ??= []; parts.push({ dyn: true }); };
  const end = () => {
    if (parts) {
      // Adjacent literal pieces are one literal: `g\it` and `"g"it` read as git.
      const word = [];
      for (const part of parts) {
        if (part.lit !== undefined && word.at(-1)?.lit !== undefined) word.at(-1).lit += part.lit;
        else word.push({ ...part });
      }
      tokens.push({ word });
    }
    parts = null;
  };
  const op = (value) => { end(); tokens.push({ op: value }); };

  const balanced = (start) => {
    // From just after `$(` or `<(`, to the matching `)`, quote-aware.
    let depth = 1;
    for (let j = start; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === '\\') { j += 1; continue; }
      if (ch === '\'') { const k = text.indexOf('\'', j + 1); if (k < 0) return null; j = k; continue; }
      if (ch === '"') {
        for (j += 1; j < text.length && text[j] !== '"'; j += 1) if (text[j] === '\\') j += 1;
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')' && (depth -= 1) === 0) return { inner: text.slice(start, j), end: j };
    }
    return null;
  };

  // `$…` at text[i]; returns the index after it.
  const dollar = (j) => {
    const next = text[j + 1];
    if (next === '(') {
      if (text[j + 2] === '(') { const b = balanced(j + 2); dyn(); return b ? b.end + 2 : text.length; }
      const b = balanced(j + 2);
      if (!b) { dyn(); return text.length; }
      subs.push(b.inner);
      dyn();
      return b.end + 1;
    }
    if (next === '{') {
      const close = text.indexOf('}', j + 2);
      if (close < 0) { dyn(); return text.length; }
      const inner = text.slice(j + 2, close);
      if (NAME.test(inner)) { parts ??= []; parts.push({ v: inner }); } else { subs.push(inner); dyn(); }
      return close + 1;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(j + 1));
    if (m) { parts ??= []; parts.push({ v: m[0] }); return j + 1 + m[0].length; }
    if (next !== undefined && /[0-9?#@*$!-]/.test(next)) { dyn(); return j + 2; }
    lit('$');
    return j + 1;
  };

  const ansiC = (j) => {
    // $'…' — decode the escapes sh and bash agree on; anything else is dyn.
    let out = '';
    for (j += 2; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === '\'') { lit(out); return j + 1; }
      if (ch !== '\\') { out += ch; continue; }
      const e = text[j + 1];
      j += 1;
      const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v',
        '\\': '\\', '\'': '\'', '"': '"', '?': '?' };
      if (e in simple) { out += simple[e]; continue; }
      const hex = /^x([0-9A-Fa-f]{1,2})/.exec(text.slice(j));
      if (hex) { out += String.fromCharCode(parseInt(hex[1], 16)); j += hex[0].length - 1; continue; }
      const oct = /^[0-7]{1,3}/.exec(text.slice(j));
      if (oct) { out += String.fromCharCode(parseInt(oct[0], 8)); j += oct[0].length - 1; continue; }
      dyn();
    }
    dyn();
    return text.length;
  };

  let dropNext = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') { end(); if (dropNext && tokens.at(-1)?.word) { tokens.pop(); dropNext = false; } i += 1; continue; }
    if (ch === '\n') {
      end();
      tokens.push({ op: ';' });
      i += 1;
      // Skip pending here-document bodies: they are data, not commands.
      while (heredocs.length) {
        const { delim, strip } = heredocs.shift();
        for (;;) {
          const nl = text.indexOf('\n', i);
          const line = text.slice(i, nl < 0 ? text.length : nl);
          i = nl < 0 ? text.length : nl + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim || nl < 0) break;
        }
      }
      continue;
    }
    if (ch === '#' && !parts) { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (ch === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < text.length) lit(text[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '\'') {
      const close = text.indexOf('\'', i + 1);
      if (close < 0) { dyn(); i = text.length; continue; }
      lit(text.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === '\'') { i = ansiC(i); continue; }
    if (ch === '"') {
      parts ??= [];
      i += 1;
      while (i < text.length && text[i] !== '"') {
        const c = text[i];
        if (c === '\\' && i + 1 < text.length) {
          const e = text[i + 1];
          if (e === '\n') { i += 2; continue; }
          lit('$`"\\'.includes(e) ? e : `\\${e}`);
          i += 2;
          continue;
        }
        if (c === '$') { i = dollar(i); continue; }
        if (c === '`') {
          const close = text.indexOf('`', i + 1);
          if (close < 0) { dyn(); i = text.length; break; }
          subs.push(text.slice(i + 1, close));
          dyn();
          i = close + 1;
          continue;
        }
        lit(c);
        i += 1;
      }
      if (i >= text.length) dyn();
      i += 1;
      continue;
    }
    if (ch === '$') { i = dollar(i); continue; }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close < 0) { dyn(); i = text.length; continue; }
      subs.push(text.slice(i + 1, close));
      dyn();
      i = close + 1;
      continue;
    }
    if ((ch === '<' || ch === '>') && text[i + 1] === '(') {
      const b = balanced(i + 2);
      if (b) subs.push(b.inner);
      dyn();
      i = b ? b.end + 1 : text.length;
      continue;
    }
    if (ch === '<' || ch === '>' || (ch === '&' && text[i + 1] === '>')) {
      // A redirection: an all-digit word before it is its fd, the word after
      // it is a file (or a here-document delimiter), and neither is an arg.
      if (parts && parts.every((p) => p.lit !== undefined && /^\d+$/.test(p.lit))) parts = null;
      end();
      const m = /^(<<<|<<-|<<|<>|<&|>>|>&|>\||&>>|&>|<|>)/.exec(text.slice(i));
      i += m[0].length;
      if (m[0] === '<<' || m[0] === '<<-') {
        const d = /^\s*(['"]?)([^\s'";&|<>()]+)\1/.exec(text.slice(i));
        if (d) { heredocs.push({ delim: d[2], strip: m[0] === '<<-' }); i += d[0].length; }
        continue;
      }
      while (text[i] === ' ' || text[i] === '\t') i += 1;
      dropNext = true;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
      const two = text.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === ';;' || two === '|&') { op(two); i += 2; } else { op(ch); i += 1; }
      dropNext = false;
      continue;
    }
    if (ch === '~' && !parts) {
      const m = /^~(?=\/|$|[\s;&|)])/.exec(text.slice(i));
      if (m) { parts = [{ v: 'HOME' }]; i += 1; continue; }
      dyn();
      i += 1;
      continue;
    }
    // Unquoted glob and brace characters expand into words only the shell
    // knows.
    if ('*?['.includes(ch) || (ch === '{' && /^\{[^}\s]*[,.][^}\s]*\}/.test(text.slice(i)))) { dyn(); lit(ch); i += 1; continue; }
    lit(ch);
    i += 1;
  }
  end();
  if (dropNext && tokens.at(-1)?.word) tokens.pop();
  return { tokens, subs };
}

// ---- evaluator -------------------------------------------------------------

function expand(parts, vars) {
  let text = '';
  for (const part of parts) {
    if (part.dyn) return { text: null };
    if (part.lit !== undefined) { text += part.lit; continue; }
    // A variable this scan never saw may still be set in the harness's
    // shell (profiles, snapshots), so it is unknown, not empty.
    const value = vars.get(part.v);
    if (value === null || value === undefined) return { text: null };
    text += value;
  }
  return { text };
}

function place(base, path) {
  if (base === null || path === null) return null;
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

// Options that take a separate value, per wrapper, so the value is not read
// as the wrapped command.
const WRAPPERS = {
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  time: new Set(['-f', '-o']),
  nice: new Set(['-n']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  caffeinate: new Set(['-t', '-w']),
  xargs: new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '-R', '-S', '-J']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-r', '-t', '-U', '-C', '-T']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset']),
};

export function scanGitPublish(command, { cwd = process.cwd(), env = process.env, depth = 0 } = {}) {
  const result = { publishes: [], aliases: [], ambiguous: false, opaqueExecution: false, opaque: [], skipsHooks: false, bypasses: [] };
  if (depth > 8) { result.ambiguous = true; return result; }
  const vars = new Map(Object.entries(env ?? {}));
  const exported = new Set(Object.keys(env ?? {}));
  const { tokens, subs } = lex(String(command ?? ''));
  for (const sub of subs) merge(result, scanGitPublish(sub, { cwd, env: envOf(vars, exported), depth: depth + 1 }));

  // Split into simple commands, remembering the operator on each side: a `cd`
  // only moves the shell for sure when it runs unconditionally, in the
  // shell's own process. Grouping and control flow make that unknowable.
  const commands = [];
  let words = [];
  let before = ';';
  let structured = false;
  for (const token of tokens) {
    if (token.word) { words.push(token.word); continue; }
    if (token.op === '(' || token.op === ')') structured = true;
    if (words.length) commands.push({ words, before, after: token.op });
    words = [];
    before = token.op;
  }
  if (words.length) commands.push({ words, before, after: ';' });

  let here = cwd;
  for (const { words: raw, before: pre, after } of commands) {
    let rest = raw;
    while (rest.length && rest[0].length === 1 && KEYWORDS.has(rest[0][0].lit)) { structured = true; rest = rest.slice(1); }
    if (!rest.length) continue;
    // Leading NAME=value assignments.
    const local = new Map();
    while (rest.length) {
      const first = rest[0][0];
      const m = first?.lit !== undefined ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(first.lit) : null;
      if (!m) break;
      const valueParts = [{ lit: first.lit.slice(m[0].length) }, ...rest[0].slice(1)];
      local.set(m[1], expand(valueParts, vars).text);
      rest = rest.slice(1);
    }
    if (!rest.length) {
      for (const [name, value] of local) vars.set(name, value);
      continue;
    }
    const argv = rest.map((w) => expand(w, new Map([...vars, ...local])).text);
    const childEnv = new Map([...[...exported].map((k) => [k, vars.get(k)]), ...local]);
    const step = evaluate(argv, { here, env: childEnv, vars, exported, depth, result, pre, after, structured });
    if (step.cwd !== undefined) here = step.cwd;
  }
  return result;
}

function envOf(vars, exported) {
  const out = {};
  for (const name of exported) if (vars.get(name) !== undefined) out[name] = vars.get(name);
  return out;
}

function merge(into, from) {
  into.publishes.push(...from.publishes);
  into.aliases.push(...from.aliases);
  into.ambiguous ||= from.ambiguous;
  into.opaqueExecution ||= from.opaqueExecution;
  into.opaque.push(...from.opaque);
  into.skipsHooks ||= from.skipsHooks;
  into.bypasses.push(...from.bypasses);
}

function evaluate(argv, ctx) {
  const { here, env, vars, exported, depth, result } = ctx;
  let i = 0;
  let cwd = here;
  // Wrappers that run the rest of argv as a command.
  for (;;) {
    const word = argv[i];
    if (word === null) { result.ambiguous = true; return {}; }
    const base = word?.split('/').pop();
    if (!(base in WRAPPERS)) break;
    if ((base === 'command' && /^-[vV]/.test(argv[i + 1] ?? '')) || (base === 'builtin' && argv[i + 1] === undefined)) return {};
    i += 1;
    if (base === 'timeout') {
      while (argv[i]?.startsWith('-')) i += WRAPPERS.timeout.has(argv[i]) ? 2 : 1;
      i += 1; // the duration
      continue;
    }
    while (i < argv.length && argv[i] !== null && argv[i].startsWith('-') && argv[i] !== '-') {
      const opt = argv[i];
      if (opt === '--') { i += 1; break; }
      if (base === 'env' && (opt === '-C' || opt === '--chdir')) { cwd = place(cwd, argv[i + 1]); i += 2; continue; }
      if (base === 'env' && opt.startsWith('--chdir=')) { cwd = place(cwd, opt.slice(8)); i += 1; continue; }
      if (base === 'env' && (opt === '-S' || opt.startsWith('--split-string'))) { result.ambiguous = true; return {}; }
      if ((base === 'sudo' || base === 'doas') && (opt === '-D' || opt === '--chdir')) { cwd = place(cwd, argv[i + 1]); i += 2; continue; }
      i += WRAPPERS[base].has(opt) ? 2 : 1;
    }
    if (base === 'env') {
      while (argv[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) {
        const eq = argv[i].indexOf('=');
        env.set(argv[i].slice(0, eq), argv[i].slice(eq + 1));
        i += 1;
      }
    }
  }
  const word = argv[i];
  if (word === undefined) return {};
  if (word === null) { result.ambiguous = true; return {}; }
  const base = word.split('/').pop();
  const args = argv.slice(i + 1);
  // Only an unconditional cd, run by the shell itself (not behind a wrapper,
  // in a pipeline, in the background or after a test), moves it for sure.
  const certain = i === 0 && !ctx.structured
    && !['&&', '||', '|', '|&'].includes(ctx.pre) && !['|', '|&', '&'].includes(ctx.after);

  if (base === 'cd' || base === 'pushd') {
    const target = args.filter((a) => a === null || !/^-[LPe@]+$/.test(a))[0];
    let next;
    if (target === undefined) next = vars.get('HOME') ?? null;
    else if (target === '-' || target === null) next = null;
    else next = place(here, target);
    return { cwd: certain ? next : null };
  }
  if (base === 'popd') return { cwd: null };
  if (base === 'export' || base === 'declare' || base === 'typeset' || base === 'local' || base === 'readonly') {
    for (const arg of args) {
      if (arg === null) { result.ambiguous = true; continue; }
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg : arg.slice(0, eq);
      if (!NAME.test(name)) continue;
      if (eq >= 0) vars.set(name, arg.slice(eq + 1));
      if (base === 'export' || arg.startsWith('-x')) exported.add(name);
    }
    if (base === 'export' || base === 'declare' || base === 'typeset') for (const arg of args) if (arg && NAME.test(arg)) exported.add(arg);
    return {};
  }
  if (base === 'unset') {
    for (const arg of args) if (arg && NAME.test(arg)) vars.delete(arg);
    return {};
  }
  if (base === 'eval') {
    if (args.includes(null)) { result.ambiguous = true; return {}; }
    merge(result, scanGitPublish(args.join(' '), { cwd, env: Object.fromEntries(env), depth: depth + 1 }));
    return {};
  }
  // Sourcing executes a file in the current shell; its contents are just as
  // opaque as a script passed to an interpreter.
  if (base === 'source' || base === '.') {
    result.opaqueExecution = true;
    result.opaque.push({ cwd });
    return {};
  }
  if (SHELLS.has(base)) {
    for (let j = 0; j < args.length; j += 1) {
      const arg = args[j];
      if (arg === null) { result.ambiguous = true; break; }
      if (arg === '--') break;
      // An option that takes the next word, so `bash --rcfile -c x.sh`
      // runs x.sh rather than a `-c` payload.
      if (SHELL_OPERAND_OPTIONS.has(arg)) { j += 1; continue; }
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
        const payload = args[j + 1];
        if (payload === null || payload === undefined) { result.ambiguous = true; break; }
        merge(result, scanGitPublish(payload, { cwd, env: Object.fromEntries(env), depth: depth + 1 }));
        return {};
      }
      if (!arg.startsWith('-') && !arg.startsWith('+')) break;
    }
    // No readable -c payload: unknown arguments, -s, redirected stdin, or a script
    // can execute arbitrary Git commands with per-invocation hook overrides.
    result.opaqueExecution = true;
    result.opaque.push({ cwd });
    return {};
  }
  if (OPAQUE_EXECUTORS.has(base) || /^python\d+(?:\.\d+)?$/.test(base)) {
    result.opaqueExecution = true;
    result.opaque.push({ cwd });
    return {};
  }
  if (base === 'git') { gitInvocation(args, { cwd, env, result, depth }); return {}; }
  // An explicit executable path can be a shell script or any other program
  // that runs Git with its hooks disabled. The file contents are opaque here.
  // Only git and known shells/interpreters above have their own handling.
  if (word.includes('/')) {
    result.opaqueExecution = true;
    result.opaque.push({ cwd });
  }
  return {};
}

// Parse git's global options to the subcommand and record where it runs.
function gitInvocation(args, { cwd, env, result, depth, aliases = new Map(), names = new Map(), hooksOverridden = false }) {
  let dir = cwd;
  let hooksOff = hooksOverridden || hooksPathInEnv(env, result);
  let gitDir = env.get('GIT_DIR') ?? undefined;
  let workTree = env.get('GIT_WORK_TREE') ?? undefined;
  if (gitDir === null || workTree === null) dir = null;
  let j = 0;
  for (; j < args.length; j += 1) {
    const arg = args[j];
    if (arg === null) { dir = null; continue; }
    if (arg === '-C') { const p = args[j += 1]; if (p !== '') dir = place(dir, p ?? null); continue; }
    if (arg === '-c') {
      const kv = args[j += 1];
      if (kv === null) { result.ambiguous = true; continue; }
      const m = /^alias\.([^=]+)=(.*)$/is.exec(kv ?? '');
      if (m) aliases.set(m[1].toLowerCase(), m[2]);
      const ident = /^(user|author|committer)\.name(?:=(.*))?$/is.exec(kv ?? '');
      if (ident) names.set(ident[1].toLowerCase(), ident[2] ?? '');
      if (setsHooksPath(/^[^=]*/.exec(kv ?? '')[0])) hooksOff = true;
      continue;
    }
    if (arg === '--config-env' || arg.startsWith('--config-env=')) {
      const spec = arg === '--config-env' ? args[j += 1] : arg.slice(13);
      const ident = /^(user|author|committer)\.name=/i.exec(spec ?? '');
      if (ident || spec === null) names.set(ident ? ident[1].toLowerCase() : 'user', null);
      if (spec === null || setsHooksPath(/^[^=]*/.exec(spec ?? '')[0])) hooksOff = true;
      continue;
    }
    if (arg === '--git-dir' || arg === '--work-tree') {
      const value = args[j += 1] ?? null;
      if (arg === '--git-dir') gitDir = value; else workTree = value;
      continue;
    }
    if (arg.startsWith('--git-dir=')) { gitDir = arg.slice(10); continue; }
    if (arg.startsWith('--work-tree=')) { workTree = arg.slice(12); continue; }
    if (arg === '--namespace') { j += 1; continue; }
    if (arg.startsWith('-')) continue;
    break;
  }
  const sub = args[j];
  if (sub === undefined) return;
  if (sub === null) { result.ambiguous = true; return; }
  const target = {
    cwd: dir,
    gitDir: gitDir === undefined ? undefined : place(dir, gitDir),
    workTree: workTree === undefined ? undefined : place(dir, workTree),
  };
  if (target.gitDir === null || target.workTree === null) target.cwd = null;
  const rest = args.slice(j + 1);
  const bypass = () => { result.skipsHooks = true; result.bypasses.push(target); };
  if (sub === 'config') {
    if (!writesHooksPath(rest)) return;
    // `--file` writes that file's repository, not the one git runs in.
    const file = configFile(rest);
    if (file === undefined) bypass();
    else { result.skipsHooks = true; result.bypasses.push({ cwd: file === null ? null : dirname(place(dir, file) ?? '') }); }
    return;
  }
  if (sub === 'push' || (COMMITTING.has(sub) && !controlOnly(sub, rest))) {
    if (hooksOff || skipsVerify(sub, rest)) bypass();
    if (sub === 'rebase') rebaseExecs(rest, target, env, result, depth);
    if (sub === 'push') { result.publishes.push(target); return; }
    // Only `commit` takes --author; the others use the configured identity.
    result.publishes.push({ ...target, identity: commitIdentity(sub === 'commit' ? rest : [], env, names) });
    return;
  }
  const alias = aliases.get(sub.toLowerCase());
  if (alias !== undefined) {
    expandAlias(alias, target, rest, { env, result, depth, aliases, names, hooksOverridden: hooksOff });
    return;
  }
  if (!GIT_BUILTINS.has(sub)) result.aliases.push({ ...target, name: sub, rest, hooksOverridden: hooksOff });
}

// A `core.hooksPath` override the environment hands this git: what `git -c`
// exports to its children, or the GIT_CONFIG_COUNT/KEY_n pairs. A value the
// scan cannot read could be one.
function hooksPathInEnv(env, result) {
  let found = false;
  for (const [key, value] of env) {
    if (key !== 'GIT_CONFIG_PARAMETERS' && !/^GIT_CONFIG_KEY_\d+$/.test(key)) continue;
    if (value === null) { result.ambiguous = true; continue; }
    if (key === 'GIT_CONFIG_PARAMETERS' ? /core\.hookspath|include(if\..*)?\.path/i.test(value) : setsHooksPath(value)) found = true;
  }
  return found;
}

// A sequencer control (`--abort`, `--quit`, …) on its own. Git takes these
// alone, and reading them out of a longer command would have to know every
// option's value (`--mes --abort` is a message), so anything more is a
// commit-writing command.
function controlOnly(sub, rest) {
  return rest.length === 1 && Boolean(NO_COMMIT[sub]?.has(rest[0]));
}

// `--no-verify` in any unambiguous abbreviation (git accepts `--no-veri`),
// and on `commit` its short `-n`, alone or in a cluster (`-anm x`). On push
// `-n` is --dry-run and writes nothing.
function skipsVerify(sub, rest) {
  if (!VERIFYING.has(sub)) return false;
  for (let k = 0; k < rest.length; k += 1) {
    const arg = rest[k];
    if (arg === null) continue;
    if (arg === '--') break;
    if (VALUE_OPTS[sub].has(arg)) { k += 1; continue; }
    if (arg.length >= 6 && '--no-verify'.startsWith(arg)) return true;
    if (sub !== 'commit' || !/^-[^-]/.test(arg)) continue;
    for (let c = 1; c < arg.length; c += 1) {
      if (arg[c] === 'n') return true;
      if (!COMMIT_VALUE_SHORT.includes(arg[c])) continue;
      // The value is the rest of the cluster, or the next word for the
      // options that require one (-S and -u only take it attached).
      if (c === arg.length - 1 && 'mFCct'.includes(arg[c])) k += 1;
      break;
    }
  }
  return false;
}

// `git config [scope] core.hooksPath <value>` (or an include that could set
// it), `--unset`, `--add`,
// `--replace-all`, or the `set`/`unset` verbs. Reads (`--get`, a bare key)
// change nothing.
function writesHooksPath(rest) {
  const words = rest.filter((a) => a !== null);
  // Renaming or removing a section that holds it, or renaming another
  // section onto one, drops or sets it without naming it. Every word after
  // the action counts, so location flags in between change nothing.
  const section = words.findIndex((a) => /^(--)?(rename|remove)-section(=|$)/.test(a));
  if (section >= 0) {
    const names = [/=(.*)$/s.exec(words[section])?.[1], ...words.slice(section + 1)];
    if (names.some((a) => /^(core|include|includeif\..*)$/i.test(a ?? ''))) return true;
  }
  const key = words.findIndex((a) => setsHooksPath(a));
  if (key < 0) return false;
  const writes = ['set', 'unset', '--unset', '--unset-all', '--add', '--replace-all'];
  if (words.some((a) => writes.includes(a))) return true;
  if (words.some((a) => /^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|get|list)$/.test(a))) return false;
  return words[key + 1] !== undefined;
}

// The `-f`/`--file` a `git config` writes: undefined for none, null for one
// the scan cannot read.
function configFile(rest) {
  let file;
  for (let k = 0; k < rest.length; k += 1) {
    const arg = rest[k];
    if (arg === '-f' || arg === '--file') file = rest[k += 1] ?? null;
    else if (arg?.startsWith('--file=')) file = arg.slice(7);
  }
  return file;
}

// `git rebase -x <cmd>` runs each command in the shell at the work tree.
function rebaseExecs(rest, target, env, result, depth) {
  for (let k = 0; k < rest.length; k += 1) {
    const arg = rest[k];
    if (arg === '--') break;
    let cmd;
    if (arg === '-x' || arg === '--exec') cmd = rest[k += 1];
    else if (arg?.startsWith('--exec=')) cmd = arg.slice(7);
    else if (arg?.startsWith('-x')) cmd = arg.slice(2);
    else continue;
    if (cmd === null || cmd === undefined) { result.ambiguous = true; continue; }
    merge(result, scanGitPublish(cmd, { cwd: target.cwd, env: Object.fromEntries(env), depth: depth + 1 }));
  }
}

// An alias value: `!cmd` runs in the shell at the repository top level (the
// target directory is close enough to place it); anything else is git
// arguments, which may themselves name commit or push.
export function expandAlias(value, target, rest, {
  env = new Map(), result, depth = 0, aliases = new Map(), names = new Map(), hooksOverridden = false,
}) {
  const into = result ?? { publishes: [], aliases: [], ambiguous: false, opaqueExecution: false, opaque: [], skipsHooks: false, bypasses: [] };
  const envObject = { ...(env instanceof Map ? Object.fromEntries(env) : env) };
  if (value.startsWith('!')) {
    // A shell alias's git inherits the outer `-c` through this variable.
    if (hooksOverridden) envObject.GIT_CONFIG_PARAMETERS = `${envObject.GIT_CONFIG_PARAMETERS ?? ''} 'core.hookspath'=''`;
    merge(into, scanGitPublish(value.slice(1), { cwd: target.cwd, env: envObject, depth: depth + 1 }));
    return into;
  }
  const { tokens } = lex(value);
  const words = tokens.filter((t) => t.word).map((t) => expand(t.word, new Map()).text);
  const inner = new Map(env instanceof Map ? env : Object.entries(env));
  if (target.gitDir !== undefined) inner.set('GIT_DIR', target.gitDir);
  if (target.workTree !== undefined) inner.set('GIT_WORK_TREE', target.workTree);
  if (depth > 8) { into.ambiguous = true; return into; }
  gitInvocation([...words, ...rest], { cwd: target.cwd, env: inner, result: into, depth: depth + 1, aliases, names, hooksOverridden });
  return into;
}

// The author and committer names a commit's own command sets, in git's
// precedence; undefined where it sets none (git var answers), null where it
// sets one this scan cannot read.
function commitIdentity(args, env, names) {
  let author;
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k];
    if (arg === '--') break;
    const value = arg === '--author' ? args[k += 1] : arg?.startsWith('--author=') ? arg.slice(9) : undefined;
    if (value === undefined) continue;
    // `Name <email>` is literal; anything else is a pattern git looks up.
    const m = value === null ? null : /^(.*?)\s*<[^<>]*>$/.exec(value);
    author = m ? m[1] : null;
  }
  const pick = (...candidates) => {
    for (const value of candidates) if (value !== undefined) return value;
    return undefined;
  };
  const fromEnv = (key) => (env.has(key) ? env.get(key) : undefined);
  return {
    author: pick(author, fromEnv('GIT_AUTHOR_NAME'), names.get('author'), names.get('user')),
    committer: pick(fromEnv('GIT_COMMITTER_NAME'), names.get('committer'), names.get('user')),
  };
}
