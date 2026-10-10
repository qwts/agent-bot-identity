// Minimal inherited environment for processes that run agent-controlled code
// or third-party installers. Deliberately exclude arbitrary parent credentials,
// SSH_AUTH_SOCK, cloud tokens, NODE_OPTIONS, and provider keys. Explicit
// per-soul grants are applied only after this boundary.
const CHILD_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'ZDOTDIR',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR',
  'FORCE_COLOR', 'TZ', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'XDG_STATE_HOME', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
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

export function minimalChildEnv(source = {}) {
  return Object.fromEntries(Object.entries(source).filter(
    ([name, value]) => typeof value === 'string'
      && (CHILD_KEYS.has(name) || (OWN_PREFIX.test(name) && !SECRET_NAME.test(name))),
  ));
}
