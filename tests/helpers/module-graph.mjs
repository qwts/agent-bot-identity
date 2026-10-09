// The static import graph of the runtime's own files, checked against the
// module ownership map in governance/runtime-modules.json (#645, ADR-0645).
//
// Only relative specifiers count: `node:` built-ins and the runtime has no
// packages. Dynamic imports count when their specifier is a string literal; a
// computed one cannot be checked here and is reported so it gets a reviewer.

import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const STATIC = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gu;
const DYNAMIC = /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gu;

// Comments can quote an import line, so they are stripped first. This is a
// regex, not a parser: a string literal holding `/*` (a glob, say) would hide
// imports up to the next `*/`. No runtime file does that today; if one ever
// must, the ownership test's file-by-file edge count is where it shows.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gu, '$1');
}

export function importSpecifiers(source) {
  const code = stripComments(source);
  const found = new Set();
  for (const pattern of [STATIC, DYNAMIC]) {
    for (const match of code.matchAll(pattern)) found.add(match[1]);
  }
  return [...found].sort();
}

// Repository-relative POSIX path of a specifier imported by `from`.
export function resolveSpecifier(from, specifier) {
  return normalize(join(dirname(from), specifier)).split('\\').join('/');
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
  for (const file of Object.keys(map.notes ?? {})) {
    if (!Object.hasOwn(assigned, file)) errors.push(`${file}: note for an unassigned file`);
  }
  return errors;
}

// Edges that cross a module boundary the map does not allow.
export function crossingEdges(map, edges) {
  return edges.filter(({ from, to }) => {
    const source = map.files[from];
    const target = map.files[to];
    if (source === target) return false;
    return !map.modules[source].may_import.includes(target);
  });
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
