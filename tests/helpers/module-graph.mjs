// The static import graph of the runtime's own files, checked against the
// module ownership map in governance/runtime-modules.json (#645, ADR-0645).
//
// Only relative specifiers count: `node:` built-ins and the runtime has no
// packages. Dynamic imports count when their specifier is a string literal;
// any other `import(...)` is reported by computedImports, and the ownership
// test fails on one the map does not list, so it cannot hide an edge.

import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
]);

const SIMPLE_ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' };

// The value a string literal denotes: `'./secret\x2dstore.mjs'` is the
// specifier './secret-store.mjs', and Node imports it as such.
export function decodeEscapes(raw) {
  return raw.replace(
    /\\(?:x([0-9A-Fa-f]{2})|u\{([0-9A-Fa-f]{1,6})\}|u([0-9A-Fa-f]{4})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/gu,
    (match, hex, braced, unicode, lineContinuation, other) => {
      if (hex || unicode) return String.fromCharCode(Number.parseInt(hex ?? unicode, 16));
      if (braced) {
        const point = Number.parseInt(braced, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : match;
      }
      if (lineContinuation) return '';
      return SIMPLE_ESCAPES[other] ?? other;
    },
  );
}

// A small lexer, enough to tell code from comments, strings, template text
// and regular expressions. It returns the code with every comment removed,
// every literal string (and template without substitutions) replaced by a
// placeholder `"\0<n>"` whose decoded value is strings[n], and regex bodies blanked,
// so the import patterns below only ever match real code.
export function maskSource(source) {
  const strings = [];
  let out = '';
  let i = 0;
  const templates = []; // brace depth at each open `${`
  let depth = 0;
  const lastSignificant = () => {
    const trimmed = out.trimEnd();
    const word = /[A-Za-z_$][\w$]*$/u.exec(trimmed)?.[0];
    return { char: trimmed.at(-1) ?? '', word };
  };
  const regexAllowed = () => {
    const { char, word } = lastSignificant();
    if (word) return KEYWORDS_BEFORE_EXPRESSION.has(word);
    return !/[\w$)\]}"'`]/u.test(char);
  };
  // A backslash before CRLF is one line continuation, three characters long.
  const escapeLength = (at) => (source[at + 1] === '\r' && source[at + 2] === '\n' ? 3 : 2);
  const quoted = (raw) => {
    strings.push(decodeEscapes(raw));
    return `"\0${strings.length - 1}"`;
  };
  // Reads template text from i (just past ` or }) to the closing ` or ${.
  const templateText = () => {
    let text = '';
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { const n = escapeLength(i); text += source.slice(i, i + n); i += n; continue; }
      if (c === '`') { i += 1; return { text, closed: true }; }
      if (c === '$' && source[i + 1] === '{') { i += 2; return { text, closed: false }; }
      text += c;
      i += 1;
    }
    return { text, closed: true };
  };
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      out += ' ';
    } else if (c === '"' || c === "'") {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') { const n = escapeLength(i); value += source.slice(i, i + n); i += n; } else { value += source[i]; i += 1; }
      }
      i += 1;
      out += quoted(value);
    } else if (c === '`') {
      i += 1;
      const { text, closed } = templateText();
      if (closed) {
        out += quoted(text);
      } else {
        out += '`${';
        templates.push(depth);
        depth += 1;
      }
    } else if (c === '}' && templates.length && templates.at(-1) === depth - 1) {
      templates.pop();
      depth -= 1;
      i += 1;
      const { closed } = templateText();
      if (closed) {
        out += '}`';
      } else {
        out += '}${';
        templates.push(depth);
        depth += 1;
      }
    } else if (c === '/' && regexAllowed()) {
      let inClass = false;
      i += 1;
      while (i < source.length && source[i] !== '\n') {
        const r = source[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      while (/[a-z]/u.test(source[i] ?? '')) i += 1;
      out += '/r/';
    } else {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      out += c;
      i += 1;
    }
  }
  return { code: out, strings };
}

const LITERAL = String.raw`"\0(\d+)"`;
const STATIC = new RegExp(String.raw`(?<![\w$.])(?:import|export)\s+(?:[^";]*?\s+from\s*)?${LITERAL}`, 'gu');
const DYNAMIC = /(?<![\w$.])import\s*\(/gu;

function relative(specifier) {
  return /^\.{1,2}\//u.test(specifier);
}

// Every `import(` whose argument is not a single string literal, as written.
function dynamicCalls({ code, strings }) {
  const literal = [];
  const computed = [];
  for (const match of code.matchAll(DYNAMIC)) {
    const rest = code.slice(match.index + match[0].length);
    const only = new RegExp(String.raw`^\s*${LITERAL}\s*[,)]`, 'u').exec(rest);
    if (only) literal.push(strings[Number(only[1])]);
    else {
      const end = rest.search(/[)\n]/u);
      computed.push(`import(${(end === -1 ? rest : rest.slice(0, end)).trim()})`);
    }
  }
  return { literal, computed };
}

export function importSpecifiers(source) {
  const masked = maskSource(source);
  const found = new Set();
  for (const match of masked.code.matchAll(STATIC)) found.add(masked.strings[Number(match[1])]);
  for (const specifier of dynamicCalls(masked).literal) found.add(specifier);
  return [...found].filter(relative).sort();
}

