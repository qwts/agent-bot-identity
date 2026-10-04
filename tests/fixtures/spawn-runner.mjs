// Mimics a spawn-runner registry row (npx and friends): the real agent is a
// DESCENDANT of the spawned command, inheriting its stdio. Exists so the
// engine's process-tree termination has a regression test — killing only the
// direct child would leave the grandchild alive on the pipes.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit' });
// The grandchild's pid as soon as it exists, so a test can check it died
// without waiting for a second Node to boot and speak ACP under a deadline.
if (process.env.SPAWN_RUNNER_PID_FILE) writeFileSync(process.env.SPAWN_RUNNER_PID_FILE, String(child.pid));
child.on('exit', (code) => process.exit(code ?? 0));
