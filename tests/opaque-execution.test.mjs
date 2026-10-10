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
    'eval "$CMD"',
    '$RUNNER build',
    'env -S "$CMD"',
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

test('sourced scripts and unreadable shell inputs are opaque at their target cwd', () => {
  for (const command of [
    'source release.sh', '. ./release.sh', 'builtin source release.sh',
    'source "$SCRIPT"', 'sh $SCRIPT', 'sh -c "$CMD"', 'bash -lc "$CMD"',
    'env sh $SCRIPT', 'sh -c', 'bash -- -c payload.sh',
  ]) {
    const scan = scanGitPublish(`cd /target && ${command}`, { cwd: '/session', env: {} });
    assert.equal(scan.opaqueExecution, true, command);
    assert.deepEqual(scan.opaque, [{ cwd: '/target' }], command);
    assert.equal(scan.publishes.length, 0, command);
  }
  for (const command of ['sh $SCRIPT', 'sh -c "$CMD"', 'bash -lc "$CMD"']) {
    assert.equal(scanGitPublish(command, { env: {} }).ambiguous, true, command);
  }
  const known = scanGitPublish('CMD="git status"; sh -c "$CMD"', { env: {} });
  assert.equal(known.opaqueExecution, false);
  assert.equal(known.ambiguous, false);
});

test('directly executed scripts and executable paths are opaque', () => {
  for (const command of [
    './release.sh',
    './release',
    '../tools/publish',
    '/opt/tools/publish',
    'env ./release.sh',
    'cd scripts && ./release.sh',
  ]) {
    const scan = scanGitPublish(command);
    assert.equal(scan.opaqueExecution, true, command);
    assert.equal(scan.opaque.length, 1, command);
  }
});

test('direct read-only Git and analyzable shell payloads remain transparent', () => {
  for (const command of ['git status', 'git log -1', 'sh -c "git status"', 'echo hello']) {
    const result = scanGitPublish(command);
    assert.equal(result.opaqueExecution, false, command);
    assert.equal(result.publishes.length, 0, command);
  }
});
