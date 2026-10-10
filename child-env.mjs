import process from 'node:process';

// Minimal inherited environment for processes that run agent-controlled code
// or third-party installers. Deliberately exclude arbitrary parent credentials,
// SSH_AUTH_SOCK, cloud tokens, NODE_OPTIONS, and provider keys. Explicit
// per-soul grants are applied only after this boundary.
const CHILD_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'ZDOTDIR',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR',
  'FORCE_COLOR', 'TZ', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'XDG_STATE_HOME', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  // Where a harness keeps its host store (paths, not secrets): a soul with
  // no tool home of its own signs in from there, as before (#583 slice 2).
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  // The network the host reaches the internet through: proxies (uv, curl
  // and Node read either case) and the CA bundles a TLS-inspecting proxy
  // needs. Installers and harness API calls fail behind one without them.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
]);

// agent-bot's own host configuration (the tool path, npm, service label,
// credential names, binding) reaches the reach server, keyd's relay and
// agent-comms through the turn env, so the namespace passes; a secret kept
// under it (AGENT_BOT_TELEGRAM_TOKEN) does not.
const OWN_PREFIX = /^(AGENT_BOT|QWTS)_/;
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD)$/;

// Windows names are case-insensitive and enumerate as `Path`, `SystemRoot`,
// `windir`: there a kept name is matched without case and written in the
// spelling above, so `env.PATH` reads it. POSIX stays exact.
const BY_UPPER = new Map([...CHILD_KEYS].map((name) => [name.toUpperCase(), name]));

export function minimalChildEnv(source = {}, { platform = process.platform } = {}) {
  const kept = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    const upper = name.toUpperCase();
    const own = platform === 'win32' ? upper : name;
    if (CHILD_KEYS.has(name)) kept[name] = value;
    else if (platform === 'win32' && BY_UPPER.has(upper)) kept[BY_UPPER.get(upper)] = value;
    else if (OWN_PREFIX.test(own) && !SECRET_NAME.test(own)) kept[platform === 'win32' ? upper : name] = value;
  }
  return kept;
}
