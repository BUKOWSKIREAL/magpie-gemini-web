import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Run the actual lock/update implementation with deterministic process evidence.
// Real cross-process liveness is covered separately in studio-updates.test.mjs;
// randomized protocol checks must not depend on recycled OS PIDs or CIM latency.
export async function lockRuntime(root) {
  const evidence = path.join(root, 'process-evidence.mjs');
  fs.writeFileSync(evidence, `
    export const processes = new Map();
    export function processExists(pid) { return processes.get(pid)?.state === 'alive'; }
    export function studioProcessStarted(pid) { return processes.get(pid)?.started || null; }
  `);
  const native = path.join(root, 'native.mjs');
  fs.writeFileSync(native, `
    export * from ${JSON.stringify(new URL('../../lib/studio-native.mjs', import.meta.url).href)};
    export { studioProcessStarted } from './process-evidence.mjs';
  `);
  const original = fs.readFileSync(new URL('../../lib/studio-updates.mjs', import.meta.url), 'utf8');
  const script = path.join(root, 'updates.mjs');
  fs.writeFileSync(script, original
    .replace("'./proc.mjs'", JSON.stringify(pathToFileURL(evidence).href))
    .replace("'./studio-native.mjs'", JSON.stringify(pathToFileURL(native).href))
    .replace("'./studio-upstream.mjs'", JSON.stringify(new URL('../../lib/studio-upstream.mjs', import.meta.url).href)));
  const { processes } = await import(pathToFileURL(evidence).href);
  processes.set(process.pid, { state: 'alive', started: 'test-host-start' });
  return { processes, ...await import(pathToFileURL(script).href) };
}
