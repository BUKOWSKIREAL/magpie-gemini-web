#!/usr/bin/env node
// Real official backend checks in a temporary directory. No Google login, generation or applied update.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateStudioBinary, useStudioBinary, ensureStudio, stopStudio, studioStatus, studioAdmin,
  readStudioEnv, saveStudioProxy, cleanStudio, computeFileHash, nodeFetch, localStudio
} from '../lib/studio-native.mjs';
import { openStudioConnect } from '../lib/studio-connect.mjs';
import { AIStudioPlugin } from '../index.mjs';
import { smokeStudioLifecycle, removeSmokeData } from './studio-lifecycle-smoke.mjs';

export async function smokeOfficialStudio({ binary, version, archivePath } = {}) {
  const selected = binary ? validateStudioBinary(binary) : undefined;
  const selectedHash = selected ? computeFileHash(selected) : undefined;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-official-smoke-'));
  let local;
  try {
    if (selected) await useStudioBinary(selected, { dataDir, preferredPort: 0 });
    console.log(selected ? 'Starting the selected official executable in temporary data...' : 'Installing and starting the official CLI in an empty temporary directory...');
    local = await ensureStudio({ dataDir, preferredPort: 0, managementOnly: true, version, archivePath });
    const bin = local.binaryPath;
    const hash = computeFileHash(bin);
    if (selectedHash) assert.equal(hash, selectedHash);
    const report = await studioStatus({ dataDir });
    assert.equal(report.status, 'running');
    assert.equal(report.backendMode, selected ? 'user' : 'local');
    assert.equal(report.binaryPath, bin);
    console.log(`Started official ${report.version} (${process.platform}-${process.arch}); checking settings and account connection...`);
    const config = await studioAdmin(local, 'GET', '/api/config');
    assert.equal(config.search_model_aliases, true, 'official defaults belong to upstream');
    assert.equal(config.environment.includes('WAA_BACKEND'), false);
    const choices = { search_model_aliases: true, request_timeout: '41m0s', max_account_switches: 5, discover_hidden_models: true };
    const saved = await studioAdmin(local, 'PUT', '/api/config', { ...config, ...choices });
    for (const [key, value] of Object.entries(choices)) assert.equal(saved[key], value, key);
    assert.equal(readStudioEnv(dataDir).SEARCH_MODEL_ALIASES, undefined, 'official Save omits its default');
    fs.appendFileSync(path.join(dataDir, '.env'), 'FUTURE_BACKEND_SETTING="retain this value"\n');
    saveStudioProxy(dataDir, '');
    assert.equal(readStudioEnv(dataDir).FUTURE_BACKEND_SETTING, 'retain this value');

    const tasks = await studioAdmin(local, 'GET', '/api/accounts/tasks');
    assert.equal(tasks.magpie_signin, undefined, 'this check requires an unpatched official backend');
    const bridge = await openStudioConnect({ prepare: async () => local, deadline: Date.now() + 15000 });
    const pending = bridge.start();
    try {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        if ((await (await fetch(bridge.url + '/status')).json()).ready) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'manual sign-in bridge must become ready');
      const destination = await (await fetch(bridge.url + '/manage', {
        method: 'POST', headers: { Origin: new URL(bridge.url).origin }
      })).json();
      assert.notEqual(new URL(destination.url).origin, local.origin);
      assert.match(await (await fetch(destination.url)).text(), /连接到 Magpie/);
      await fetch(bridge.url + '/cancel', { method: 'POST', headers: { Origin: new URL(bridge.url).origin } });
      await assert.rejects(pending, /取消/);
    } finally { bridge.close(); }

    const update = await studioAdmin(local, 'GET', '/api/update', null, { fetchFn: nodeFetch, timeoutMs: 20000 });
    assert.equal(update.mode, 'binary', 'official upstream update support stays enabled');
    assert.ok(!update.managed_by);
    if (selected) {
      assert.equal((await cleanStudio({ dataDir })).skipped, 'user_backend');
      assert.equal((await studioStatus({ dataDir })).status, 'running');
    } else {
      // The official updater must be able to create a replacement next to the executable.
      const probe = path.join(path.dirname(bin), '.update-write-probe');
      fs.writeFileSync(probe, 'writable');
      fs.rmSync(probe);
      const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'install-manifest.json')));
      assert.equal(manifest.source, 'official');
      assert.equal(manifest.binarySha256, hash);
    }
    assert.equal(computeFileHash(bin), hash);
    assert.deepEqual(await stopStudio({ dataDir }), { stopped: true });
    const credentials = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
    let history;
    if (!selected) {
      // A stale install record must not trigger restoration. Replacing the stopped file with
      // identical official bytes also exercises the path remaining usable after an inode swap.
      const replaced = bin + '.old';
      fs.renameSync(bin, replaced);
      fs.copyFileSync(replaced, bin);
      fs.chmodSync(bin, 0o755);
      fs.rmSync(replaced);
      const manifestPath = path.join(dataDir, 'install-manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath));
      history = JSON.stringify({ ...manifest, version: '0.0.0-magpie.1', binarySha256: '0'.repeat(64) });
      fs.writeFileSync(manifestPath, history);
    }
    await ensureStudio({ dataDir, managementOnly: true, fetchFn: (url, init) => {
      assert.ok(!String(url).includes('github.com'), 'restart must not resolve or download a release');
      return fetch(url, init);
    } });
    const restarted = await studioAdmin(local, 'GET', '/api/config');
    for (const [key, value] of Object.entries(choices)) assert.equal(restarted[key], value, key + ' after restart');
    assert.equal(readStudioEnv(dataDir).FUTURE_BACKEND_SETTING, 'retain this value');
    assert.equal(readStudioEnv(dataDir).SEARCH_MODEL_ALIASES, undefined);
    assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), credentials);
    if (selected) {
      assert.equal(fs.existsSync(path.join(dataDir, 'package')), false);
      assert.equal(fs.existsSync(path.join(dataDir, 'install-manifest.json')), false);
    } else {
      assert.equal(fs.readFileSync(path.join(dataDir, 'install-manifest.json'), 'utf8'), history);
    }
    assert.equal(computeFileHash(bin), hash);
    assert.deepEqual(await stopStudio({ dataDir }), { stopped: true });
    await smokeAccountConnection(dataDir);
    await smokeStudioLifecycle(bin);
    console.log(`PASS official ${report.version}: ${selected ? 'custom path and cleanup preservation' : 'automatic installation and writable update directory'}, upstream settings, manual connection page, enabled updater, unchanged credentials and restart without release checks`);
  } finally {
    local ||= localStudio({ dataDir });
    const stopped = !local || (await stopStudio({ dataDir }).catch(() => ({ stopped: false }))).stopped;
    if (stopped) await removeSmokeData(dataDir);
    else {
      console.error(`Backend exit not confirmed; kept ${dataDir}`);
      process.exitCode = 1;
    }
  }
}

