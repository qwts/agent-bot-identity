// Stateful GitHub API stub for gist handoff tests: serves the App token mint
// endpoints plus /gists create/fetch, and exposes GET /__state so tests can
// assert which routes were hit without parsing server logs. Runs as its own
// process because spawnSync blocks the test runner's event loop.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function startMockGistGitHub(root, mode = 'ok') {
  const portFile = join(root, `gist-github-port-${process.pid}-${Date.now()}-${mode}`);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), portFile, mode], {
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5_000;
  let port;
  do {
    port = existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '';
    if (/^\d+$/.test(port)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  } while (Date.now() < deadline);
  if (!/^\d+$/.test(port)) {
    child.kill();
    throw new Error('mock gist GitHub server did not start');
  }
  const apiBase = `http://127.0.0.1:${port}`;
  return {
    apiBase,
    state: async () => (await fetch(`${apiBase}/__state`)).json(),
    stop: () => child.kill(),
  };
}

function serve(portFile, mode) {
  const gists = new Map();
  const hits = [];
  let nextGistId = 'abc123DEF456';
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const respond = (status, payload) => {
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      };
      if (request.url === '/__state') {
        respond(200, { hits, gists: Object.fromEntries(gists) });
        return;
      }
      hits.push(`${request.method} ${request.url}`);
      if (request.method === 'GET' && request.url === '/app/installations') {
        if (mode === 'fail-mint') {
          respond(500, { message: 'installation lookup unavailable' });
          return;
        }
        respond(200, [{ id: 31, account: { login: 'you' } }]);
        return;
      }
      if (request.method === 'POST' && request.url === '/app/installations/31/access_tokens') {
        respond(201, { token: 'installation-token-sentinel', expires_at: '2099-01-01T00:00:00Z' });
        return;
      }
      if (request.method === 'POST' && request.url === '/gists') {
        if (mode === 'refuse-gists') {
          respond(404, { message: 'Not Found' });
          return;
        }
        if (request.headers.authorization !== 'Bearer installation-token-sentinel') {
          respond(401, { message: 'Bad credentials' });
          return;
        }
        const id = nextGistId;
        nextGistId = `${nextGistId}0`;
        gists.set(id, JSON.parse(body));
        respond(201, { id, html_url: `https://gist.github.com/you/${id}` });
        return;
      }
      const gist = request.url.match(/^\/gists\/([A-Za-z0-9]+)$/);
      if (gist && request.method === 'GET') {
        const stored = gists.get(gist[1]);
        if (!stored) {
          respond(404, { message: 'Not Found' });
          return;
        }
        const files = {};
        for (const [name, file] of Object.entries(stored.files)) {
          files[name] = { filename: name, content: file.content, truncated: false };
        }
        respond(200, { id: gist[1], files });
        return;
      }
      respond(404, { message: 'unhandled route' });
    });
  });
  server.listen(0, '127.0.0.1', () => {
    // Write-then-rename: the parent polls for this file, and open+write is not
    // atomic — it must never observe an empty or partially written port.
    writeFileSync(`${portFile}.tmp`, String(server.address().port), { flag: 'wx' });
    renameSync(`${portFile}.tmp`, portFile);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(process.argv[2], process.argv[3] ?? 'ok');
}
