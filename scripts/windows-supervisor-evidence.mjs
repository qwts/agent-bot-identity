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
