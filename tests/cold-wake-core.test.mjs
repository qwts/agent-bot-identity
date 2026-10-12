import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { coldWakeCommand, coldWakeFile, readColdWakeSettings, readColdWakeSnapshot, setColdWake, setColdWakeWebhook } from '../cold-wake-settings.mjs';
import { createColdWaker } from '../cold-wake.mjs';
import { createWebhookWaker, readWebhook, saveWebhook, webhookFile } from '../wake-webhook.mjs';
import { readWebhookLocked } from '../wake-webhook-store.mjs';
import { withColdWakeLock } from '../cold-wake-lock.mjs';

const ID = 'agent_33433433-3343-4343-8343-334334334334';
const FIRST = { url: 'https://hooks.example.com/first-secret-path', key: 'synthetic-first-key' };
const NEXT = { url: 'https://hooks.example.com/next-secret-path', key: 'synthetic-next-key' };
const settingsUrl = new URL('../cold-wake-settings.mjs', import.meta.url).href;
const webhookUrl = new URL('../wake-webhook.mjs', import.meta.url).href;
function state(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'cold-core-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env: { ...process.env, XDG_STATE_HOME: path.join(root, 'state'), HOME: root } };
}
// Every child has its own bounded timeout/output and awaited cleanup, including
// assertion failure while the child is deliberately held inside a lock.
function child(t, source, env) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', source], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '', overflow = false;
  const timer = setTimeout(() => proc.kill('SIGKILL'), 12_000);
  const closed = new Promise((resolve) => proc.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }));
  for (const [stream, collect] of [[proc.stdout, text => { stdout += text; }], [proc.stderr, text => { stderr += text; }]]) {
    stream.on('data', data => { collect(String(data)); if (stdout.length + stderr.length > 32_768) { overflow = true; proc.kill('SIGKILL'); } });
  }
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await closed; });
  return { proc, closed, result: async () => {
    const exit = await closed;
    assert.equal(overflow, false, 'child output exceeded limit');
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    return JSON.parse(stdout);
  } };
}
function paused(t, process) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('writer did not reach publication barrier')), 5000);
    process.once('message', message => { clearTimeout(timer); resolve(message); });
    t.after(() => clearTimeout(timer));
  });
}

test('composite setting and secret preserve public access and invalidate escaped lock tokens', t => {
  const { env } = state(t);
  assert.deepEqual(setColdWakeWebhook(ID, FIRST, { env }), { host: 'hooks.example.com' });
  assert.deepEqual(readColdWakeSnapshot(ID, { env }), { setting: { lane: 'webhook' }, webhook: FIRST });
  let escaped;
  withColdWakeLock({ env }, context => { escaped = context; assert.deepEqual(readWebhookLocked(ID, context), FIRST); });
  assert.throws(() => readWebhookLocked(ID, escaped), /requires its synchronous lock/);
  assert.throws(() => readWebhookLocked(ID, { options: { env } }), /requires its synchronous lock/);
  setColdWake(ID, false, { env });
  assert.deepEqual(readColdWakeSnapshot(ID, { env }), { setting: false, webhook: null });
  assert.equal(readWebhook(ID, { env }), null);
  // Existing standalone writer remains a secret-only API, under the same lock.
  saveWebhook(ID, FIRST, { env });
  assert.deepEqual(readWebhook(ID, { env }), FIRST);
  assert.equal(readColdWakeSnapshot(ID, { env }).webhook, null);
});

