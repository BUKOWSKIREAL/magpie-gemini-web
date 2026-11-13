import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cleanStudio,
  hasStudioAssets,
  ensureStudioConfig,
  computeFileHash
} from '../lib/studio-native.mjs';
import { STUDIO_VERSION, PINNED_ARCHIVES } from './helpers/studio-legacy.mjs';
import {
  cleanBackend,
  stopBackend,
  hasBackendAssets,
  localBackend,
  localSetup,
  pinnedBinary
} from '../lib/native.mjs';
import {
  isPluginInMagpie,
  cleanDownloadedAssets,
  registerMagpieCleanup,
  ensureDetachedWatcher
} from '../lib/cleanup.mjs';
import { GeminiWebPlugin } from '../index.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

async function configureStudio(dataDir) {
  return ensureStudioConfig(dataDir, undefined, { port: await freePort() });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

describe('Automatic & Manual Cleanup of Downloaded Assets', () => {
  let tmpRoot;
  const watchers = new Set();
  const spawnWatcher = (...args) => {
    const child = spawn(...args);
    watchers.add(child);
    return child;
  };

  afterEach(async () => {
    for (const child of watchers) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
        child.ref();
        child.kill('SIGKILL');
        await exited;
      }
      watchers.delete(child);
    }
  });

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cleanup-test-'));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('1. cleanStudio stops running service and Camoufox, removes downloaded assets, and preserves auth & config', async () => {
    const dataDir = path.join(tmpRoot, 'studio-clean');
    await configureStudio(dataDir);
    fs.writeFileSync(path.join(dataDir, 'backend.log'), 'log line\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'backend.log.1'), 'old log\n', { mode: 0o600 });

    // Create a saved Google account in auth/
    const accDir = path.join(dataDir, 'auth', 'user@gmail.com');
    fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(accDir, 'storage-state.json'), '{"cookies":[{"name":"SAPISID","value":"v","domain":".google.com"}],"origins":[]}\n', { mode: 0o600 });

    // Create package/, archive, manifest, launch record, and staging leftovers
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(path.join(pkgDir, 'sub'), { recursive: true, mode: 0o700 });
    const binName = process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api';
    const binPath = path.join(pkgDir, binName);
    fs.copyFileSync(process.execPath, binPath, fs.constants.COPYFILE_FICLONE);
    fs.writeFileSync(path.join(pkgDir, 'sub', 'asset.txt'), 'asset', { mode: 0o400 });

    const nodeLib = path.join(path.dirname(fs.realpathSync(process.execPath)), '..', 'lib');
    const child = spawn(binPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], {
      env: { ...process.env, DYLD_LIBRARY_PATH: nodeLib, LD_LIBRARY_PATH: nodeLib },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const childExited = new Promise(resolve => child.on('exit', resolve));
    await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
    });

    // Harden package directory like protectPackage() does on Unix
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(pkgDir, 'sub'), 0o500);
      fs.chmodSync(pkgDir, 0o555);
    }

    fs.writeFileSync(path.join(dataDir, 'backend.pid'), `${child.pid}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'backend.launch.json'), '{"pid":1,"proxy":null,"proxyEnv":"none"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'install-manifest.json'), `{"version":"${STUDIO_VERSION.slice(1)}"}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'aistudio2api-v0.2.19-magpie.1-darwin-arm64.tar.gz'), 'archive-bytes', { mode: 0o600 });
    fs.mkdirSync(path.join(dataDir, '.install.tmp.abcd'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, '.package.stage.abcd'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, '.package.backup.abcd'), { recursive: true });

    // Create Camoufox runtime files (~300 MB archive + unpacked browser)
    const camoufoxDir = path.join(dataDir, 'runtime', 'camoufox', 'Camoufox.app', 'Contents', 'MacOS');
    fs.mkdirSync(camoufoxDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(camoufoxDir, 'camoufox'), 'browser-bin', { mode: 0o755 });
    fs.writeFileSync(path.join(dataDir, 'runtime', 'camoufox-152.0.4-beta.29-mac.arm64.zip.part'), 'part-bytes', { mode: 0o600 });
    fs.mkdirSync(path.join(dataDir, 'runtime', '.camoufox-stage-1234'), { recursive: true });

    assert.equal(hasStudioAssets(dataDir), true);

    try {
      const res = await cleanStudio({
        dataDir,
        fetchFn: async () => {
          throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        }
      });
      assert.equal(res.cleaned, true);
      await childExited;
      assert.equal(processAlive(child.pid), false, 'running aistudio2api process must be stopped');
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }

    assert.equal(hasStudioAssets(dataDir), false);
    assert.equal(fs.existsSync(pkgDir), false, 'package/ must be removed');
    assert.equal(fs.existsSync(path.join(dataDir, 'install-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'backend.pid')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'backend.launch.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'aistudio2api-v0.2.19-magpie.1-darwin-arm64.tar.gz')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'runtime')), false, 'empty runtime/ directory must be removed');

    // Preserved files
    assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), true, 'config.json must be preserved');
    assert.equal(fs.existsSync(path.join(dataDir, '.env')), true, '.env must be preserved');
    assert.equal(fs.existsSync(path.join(accDir, 'storage-state.json')), true, 'auth account must be preserved');
    assert.equal(fs.existsSync(path.join(dataDir, 'backend.log')), true, 'backend.log must be preserved');
  });

  it('2. cleanBackend stops running gemini-web2api-go, removes bin/, and preserves config, secrets & gemini.db', async () => {
    const dataDir = path.join(tmpRoot, 'web-clean');
    const binDir = path.join(dataDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const binName = process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go';
    const binPath = path.join(binDir, binName);
    fs.copyFileSync(process.execPath, binPath, fs.constants.COPYFILE_FICLONE);

    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 18083 }), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_keep', adminToken: 'adm_keep' }), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'gemini.db'), 'sqlite-data', { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'backend-channel.json'), '{"channel":"optimized"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'argon-build.json'), `{"sha256":"${'a'.repeat(64)}"}\n`, { mode: 0o600 });

    const nodeLib = path.join(path.dirname(fs.realpathSync(process.execPath)), '..', 'lib');
    const child = spawn(binPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], {
      env: { ...process.env, DYLD_LIBRARY_PATH: nodeLib, LD_LIBRARY_PATH: nodeLib },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const childExited = new Promise(resolve => child.on('exit', resolve));
    await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
    });
    fs.writeFileSync(path.join(dataDir, 'backend.pid'), `${child.pid}\n`, { mode: 0o600 });

    assert.equal(hasBackendAssets(dataDir), true);
    assert.ok(localBackend({ dataDir }));

    try {
      const res = await cleanBackend({ dataDir });
      assert.equal(res.cleaned, true);
      await childExited;
      assert.equal(processAlive(child.pid), false, 'running gemini-web2api-go process must be stopped');
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }

    assert.equal(hasBackendAssets(dataDir), false);
    assert.equal(localBackend({ dataDir }), null, 'localBackend is null once binary is removed');
    assert.deepEqual(localSetup({ dataDir }), {
      origin: 'http://127.0.0.1:18083',
      baseURL: 'http://127.0.0.1:18083/v1',
      apiKey: 'gw_keep',
      adminToken: 'adm_keep'
    });
    assert.equal(fs.existsSync(path.join(dataDir, 'gemini.db')), true, 'gemini.db must be preserved');
  });

  it('3. isPluginInMagpie distinguishes installed, disabled ("off": true), stale paths, and removed states', () => {
    const magpieDir = path.join(tmpRoot, 'magpie-config');
    fs.mkdirSync(magpieDir, { recursive: true });

    // Missing plugins.json -> null
    assert.equal(isPluginInMagpie(magpieDir), null);

    // Invalid JSON -> null
    fs.writeFileSync(path.join(magpieDir, 'plugins.json'), '{not-valid');
    assert.equal(isPluginInMagpie(magpieDir), null);

    // Installed via npm spec
    fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
      plugins: [{ spec: 'magpie-gemini-web@0.9.0' }]
    }));
    assert.equal(isPluginInMagpie(magpieDir), true);

    // Disabled via UI toggle ("off": true) -> still true!
    fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
      plugins: [{ spec: 'magpie-gemini-web', off: true }]
    }));
    assert.equal(isPluginInMagpie(magpieDir), true);

    // Stale path entry pointing to a non-existent folder -> false!
    fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
      plugins: [{ spec: path.join(tmpRoot, 'deleted-checkout-magpie-gemini-web'), off: true }]
    }));
    assert.equal(isPluginInMagpie(magpieDir, { pluginRoot: path.join(tmpRoot, 'other-root') }), false);

    // Valid local path entry with package.json name === "magpie-gemini-web" -> true!
    const validLocalDir = path.join(tmpRoot, 'local-checkout');
    fs.mkdirSync(validLocalDir, { recursive: true });
    fs.writeFileSync(path.join(validLocalDir, 'package.json'), JSON.stringify({ name: 'magpie-gemini-web' }));
    fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
      plugins: [{ spec: validLocalDir }]
    }));
    assert.equal(isPluginInMagpie(magpieDir, { pluginRoot: path.join(tmpRoot, 'other-root') }), true);

    // Removed (empty plugins list) -> false!
    fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
      plugins: []
    }));
    assert.equal(isPluginInMagpie(magpieDir), false);
  });

  it('4. detached watcher automatically cleans both Studio and Web assets when plugin is disabled then removed in Magpie', async () => {
    const magpieDir = path.join(tmpRoot, 'magpie-e2e');
    const studioDir = path.join(tmpRoot, 'studio-e2e');
    const webDir = path.join(tmpRoot, 'web-e2e');
    const pidFile = path.join(tmpRoot, 'watcher.pid');

    fs.mkdirSync(magpieDir, { recursive: true });
    fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
      plugins: [{ spec: 'magpie-gemini-web' }]
    }));

    await configureStudio(studioDir);
    fs.mkdirSync(path.join(studioDir, 'package'), { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'), 'bin');
    if (process.platform !== 'win32') fs.chmodSync(path.join(studioDir, 'package'), 0o555);
    fs.writeFileSync(path.join(studioDir, 'aistudio2api-v0.2.19-magpie.1-darwin-arm64.tar.gz'), 'archive');
    fs.mkdirSync(path.join(studioDir, 'runtime', 'camoufox'), { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'runtime', 'camoufox', 'camoufox-bin'), 'browser');
    fs.mkdirSync(path.join(studioDir, 'auth', 'keep@gmail.com'), { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'auth', 'keep@gmail.com', 'storage-state.json'), '{}');

    // Populate Web downloaded assets + db
    fs.mkdirSync(path.join(webDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(webDir, 'bin', process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go'), 'web-bin');
    fs.writeFileSync(path.join(webDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: await freePort() }));
    fs.writeFileSync(path.join(webDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_1', adminToken: 'adm_1' }));
    fs.writeFileSync(path.join(webDir, 'gemini.db'), 'db-keep');

    // Start the detached watcher with a fast poll interval (100ms)
    const watcher = ensureDetachedWatcher({
      magpieDir,
      studioDir,
      webDir,
      pidFile,
      pollMs: 100,
      spawnFn: spawnWatcher
    });
    assert.ok(watcher?.pid, 'detached watcher should be spawned');

    try {
      // Step 1: User toggles plugin OFF in Magpie ("off": true) -> assets must NOT be deleted
      fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
        plugins: [{ spec: 'magpie-gemini-web', off: true }]
      }));
      await sleep(300);
      assert.equal(hasStudioAssets(studioDir), true, 'disabling plugin must not delete Studio assets');
      assert.equal(hasBackendAssets(webDir), true, 'disabling plugin must not delete Web assets');

      // Step 2: User deletes plugin in Magpie -> entry removed from plugins.json
      fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
        plugins: []
      }));

      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && (hasStudioAssets(studioDir) || hasBackendAssets(webDir))) {
        await sleep(100);
      }

      assert.equal(hasStudioAssets(studioDir), false, 'Studio downloaded assets must be removed upon uninstall');
      assert.equal(hasBackendAssets(webDir), false, 'Web downloaded assets must be removed upon uninstall');
      assert.equal(fs.existsSync(path.join(studioDir, 'auth', 'keep@gmail.com', 'storage-state.json')), true, 'Studio auth must be preserved');
      assert.equal(fs.existsSync(path.join(studioDir, 'config.json')), true, 'Studio config.json must be preserved');
      assert.equal(fs.existsSync(path.join(webDir, 'gemini.db')), true, 'Web gemini.db must be preserved');
      assert.equal(fs.existsSync(path.join(webDir, 'secrets.json')), true, 'Web secrets.json must be preserved');
    } finally {
      fs.rmSync(pidFile, { force: true });
    }
  });

  it('5. CLI clean subcommands in scripts/studio.mjs and scripts/backend.mjs clean downloaded assets while keeping accounts', async () => {
    const studioDir = path.join(tmpRoot, 'cli-studio');
    const webDir = path.join(tmpRoot, 'cli-web');

    await configureStudio(studioDir);
    fs.mkdirSync(path.join(studioDir, 'package'), { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'), 'bin');
    fs.mkdirSync(path.join(studioDir, 'runtime', 'camoufox'), { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'runtime', 'camoufox', 'camoufox-bin'), 'cam');

    fs.mkdirSync(path.join(webDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(webDir, 'bin', process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go'), 'web');
    fs.writeFileSync(path.join(webDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: await freePort() }));
    fs.writeFileSync(path.join(webDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_cli', adminToken: 'adm_cli' }));

    const runCli = (script, args) => new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [path.resolve(script), ...args], { stdio: 'pipe' });
      let out = '';
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { out += d; });
      proc.on('error', reject);
      proc.on('close', code => resolve({ code, out }));
    });

    const studioRes = await runCli('scripts/studio.mjs', ['clean', '--data-dir', studioDir]);
    assert.equal(studioRes.code, 0, studioRes.out);
    assert.equal(hasStudioAssets(studioDir), false);
    assert.equal(fs.existsSync(path.join(studioDir, 'config.json')), true);

    const webRes = await runCli('scripts/backend.mjs', ['clean', `--data-dir=${webDir}`]);
    assert.equal(webRes.code, 0, webRes.out);
    assert.equal(hasBackendAssets(webDir), false);
    assert.equal(fs.existsSync(path.join(webDir, 'config.json')), true);
  });

  it('6. registerMagpieCleanup exposes handle.pid, resets after reinstall, and cleans again on 2nd removal', async () => {
    const magpieDir = path.join(tmpRoot, 'magpie-reinstall');
    const studioDir = path.join(tmpRoot, 'studio-reinstall');
    const webDir = path.join(tmpRoot, 'web-reinstall');
    const pidFile = path.join(tmpRoot, 'watcher-reinstall.pid');

    fs.mkdirSync(magpieDir, { recursive: true });
    fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
      plugins: [{ spec: 'magpie-gemini-web' }]
    }));

    const seedAssets = async () => {
      await configureStudio(studioDir);
      fs.mkdirSync(path.join(studioDir, 'package'), { recursive: true });
      fs.writeFileSync(path.join(studioDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'), 'bin');
      fs.mkdirSync(path.join(webDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(webDir, 'bin', process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go'), 'web-bin');
      fs.writeFileSync(path.join(webDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: await freePort() }));
      fs.writeFileSync(path.join(webDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_re', adminToken: 'adm_re' }));
    };

    await seedAssets();
    const handle = registerMagpieCleanup({ directory: magpieDir }, {
      studioDir,
      webDir,
      pidFile,
      pollMs: 80,
      spawnFn: spawnWatcher
    });
    assert.ok(handle, 'registerMagpieCleanup must return a handle');
    assert.ok(Number.isInteger(handle.pid) && handle.pid > 0, 'handle.pid must expose active watcher PID');

    try {
      // 1st removal
      fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({ plugins: [] }));
      handle.triggerIfRemoved();

      const deadline1 = Date.now() + 30000;
      while (Date.now() < deadline1 && (hasStudioAssets(studioDir) || hasBackendAssets(webDir))) {
        await sleep(80);
      }
      assert.equal(hasStudioAssets(studioDir), false, '1st removal must clean Studio assets');
      assert.equal(hasBackendAssets(webDir), false, '1st removal must clean Web assets');

      // Wait for 1st watcher to exit and clear pidFile
      const exitDeadline1 = Date.now() + 10000;
      while (Date.now() < exitDeadline1 && handle.pid !== undefined) {
        await sleep(50);
      }

      // Reinstall plugin in plugins.json and re-create assets
      fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({
        plugins: [{ spec: 'magpie-gemini-web' }]
      }));
      await seedAssets();
      const rewatched = handle.ensureWatcher();
      assert.ok(rewatched?.pid, 'ensureWatcher must re-arm after reinstall');
      assert.ok(Number.isInteger(handle.pid) && handle.pid > 0, 'handle.pid must be populated after reinstall');

      // 2nd removal
      fs.writeFileSync(path.join(magpieDir, 'plugins.json'), JSON.stringify({ plugins: [] }));
      handle.triggerIfRemoved();

      const deadline2 = Date.now() + 30000;
      while (Date.now() < deadline2 && (hasStudioAssets(studioDir) || hasBackendAssets(webDir))) {
        await sleep(80);
      }
      assert.equal(hasStudioAssets(studioDir), false, '2nd removal must also clean Studio assets');
      assert.equal(hasBackendAssets(webDir), false, '2nd removal must also clean Web assets');
    } finally {
      handle.close();
      fs.rmSync(pidFile, { force: true });
    }
  });

  it('7. stale or reused PIDs are never signaled and do not keep the watcher alive as an orphan', async () => {
    const studioDir = path.join(tmpRoot, 'stale-pid-studio');
    const webDir = path.join(tmpRoot, 'stale-pid-web');
    fs.mkdirSync(studioDir, { recursive: true });
    fs.mkdirSync(webDir, { recursive: true });

    const unrelated = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const exited = new Promise(resolve => unrelated.on('exit', resolve));
    await new Promise((resolve, reject) => {
      unrelated.once('message', resolve);
      unrelated.once('error', reject);
    });

    try {
      // Write unrelated process PID into backend.pid without matching binaries
      fs.writeFileSync(path.join(studioDir, 'backend.pid'), `${unrelated.pid}\n`);
      fs.writeFileSync(path.join(studioDir, 'backend.launch.json'), JSON.stringify({ pid: unrelated.pid, proxy: null, proxyEnv: 'none' }));
      fs.writeFileSync(path.join(webDir, 'backend.pid'), `${unrelated.pid}\n`);

      // hasStudioAssets and hasBackendAssets must ignore and clean up stale/unverified backend.pid
      assert.equal(hasStudioAssets(studioDir), false, 'unverified Studio backend.pid must not count as active asset');
      assert.equal(hasBackendAssets(webDir), false, 'unverified Web backend.pid must not count as active asset');
      assert.equal(fs.existsSync(path.join(studioDir, 'backend.pid')), false);
      assert.equal(fs.existsSync(path.join(webDir, 'backend.pid')), false);

      // Even when binaries exist on disk at different paths, cleanStudio / cleanBackend must not kill unrelated PID
      fs.mkdirSync(path.join(studioDir, 'package'), { recursive: true });
      fs.writeFileSync(path.join(studioDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(studioDir, 'backend.pid'), `${unrelated.pid}\n`);

      fs.mkdirSync(path.join(webDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(webDir, 'bin', process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(path.join(webDir, 'backend.pid'), `${unrelated.pid}\n`);

      await cleanStudio({ dataDir: studioDir });
      await cleanBackend({ dataDir: webDir });

      assert.equal(processAlive(unrelated.pid), true, 'unrelated process must survive cleanStudio and cleanBackend');
    } finally {
      try { unrelated.kill('SIGKILL'); } catch {}
      await exited;
    }
  });

  it('8. cleanStudio and cleanBackend serialize with .setup.lock and stopBackend rejects foreign listeners', async () => {
    const studioDir = path.join(tmpRoot, 'lock-studio');
    const webDir = path.join(tmpRoot, 'lock-web');
    await configureStudio(studioDir);
    fs.mkdirSync(path.join(studioDir, 'package'), { recursive: true });
    fs.writeFileSync(path.join(studioDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'), 'bin');

    fs.mkdirSync(path.join(webDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(webDir, 'bin', process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go'), 'bin');
    fs.writeFileSync(path.join(webDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: await freePort() }));
    fs.writeFileSync(path.join(webDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_lock', adminToken: 'adm_lock' }));

    // Hold .setup.lock briefly and verify cleanStudio / cleanBackend wait for release
    const studioLock = path.join(studioDir, '.setup.lock');
    const webLock = path.join(webDir, '.setup.lock');
    fs.writeFileSync(studioLock, `${process.pid}\n${Date.now()}\ntoken\n`, { mode: 0o600 });
    fs.writeFileSync(webLock, `${process.pid}\n${Date.now()}\n`, { mode: 0o600 });

    let studioCleaned = false;
    let webCleaned = false;
    const pStudio = cleanStudio({ dataDir: studioDir }).then(() => { studioCleaned = true; });
    const pWeb = cleanBackend({ dataDir: webDir }).then(() => { webCleaned = true; });

    await sleep(150);
    assert.equal(studioCleaned, false, 'cleanStudio must wait while .setup.lock is held');
    assert.equal(webCleaned, false, 'cleanBackend must wait while .setup.lock is held');

    fs.rmSync(studioLock, { force: true });
    fs.rmSync(webLock, { force: true });
    await Promise.all([pStudio, pWeb]);
    assert.equal(studioCleaned, true);
    assert.equal(webCleaned, true);

    // stopBackend rejects foreign listener (HTTP 401 on /v1/models)
    await assert.rejects(
      stopBackend({
        dataDir: webDir,
        fetchFn: async () => new Response('unauthorized', { status: 401 })
      }),
      /Cannot stop unknown or foreign process/
    );
  });
});
