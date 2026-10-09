// Per-soul tool homes (#583 slice 2, ADR-0583 decision 5). Pure data and
// path arithmetic, no I/O: the descriptor reads it, the launch routes with
// it, and `soul env migrate` (soul-env-migrate.mjs) adopts with it.
//
// A harness keeps its native state (sign-in, sessions, settings) in a
// store under the user's HOME, shared by every soul on the machine. A
// routable harness has a variable that moves that store, so a launch points
// it at `<soul>/.soul-state/tools/<harness>/` and two souls on one Mac stop
// sharing a login. Only harness-specific variables are ever set: `HOME`
// stays the host's and `XDG_STATE_HOME` is read by every agent-bot child
// for the daemon's own state, so neither is routable. A harness with no
// such variable is reported `unsupported`, never faked with a HOME swap.
//
// Whether a routable harness is routed is decided per launch from the
// sign-in files alone (`toolHomeDecision`): a soul that already holds its
// sign-in, or a host with none to lose, is contained; a host sign-in the
// soul lacks is kept exactly where it works, `shared-host`, until the owner
// adopts it. A harness is never started into an empty store it would ask
// to sign in to.
//
// A soul's own choice, one entry per harness in `.soul-state/tool-homes.json`
// (#617, soul-tool-home-record.mjs reads and writes it), comes before that:
// `soul` keeps the harness's config, sign-in and sessions in the soul's tool
// home whatever the host holds, `global` uses the host's install and store,
// explicitly. A soul born managed gets `soul` for the harnesses in
// `SOUL_DEFAULT_HARNESSES`; a soul without the file (one that existed before
// it) keeps the sign-in decision above, so nothing it has moves.
import path from 'node:path';

export const TOOL_HOMES_SCHEMA_VERSION = 1;
export const TOOL_CONTAINMENTS = Object.freeze(['soul', 'shared-host', 'unsupported']);
export const SIGN_IN_STATES = Object.freeze(['present', 'missing', 'unknown']);
export const TOOL_FILE_KINDS = Object.freeze(['sign-in', 'state']);
// A soul's per-harness choice: its own tool home, or the host's (global)
// install and store.
export const TOOL_HOME_CHOICES = Object.freeze(['soul', 'global']);
// The harnesses a soul born managed is stamped `soul` for. Codex only in
// this slice of #617; the other routable harnesses keep the sign-in
// decision until their slice adds them here.
export const SOUL_DEFAULT_HARNESSES = Object.freeze(['codex']);
// Never routed, whatever a registry row says (decision 5).
export const NEVER_ROUTED = Object.freeze(['HOME', 'XDG_STATE_HOME']);
const STATE = '.soul-state';
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

