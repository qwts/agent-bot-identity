// `agent-bot diagnostics export` (ADR-0983 decision 5, #983).
//
//   agent-bot diagnostics export [--since ISO-8601|-P1D] --output FILE
//   agent-bot diagnostics export [--since ISO-8601|-P1D] --preview
//
// Builds a local bundle from the diagnostics store: this install's version
// and platform, a summary, and the events in the window (default the last
// day, never beyond retention), each re-checked and redacted on the way out.
// `--output` writes it to a new file (0600, never over an existing one);
// `--preview` prints the same bundle to stdout and writes nothing. It never
// uploads, never opens an issue, and never contacts anything.

import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sinceTime } from './identity/agent-audit.mjs';
import { cleanStoredEvent, readDiagnostics, runtimeVersion } from './diagnostics.mjs';

export const EXPORT_FORMAT = 'agent-bot-diagnostics-export';
export const EXPORT_VERSION = 1;
export const MAX_EXPORT_EVENTS = 10_000;
const USAGE = 'usage: agent-bot diagnostics export [--since ISO-8601|-P1D] (--output FILE | --preview)';
const DEFAULT_SINCE = '-P1D';

function usage(message = USAGE) {
  return Object.assign(new Error(message), { code: 'usage' });
}

function options(argv, now) {
  const [action, ...args] = argv;
  if (action !== 'export') throw usage();
  const result = { since: DEFAULT_SINCE, output: null, preview: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) throw usage();
    seen.add(flag);
    if (flag === '--preview') { result.preview = true; continue; }
    if (!['--since', '--output'].includes(flag) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw usage();
    result[flag.slice(2)] = args[++i];
  }
  if (result.preview === (result.output !== null)) throw usage();
  try { result.sinceMs = sinceTime(result.since, now); } catch (error) { throw usage(error.message); }
  return result;
}

const tally = (events, key) => {
  const counts = {};
  for (const event of events) if (event[key] !== undefined) counts[event[key]] = (counts[event[key]] ?? 0) + 1;
  return counts;
};

/** The export bundle for events since `sinceMs`; reads only the local store. */
export function buildExport({ sinceMs, env = process.env, home = homedir(), now = () => new Date(), platform = process.platform, arch = process.arch, node = process.version } = {}) {
  const createdAt = now().toISOString();
  const all = readDiagnostics({ env, home, since: sinceMs, now })
    .map((event) => cleanStoredEvent(event, { env, home }))
    .filter(Boolean);
  const events = all.slice(-MAX_EXPORT_EVENTS);
  return {
    format: EXPORT_FORMAT,
    v: EXPORT_VERSION,
    createdAt,
    agentBot: runtimeVersion(),
    platform,
    arch,
    node,
    window: { since: new Date(Math.max(sinceMs, 0)).toISOString(), until: createdAt },
    summary: {
      events: events.length,
      omitted: all.length - events.length,
      outcomes: tally(events, 'outcome'),
      codes: tally(events, 'code'),
      components: tally(events, 'component'),
    },
    events,
  };
}

export function main(argv = process.argv.slice(2), {
  env = process.env, home = homedir(), now = () => new Date(), cwd = process.cwd(),
  writeOut = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s),
} = {}) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    writeOut(`${USAGE}\n`);
    return 0;
  }
  try {
    const opts = options(argv, now);
    const bundle = buildExport({ sinceMs: opts.sinceMs, env, home, now });
    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    if (opts.preview) {
      writeOut(text);
      writeErr(`agent-bot diagnostics: preview of ${bundle.summary.events} event(s); nothing was written or sent\n`);
      return 0;
    }
    const file = resolve(cwd, opts.output);
    // `wx`: never replace an existing file, and never follow a link planted there.
    writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
    writeErr(`agent-bot diagnostics: wrote ${bundle.summary.events} event(s) to ${opts.output}; nothing was sent\n`);
    return 0;
  } catch (error) {
    writeErr(`agent-bot diagnostics: ${error.code === 'EEXIST' ? `${argv.at(argv.indexOf('--output') + 1)} already exists; choose a new file` : error.message}\n`);
    return error.code === 'usage' ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
