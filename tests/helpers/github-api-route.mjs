// Test-only. App JWTs go only to https://api.github.com (#1062), so a test
// reaches its local GitHub by rerouting that origin to a loopback mock inside
// the process under test. Production code has no such seam: the reroute lives
// here, and a subprocess gets it only through the --import this file names.
export const GITHUB_API = 'https://api.github.com';
const ROUTE_ENV = 'GITHUB_API_TEST_ROUTE';

// Sends this process's fetches for GITHUB_API to `target` (an http://127.0.0.1
// mock). Returns a function that restores the original fetch.
export function routeGitHubApi(target) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === GITHUB_API || url.startsWith(`${GITHUB_API}/`)) {
      return original(target + url.slice(GITHUB_API.length), init);
    }
    return original(input, init);
  };
  return () => { globalThis.fetch = original; };
}

// Environment for a child node process (directly or under a shell) that
// should see the same reroute.
export function githubApiRouteEnv(target, env = {}) {
  const preload = `--import=${new URL('./github-api-route-preload.mjs', import.meta.url).href}`;
  return { NODE_OPTIONS: [env.NODE_OPTIONS, preload].filter(Boolean).join(' '), [ROUTE_ENV]: target };
}
