#!/usr/bin/env node
import http from 'node:http';
import { installBackend, startBackend, statusBackend } from '../lib/native.mjs';

const command = process.argv[2];

async function main() {
  // A download goes through HTTPS_PROXY and the like, as it does under Bun.
  if (command === 'install' || command === 'install-upstream') http.setGlobalProxyFromEnv?.();
  switch (command) {
    case 'install':
      await installBackend();
      break;
    case 'install-upstream':
      await installBackend({ channel: 'upstream' });
      break;
    case 'start':
      startBackend();
      break;
    case 'status':
      await statusBackend();
      break;
    default:
      console.error('Usage: node scripts/backend.mjs <install|install-upstream|start|status>');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
