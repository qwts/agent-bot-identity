import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { legacyPowerShellEnv } from '../windows-account-custody.mjs';
import { windowsTaskJobArguments } from '../windows-task-job.mjs';

async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('terminating the task wrapper kills its child tree and leaves an unrelated process alive',
  { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agent task's space "));
    const marker = path.join(root, 'processes.json');
    const script = path.join(root, 'child.mjs');
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
    let wrapper;
    let pids;
    let failure;
    try {
      writeFileSync(script, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true});
writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
      const command = `/S /C ""${process.execPath}" "${script}""`;
      const encoded = windowsTaskJobArguments(command).split(' ').at(-1);
      wrapper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, env: legacyPowerShellEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      wrapper.stderr.on('data', bytes => { stderr += bytes; });
      await until(() => { try { pids = JSON.parse(readFileSync(marker, 'utf8')); return pids.length === 2; } catch { return false; } },
        `job child did not start: ${stderr}`);
      assert.ok(pids.every(alive));
      wrapper.kill(); // Only the wrapper; job closure must terminate descendants.
      await until(() => pids.every(pid => !alive(pid)), 'job descendants survived wrapper termination');
      assert.equal(alive(sentinel.pid), true);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      wrapper?.kill();
      sentinel.kill();
      // Do not scan or kill PIDs from the marker on failure; preserve the failure.
      try { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
      catch (error) { if (!failure) throw error; }
    }
  });
