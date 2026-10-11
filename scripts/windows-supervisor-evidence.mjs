// Evidence predicates for the disposable desktop acceptance. Neither a send's
// initial wake outcome nor an arbitrary schtasks failure establishes success.
export function hasDaemonWakeReport(records, { account, agentId, messageId }) {
  const details = new Set(['no warm socket and cold wake is off for this soul',
    'no warm socket and no cold wake path configured']);
  return records.some(record => record.t === 'wake-outcome' && record.account === account
    && record.agentId === agentId && Array.isArray(record.ids) && record.ids.includes(messageId)
    && record.outcome === 'waiting' && details.has(record.detail));
}

export function taskQueryProvesAbsence(response) {
  return response.exit > 0 && /^\s*ERROR:\s*The system cannot find the file specified\.\s*$/i
    .test(response.stderr);
}

// Only fixed phase names and short error codes enter the report; OS errors
// can carry command lines, credentials, stdout and stderr on other fields.
export function acceptanceFailureEvidence(error, substage) {
  const safe = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
  return { code: safe(error?.code) ?? 'assertion-failed',
    ...(safe(substage) ? { substage } : {}) };
}
