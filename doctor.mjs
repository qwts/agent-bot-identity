#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildReadinessReport,
  collectReadiness,
  hookCoverage,
  readinessCheck,
  renderReadinessJson,
  renderReadinessReport,
  requireReadinessSchema,
} from './readiness.mjs';

export { hookCoverage };

export const DOCTOR_USAGE = `usage: agent-bot doctor [options]

Options:
  --app <slug>                    Verify one additional App (repeatable)
  --machine-only                  Skip current-worktree readiness
  --json                          Emit readiness schema JSON only
  --require-schema-version <n>    Require at least readiness schema version n
  -h, --help                      Show this help
`;

export function parseDoctorArgs(argv = process.argv.slice(2)) {
  const options = {
    apps: [],
    help: false,
    json: false,
    machineOnly: false,
    requireSchemaVersion: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--machine-only') {
      options.machineOnly = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--app' || arg === '--require-schema-version') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--app') {
        options.apps.push(value);
      } else {
        if (options.requireSchemaVersion !== null) {
          throw new Error('--require-schema-version may be passed only once');
        }
        options.requireSchemaVersion = Number(value);
      }
      index += 1;
    } else if (arg === '--repair') {
      throw new Error('doctor is diagnostic only; use agent-bot bootstrap for explicit repair');
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

export async function main(
  argv = process.argv.slice(2),
  {
    collect = collectReadiness,
    output = process.stdout,
  } = {},
) {
  const options = parseDoctorArgs(argv);
  if (options.help) {
    output.write(DOCTOR_USAGE);
    return { help: true };
  }
  const scope = options.machineOnly ? 'machine' : 'all';
  let report;
  try {
    requireReadinessSchema(options.requireSchemaVersion);
  } catch {
    report = buildReadinessReport({
      command: 'doctor',
      scope,
      machineChecks: [readinessCheck({
        id: 'runtime.readiness_schema',
        status: 'failed',
        code: 'readiness-schema-unsupported',
        message: 'the installed readiness schema does not satisfy the requested minimum',
        action: 'update agent-bot to a runtime with the required readiness schema',
      })],
      worktreeStatus: scope === 'machine' ? 'not_requested' : 'not_applicable',
    });
  }
  if (!report) {
    report = await collect({
      command: 'doctor',
      scope,
      explicitApps: options.apps,
    });
  }
  output.write(options.json ? renderReadinessJson(report) : renderReadinessReport(report));
  process.exitCode = report.ready ? 0 : 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`doctor: ${error.message}\n`);
    process.exit(1);
  });
}