for (const mode of ['replace-webhook', 'disable']) test(`coherent snapshot waits for ${mode} composite publication`, async t => {
  const { env, root } = state(t);
  setColdWakeWebhook(ID, FIRST, { env });
  const release = path.join(root, 'release');
  const source = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (${JSON.stringify(mode)} === 'replace-webhook' ? to.includes('/webhooks/') : to.endsWith('/cold-wake.json')) {
        process.send('published'); const end = Date.now() + 7000;
        while (!fs.existsSync(${JSON.stringify(release)})) {
          if (Date.now() >= end) throw new Error('barrier timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    }; syncBuiltinESMExports();
    const m = await import(${JSON.stringify(settingsUrl)});
    ${mode === 'replace-webhook' ? `m.setColdWakeWebhook(${JSON.stringify(ID)}, ${JSON.stringify(NEXT)});` : `m.setColdWake(${JSON.stringify(ID)}, false);`}
    console.log(JSON.stringify({ done: true }));`;
  const writer = child(t, source, env);
  assert.equal(await paused(t, writer.proc), 'published');
  const reader = child(t, `const m = await import(${JSON.stringify(settingsUrl)}); process.send('reading'); console.log(JSON.stringify(m.readColdWakeSnapshot(${JSON.stringify(ID)})));`, env);
  assert.equal(await paused(t, reader.proc), 'reading');
  let readerFinished = false;
  reader.closed.then(() => { readerFinished = true; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(readerFinished, false, 'reader crossed the writer lock');
  writeFileSync(release, 'go');
  assert.deepEqual(await writer.result(), { done: true });
  assert.deepEqual(await reader.result(), mode === 'replace-webhook' ? { setting: { lane: 'webhook' }, webhook: NEXT } : { setting: false, webhook: null });
});

for (const phase of ['secret-file', 'secret-directory', 'settings-file', 'settings-directory', 'removal-directory']) {
  test(`fsync failure at ${phase} reports failure without a false composite success`, async t => {
    if (process.platform === 'win32' && phase.includes('directory')) return t.skip('POSIX directory durability only');
    const { env } = state(t);
    if (phase === 'removal-directory') setColdWakeWebhook(ID, FIRST, { env });
    else setColdWake(ID, false, { env });
    const source = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const opens = new Map(), open = fs.openSync, sync = fs.fsyncSync, rename = fs.renameSync; let injected = false, settingsPublished = false;
      fs.renameSync = (from, to) => { rename(from, to); if (String(to).endsWith('/cold-wake.json')) settingsPublished = true; };
      fs.openSync = (file, ...args) => { const fd = open(file, ...args); opens.set(fd, String(file)); return fd; };
      fs.fsyncSync = fd => { const file = opens.get(fd) ?? ''; const phase = ${JSON.stringify(phase)};
        const hit = phase === 'secret-file' ? /webhooks\\/.*\\.tmp$/.test(file)
          : phase === 'secret-directory' || phase === 'removal-directory' ? file.endsWith('/webhooks')
          : phase === 'settings-file' ? /cold-wake\\.json\\..*\\.tmp$/.test(file)
          : settingsPublished && file.endsWith('/agent-bot');
        if (hit && !injected) { injected = true; throw new Error('synthetic-next-key next-secret-path'); }
        return sync(fd);
      }; syncBuiltinESMExports(); const m = await import(${JSON.stringify(settingsUrl)});
      let error; try { ${phase === 'removal-directory' ? `m.setColdWake(${JSON.stringify(ID)}, false);` : `m.setColdWakeWebhook(${JSON.stringify(ID)}, ${JSON.stringify(NEXT)});`} }
      catch (caught) { error = { code: caught.code, message: caught.message }; }
      console.log(JSON.stringify({ injected, error }));`;
    const result = await child(t, source, env).result();
    assert.equal(result.injected, true);
    assert.ok(result.error);
    assert.equal(result.error.code, phase === 'secret-file' ? 'cold-wake-storage-failed' : 'cold-wake-publication-uncertain');
    assert.doesNotMatch(result.error.message, /synthetic-next-key|next-secret-path/);
    const snapshot = readColdWakeSnapshot(ID, { env });
    if (phase === 'secret-file' || phase === 'secret-directory' || phase === 'settings-file') assert.equal(snapshot.setting, false);
    if (phase === 'settings-directory') assert.deepEqual(snapshot, { setting: { lane: 'webhook' }, webhook: NEXT });
    if (phase === 'removal-directory') assert.deepEqual(snapshot, { setting: false, webhook: null });
    assert.equal(existsSync(`${coldWakeFile({ env })}.lock`), false);
  });
}

test('daemon composition uses saved setting and webhook before an asynchronous binding race', async t => {
  const { env } = state(t);
  setColdWakeWebhook(ID, FIRST, { env });
  const calls = [];
  const webhook = createWebhookWaker({ read: () => { throw new Error('must use selected configuration'); }, fetchImpl: async (url, init) => { calls.push({ url, key: init.headers.authorization }); return { status: 200 }; } });
  const cold = createColdWaker({
    snapshot: id => readColdWakeSnapshot(id, { env }),
    executor: () => { throw new Error('unexpected executor'); },
    lookupBinding: async () => { setColdWakeWebhook(ID, NEXT, { env }); return { worktree: '/synthetic/worktree' }; },
    identities: () => { throw new Error('unexpected identity lookup'); }, receipt: () => {}, webhook,
  });
  assert.equal((await cold({ agentId: ID })).outcome, 'cold');
  assert.deepEqual(calls, [{ url: FIRST.url, key: `Bearer ${FIRST.key}` }]);
  assert.deepEqual(readColdWakeSnapshot(ID, { env }).webhook, NEXT);
});

test('no-state reads retain empty results while creating only the common lock directories', t => {
  const { env } = state(t);
  assert.deepEqual(readColdWakeSettings({ env }), {});
  assert.deepEqual(readColdWakeSnapshot(ID, { env }), { setting: undefined, webhook: null });
  assert.equal(readWebhook(ID, { env }), null);
  assert.equal(existsSync(coldWakeFile({ env })), false);
  assert.equal(existsSync(`${coldWakeFile({ env })}.lock`), false);
});

test('settings lock timeout refuses with a fixed non-secret message', t => {
  const { env } = state(t);
  setColdWakeWebhook(ID, FIRST, { env });
  const lock = `${coldWakeFile({ env })}.lock`;
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner'), `${process.pid}.synthetic-owner`);
  assert.throws(() => readColdWakeSnapshot(ID, { env }), error => {
    assert.equal(error.message, 'timed out waiting for cold wake settings');
    assert.doesNotMatch(error.message, /synthetic-first-key|first-secret-path/);
    return true;
  });
});

test('JSON show remains setting-only when the stored webhook is malformed', async t => {
  const { env, root } = state(t);
  setColdWakeWebhook(ID, FIRST, { env });
  writeFileSync(webhookFile(ID, { env }), '{invalid-json');
  const output = [];
  await coldWakeCommand([ID, 'show', '--json'], { env: { ...env, GH_AGENT_APP: '' }, home: root, cwd: root, write: text => output.push(text) });
  assert.deepEqual(JSON.parse(output.join('')), { agentId: ID, setting: 'webhook', policy: null, lane: 'webhook' });
});
