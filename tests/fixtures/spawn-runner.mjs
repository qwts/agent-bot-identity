// Mimics a spawn-runner registry row (npx and friends): the real agent is a
// DESCENDANT of the spawned command, inheriting its stdio. Exists so the
// engine's process-tree termination has a regression test — killing only the
// direct child would leave the grandchild alive on the pipes.
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
