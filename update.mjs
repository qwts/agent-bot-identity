#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { main as install } from './install.mjs';

export async function main(argv = process.argv.slice(2)) {
  return install(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`update: ${error.message}\n`);
    process.exit(1);
  });
}
