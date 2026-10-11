// `node --import ./tests/helpers/no-exec.mjs`: in that process every
// `node:child_process` import gets no-exec-child-process.mjs instead, so a
// test can run agent-bot's real default wiring (the daemon's owner gate, its
// keyd and codesign checks) without ever starting codesign, keyd or the
// administrator dialog (osascript). Node 20.6+ module hooks; no flags.
import { register } from 'node:module';

register(new URL('./no-exec-hooks.mjs', import.meta.url));
