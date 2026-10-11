import assert from 'node:assert/strict';
import test from 'node:test';
import { hasDaemonWakeReport, taskQueryProvesAbsence, acceptanceFailureEvidence } from '../scripts/windows-supervisor-evidence.mjs';

test('wake acceptance requires a daemon report for the exact fresh message, account and soul', () => {
  const expected = { account: 'owner', agentId: 'agent_test', messageId: 'msg_fresh' };
  const report = { t: 'wake-outcome', account: 'owner', agentId: 'agent_test', ids: ['msg_fresh'],
    outcome: 'waiting', detail: 'no warm socket and cold wake is off for this soul' };
  assert.equal(hasDaemonWakeReport([report], expected), true);
  for (const altered of [
    { t: 'send' }, { account: 'elsewhere' }, { agentId: 'agent_other' }, { ids: ['msg_stale'] },
    { detail: undefined }, { detail: 'arbitrary waiting status' }, { outcome: 'failed' },
  ]) assert.equal(hasDaemonWakeReport([{ ...report, ...altered }], expected), false);
});

test('task query proves absence only for the specific missing-task response', () => {
  assert.equal(taskQueryProvesAbsence({ exit: 1, stderr: 'ERROR: The system cannot find the file specified.\r\n' }), true);
  for (const response of [
    { exit: 0, stderr: '' }, { exit: -1, stderr: '' }, { exit: 1, stderr: 'ERROR: Access is denied.' },
    { exit: 1, stderr: 'ERROR: Unknown task scheduler failure.' },
    { exit: 1, stderr: 'ERROR: Access is denied.\nERROR: The system cannot find the file specified.' },
  ]) assert.equal(taskQueryProvesAbsence(response), false);
});


test('substage diagnostics retain a fixed phase without copying sensitive error fields', () => {
  const error = Object.assign(new Error('private message'), { code: 'usage', stdout: 'private stdout',
    stderr: 'private stderr', command: 'private command', credential: 'private credential' });
  assert.deepEqual(acceptanceFailureEvidence(error, 'native-daemon-pair'), { code: 'usage', substage: 'native-daemon-pair' });
  assert.deepEqual(acceptanceFailureEvidence({ code: 'secret with spaces' }, 'arbitrary output with spaces'), { code: 'assertion-failed' });
});
