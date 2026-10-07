// The soul environment contract (#583, ADR-0583): one pure, versioned
// description of what lives where under a soul root, shared by the engine's
// descriptor (`soul env`), `soul revision prepare`, and hosts such as
// GeniusBar, which read it instead of carrying their own path lists. No I/O:
// everything here is data and pure functions over root-relative paths.
import { GENERATED_HARNESS_MARKER, GENERATED_HARNESS_PATHS, PACKAGE_IGNORE_LIST, isGeneratedPath } from './soul-harness-contract.mjs';

// One source for the generated paths and the format-2 ignore list: the
// harness contract owns them, this module re-exports them so a consumer of
// the environment contract never imports a second list.
export { GENERATED_HARNESS_MARKER, GENERATED_HARNESS_PATHS, PACKAGE_IGNORE_LIST };

export const ENV_CONTRACT_VERSION = 1;

// Closed enum. Order is part of the contract (a host may index by it);
// values are only ever appended.
export const CLASSIFICATIONS = Object.freeze([
  'definition', 'generated', 'workspace', 'runtime', 'private-home',
  'memory', 'history', 'cache', 'temp', 'external',
]);

// What losing each class costs: durable state is the soul's life and is
// never reconstructible; reconstructible state is rebuilt from the definition
// (a build, an install); disposable state may vanish at any time. `external`
// has no retention: it is the host's, not the soul's.
export const RETENTION = Object.freeze(['durable', 'reconstructible', 'disposable']);
const RETENTION_OF = Object.freeze({
  definition: 'durable', generated: 'reconstructible', workspace: 'durable', runtime: 'reconstructible',
  'private-home': 'durable', memory: 'durable', history: 'durable', cache: 'reconstructible', temp: 'disposable',
  external: null,
});

export function retentionOf(classification) {
  if (!CLASSIFICATIONS.includes(classification)) throw new Error(`unknown classification: ${classification}`);
  return RETENTION_OF[classification];
}

// Where each component of a soul's environment lives, root-relative. `path`
// null means the component is not one path (generated output is a set of
// paths; host tools are outside the root). The descriptor reports presence
// per component; this table says what it would mean.
export const SOUL_LAYOUT = Object.freeze([
  { id: 'manifest', path: 'soul.json', classification: 'definition' },
  { id: 'instructions', path: 'AGENTS.md', classification: 'definition' },
  { id: 'skills', path: 'skills', classification: 'definition' },
  { id: 'hooks', path: 'hooks', classification: 'definition' },
  { id: 'tools-bin', path: 'bin', classification: 'definition' },
  { id: 'workflows', path: 'workflows', classification: 'definition' },
  { id: 'sop', path: 'sop', classification: 'definition' },
  { id: 'harness-pins', path: 'package.json', classification: 'definition' },
  { id: 'generated', path: null, classification: 'generated' },
  { id: 'workspaces', path: 'worktrees', classification: 'workspace' },
  { id: 'home', path: '.soul-state/home', classification: 'private-home' },
  { id: 'tool-state', path: '.soul-state/tools', classification: 'private-home' },
  { id: 'credentials', path: '.soul-state/credentials', classification: 'private-home' },
  { id: 'runtimes', path: '.soul-state/runtimes', classification: 'runtime' },
  { id: 'memory', path: '.soul-state/space', classification: 'memory' },
  { id: 'history', path: '.soul-state/runs', classification: 'history' },
  { id: 'cache', path: '.soul-state/cache', classification: 'cache' },
  { id: 'temp', path: '.soul-state/tmp', classification: 'temp' },
  { id: 'host-tools', path: null, classification: 'external' },
].map((component) => Object.freeze({ ...component, retention: RETENTION_OF[component.classification] })));

// Ordered: the first matching rule wins, so the specific `.soul-state/`
// children precede the private-home prefix, and working-state prefixes
// precede the generated check (a generated path is only ever at the root).
// The last rule is the default: anything else in the root is the definition.
export const CLASSIFICATION_RULES = Object.freeze([
  { match: 'prefix', path: '.soul-state/runtimes/', classification: 'runtime' },
  { match: 'prefix', path: '.soul-state/space/', classification: 'memory' },
  { match: 'prefix', path: '.soul-state/runs/', classification: 'history' },
  { match: 'prefix', path: '.soul-state/cache/', classification: 'cache' },
  { match: 'prefix', path: '.soul-state/tmp/', classification: 'temp' },
  { match: 'prefix', path: '.soul-state/', classification: 'private-home' },
  { match: 'prefix', path: 'worktrees/', classification: 'workspace' },
  { match: 'generated', classification: 'generated' },
  { match: 'default', classification: 'definition' },
].map(Object.freeze));

const SAFE_RELATIVE = (relative) => typeof relative === 'string' && relative.length > 0 && relative.length <= 4096
  && !relative.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(relative)
  && relative.split('/').every((part) => part && part !== '.' && part !== '..');

// A prefix rule matches the directory itself (`worktrees`) as well as what
// is under it (`worktrees/x`); the path `.soul-state` is the directory the
// private-home rule names.
function prefixMatches(prefix, relative) {
  return relative === prefix.slice(0, -1) || relative.startsWith(prefix);
}

/** The classification of one root-relative path (POSIX separators, no traversal). */
export function classifyPath(relative) {
  if (!SAFE_RELATIVE(relative)) throw new Error('classifyPath needs a relative path without traversal');
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.match === 'prefix' && prefixMatches(rule.path, relative)) return rule.classification;
    if (rule.match === 'generated' && (isGeneratedPath(relative) || isGeneratedPath(`${relative}/`))) return rule.classification;
    if (rule.match === 'default') return rule.classification;
  }
  throw new Error('classification rules must end with a default');
}

/** The contract as the descriptor publishes it. */
export function classificationContract() {
  return { enum: [...CLASSIFICATIONS], rules: CLASSIFICATION_RULES.map((rule) => ({ ...rule })) };
}
