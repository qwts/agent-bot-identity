// The daemon's route registry (HQ plan Stage 0 row 8, #1392). Each route
// source registers its routes with an explicit auth class per route, and the
// daemon composes the sources: it reads each route's class from here for its
// bearer and soul-binding checks, then dispatches here. This is the in-place
// seam for plugin registration in HQ (plan §4.2, `ctx.hq.register({ op, auth,
// schema, handler })`): a source declares, and the host owns dispatch and
// auth. A source receives no registry and imports nothing from this file, so
// identity and soul gain no import (ADR-0645).
//
// A registration is { module, routes, handle, prefix? }:
//
// - module: the source's name, used in refusals.
// - routes: route table name -> declaration. The name is `METHOD /path`, as
//   docs/daemon-api.md writes it. A `{id}` segment matches any one segment.
//   An `{action}` segment matches the declaration's `actions`: a list, or a
//   pattern when the family takes any action. A declaration is:
//     auth     one of ROUTE_AUTH, the classes in docs/daemon-api.md;
//     bearer   false when the daemon does not check the bearer. Only a
//              binding route can say so, and a binding route without it
//              still takes the bearer;
//     receipt  the audit event a refused soul binding is recorded under on
//              an owner route (the daemon's default is owner-route);
//     actions  required with `{action}`, refused without it.
// - handle(route, req, res, url): called for a request that matches one of
//   the source's routes, or falls under its prefix. `route` is the concrete
//   `METHOD /path`. Answering false means it did not handle the request.
// - prefix: an optional path the source answers in full, including paths it
//   declares no route for. A prefix that ends in `/` claims every path that
//   starts with it. Any other prefix claims itself and the paths below it.
//
// A source's prefix wins over a declared route, and no other source may
// declare a route under it or a prefix overlapping it. A route has exactly
// one source, so the order of registration never changes who answers.
// `close()` ends registration, as HQ closes it after init (§4.4).

export const ROUTE_AUTH = Object.freeze(['owner', 'owner-credential', 'bearer', 'binding', 'principal']);