// Each routable row: `routes[]`, one per variable the launch sets, with the
// directory under the tool home it points at (`dir` null is the tool home
// itself; `app` is the subdirectory the harness itself adds under an XDG
// base) and `host`, how the host resolves the same store (the variable it
// honours when set, else `default` under the home; '' is the home itself).
// `files[]` is what adoption copies and what sign-in presence is read from,
// each relative to its route's directory on both sides; a file's own `host`
// overrides the route's when the host keeps it elsewhere. `note` says what
// a file copy cannot carry.
//
// Evidence for each variable, as the repo has it: CLAUDE_CONFIG_DIR is
// followed by sync-hooks.mjs and metrics.mjs; CODEX_HOME and the OpenCode
// XDG bases come from ADR-0583 decision 5 and the registry's store paths
// (acp-registry.mjs); `.claude.json` moving with CLAUDE_CONFIG_DIR is Claude
// Code's documented behaviour, not verified here (docs/soul-tool-homes.md).
const CLAUDE_HOST = Object.freeze({ env: 'CLAUDE_CONFIG_DIR', default: '.claude' });
const CODEX_HOST = Object.freeze({ env: 'CODEX_HOME', default: '.codex' });
export const TOOL_HOME_REGISTRY = Object.freeze({
  claude: Object.freeze({
    harness: 'claude',
    routable: true,
    reason: null,
    routes: Object.freeze([Object.freeze({ env: 'CLAUDE_CONFIG_DIR', dir: null, app: null, host: CLAUDE_HOST })]),
    files: Object.freeze([
      Object.freeze({ kind: 'sign-in', path: '.credentials.json', route: 'CLAUDE_CONFIG_DIR', host: null }),
      // Onboarding, theme and user-scoped settings; at `~/.claude.json` on a
      // host that sets no CLAUDE_CONFIG_DIR, inside the directory otherwise.
      Object.freeze({ kind: 'state', path: '.claude.json', route: 'CLAUDE_CONFIG_DIR', host: Object.freeze({ env: 'CLAUDE_CONFIG_DIR', default: '' }) }),
    ]),
    note: 'on macOS Claude Code keeps its OAuth sign-in in the login keychain, per user, which no file copy carries; a routed soul with no .credentials.json signs in once in its own tool home, or runs on a provider secret',
  }),
  codex: Object.freeze({
    harness: 'codex',
    routable: true,
    reason: null,
    routes: Object.freeze([Object.freeze({ env: 'CODEX_HOME', dir: null, app: null, host: CODEX_HOST })]),
    files: Object.freeze([Object.freeze({ kind: 'sign-in', path: 'auth.json', route: 'CODEX_HOME', host: null })]),
    note: null,
  }),
  opencode: Object.freeze({
    harness: 'opencode',
    routable: true,
    reason: null,
    routes: Object.freeze([
      Object.freeze({ env: 'XDG_CONFIG_HOME', dir: 'config', app: 'opencode', host: Object.freeze({ env: 'XDG_CONFIG_HOME', default: '.config' }) }),
      Object.freeze({ env: 'XDG_DATA_HOME', dir: 'data', app: 'opencode', host: Object.freeze({ env: 'XDG_DATA_HOME', default: path.join('.local', 'share') }) }),
      Object.freeze({ env: 'XDG_CACHE_HOME', dir: 'cache', app: 'opencode', host: Object.freeze({ env: 'XDG_CACHE_HOME', default: '.cache' }) }),
    ]),
    files: Object.freeze([Object.freeze({ kind: 'sign-in', path: path.join('opencode', 'auth.json'), route: 'XDG_DATA_HOME', host: null })]),
    note: null,
  }),
  kiro: unroutable('kiro', 'kiro-cli keeps sessions under ~/.kiro and its sign-in under ~/Library/Application Support/kiro-cli; no variable that moves them is documented in this repo'),
  muse: unroutable('muse', 'muse keeps its store under ~/.local/share/muse; no variable that moves it is documented in this repo'),
  gemini: unroutable('gemini', 'gemini keeps its store under ~/.gemini and is not an ACP drive harness; no variable that moves it is documented in this repo'),
  copilot: unroutable('copilot', 'Copilot CLI keeps an isolated session store with no ACP drive row; nothing to route'),
});

function unroutable(harness, reason) {
  return Object.freeze({ harness, routable: false, reason, routes: Object.freeze([]), files: Object.freeze([]), note: null });
}

// A row is data the launch trusts, so it is checked once at load: every
// variable name is well formed, never one decision 5 forbids, and every
// file names a route of its own row.
export function validateToolHomeRow(row) {
  const label = `tool-home registry ${row?.harness ?? '?'}`;
  if (!row || typeof row.harness !== 'string' || typeof row.routable !== 'boolean') throw new Error(`${label}: harness and routable are required`);
  if (!row.routable && !row.reason) throw new Error(`${label}: an unroutable harness needs a reason`);
  const routes = new Set();
  for (const route of row.routes) {
    if (!ENV_NAME.test(route.env) || NEVER_ROUTED.includes(route.env)) throw new Error(`${label}: ${route.env} may not be routed`);
    if (route.dir !== null && (typeof route.dir !== 'string' || !route.dir || path.isAbsolute(route.dir) || route.dir.includes('..'))) throw new Error(`${label}: ${route.env} dir must be a relative name`);
    routes.add(route.env);
  }
  for (const file of row.files) {
    if (!TOOL_FILE_KINDS.includes(file.kind) || !routes.has(file.route)) throw new Error(`${label}: file ${file.path} needs a kind and a route of this row`);
    if (typeof file.path !== 'string' || !file.path || path.isAbsolute(file.path) || file.path.includes('..')) throw new Error(`${label}: file ${file.path} must be a relative path`);
  }
  if (row.routable && !row.files.some((file) => file.kind === 'sign-in')) throw new Error(`${label}: a routable harness names its sign-in file`);
  return row;
}
for (const row of Object.values(TOOL_HOME_REGISTRY)) validateToolHomeRow(row);

