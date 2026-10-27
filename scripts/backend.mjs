#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { installBackend, startBackend, statusBackend } from '../lib/native.mjs';

const command = process.argv[2];
const args = process.argv.slice(3);
const dataArg = args.find(arg => arg.startsWith('--data-dir='));
const dataValue = dataArg ? dataArg.slice('--data-dir='.length) : '';
// A relative --data-dir is taken from where the command runs, as for scripts/studio.mjs.
const options = dataValue ? { dataDir: path.resolve(dataValue) } : {};

async function main() {
  if (args.some(arg => !arg.startsWith('--data-dir=')) || args.length > 1 || (dataArg && !options.dataDir)) {
    throw new Error('Expected at most one --data-dir=<path> argument');
  }
  // A download goes through HTTPS_PROXY and the like, as it does under Bun.
  if (command === 'install' || command === 'install-upstream') http.setGlobalProxyFromEnv?.();
  switch (command) {
    case 'install':
      await installBackend(options);
      break;
    case 'install-upstream':
      await installBackend({ ...options, channel: 'upstream' });
      break;
    case 'start':
      startBackend(options);
      break;
    case 'status':
      await statusBackend(options);
      break;
    default:
      console.error('Usage: node scripts/backend.mjs <install|install-upstream|start|status> [--data-dir=<path>]');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
