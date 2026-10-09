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
// and `git push` with the directory it runs in. What it cannot follow it says
// so: a target it cannot place is `cwd: null`, and a command word it cannot
// read (a variable, a substitution, a glob) makes the scan `ambiguous`. The
// caller fails closed on either, but only for a session that stated a bot.
// Git aliases cannot shadow builtins, so a subcommand that is not a known
// builtin is returned as an alias candidate for the caller to look up.

import { isAbsolute, resolve } from 'node:path';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'yash', 'busybox']);
const PUBLISH = new Set(['commit', 'push']);
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
  const result = { publishes: [], aliases: [], ambiguous: false };
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
  if (SHELLS.has(base)) {
    for (let j = 0; j < args.length; j += 1) {
      const arg = args[j];
      if (arg === null) { result.ambiguous = true; return {}; }
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
        const payload = args[j + 1];
        if (payload === null || payload === undefined) { result.ambiguous = true; return {}; }
        merge(result, scanGitPublish(payload, { cwd, env: Object.fromEntries(env), depth: depth + 1 }));
        return {};
      }
      if (!arg.startsWith('-') && !arg.startsWith('+')) break;
    }
    return {};
  }
  if (base === 'git') gitInvocation(args, { cwd, env, result, depth });
  return {};
}

// Parse git's global options to the subcommand and record where it runs.
function gitInvocation(args, { cwd, env, result, depth, aliases = new Map() }) {
  let dir = cwd;
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
      continue;
    }
    if (arg === '--git-dir' || arg === '--work-tree') {
      const value = args[j += 1] ?? null;
      if (arg === '--git-dir') gitDir = value; else workTree = value;
      continue;
    }
    if (arg.startsWith('--git-dir=')) { gitDir = arg.slice(10); continue; }
    if (arg.startsWith('--work-tree=')) { workTree = arg.slice(12); continue; }
    if (arg === '--namespace' || arg === '--config-env') { j += 1; continue; }
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
  if (PUBLISH.has(sub)) { result.publishes.push(target); return; }
  const alias = aliases.get(sub.toLowerCase());
  if (alias !== undefined) {
    expandAlias(alias, target, args.slice(j + 1), { env, result, depth, aliases });
    return;
  }
  if (!GIT_BUILTINS.has(sub)) result.aliases.push({ ...target, name: sub, rest: args.slice(j + 1) });
}

// An alias value: `!cmd` runs in the shell at the repository top level (the
// target directory is close enough to place it); anything else is git
// arguments, which may themselves name commit or push.
export function expandAlias(value, target, rest, { env = new Map(), result, depth = 0, aliases = new Map() }) {
  const into = result ?? { publishes: [], aliases: [], ambiguous: false };
  const envObject = env instanceof Map ? Object.fromEntries(env) : env;
  if (value.startsWith('!')) {
    merge(into, scanGitPublish(value.slice(1), { cwd: target.cwd, env: envObject, depth: depth + 1 }));
    return into;
  }
  const { tokens } = lex(value);
  const words = tokens.filter((t) => t.word).map((t) => expand(t.word, new Map()).text);
  const inner = new Map(env instanceof Map ? env : Object.entries(env));
  if (target.gitDir !== undefined) inner.set('GIT_DIR', target.gitDir);
  if (target.workTree !== undefined) inner.set('GIT_WORK_TREE', target.workTree);
  if (depth > 8) { into.ambiguous = true; return into; }
  gitInvocation([...words, ...rest], { cwd: target.cwd, env: inner, result: into, depth: depth + 1, aliases });
  return into;
}
