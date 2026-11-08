// Soul's daemon routes (#645, F9 step 3; owner decision D6). POST
// /v0/register records a soul's space and worktree in the population census
// for setup-worktree and join. agent-daemon.mjs keeps the server and its
// auth (the route stays bearer-only, docs/daemon-api.md); the request helpers
// come in as ports. createSoulRoutes returns soul's registration for the
// daemon's route registry (route-registry.mjs, HQ plan Stage 0 row 8): its
// route with the auth class, and handleSoulRoute, which answers true when it
// handled the route and false when the route is not soul's.

import path from 'node:path';

import { upsertIdentitySoul } from './agent-population.mjs';
import { stateDirectory } from './state-paths.mjs';

// Soul's route and its class (docs/daemon-api.md).
const SOUL_ROUTES = Object.freeze({
  'POST /v0/register': { auth: 'bearer' },
});

export function createSoulRoutes({
  env, home,
  readBody, parseJsonBody, sendJson,
  requireAgentId, populationOverride,
}) {
  async function handleSoulRoute(route, req, res) {
    switch (route) {
      case 'POST /v0/register': {
        const body = parseJsonBody(await readBody(req));
        const id = requireAgentId(body.agentId);
        if (typeof body.spacePath !== 'string' || !path.isAbsolute(body.spacePath)) {
          throw Object.assign(new Error('spacePath must be an absolute path'), { statusCode: 400 });
        }
        let worktree;
        if (body.worktree !== undefined && body.worktree !== null) {
          if (typeof body.worktree !== 'string' || !path.isAbsolute(body.worktree)) {
            throw Object.assign(new Error('worktree must be an absolute path'), { statusCode: 400 });
          }
          worktree = body.worktree;
        }
        // `sighted` comes from setup-worktree and its hooks, a live
        // session; a join or repair registers without it (#109).
        const soul = upsertIdentitySoul(id, body.spacePath, {
          file: populationOverride(env, home),
          stateDir: stateDirectory({ env, home }),
          worktree,
          sighted: body.sighted === true,
        });
        sendJson(res, 200, { soul });
        return true;
      }
      default:
        return false;
    }
  }

  return { module: 'soul', routes: SOUL_ROUTES, handle: handleSoulRoute };
}
