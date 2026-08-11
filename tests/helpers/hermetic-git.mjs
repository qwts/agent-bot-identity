// Hermetic Git environments for test fixtures.
//
// Agent containers and developer machines inject Git state that a fixture
// never asked for: GIT_CONFIG_COUNT/GIT_CONFIG_KEY_*/GIT_CONFIG_VALUE_*
// command-scope pairs (e.g. url.….insteadOf rewrites that turn a fixture's
// SSH remote into HTTPS), GIT_DIR-style repository overrides, author/committer
// overrides, and a real global config (signing keys, identity). Any of those
// can change what a subprocess reads back from a private temporary repo, so a
// fixture that spreads `...process.env` is only isolated until the host
// environment disagrees with it.

const AMBIENT_GIT_RE = new RegExp(
  '^GIT_(?:CONFIG(?:_|$)|DIR$|WORK_TREE$|COMMON_DIR$|INDEX_FILE$|NAMESPACE$'
  + '|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|CEILING_DIRECTORIES$'
  + '|AUTHOR_|COMMITTER_)',
);

// Strip every ambient Git override from `base`, disable the system config,
// then apply the fixture's own overrides (a fixture that needs
// GIT_CONFIG_GLOBAL sets it explicitly via `overrides`).
export function hermeticGitEnv(base = process.env, overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!AMBIENT_GIT_RE.test(key)) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  return Object.assign(env, overrides);
}
