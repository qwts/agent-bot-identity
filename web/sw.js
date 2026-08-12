// agent-bot UI service worker: a minimal offline shell, nothing more.
//
// Only the static shell (index, script, style, manifest, icon) is ever
// cached. API responses are never cached and never served from cache — the
// browser is a projection of the daemon, not a replica of it, and no daemon
// state or token may persist in browser storage. Offline, the cached shell
// loads and the page itself reports "daemon unreachable" when its API calls
// fail.

const CACHE = 'agent-bot-ui-v1';
const SHELL = ['/ui/', '/ui/app.js', '/ui/style.css', '/ui/manifest.webmanifest', '/ui/icon.svg'];

// Everything under /ui/api plus the pairing endpoints is daemon state or
// authentication. These requests always go to the network and their
// responses are never cached.
function isApiRequest(url) {
  return url.pathname.startsWith('/ui/api')
    || url.pathname === '/ui/session'
    || url.pathname === '/ui/pair';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || isApiRequest(url) || event.request.method !== 'GET') {
    // API and non-GET traffic: straight to the network, never cached.
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('/ui/');
          if (shell) return shell;
        }
        return new Response('daemon unreachable', { status: 503, headers: { 'content-type': 'text/plain' } });
      }),
  );
});
