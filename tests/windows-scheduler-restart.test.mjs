// Opt-in real Task Scheduler regression for #954. The full daemon acceptance
// additionally verifies credential continuity and fresh broker wake reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { kickstartScheduledTask, renderScheduledTask, scheduledTaskBytes } from '../daemon-supervisor.mjs';

test('native scheduled refresh waits for termination and starts a different owned worker each time', {
  skip: process.platform !== 'win32' || process.env.AGENT_BOT_WINDOWS_SCHEDULER_TESTS !== '1', timeout: 180_000,
}, async () => {
  const root = mkdtempSync(path.join(process.env.LOCALAPPDATA, "agent-bot restart's "));
  const label = `test.agent-bot.restart.${randomUUID()}`;
  const worker = path.join(root, 'worker.mjs'), history = path.join(root, 'pids.jsonl'), unit = path.join(root, 'task.xml');
  const env = { ...process.env }; for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const command = args => execFileSync('schtasks.exe', args, { env, encoding: 'utf8', timeout: 20_000 });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const rows = () => existsSync(history) ? readFileSync(history, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const until = async predicate => { const deadline = Date.now() + 30_000; do { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline); assert.fail('native scheduler worker did not reach expected state'); };
  let primary;
  try {
    writeFileSync(worker, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(history)},JSON.stringify({pid:process.pid})+String.fromCharCode(10));setInterval(()=>{},1000);\n`);
    writeFileSync(unit, scheduledTaskBytes(renderScheduledTask({ programArguments: [process.execPath, worker], environment: {}, label, logPath: path.join(root, 'worker.log') })));
    command(['/Create', '/TN', label, '/XML', unit, '/F']); command(['/Run', '/TN', label]);
    await until(() => rows().length === 1);
    for (let index = 0; index < 3; index++) {
      const oldPid = rows().at(-1).pid;
      assert.equal(alive(oldPid), true);
      command(['/Create', '/TN', label, '/XML', unit, '/F']);
      await kickstartScheduledTask({ label }, { env, oldPid });
      assert.equal(alive(oldPid), false);
      await until(() => rows().length === index + 2);
      const newPid = rows().at(-1).pid;
      assert.notEqual(newPid, oldPid); assert.equal(alive(newPid), true);
    }
  } catch (error) { primary = error; }
  finally {
    try {
      try { command(['/End', '/TN', label]); } catch (error) { if (!/cannot find the file specified|not (?:currently )?running/i.test(`${error.stderr}`)) throw error; }
      await until(() => rows().every(row => !alive(row.pid)));
      command(['/Delete', '/TN', label, '/F']);
      try { command(['/Query', '/TN', label]); assert.fail('owned task remains registered'); }
      catch (error) { if (!/cannot find the file specified/i.test(`${error.stderr}`)) throw error; }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) { if (primary) primary.cleanupCode = 'native-scheduler-cleanup-failed'; else primary = error; }
  }
  if (primary) throw primary;
});
