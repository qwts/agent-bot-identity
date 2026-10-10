// agent-bot skill agent-bot --for <subcommand> (#226): the static, reviewable
// table from each agent-bot subcommand to the one reference file under
// skills/agent-bot/references/ that covers it. It replaces the SKILL.md's
// prose routing ("Read operations.md for ...") with a lookup. It is not a
// need-to-skill index: a subcommand the agent is about to run is the key, and
// an unknown key is an error, never a nearest match.
//
// tests/skill-catalog.test.mjs fails when a command in cli/dispatch.mjs or
// cli/parse.mjs is in neither table, so the two cannot drift silently.

export const SKILL_REFERENCES = Object.freeze({
  bootstrap: 'operations.md',
  'setup-worktree': 'operations.md',
  'mint-token': 'operations.md',
  doctor: 'operations.md',
  install: 'operations.md',
  'install-gh-shim': 'operations.md',
  'ensure-private-key': 'operations.md',
  secret: 'operations.md',
  daemon: 'operations.md',
  'signed-commit': 'verified-publish.md',
  identity: 'execution-identities.md',
  binding: 'execution-identities.md',
  population: 'execution-identities.md',
  soul: 'execution-identities.md',
  wake: 'execution-identities.md',
  space: 'storage-surfaces.md',
});

// Commands no reference file covers. SKILL.md itself (join, approvals,
// sandbox), docs/, or the command's own --help is the guidance; internal
// commands are run by hooks and harness configs, not by an agent.
export const NO_SKILL_REFERENCE = Object.freeze([
  'join', 'principal', 'harness', 'keyd', 'owner', 'approvals', 'audit', 'mcp',
  'reach-mcp', 'web', 'telegram', 'update', 'skill', 'sop', 'sandbox', 'metrics',
  'credential', 'worktree-token', 'gh-inbox-query', 'gh-pr-view-json',
  'claude-worktree-create', 'agent-hook', 'hook',
]);

export function skillReferenceFor(subcommand) {
  return Object.hasOwn(SKILL_REFERENCES, subcommand) ? SKILL_REFERENCES[subcommand] : null;
}