/** The registry row for a harness; an unknown name is unroutable with a reason, never an error. */
export function toolHomeFor(harness) {
  if (typeof harness === 'string' && Object.hasOwn(TOOL_HOME_REGISTRY, harness)) return TOOL_HOME_REGISTRY[harness];
  return unroutable(typeof harness === 'string' ? harness : '?', `no tool-home routing is known for ${typeof harness === 'string' ? harness : 'this harness'}`);
}

export function toolHomesRoot(soulDir) {
  return path.join(soulDir, STATE, 'tools');
}

export function toolHomePath(soulDir, harness) {
  return path.join(toolHomesRoot(soulDir), harness);
}

export const toolHomeRelative = (harness) => `${STATE}/tools/${harness}`;

// Where the host keeps a store: the variable it honours when set to an
// absolute path, else the default under the home.
function hostBase(spec, { env = {}, home }) {
  const value = env[spec.env];
  if (typeof value === 'string' && path.isAbsolute(value)) return path.resolve(value);
  return spec.default ? path.join(home, spec.default) : home;
}

const routeDir = (soulDir, harness, route) => (route.dir === null ? toolHomePath(soulDir, harness) : path.join(toolHomePath(soulDir, harness), route.dir));

/**
 * The env patch a launch of this harness adds when it is routed, pure over
 * the soul folder: `{ env, routing, home, dirs, routable, reason }`.
 * `routing` names the variables in registry order; `dirs` is every
 * directory the patch points at, for the launch to create; an unroutable
 * harness patches nothing and carries its reason. Whether the patch is
 * applied is `toolHomeDecision`'s call.
 */
