import test from 'node:test';
import assert from 'node:assert/strict';
import { scanGitPublish } from '../git-publish-scan.mjs';

// These commands can run Git with core.hooksPath disabled inside code the
// pre-command lexical scanner cannot inspect. No sink must be required in the
// visible command for the scan to report opaque execution.
test('stdin and script-based shells are opaque', () => {
  for (const command of [
    'sh < bootstrap.sh',
    'bash -s < instructions.sh',
    'zsh ./build.sh',
    'env bash ./build.sh',
    'bash',
    'sh -c "sh ./hidden-script"',
    'bash --rcfile -c payload.sh',
    'bash -o -c payload.sh',
  ]) {
    assert.equal(scanGitPublish(command).opaqueExecution, true, command);
  }
});

test('interpreters and task runners are opaque', () => {
  for (const command of [
    'python3 build.py',
    'python3 -',
    'node tools/build.mjs',
    'node -e "require(\'child_process\').execSync(\'true\')"',
    'npm run release',
    'make publish',
    'just release',
  ]) {
    assert.equal(scanGitPublish(command).opaqueExecution, true, command);
  }
});

test('direct read-only Git and analyzable shell payloads remain transparent', () => {
  for (const command of ['git status', 'git log -1', 'sh -c "git status"', 'echo hello']) {
    const result = scanGitPublish(command);
    assert.equal(result.opaqueExecution, false, command);
    assert.equal(result.publishes.length, 0, command);
  }
});
