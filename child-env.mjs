// Minimal inherited environment for processes that run agent-controlled code
// or third-party installers. Deliberately exclude arbitrary parent credentials,
// SSH_AUTH_SOCK, cloud tokens, NODE_OPTIONS, and provider keys. Explicit
// per-soul grants are applied only after this boundary.
const CHILD_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR',
  'FORCE_COLOR', 'TZ', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'XDG_STATE_HOME', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
]);

export function minimalChildEnv(source = {}) {
  return Object.fromEntries(Object.entries(source).filter(
    ([name, value]) => CHILD_KEYS.has(name) && typeof value === 'string',
  ));
}
