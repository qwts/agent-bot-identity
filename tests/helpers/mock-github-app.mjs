import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MOCK_BOT_UID = '700001';

export function startMockGitHubApp(root) {
  const portFile = join(root, `github-app-port-${process.pid}-${Date.now()}`);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), portFile], {
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5_000;
  while (!existsSync(portFile) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!existsSync(portFile)) {
    child.kill();
    throw new Error('mock GitHub App server did not start');
  }
  const port = readFileSync(portFile, 'utf8').trim();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    apiBase: `http://127.0.0.1:${port}`,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    stop: () => child.kill(),
  };
}

function serve(portFile) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/app/installations') {
      response.end(JSON.stringify([{ id: 1, account: { login: 'test-owner' } }]));
      return;
    }
    if (request.method === 'POST' && request.url === '/app/installations/1/access_tokens') {
      response.end(JSON.stringify({
        token: 'fixture-token-never-logged',
        expires_at: '2099-01-01T00:00:00Z',
      }));
      return;
    }
    // Bot user lookup used by setup-worktree to derive the noreply author
    // email. The fixture id is deliberately stable so tests can assert the
    // exact attribution written into the worktree.
    if (request.method === 'GET' && request.url.startsWith('/users/')) {
      response.end(JSON.stringify({
        id: 700001,
        avatar_url: 'https://avatars.example/u/700001',
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'not found' }));
  });
  server.listen(0, '127.0.0.1', () => {
    writeFileSync(portFile, String(server.address().port), { flag: 'wx' });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(process.argv[2]);
}
