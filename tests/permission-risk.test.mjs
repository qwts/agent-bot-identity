import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, isComputerUse } from '../permission-risk.mjs';

for (const toolName of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'TodoRead', 'Task', 'Agent',
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__files__get_file', 'mcp__files__list_files',
  'mcp__files__read_file', 'mcp__files__search_files', 'mcp__daemon__fetch_context', 'mcp__files__Read']) {
  test(`${toolName} is safe before text heuristics`, () => {
    assert.equal(classifyRisk({ toolName, summary: 'rm -rf /tmp; git push' }), 'safe');
  });
}

for (const command of ['rm -rf /tmp/a', 'rm -r /tmp/a', 'git push --force', 'git push origin main -f',
  'git reset --hard', 'git clean -fd', 'git branch -D old', 'DROP TABLE users', 'DROP DATABASE db',
  'TRUNCATE users', 'VACUUM FULL', 'mkfs.ext4 /dev/foo', 'dd if=/dev/zero', 'shutdown now', 'reboot',
  'kill -9 123', 'launchctl unload service', 'defaults write a b', 'chmod -R 777 a', 'chown -R user a',
  'echo hi > /dev/foo', ':(){ :|:& };:']) {
  test(`${command} is destructive in shell summary or operation`, () => {
    for (const toolName of ['Bash', 'terminal', 'execute', 'shell']) {
      assert.equal(classifyRisk({ toolName, summary: command.toUpperCase() }), 'destructive');
      assert.equal(classifyRisk({ toolName, operation: { command } }), 'destructive');
    }
  });
}

test('unknown, malformed, external and ordinary shell requests default to external', () => {
  for (const input of [undefined, null, {}, 42, { toolName: 42 }, { toolName: 'read' }, { toolName: 'get_file' },
    ...['WebFetch', 'WebSearch', 'send_message', 'start_soul', 'unknown', 'Bash'].map((toolName) => ({ toolName }))]) {
    assert.equal(classifyRisk(input), 'external');
  }
  for (const summary of ['gh api user', 'git push', 'curl url', 'ssh host', 'scp a b', 'npm publish', 'brew install foo', 'ls']) {
    assert.equal(classifyRisk({ toolName: 'Bash', summary }), 'external');
  }
  const operation = {}; operation.self = operation;
  assert.equal(classifyRisk({ toolName: 'Bash', operation }), 'external');
});

test('everyday redirections to the null sink, the standard streams and a tty are not destructive', () => {
  for (const summary of ['make 2>/dev/null', 'echo hi > /dev/stdout', 'cat x >/dev/stderr', 'say > /dev/tty', 'ls >/dev/fd/1']) {
    assert.equal(classifyRisk({ toolName: 'Bash', summary }), 'external');
  }
  assert.equal(classifyRisk({ toolName: 'Bash', summary: 'cat img > /dev/disk2' }), 'destructive');
  assert.equal(classifyRisk({ toolName: 'Bash', summary: 'echo x >/dev/nullable' }), 'destructive');
});

test('only the first 2000 characters are scanned', () => {
  assert.equal(classifyRisk({ toolName: 'Bash', summary: `${' '.repeat(2000)}rm -rf a` }), 'external');
  assert.equal(classifyRisk({ toolName: 'Bash', operation: `${' '.repeat(2000)}rm -rf a` }), 'external');
  assert.equal(classifyRisk({ toolName: 'Bash', summary: `${' '.repeat(1950)}rm -rf a` }), 'destructive');
});

for (const name of ['computer', 'computer_use', 'computer-use', 'screenshot', 'left_click', 'right_click',
  'double_click', 'type', 'key', 'scroll', 'mouse_move', 'left_click_drag', 'open_application']) {
  test(`${name} matches computer use with or without an MCP prefix`, () => {
    for (const toolName of [name, `mcp__desktop__${name}`]) {
      assert.equal(isComputerUse(toolName), true);
      assert.equal(classifyRisk({ toolName, summary: 'rm -rf a' }), 'external');
    }
  });
}

test('computer server prefixes match; unrelated or differently cased names do not', () => {
  for (const name of ['mcp__computer-use__get_screen', 'mcp__remote-devices__computer_click']) {
    assert.equal(isComputerUse(name), true);
    assert.equal(classifyRisk({ toolName: name }), 'external');
  }
  for (const name of [undefined, null, 42, '', 'Computer', 'mcp__desktop__get_screenshot', 'mcp__remote-devices__get_status']) {
    assert.equal(isComputerUse(name), false);
  }
});