const MODULE = /^[a-z0-9-]{1,64}$/;
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) (\/[^\s?#]*)$/;
const RECEIPT = /^[a-z][a-z-]{0,63}$/;
const ACTION = /^[a-z][a-z-]*$/;
const KEYS = new Set(['auth', 'bearer', 'receipt', 'actions']);

function refuse(message) {
  throw Object.assign(new Error(`route registry: ${message}`), { code: 'route-registry-invalid' });
}

function claims(prefix, pathname) {
  return prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The template's path as a pattern: {id} is one segment, {action} one
// segment of lowercase letters and hyphens, checked against the declaration
// afterwards.
function compile(pathname) {
  const source = pathname.split(/(\{id\}|\{action\})/).map((part) => {
    if (part === '{id}') return '[^/]+';
    if (part === '{action}') return '([a-z-]+)';
    return escape(part);
  }).join('');
  return new RegExp(`^${source}$`);
}

function declaration(module, route, value) {
  const [, method, pathname] = ROUTE.exec(route) ?? refuse(`${module}: ${JSON.stringify(route)} is not METHOD /path`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`${module}: ${route} needs a declaration`);
  for (const key of Object.keys(value)) if (!KEYS.has(key)) refuse(`${module}: ${route} has an unknown field ${key}`);
  const { auth, bearer, receipt, actions } = value;
  if (!ROUTE_AUTH.includes(auth)) refuse(`${module}: ${route} needs an auth class, one of ${ROUTE_AUTH.join(', ')}`);
  if (bearer !== undefined && (bearer !== false || auth !== 'binding')) refuse(`${module}: ${route}: only a binding route can skip the bearer (bearer: false)`);
  if (receipt !== undefined && (!['owner', 'owner-credential'].includes(auth) || typeof receipt !== 'string' || !RECEIPT.test(receipt))) {
    refuse(`${module}: ${route}: a receipt names an audit event, on an owner route only`);
  }
  const segments = pathname.split('/');
  if (segments.filter((segment) => segment === '{action}').length > 1) refuse(`${module}: ${route}: one {action} at most`);
  const family = segments.includes('{action}');
  if (family !== (actions !== undefined)) refuse(`${module}: ${route}: actions go with an {action} segment, and only with one`);
  if (family && !(actions instanceof RegExp)
    && !(Array.isArray(actions) && actions.length && actions.every((action) => typeof action === 'string' && ACTION.test(action)))) {
    refuse(`${module}: ${route}: actions is a list of actions or a pattern`);
  }
  const template = family || segments.includes('{id}');
  return Object.freeze({
    route, method, pathname, auth, module,
    bearer: bearer !== false,
    ...(receipt ? { receipt } : {}),
    ...(template ? { pattern: compile(pathname) } : {}),
    ...(family ? { actions: Array.isArray(actions) ? Object.freeze([...actions]) : actions } : {}),
  });
}

function admits(entry, method, pathname) {
  if (entry.method !== method) return false;
  if (!entry.pattern) return entry.pathname === pathname;
  const match = entry.pattern.exec(pathname);
  if (!match) return false;
  if (!entry.actions) return true;
  return Array.isArray(entry.actions) ? entry.actions.includes(match[1]) : entry.actions.test(match[1]);
}

export function createRouteRegistry() {
  const sources = [];
  const entries = [];
  let closed = false;

  function register({ module, routes, handle, prefix, ...rest } = {}) {
    if (closed) refuse(`${module}: registration is closed`);
    if (typeof module !== 'string' || !MODULE.test(module)) refuse(`module ${JSON.stringify(module)} must match ${MODULE}`);
    if (Object.keys(rest).length) refuse(`${module}: unknown registration field ${Object.keys(rest)[0]}`);
    if (sources.some((source) => source.module === module)) refuse(`${module} is already registered`);
    if (typeof handle !== 'function') refuse(`${module}: handle must be a function`);
    if (prefix !== undefined && (typeof prefix !== 'string' || !prefix.startsWith('/') || prefix === '/')) refuse(`${module}: prefix must be a path below /`);
    if (!routes || typeof routes !== 'object' || !Object.keys(routes).length) refuse(`${module}: declare at least one route`);
    const declared = Object.entries(routes).map(([route, value]) => declaration(module, route, value));
    for (const entry of declared) {
      const owner = entries.find((other) => other.route === entry.route);
      if (owner) refuse(`${entry.route} is already registered by ${owner.module}`);
      if (prefix !== undefined && !claims(prefix, entry.pathname)) refuse(`${module}: ${entry.route} is outside its prefix ${prefix}`);
      const mount = sources.find((source) => source.prefix !== undefined && claims(source.prefix, entry.pathname));
      if (mount) refuse(`${module}: ${entry.route} is under ${mount.module}'s prefix ${mount.prefix}`);
    }
    if (prefix !== undefined) {
      const overlap = sources.find((source) => (source.prefix !== undefined && (claims(source.prefix, prefix) || claims(prefix, source.prefix)))
        || entries.some((entry) => entry.module === source.module && claims(prefix, entry.pathname)));
      if (overlap) refuse(`${module}: prefix ${prefix} overlaps ${overlap.module}`);
    }
    sources.push(Object.freeze({ module, handle, ...(prefix !== undefined ? { prefix } : {}) }));
    entries.push(...declared);
  }

  // The declaration a request falls under, or null. A literal route wins
  // over a template; templates are tried in registration order.
  function match(method, pathname) {
    return entries.find((entry) => !entry.pattern && admits(entry, method, pathname))
      ?? entries.find((entry) => entry.pattern && admits(entry, method, pathname))
      ?? null;
  }

  // Hands the request to the source that owns it: the one whose prefix claims
  // the path, else the one that declared the route. False when none does, or
  // the source answered false.
  async function dispatch(req, res, url) {
    const pathname = url.pathname;
    const owner = sources.find((source) => source.prefix !== undefined && claims(source.prefix, pathname))
      ?? sources.find((source) => source.module === match(req.method, pathname)?.module);
    if (!owner) return false;
    return (await owner.handle(`${req.method} ${pathname}`, req, res, url)) !== false;
  }

  // Route table name -> auth class, in registration order.
  function table() {
    return Object.fromEntries(entries.map((entry) => [entry.route, entry.auth]));
  }

  return Object.freeze({
    register,
    match,
    dispatch,
    table,
    entries: () => [...entries],
    close() { closed = true; },
  });
}
