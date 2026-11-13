// Run an actual official image through the updater's rename/replace/unlink sequence.
// HTTP refusal is injected to deterministically exercise the restart gap. This is not an online update.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ensureStudio, ensureStudioConfig, useStudioBinary, useDefaultStudio, installStudio, stopStudio,
  pickStudioPort, studioAdmin, studioProcessPids, verifyProcessIdentity, checkStudioHealth
} from '../lib/studio-native.mjs';

export async function smokeStudioLifecycle(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-official-lifecycle-'));
  let active;
  try {
    for (const mode of ['local', 'user']) {
      const dataDir = path.join(root, mode + ' data');
      const cwd = path.join(root, mode + ' different cwd');
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, '.env'), '# Deliberately conflicting relative account directory\nAISTUDIO_AUTH_STATES=./wrong-accounts\n');
      ensureStudioConfig(dataDir, '', { port: await pickStudioPort(0) });
      const seedDisabled = (base, id) => {
        const dir = path.join(base, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ label: id, enabled: false, proxy: '', locale: 'en-US', timezone: 'UTC' }));
        fs.writeFileSync(path.join(dir, 'storage-state.json'), JSON.stringify({ cookies: [], origins: [] }));
      };
      // Synthetic disabled records contain no Google credentials and make no Google requests.
      seedDisabled(path.join(dataDir, 'auth'), 'directory-probe@example.invalid');
      seedDisabled(path.join(cwd, 'wrong-accounts'), 'wrong-directory@example.invalid');
      const programDir = mode === 'user' ? root : process.platform === 'win32' ? dataDir : path.join(dataDir, 'package');
      const bin = path.join(programDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.copyFileSync(source, bin);
      fs.chmodSync(bin, 0o755);
      if (mode === 'user') await useStudioBinary(bin, { dataDir });
      active = dataDir;
      const local = await ensureStudio({ dataDir, managementOnly: true, spawnFn(file, args, options) {
        assert.equal(options.env.AISTUDIO_AUTH_STATES, path.join(dataDir, 'auth'));
        assert.ok(args.includes('-auth=' + path.join(dataDir, 'auth')));
        // Prove the environment alone controls official v0.3.7's effective directory,
        // even without -auth and with a conflicting .env in a different working directory.
        return spawn(file, mode === 'local' ? args.filter(a => !a.startsWith('-auth=')) : args, { ...options, cwd });
      } });
      const config = await studioAdmin(local, 'GET', '/api/config');
      assert.equal(config.auth_states, path.join(dataDir, 'auth'));
      assert.ok(config.environment.includes('AISTUDIO_AUTH_STATES'));
      const accounts = await studioAdmin(local, 'GET', '/api/accounts');
      assert.deepEqual(accounts.accounts.map(a => a.id), ['directory-probe@example.invalid']);
      assert.equal(accounts.accounts[0].state, 'disabled');
      const pid = Number(fs.readFileSync(path.join(dataDir, 'backend.pid'), 'utf8').trim());
      const old = path.join(path.dirname(bin), '.' + path.basename(bin) + '.old');
      const next = path.join(path.dirname(bin), '.' + path.basename(bin) + '.new');
      fs.copyFileSync(bin, next);
      fs.chmodSync(next, 0o755);
      fs.renameSync(bin, old);
      fs.renameSync(next, bin);
      if (process.platform !== 'win32') fs.rmSync(old);
      if (process.platform === 'darwin') console.log('Live official image after replacement: ' + execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim());
      assert.equal(verifyProcessIdentity(pid, bin), true, mode + ' replaced image identity');
      assert.ok(studioProcessPids(bin).includes(pid), mode + ' discovery without PID file');
      const gap = { dataDir, managementOnly: true, fetchFn: async () => {
        throw Object.assign(new Error('HTTP-down update window'), { code: 'ECONNREFUSED' });
      }, spawnFn() { assert.fail('must not spawn alongside the running replaced image'); } };
      for (const tracked of [true, false]) {
        if (!tracked) fs.rmSync(path.join(dataDir, 'backend.pid'), { force: true });
        await assert.rejects(ensureStudio(gap), /still be running or restarting/);
        if (mode === 'local') await assert.rejects(installStudio(gap), /still be running or restarting/);
        else await assert.rejects(useDefaultStudio(gap), /still be running or restarting/);
      }
      assert.deepEqual(await stopStudio(gap), { stopped: true });
      // An already pooled socket can reset once after exit on Windows. Require
      // a confirmed refusal, but allow the next probe to open a fresh connection.
      let health;
      const closedDeadline = Date.now() + 10000;
      do {
        health = await checkStudioHealth(local, globalThis.fetch);
        if (health.state !== 'unresponsive') break;
        await sleep(150);
      } while (Date.now() < closedDeadline);
      assert.equal(health.state, 'down', health.reason);
      if (mode === 'local') {
        // Existing installations have no policy marker. Migrate missing settings once.
        const configPath = path.join(dataDir, 'config.json');
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        delete saved.defaultsPolicy;
        fs.writeFileSync(configPath, JSON.stringify(saved));
      }
      await ensureStudio({ dataDir, managementOnly: true });
      const restarted = await studioAdmin(local, 'GET', '/api/config');
      assert.equal(restarted.auth_states, path.join(dataDir, 'auth'));
      if (mode === 'local') {
        const legacy = { search_model_aliases: false, per_account_concurrency: 1, warm_worker_limit: 1, max_active_workers: 1, warm_startup_concurrency: 1, routing_strategy: 'fill-first', request_timeout: '30m0s' };
        for (const [key, value] of Object.entries(legacy)) assert.equal(restarted[key], value, key + ' legacy migration');
        // Official Save omits its defaults: a later true/2 must survive the next restart.
        await studioAdmin(local, 'PUT', '/api/config', { ...restarted, search_model_aliases: true, per_account_concurrency: 2 });
        assert.deepEqual(await stopStudio({ dataDir }), { stopped: true });
        await ensureStudio({ dataDir, managementOnly: true });
        const chosen = await studioAdmin(local, 'GET', '/api/config');
        assert.equal(chosen.search_model_aliases, true);
        assert.equal(chosen.per_account_concurrency, 2);
      }
      // Also stop while the updater has moved the old image but not placed the new file yet.
      fs.rmSync(old, { force: true });
      fs.renameSync(bin, old);
      assert.deepEqual(await stopStudio({ dataDir }), { stopped: true });
      fs.renameSync(old, bin);
      active = undefined;
      console.log('PASS official ' + mode + ': effective absolute account directory, live image replacement, HTTP-down checks with/without PID, verified stop and restart');
    }
  } finally {
    const stopped = !active || (await stopStudio({ dataDir: active }).catch(() => ({ stopped: false }))).stopped;
    if (stopped) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    else { console.error('Process exit not confirmed; kept ' + root); process.exitCode = 1; }
  }
}
