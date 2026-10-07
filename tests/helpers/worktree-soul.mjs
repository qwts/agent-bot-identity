import { mintAgentIdentity, stateDirectory } from '../../agent-identity.mjs';
import { upsertSoul, populationFile, displayName } from '../../agent-population.mjs';
import { linkWorktree } from '../../soul-worktrees.mjs';
import { join } from 'node:path';

// Explicitly establish the session before exercising setup; setup never mints
// an identity from a checkout pin or from its location.
export function worktreeSoul(env, checkout = null, { harness = 'codex', appSlug = null, transcript = null, parentId = null } = {}) {
  const options = { env, home: env.HOME, config: {}, file: populationFile({ env, home: env.HOME }) };
  const identity = mintAgentIdentity({ ...options, stateDir: stateDirectory(options), harness, appSlug, transcript, parentId, useGithub: Boolean(appSlug) });
  upsertSoul({ id: identity.id, name: displayName(identity.id), harness, status: 'active', appSlug,
    spacePath: join(env.AGENT_BOT_SPACES_HOME ?? join(env.HOME, 'spaces'), identity.id) }, options);
  if (checkout) linkWorktree(identity.id, checkout, options);
  env.AGENT_BOT_ID = identity.id;
  return { identity, options };
}