// Exercise the plugin entry points against a real backend with a synthetic restricted record.
// Empty cookies and the restricted state keep this check from contacting Google or generating.
async function smokeAccountConnection(dataDir) {
  const previousDir = process.env.AI_STUDIO_DATA_DIR;
  const id = 'connection-probe@example.invalid';
  const directory = path.join(dataDir, 'auth', id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'account.json'), JSON.stringify({ label: id, enabled: true, proxy: '', locale: 'en-US', timezone: 'UTC' }));
  fs.writeFileSync(path.join(directory, 'storage-state.json'), JSON.stringify({ cookies: [], origins: [] }));
  fs.writeFileSync(path.join(directory, 'runtime-state.json'), JSON.stringify({ restricted: 'Isolated connection test; no Google credentials' }));
  process.env.AI_STUDIO_DATA_DIR = dataDir;
  const pages = [];
  const post = (url, body = {}) => fetch(url, { method: 'POST', headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function connectionPage(login) {
    pages.push(login.url);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const state = await (await fetch(login.url + '/status')).json();
      assert.ok(!state.error, state.error);
      if (state.ready) return (await (await post(login.url + '/manage')).json()).url;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Official connection page did not become ready');
  }
  try {
    const plugin = await AIStudioPlugin({});
    const login = await plugin.auth.methods[0].authorize({});
    const pending = login.callback();
    const url = await connectionPage(login);
    const local = localStudio({ dataDir });
    const management = await post(url + '/manage');
    const cookie = management.headers.get('set-cookie');
    assert.ok(cookie?.includes('; HttpOnly; SameSite=Strict'));
    const target = (await management.json()).url;
    assert.equal(new URL(target).origin, local.origin);
    assert.equal((await fetch(local.origin + '/api/accounts')).status, 401);
    assert.equal((await fetch(local.origin + '/api/accounts', { headers: { Cookie: cookie.split(';')[0] } })).status, 200, 'management handoff authenticates without entering credentials');
    const state = await (await fetch(url + '/status')).json();
    assert.ok(state.accounts.some(account => account.id === id && account.available));
    assert.equal((await post(url + '/select', { id })).status, 200);
    const signed = await pending;
    assert.equal(signed.type, 'success');
    assert.equal(signed.metadata.account, id);
    assert.equal(signed.metadata.managed, true);
    const auth = { type: 'api', key: signed.key, metadata: signed.metadata };
    const card = await plugin.auth.usage(async () => auth);
    assert.match(card.error, /服务受限/);
    assert.equal(card.signIn, 'kept');
    for (const secret of [local.apiKey, local.adminUsername, local.adminPassword, local.dataDir, local.binaryPath]) {
      assert.ok(!JSON.stringify(card).includes(JSON.stringify(secret).slice(1, -1)), 'cards must not expose private backend details');
    }
    assert.deepEqual(await stopStudio({ dataDir }), { stopped: true });
    const stoppedCard = await plugin.auth.usage(async () => auth);
    assert.equal(stoppedCard.signIn, 'kept');
    assert.match(stoppedCard.error, /没有在运行/);
    const reconnect = await plugin.auth.methods[0].authorize({ account: id });
    assert.equal(reconnect.url, '', 'existing account does not reopen Google login');
    assert.deepEqual(await reconnect.callback(), signed);
    const canceled = await plugin.auth.methods[0].authorize({});
    const cancelResult = canceled.callback();
    const cancelURL = await connectionPage(canceled);
    assert.equal((await post(cancelURL + '/cancel')).status, 204);
    assert.equal((await cancelResult).type, 'failed');
    assert.ok((await studioAdmin(local, 'GET', '/api/accounts')).accounts.some(account => account.id === id), 'canceling a new connection preserves existing accounts');
    console.log('PASS real official account connection: authenticated management handoff, synthetic restricted account callback/card, stopped-service card, restart/reconnect and cancellation');
  } finally {
    for (const url of pages) await post(url + '/cancel').catch(() => {});
    try { await stopStudio({ dataDir }); }
    finally {
      if (previousDir === undefined) delete process.env.AI_STUDIO_DATA_DIR;
      else process.env.AI_STUDIO_DATA_DIR = previousDir;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--binary') throw new Error('Usage: node scripts/studio-user-smoke.mjs --binary <official-aistudio2api-executable>');
  await smokeOfficialStudio({ binary: args[1] });
}
