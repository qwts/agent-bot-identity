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

// Startup diagnostics are classifications, never exception text or arbitrary
// stack paths. The bootstrap writes this before its process exits; readback
// passes through the same filter before it reaches the acceptance report.
export function startupErrorEvidence(error) {
  const evidence = acceptanceFailureEvidence(error);
  if (['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'AssertionError'].includes(error?.name)) evidence.name = error.name;
  const modules = ['agent-daemon.mjs', 'daemon-client.mjs', 'comms-client.mjs', 'daemon-log.mjs',
    'daemon-supervisor.mjs', 'windows-account-custody.mjs', 'vouch.mjs'];
  const frames = typeof error?.stack === 'string' ? error.stack.split('\n').flatMap(line => {
    const match = /\/([^/\\\s]+\.mjs):(\d+):(\d+)\)?$/.exec(line);
    return match && modules.includes(match[1]) ? [{ module: match[1], line: Number(match[2]), column: Number(match[3]) }] : [];
  }) : Array.isArray(error?.frames) ? error.frames : [];
  evidence.frames = frames.filter(frame => modules.includes(frame?.module)
    && Number.isSafeInteger(frame.line) && frame.line > 0
    && Number.isSafeInteger(frame.column) && frame.column > 0).slice(0, 8);
  return evidence;
}

export function startupLogEvidence(text) {
  const classes = ['ERR_MODULE_NOT_FOUND', 'ERR_MODULE_NOT_SUPPORTED', 'ERR_INVALID_ARG_TYPE',
    'ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE', 'SyntaxError', 'TypeError', 'ReferenceError',
    'Win32Exception', 'Add-Type', 'AssignProcessToJobObject'];
  return { present: true, bytes: Buffer.byteLength(text),
    classes: classes.filter(name => new RegExp(`\\b${name}\\b`).test(text)) };
}
