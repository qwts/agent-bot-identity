#!/usr/bin/env node
// A scripted stand-in for the Muse CLI: accepts the exact argv muse-acp
// builds (`exec --json --session-id <id> --workspace <ws> [...] <prompt>`)
// and emits the JSONL envelope shapes probed from Muse Code 0.2.1 in #145.
// The prompt selects the scenario so tests read as a list of turns.

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const sessionId = flag('--session-id');
const workspace = flag('--workspace');
const provider = flag('--provider');
const prompt = args[args.length - 1];

let sequence = 0;
function emit(payloadType, payload, recordType = 'event') {
  sequence += 1;
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    id: `fake-${sequence}`,
    stream: { kind: 'session', id: sessionId },
    sequence,
    recorded_at: 0,
    record_type: recordType,
    durability: 'durable',
    causation_id: 'fake-command',
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  })}\n`);
}

const delta = (text) => emit('run.output.delta', { kind: 'run_output_delta', text }, 'status');
const terminal = (kind, reason = null) => emit(`run.terminal.${kind}`, { kind: 'run_terminal', terminal: kind, reason });
const task = (event, taskId, extra = {}) => emit(`task.lifecycle.${event}`, {
  kind: 'task_lifecycle',
  task_id: taskId,
  event: { kind: event, task_id: taskId, ...extra },
});

if (prompt === 'argv-probe') {
  delta(JSON.stringify({ sessionId, workspace, provider, cwd: process.cwd() }));
  terminal('completed');
} else if (prompt === 'fail-run') {
  delta('about to fail');
  terminal('failed', 'provider exploded');
} else if (prompt === 'no-terminal') {
  delta('going quiet');
  // exit without a terminal event
} else if (prompt === 'hang') {
  delta('hanging now');
  setInterval(() => {}, 60_000);
} else {
  delta(`muse says: ${prompt}`);
  task('proposed', 'task-model', { task_kind: 'model.unknown.response' });
  task('started', 'task-model');
  task('proposed', 'task-tool', { task_kind: 'workspace.read_file' });
  task('started', 'task-tool');
  task('completed', 'task-tool');
  task('completed', 'task-model');
  terminal('completed');
}
