#!/usr/bin/env node
import { smokeOfficialStudio } from './studio-user-smoke.mjs';

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!['--version', '--archive'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
    throw new Error('Usage: node scripts/studio-official-smoke.mjs [--version <tag>] [--archive <official-archive>]');
  }
  options[args[i] === '--version' ? 'version' : 'archivePath'] = args[i + 1];
}
await smokeOfficialStudio(options);