export function toolHomeEnv(soulDir, harness) {
  const row = toolHomeFor(harness);
  const home = toolHomePath(soulDir, row.harness);
  if (!row.routable) return { env: {}, routing: [], home, dirs: [], routable: false, reason: row.reason };
  const env = {}, dirs = [home];
  for (const route of row.routes) {
    const dir = routeDir(soulDir, row.harness, route);
    env[route.env] = dir;
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return { env, routing: row.routes.map((route) => route.env), home, dirs, routable: true, reason: null };
}

/**
 * Where a harness's native state lives for the next launch, from sign-in
 * presence alone (`present | missing | unknown`, by existence, never read):
 * `{ containment, reason }`.
 *
 * - `unsupported`: the harness has no routable store.
 * - `soul`: the soul's tool home already holds the sign-in, or the host
 *   store has none to lose (a fresh Mac is contained from the first
 *   launch), or the owner ran the adoption (`adopted`: the journal step is
 *   done or skipped; on macOS that is how a Claude keychain sign-in, which
 *   no file copy carries, is knowingly left behind for one sign-in inside
 *   the soul).
 * - `choice` (the soul's tool-homes record, #617), when set, wins:
 *   `soul` is `soul`, `global` is `shared-host` by the soul's own choice.
 * - `shared-host`: the host has a sign-in the soul lacks, or may have one
 *   no file shows (`hostSignIn: unknown`): routing would start the harness
 *   into an empty store that asks to sign in, so it keeps the host store
 *   exactly as before, and says so, until `adoptCommand` is run.
 */
export function toolHomeDecision(harness, { signIn = 'unknown', hostSignIn = 'unknown', adopted = false, choice = null } = {}) {
  const row = toolHomeFor(harness);
  if (!row.routable) return { containment: 'unsupported', reason: row.reason };
  // The soul's recorded choice (#617) decides before any sign-in file.
  if (choice === 'soul') return { containment: 'soul', reason: null };
  if (choice === 'global') return { containment: 'shared-host', reason: `the soul is set to use the global ${row.harness} install and its host store` };
  if (signIn === 'present' || adopted === true || hostSignIn === 'missing') return { containment: 'soul', reason: null };
  if (hostSignIn === 'present') return { containment: 'shared-host', reason: `the host store holds ${row.harness}'s sign-in and the soul's tool home does not; the launch keeps the host store until the owner adopts it` };
  return { containment: 'shared-host', reason: `the host may hold ${row.harness}'s sign-in where no file shows it (${row.note ?? 'a keychain'}); the launch keeps the host store until the owner adopts it` };
}

/** The host's store for a harness, as the host would resolve it (its sign-in route's directory). */
export function hostToolStore(harness, { env = {}, home } = {}) {
  const row = toolHomeFor(harness);
  const signIn = row.files.find((file) => file.kind === 'sign-in');
  const route = row.routes.find((entry) => entry.env === signIn?.route) ?? row.routes[0];
  if (!route) return null;
  const base = hostBase(route.host, { env, home });
  return route.app ? path.join(base, route.app) : base;
}

/**
 * The files adoption copies for a harness: `{ kind, path, route, soulPath,
 * hostPath }` each, soul side under the tool home, host side as the host
 * resolves it. Paths only; nothing is read.
 */
export function toolHomeFiles(soulDir, harness, { env = {}, home } = {}) {
  const row = toolHomeFor(harness);
  return row.files.map((file) => {
    const route = row.routes.find((entry) => entry.env === file.route);
    return { kind: file.kind, path: file.path, route: file.route,
      soulPath: path.join(routeDir(soulDir, row.harness, route), file.path),
      hostPath: path.join(hostBase(file.host ?? route.host, { env, home }), file.path) };
  });
}

export const adoptCommand = (agentId, harness = null) => `agent-bot soul env migrate ${agentId} --adopt-host-signin${harness ? ` --harness ${harness}` : ''}`;
export const adoptStepId = (harness) => `adopt-host-signin:${harness}`;

/**
 * A soul's tool-homes record (#617), checked: `{ schemaVersion, harnesses }`
 * with one `soul | global` entry per routable harness. Anything else is a
 * coded `tool-home-record-invalid`: a launch never guesses where a
 * harness's sign-in and sessions live.
 */
export function normalizeToolHomeRecord(value) {
  const invalid = (why) => { throw Object.assign(new Error(`the soul's tool-homes record is invalid: ${why}; fix or remove .soul-state/tool-homes.json`), { code: 'tool-home-record-invalid' }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('not an object');
  if (value.schemaVersion !== TOOL_HOMES_SCHEMA_VERSION) invalid(`schemaVersion ${JSON.stringify(value.schemaVersion)} is not ${TOOL_HOMES_SCHEMA_VERSION}`);
  const entries = value.harnesses;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) invalid('harnesses must be an object');
  const harnesses = {};
  for (const [harness, choice] of Object.entries(entries)) {
    if (!Object.hasOwn(TOOL_HOME_REGISTRY, harness) || !TOOL_HOME_REGISTRY[harness].routable) invalid(`${JSON.stringify(harness)} is not a routable harness`);
    if (!TOOL_HOME_CHOICES.includes(choice)) invalid(`${harness} must be one of ${TOOL_HOME_CHOICES.join(', ')}`);
    harnesses[harness] = choice;
  }
  return { schemaVersion: TOOL_HOMES_SCHEMA_VERSION, harnesses };
}

/** The record a soul born managed starts with: its own tool home for each default harness. */
export const newSoulToolHomeRecord = () => ({ schemaVersion: TOOL_HOMES_SCHEMA_VERSION, harnesses: Object.fromEntries(SOUL_DEFAULT_HARNESSES.map((harness) => [harness, 'soul'])) });
