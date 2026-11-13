#!/usr/bin/env node
// Actual official binaries, synthetic disabled account, and an intentionally broken
// upgrade fixture. Never uses Google credentials or starts an account-login task.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { AIStudioPlugin } from '../index.mjs';
import { removeSmokeData } from './studio-lifecycle-smoke.mjs';
import {
  ensureStudio, stopStudio, studioAdmin, checkStudioHealth, computeFileHash, readStudioEnv
} from '../lib/studio-native.mjs';
import { acquireStudioUse, newerStudioRelease, updateStudioAutomatically } from '../lib/studio-updates.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-auto-smoke-'));
const dataDir = path.join(root, 'local data');
const originalDataDir = process.env.AI_STUDIO_DATA_DIR;
let local;
try {
  local = await ensureStudio({ dataDir, preferredPort: 0, managementOnly: true, version: process.argv[2] || 'v0.3.6' });
  const initial = (await checkStudioHealth(local, globalThis.fetch)).status.version;
  const initialHash = computeFileHash(local.binaryPath);
  const accountDir = path.join(dataDir, 'auth', 'automatic-probe@example.invalid');
  fs.mkdirSync(accountDir, { recursive: true });
  const account = JSON.stringify({ label: 'automatic-probe@example.invalid', enabled: false, proxy: '', locale: 'en-US', timezone: 'UTC' });
  fs.writeFileSync(path.join(accountDir, 'account.json'), account);
  fs.writeFileSync(path.join(accountDir, 'storage-state.json'), JSON.stringify({ cookies: [], origins: [] }));
  const config = await studioAdmin(local, 'GET', '/api/config');
  await studioAdmin(local, 'PUT', '/api/config', { ...config, request_timeout: '43m0s', search_model_aliases: false });
  fs.appendFileSync(path.join(dataDir, '.env'), 'FUTURE_BACKEND_SETTING="keep this choice"\n');
  const credentials = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  const release = await acquireStudioUse({ dataDir });
  try {
    process.env.AI_STUDIO_DATA_DIR = dataDir;
    await AIStudioPlugin(); // The public entry point schedules the automatic update.
    assert.equal((await updateStudioAutomatically({ dataDir, force: true })).state, 'busy');
    assert.equal(computeFileHash(local.binaryPath), initialHash);
  } finally { release(); }

  let update;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try { update = JSON.parse(fs.readFileSync(path.join(dataDir, 'automatic-update.json'), 'utf8')); } catch {}
    if (update?.error) throw new Error('Automatic update failed: ' + update.error);
    if (update?.updatedAt) break;
    await sleep(250);
  }
  assert.ok(update?.updatedAt, 'the public plugin must automatically install the next official stable release');
  const upgraded = (await checkStudioHealth(local, globalThis.fetch)).status.version;
  assert.ok(newerStudioRelease(upgraded, initial));
  assert.notEqual(computeFileHash(local.binaryPath), initialHash);
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), credentials);
  assert.equal(fs.readFileSync(path.join(accountDir, 'account.json'), 'utf8'), account);
  assert.equal(readStudioEnv(dataDir).FUTURE_BACKEND_SETTING, 'keep this choice');
  const saved = await studioAdmin(local, 'GET', '/api/config');
  assert.equal(saved.request_timeout, '43m0s');
  assert.equal(saved.search_model_aliases, false);
  console.log(`PASS automatic official update ${initial} -> ${upgraded}; public entry point, idle deferral, retained settings, credentials and account files`);

  // Advertise a newer, digest-verified but non-executable fixture through an
  // injected metadata transport. The actual current backend must be restored.
  const parts = upgraded.replace(/^v/, '').split('.');
  parts[2] = String(Number(parts[2]) + 1);
  const brokenVersion = 'v' + parts.join('.');
  const targetOS = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
  const targetArch = process.arch === 'x64' ? 'amd64' : process.arch;
  const folder = `aistudio2api-${brokenVersion}-${targetOS}-${targetArch}`;
  const asset = `${folder}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const source = path.join(root, 'fixture', folder);
  const archive = path.join(root, asset);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'), 'deliberately invalid executable for rollback verification\n', { mode: 0o755 });
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:FIXTURE_SOURCE -DestinationPath $env:FIXTURE_ARCHIVE"], {
      env: { ...process.env, FIXTURE_SOURCE: source, FIXTURE_ARCHIVE: archive }, windowsHide: true
    });
  } else execFileSync('tar', ['-czf', archive, '-C', path.dirname(source), folder]);
  const bytes = fs.readFileSync(archive);
  const url = `https://github.com/Mag1cFall/AIStudio2API/releases/download/${brokenVersion}/${asset}`;
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const releaseMetadata = { tag_name: brokenVersion, assets: [{ name: asset, digest: 'sha256:' + digest, browser_download_url: url }] };
  const fetchFn = (address, init) => {
    const target = String(address);
    if (target.startsWith('https://api.github.com/repos/Mag1cFall/AIStudio2API/releases/')) return Promise.resolve(Response.json(releaseMetadata));
    if (target === url) return Promise.resolve(new Response(bytes));
    return fetch(address, init);
  };
  const hash = computeFileHash(local.binaryPath);
  const failed = await updateStudioAutomatically({ dataDir, force: true, fetchFn, startTimeoutMs: 5000 });
  assert.equal(failed.state, 'failed');
  const recovered = await checkStudioHealth(local, globalThis.fetch);
  assert.equal(recovered.state, 'up', JSON.stringify(recovered));
  assert.equal(recovered.status.version, upgraded);
  assert.equal(computeFileHash(local.binaryPath), hash);
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), credentials);
  assert.equal(fs.readFileSync(path.join(accountDir, 'account.json'), 'utf8'), account);
  const pid = fs.readFileSync(path.join(dataDir, 'backend.pid'), 'utf8');
  assert.equal((await updateStudioAutomatically({ dataDir, force: true, fetchFn })).state, 'blocked');
  assert.equal(fs.readFileSync(path.join(dataDir, 'backend.pid'), 'utf8'), pid);
  console.log('PASS failed automatic upgrade: previous official executable restarted, data retained, failed release blocked from repeated restarts');
} finally {
  try {
    const stopped = !local || (await stopStudio({ dataDir }).catch(() => ({ stopped: false }))).stopped;
    if (stopped) await removeSmokeData(root);
    else { console.error('Could not confirm backend exit; retained isolated data at ' + root); process.exitCode = 1; }
  } finally {
    if (originalDataDir === undefined) delete process.env.AI_STUDIO_DATA_DIR;
    else process.env.AI_STUDIO_DATA_DIR = originalDataDir;
  }
}
