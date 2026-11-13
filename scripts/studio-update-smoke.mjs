#!/usr/bin/env node
// Explicit online-update acceptance in disposable data only. Never points at a user's binary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureStudio, studioAdmin, stopStudio, studioStatus, localStudio, computeFileHash, nodeFetch } from '../lib/studio-native.mjs';

const from = process.argv[2] || 'v0.3.6';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-official-update-'));
let done = false, watching, spawnAttempts = 0, probes = 0, closedWindows = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  console.log('Installing official ' + from + ' in disposable data for an explicit online update...');
  const local = await ensureStudio({ dataDir, preferredPort: 0, managementOnly: true, version: from });
  const before = computeFileHash(local.binaryPath);
  const credentials = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  const history = fs.readFileSync(path.join(dataDir, 'install-manifest.json'), 'utf8');
  const config = await studioAdmin(local, 'GET', '/api/config');
  await studioAdmin(local, 'PUT', '/api/config', { ...config, search_model_aliases: false, request_timeout: '43m0s' });
  const update = await studioAdmin(local, 'GET', '/api/update', null, { fetchFn: nodeFetch, timeoutMs: 30000 });
  assert.equal(update.mode, 'binary');
  assert.equal(update.available, true, update.error || 'Choose an older official version for this acceptance test');
  console.log('Applying the official backend update: ' + update.current + ' -> ' + update.latest);
  // Keep ordinary start callers active through the actual backend-owned replacement and restart.
  watching = (async () => {
    while (!done) {
      try {
        await ensureStudio({ dataDir, managementOnly: true, spawnFn() {
          spawnAttempts++;
          throw new Error('Unexpected duplicate spawn during the official update');
        } });
        probes++;
      } catch (err) {
        if (/still be running or restarting/.test(err.message)) closedWindows++;
      }
      if (!done) await sleep(25);
    }
  })();
  await studioAdmin(local, 'POST', '/api/update', null, { fetchFn: nodeFetch, timeoutMs: 300000 });
  const deadline = Date.now() + 60000;
  let status;
  do {
    await sleep(100);
    status = await studioStatus({ dataDir });
  } while ((status.status !== 'running' || status.version !== update.latest) && Date.now() < deadline);
  done = true;
  await watching;
  assert.equal(spawnAttempts, 0, 'plugin must not duplicate an updating instance');
  assert.equal(status.status, 'running');
  assert.equal(status.version, update.latest);
  assert.notEqual(computeFileHash(local.binaryPath), before);
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), credentials);
  assert.equal(fs.readFileSync(path.join(dataDir, 'install-manifest.json'), 'utf8'), history);
  const chosen = await studioAdmin(local, 'GET', '/api/config');
  assert.equal(chosen.search_model_aliases, false);
  assert.equal(chosen.request_timeout, '43m0s');
  assert.equal((await stopStudio({ dataDir })).stopped, true);
  await ensureStudio({ dataDir, managementOnly: true, fetchFn: (url, init) => {
    assert.ok(!String(url).includes('github.com'), 'normal restart must reuse the updated image');
    return fetch(url, init);
  } });
  assert.equal((await studioStatus({ dataDir })).version, update.latest);
  assert.equal((await stopStudio({ dataDir })).stopped, true);
  console.log('PASS real official online update ' + from + ' -> ' + update.latest + '; ' + probes + ' healthy probes, ' + closedWindows + ' observed HTTP-down windows, no duplicate process, preserved settings and restart');
} finally {
  done = true;
  await watching;
  const local = localStudio({ dataDir });
  const stopped = !local || (await stopStudio({ dataDir }).catch(() => ({ stopped: false }))).stopped;
  if (stopped) fs.rmSync(dataDir, { recursive: true, force: true });
  else { console.error('Backend exit not confirmed; kept ' + dataDir); process.exitCode = 1; }
}