// `import(...)` calls this graph cannot follow because the specifier is
// computed. Each one is a possible boundary crossing nobody can see.
export function computedImports(source) {
  return dynamicCalls(maskSource(source)).computed;
}

// Repository-relative POSIX path of a specifier imported by `from`. Node
// resolves a relative specifier as a URL: a query or fragment does not change
// the file, and percent-escapes are decoded, so both are applied here too.
export function resolveSpecifier(from, specifier) {
  let path = specifier.replace(/[?#].*$/su, '');
  try { path = decodeURIComponent(path); } catch { /* a malformed escape stays literal */ }
  return normalize(join(dirname(from), path)).split('\\').join('/');
}

// Edges between files the map knows about. Imports of anything else (web
// assets, JSON) are outside the map and are not edges.
export function moduleEdges(root, files, read = (file) => readFileSync(join(root, file), 'utf8')) {
  const known = new Set(files);
  const edges = [];
  for (const from of files) {
    for (const specifier of importSpecifiers(read(from))) {
      const to = resolveSpecifier(from, specifier);
      if (known.has(to) && to !== from) edges.push({ from, to });
    }
  }
  return edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}

export function edgeKey({ from, to }) {
  return `${from} -> ${to}`;
}

// Structural errors in the map itself: unknown modules, rules naming unknown
// modules, files assigned to no module or to a module that does not exist.
export function validateModuleMap(map, files) {
  const errors = [];
  const modules = map?.modules;
  if (map?.schema_version !== 1) errors.push('schema_version must be 1');
  if (!modules || typeof modules !== 'object' || Array.isArray(modules)) {
    return [...errors, 'modules must be an object'];
  }
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module?.summary !== 'string' || !module.summary.trim()) errors.push(`${name}: summary is required`);
    if (!Array.isArray(module?.may_import)) {
      errors.push(`${name}: may_import must be an array`);
      continue;
    }
    for (const target of module.may_import) {
      if (!Object.hasOwn(modules, target)) errors.push(`${name}: may_import names unknown module ${target}`);
      if (target === name) errors.push(`${name}: may_import must not list itself`);
    }
  }
  const assigned = map.files ?? {};
  const present = new Set(files);
  for (const file of files) {
    if (!Object.hasOwn(assigned, file)) errors.push(`${file}: not assigned to a module`);
  }
  for (const [file, owner] of Object.entries(assigned)) {
    if (!present.has(file)) errors.push(`${file}: assigned but not a runtime file`);
    if (!Object.hasOwn(modules, owner)) errors.push(`${file}: unknown module ${owner}`);
  }
  for (const [file, reason] of Object.entries(map.computed_imports ?? {})) {
    if (!Object.hasOwn(assigned, file)) errors.push(`${file}: computed import listed for an unassigned file`);
    if (typeof reason !== 'string' || !reason.trim()) errors.push(`${file}: computed import needs a reason`);
  }
  for (const file of Object.keys(map.notes ?? {})) {
    if (!Object.hasOwn(assigned, file)) errors.push(`${file}: note for an unassigned file`);
  }
  for (const [file, contract] of Object.entries(map.contracts ?? {})) {
    if (!Object.hasOwn(assigned, file)) errors.push(`${file}: contract listed for an unassigned file`);
    if (!Array.isArray(contract?.importable_by) || !contract.importable_by.length) {
      errors.push(`${file}: contract needs importable_by`);
    } else {
      for (const name of contract.importable_by) {
        if (!Object.hasOwn(modules, name)) errors.push(`${file}: contract names unknown module ${name}`);
        if (name === assigned[file]) errors.push(`${file}: contract must not list its own module`);
      }
    }
    if (!Array.isArray(contract?.exports) || !contract.exports.length) errors.push(`${file}: contract needs its exports listed`);
    if (typeof contract?.reason !== 'string' || !contract.reason.trim()) errors.push(`${file}: contract needs a reason`);
  }
  return errors;
}

// Edges that cross a module boundary the map does not allow.
export function crossingEdges(map, edges) {
  return edges.filter(({ from, to }) => {
    const source = map.files[from];
    const target = map.files[to];
    if (source === target) return false;
    if (map.contracts?.[to]?.importable_by?.includes(source)) return false;
    return !map.modules[source].may_import.includes(target);
  });
}

// The names a module exports, for checking a contract's surface. Covers the
// declaration forms this repository uses; a contract that needs another form
// adds it here.
export function exportedNames(source) {
  const masked = maskSource(source).code;
  const names = new Set();
  for (const match of masked.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gu)) names.add(match[1]);
  for (const match of masked.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/u).pop();
      if (name) names.add(name);
    }
  }
  if (/\bexport\s+default\b/u.test(masked)) names.add('default');
  return [...names].sort();
}

// The ratchet: a crossing not in the baseline is new and fails; a baseline
// entry that no longer crosses is stale and must be removed, so the baseline
// only ever shrinks as the boundaries are untangled.
export function compareToBaseline(crossings, baseline) {
  const now = new Set(crossings.map(edgeKey));
  const recorded = new Set(baseline);
  return {
    added: [...now].filter((key) => !recorded.has(key)).sort(),
    stale: [...recorded].filter((key) => !now.has(key)).sort(),
    duplicates: baseline.filter((key, index) => baseline.indexOf(key) !== index),
  };
}
