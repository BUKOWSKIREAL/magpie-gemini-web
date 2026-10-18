import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  studioDataDir,
  localStudio,
  installStudio,
  ensureStudio,
  studioAdmin,
  studioAccounts,
  stopStudio,
  studioStatus,
  ensureStudioConfig,
  generateEnv,
  validateConfig,
  validateProxy,
  verifyProcessIdentity,
  computeFileHash,
  PINNED_ARCHIVES,
  STUDIO_VERSION,
  checkStudioHealth,
  pickStudioPort,
  studioCommand,
  studioProcessPids,
  studioListenerPids} from '../lib/studio-native.mjs';

const offlineFetch = async () => { throw Object.assign(new Error('offline fixture'), {code:'ECONNREFUSED'}); };

// An earlier install of the service, answering this setup's admin login as v0.2.11.
const earlierVersionFetch = async (url) => {
  if (url.includes('/api/auth/login')) {
    return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=t; Path=/', 'Content-Type': 'application/json' } });
  }
  if (url.includes('/api/status')) {
    return Response.json({ version: 'v0.2.11', running: true, ready: true, state: 'RUNNING', accounts: { total: 1, ready: 1 } });
  }
  return Response.json({ object: 'list', data: [] });
};

// Source of a stand-in service run by a copy of node at the binary's path, answering as VERSION.
const STAND_IN_SERVICE = `
const http = require('node:http');
http.createServer((req, res) => {
  const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/api/auth/login') {
    res.writeHead(200, { 'Set-Cookie': 'aistudio_admin=s; Path=/', 'Content-Type': 'application/json' });
    return res.end('{}');
  }
  if (req.url === '/api/status') return json({ version: process.env.VERSION, ready: true, running: true, state: 'RUNNING', accounts: { total: 1, ready: 1 } });
  if (req.url === '/v1/models') return json({ object: 'list', data: [] });
  if (req.url === '/api/control/stop') return json({});
  res.writeHead(404);
  res.end();
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

// adminFetch answers as this setup's service, reporting statusBody() and calling onStart for
// each request to start generation.
function adminFetch(statusBody, onStart = () => {}) {
  return async (url) => {
    if (url.includes('/api/auth/login')) {
      return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=t; Path=/', 'Content-Type': 'application/json' } });
    }
    if (url.includes('/api/control/start')) {
      onStart();
      return Response.json({});
    }
    if (url.includes('/api/status')) return Response.json(statusBody());
    return Response.json({ object: 'list', data: [] });
  };
}

const runningStatus = accounts => ({ version: STUDIO_VERSION, state: 'RUNNING', running: true, ready: accounts.ready + accounts.busy > 0, accounts });
const launchingStatus = (state, accounts) => ({ version: STUDIO_VERSION, state, running: false, ready: false, accounts });

async function freePort() {
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise(r => server.close(r));
  return port;
}

function writeValidManifest(dataDir, bin) {
  const pin = PINNED_ARCHIVES[`${process.platform}-${process.arch}`];
  fs.writeFileSync(path.join(dataDir, 'install-manifest.json'), JSON.stringify({
    version: STUDIO_VERSION.slice(1),
    platform: process.platform,
    arch: process.arch,
    archiveSha256: pin.sha256,
    binarySha256: computeFileHash(bin)
  }, null, 2) + '\n', { mode: 0o600 });
}

describe('AI Studio Native Lifecycle & Safety Unit Tests', () => {
  let tmpRoot;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-native-test-'));
  });

  after(() => {
    if (tmpRoot) {
      // Production packages are intentionally not writable on Unix.
      for (const entry of fs.readdirSync(tmpRoot)) {
        const pkg = path.join(tmpRoot, entry, 'package');
        if (fs.existsSync(pkg)) fs.chmodSync(pkg, 0o755);
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('1. fixed env recipe Go/playground/loopback + no inherited WAA', () => {
    const dataDir = path.join(tmpRoot, 'env-recipe-test');
    const config = ensureStudioConfig(dataDir);
    const envContent = fs.readFileSync(path.join(dataDir, '.env'), 'utf8');

    assert.ok(envContent.includes('WAA_BACKEND=go'), 'WAA_BACKEND must be go');
    assert.ok(envContent.includes('UPSTREAM_CHANNELS=playground'), 'UPSTREAM_CHANNELS must be playground');
    assert.ok(envContent.includes('BUILD_NATIVE_NONSTREAM=false'));
    assert.ok(envContent.includes('TEMPORARY_CHAT=true'));
    assert.ok(envContent.includes('PER_ACCOUNT_CONCURRENCY=1'));
    assert.ok(envContent.includes('WARM_WORKER_LIMIT=1'));
    assert.ok(envContent.includes('MAX_ACTIVE_WORKERS=1'));
    assert.ok(envContent.includes('REQUEST_TIMEOUT=30m'));
    assert.ok(envContent.includes('INIT_TIMEOUT=2m'));
    assert.ok(envContent.includes(`LISTEN_ADDR=127.0.0.1:${config.port}`));
    assert.ok(envContent.includes(`PROXY_API_KEY=${config.apiKey}`));
    assert.ok(envContent.includes(`ADMIN_PASSWORD=${config.adminPassword}`));

    // Test explicit proxy override in generateEnv with nullish precedence
    const envWithProxy = generateEnv(dataDir, config, { proxy: 'http://127.0.0.1:1082' });
    assert.ok(envWithProxy.includes('PROXY=http://127.0.0.1:1082'));

    const envWithEmptyProxy = generateEnv(dataDir, config, { proxy: '' });
    assert.ok(envWithEmptyProxy.includes('PROXY=\n') || envWithEmptyProxy.endsWith('PROXY='));
  });

  it('2. ensureStudioConfig throws on malformed config and preserves bytes without replacement', () => {
    const dataDir = path.join(tmpRoot, 'corrupt-config-test');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(dataDir, 'config.json');

    // Invalid JSON
    const malformedBytes = '{"port": 2048, INVALID_JSON';
    fs.writeFileSync(configPath, malformedBytes, { mode: 0o600 });
    assert.throws(() => ensureStudioConfig(dataDir), /Invalid JSON/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), malformedBytes, 'Malformed bytes must be preserved');

    // Unsupported version
    fs.writeFileSync(configPath, JSON.stringify({ version: 2, port: 2048, apiKey: 'k', adminUsername: 'u', adminPassword: 'p', proxy: '' }), { mode: 0o600 });
    assert.throws(() => ensureStudioConfig(dataDir), /Unsupported configuration version/);

    // Invalid port
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, port: 99999, apiKey: 'k', adminUsername: 'u', adminPassword: 'p', proxy: '' }), { mode: 0o600 });
    assert.throws(() => ensureStudioConfig(dataDir), /Invalid port number/);
  });

  it('3. private file modes for directories and generated config', () => {
    const dataDir = path.join(tmpRoot, 'modes-test');
    ensureStudioConfig(dataDir);

    const dirStat = fs.statSync(dataDir);
    assert.equal(dirStat.mode & 0o777, 0o700, 'Data dir mode must be 0700');

    const configStat = fs.statSync(path.join(dataDir, 'config.json'));
    assert.equal(configStat.mode & 0o777, 0o600, 'config.json mode must be 0600');

    const envStat = fs.statSync(path.join(dataDir, '.env'));
    assert.equal(envStat.mode & 0o777, 0o600, '.env mode must be 0600');

    const authStat = fs.statSync(path.join(dataDir, 'auth'));
    assert.equal(authStat.mode & 0o777, 0o700, 'auth dir mode must be 0700');
  });

  it('4. admin cookie authentication 401 renewal and redirect refusal', async () => {
    let requests = [];
    let loginCount = 0;
    let cookieCount = 0;

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        requests.push({ url: req.url, method: req.method, headers: req.headers });

        if (req.url === '/api/auth/login') {
          loginCount++;
          res.writeHead(200, {
            'Set-Cookie': `aistudio_admin=cookie_session_${loginCount}; Path=/; HttpOnly`,
            'Content-Type': 'application/json'
          });
          res.end(JSON.stringify({ authenticated: true }));
          return;
        }

        if (req.url === '/api/status') {
          const cookie = req.headers.cookie;
          if (cookie === 'aistudio_admin=cookie_session_1') {
            // First cookie expired
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
          if (cookie === 'aistudio_admin=cookie_session_2') {
            cookieCount++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', version: STUDIO_VERSION, running: true, ready: true, accounts: { total: 1, ready: 1 } }));
            return;
          }
          res.writeHead(401);
          res.end();
          return;
        }

        if (req.url === '/api/redirect') {
          res.writeHead(302, { 'Location': 'http://127.0.0.1/evil' });
          res.end();
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const local = {
      origin: `http://127.0.0.1:${port}`,
      baseURL: `http://127.0.0.1:${port}/v1`,
      adminUsername: 'magpie',
      adminPassword: 'pw'
    };

    try {
      const status = await studioAdmin(local, 'GET', '/api/status');
      assert.equal(status.status, 'ok');
      assert.equal(loginCount, 2, 'Should have logged in twice due to 401 renewal');
      assert.equal(cookieCount, 1);

      // Redirect refusal
      await assert.rejects(async () => {
        await studioAdmin(local, 'GET', '/api/redirect');
      }, /returned redirect; foreign listener detected/);
    } finally {
      server.close();
    }
  });

  it('5. status does not auto-start a stopped service', async () => {
    const dataDir = path.join(tmpRoot, 'status-no-start');
    ensureStudioConfig(dataDir);
    // Package exists but service is stopped
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    const bin = path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const status = await studioStatus({ dataDir, fetchFn: offlineFetch });
    assert.equal(status.status, 'stopped');
    assert.ok(!fs.existsSync(path.join(dataDir, 'backend.pid')), 'Must not have started process');
  });

  it('6. foreign listener is not spawned or stopped, and foreign status is reported', async () => {
    // Start a server that returns 401 on login
    const foreignServer = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise(r => foreignServer.listen(0, '127.0.0.1', r));
    const port = foreignServer.address().port;

    const dataDir = path.join(tmpRoot, 'foreign-listener-test');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const config = {
      version: 1,
      port,
      apiKey: 'test-key',
      adminUsername: 'magpie',
      adminPassword: 'wrong-password',
      proxy: ''
    };
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    const bin = path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    try {
      const status = await studioStatus({ dataDir });
      assert.equal(status.status, 'foreign', 'Must identify foreign listener');

      let spawned = false;
      const fakeSpawn = () => { spawned = true; return { pid: 99999, on: () => {}, unref: () => {} }; };

      await assert.rejects(async () => {
        await ensureStudio({ dataDir, spawnFn: fakeSpawn });
      }, /already used by another service/);
      assert.equal(spawned, false, 'Must not spawn over foreign listener');

      // Stop refuses foreign
      await assert.rejects(async () => {
        await stopStudio({ dataDir });
      }, /foreign/);
    } finally {
      foreignServer.close();
    }
  });

  for (const denied of [false, true]) it(`7. reused PID is cleared on stop and startup without signaling its owner${denied ? ' (EPERM)' : ''}`, async t => {
    const { dataDir } = installedStandIn(`reused-pid-${denied}`);
    const pidFile = path.join(dataDir, 'backend.pid');
    const unrelatedChild = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const exited = new Promise(resolve => unrelatedChild.once('exit', resolve));
    const unrelatedPid = unrelatedChild.pid;
    const kill = process.kill.bind(process);
    const probe = t.mock.method(process, 'kill', (pid, signal) => {
      if (pid === unrelatedPid) {
        assert.equal(signal, 0, 'must never signal an unrelated process');
        if (denied) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
      }
      return kill(pid, signal);
    });
    try {
      fs.writeFileSync(pidFile, `${unrelatedPid}\n`);
      assert.deepEqual(await stopStudio({ dataDir, fetchFn: offlineFetch }), { stopped: true });
      assert.equal(fs.existsSync(pidFile), false);
      assert.equal(kill(unrelatedPid, 0), true, 'unrelated process survives stop');

      // Startup must also recover directly, without requiring a preceding stop.
      fs.writeFileSync(pidFile, `${unrelatedPid}\n`);
      let spawned = 0;
      const up = adminFetch(() => runningStatus({ total: 1, ready: 1, busy: 0 }));
      const local = await ensureStudio({
        dataDir,
        fetchFn: (...args) => spawned ? up(...args) : offlineFetch(...args),
        spawnFn: () => {
          assert.equal(fs.existsSync(pidFile), false, 'stale record is removed before launch');
          spawned++;
          return { unref() {} };
        }
      });
      assert.equal(local.dataDir, dataDir);
      assert.equal(spawned, 1);
      assert.equal(kill(unrelatedPid, 0), true, 'unrelated process survives startup');

      fs.writeFileSync(pidFile, `${unrelatedPid}\n`);
      await assert.rejects(installStudio({ dataDir, fetchFn: offlineFetch }), /offline fixture/);
      assert.equal(fs.existsSync(pidFile), false, 'install also discards the reused PID before attempting download');
      assert.equal(kill(unrelatedPid, 0), true, 'unrelated process survives install');
    } finally {
      probe.mock.restore();
      unrelatedChild.kill('SIGKILL');
      await exited;
    }
  });

  it('8. changed binary is never launched when verified recovery is unavailable', async () => {
    const dataDir = path.join(tmpRoot, 'mutated-binary-test');
    ensureStudioConfig(dataDir);
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    const bin = path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.writeFileSync(bin, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    const pin = PINNED_ARCHIVES[`${process.platform}-${process.arch}`];
    const manifest = {
      version: STUDIO_VERSION.slice(1),
      platform: process.platform,
      arch: process.arch,
      archiveSha256: pin.sha256,
      binarySha256: computeFileHash(bin)
    };
    fs.writeFileSync(path.join(dataDir, 'install-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

    // Mutate 1 byte of the binary
    fs.appendFileSync(bin, '# mutated\n');

    let spawned = false;
    await assert.rejects(async () => {
      await ensureStudio({ dataDir, startTimeoutMs: 1000, fetchFn: offlineFetch,
        spawnFn: () => { spawned = true; throw new Error('must not execute changed binary'); } });
    }, /offline fixture/);
    assert.equal(spawned, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'install-manifest.json'))).binarySha256, manifest.binarySha256);
  });

  it('the official upstream base needs the managed build, while the exact managed version is current', async () => {
    const { dataDir } = installedStandIn('managed-version-upgrade');
    const local = localStudio({ dataDir });
    for (const version of ['v0.2.12', 'v0.2.13']) {
      const fetchFn = adminFetch(() => ({ ...runningStatus({ total: 0 }), version }));
      assert.equal((await checkStudioHealth(local, fetchFn)).state, 'outdated');
    }
    const fetchFn = adminFetch(() => runningStatus({ total: 0 }));
    assert.equal((await checkStudioHealth(local, fetchFn)).state, 'up');
  });

  it('newer or custom admin-updated versions report recovery without stopping or installing', async () => {
    const dataDir = path.join(tmpRoot, 'admin-update-conflict');
    ensureStudioConfig(dataDir);
    fs.mkdirSync(path.join(dataDir, 'package'));
    fs.writeFileSync(path.join(dataDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'), 'stand-in');
    let mutations = 0;
    for (const version of ['v0.2.14', 'v1.0.0', 'v0.2.13-custom', 'unknown']) {
      const fetchFn = async (url, init) => {
        if (url.includes('/api/control/') || url.includes('github.com')) mutations++;
        return adminFetch(() => ({ ...runningStatus({ total: 0 }), version }))(url, init);
      };
      const status = await studioStatus({ dataDir, fetchFn });
      assert.equal(status.status, 'version_conflict');
      assert.match(status.reason, /online updater/);
      assert.match(status.reason, /studio\.mjs.*install/);
      for (const action of ['stop', 'install', 'start']) {
        assert.ok(status.reason.includes(studioCommand(action, { dataDir })));
      }
      assert.match(status.reason, /may not read data migrated/);
      await assert.rejects(ensureStudio({ dataDir, fetchFn, spawnFn: () => { mutations++; } }), /Update magpie-gemini-web/);
      await assert.rejects(installStudio({ dataDir, fetchFn }), /Update magpie-gemini-web/);
    }
    assert.equal(mutations, 0);
  });

  it('a restart with HTTP closed never reinstalls or spawns; a new PID can be stopped', async () => {
    const dataDir = path.join(tmpRoot, 'restart gap with spaces');
    ensureStudioConfig(dataDir, '', { port: await freePort() });
    const pkg = path.join(dataDir, 'package');
    fs.mkdirSync(pkg);
    const bin = path.join(pkg, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.copyFileSync(process.execPath, bin, fs.constants.COPYFILE_FICLONE);
    writeValidManifest(dataDir, bin);
    const manifest = path.join(dataDir, 'install-manifest.json');
    const old = JSON.parse(fs.readFileSync(manifest));
    old.binarySha256 = '0'.repeat(64); // updated executable no longer matches the old manifest
    fs.writeFileSync(manifest, JSON.stringify(old));
    const nodeLib = path.join(path.dirname(fs.realpathSync(process.execPath)), '..', 'lib');
    const child = spawn(bin, ['-e', `process.on('message', () => { ${STAND_IN_SERVICE} }); process.send('ready');`], {
      env: { ...process.env, PORT: String(localStudio({ dataDir }).port), VERSION: 'v0.2.14', DYLD_LIBRARY_PATH: nodeLib, LD_LIBRARY_PATH: nodeLib },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const exited = new Promise(resolve => child.on('exit', resolve));
    try {
      await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('stand-in exited early'))); });
      const pidFile = path.join(dataDir, 'backend.pid');
      fs.writeFileSync(pidFile, `${child.pid}\n`);
      const hash = computeFileHash(bin);
      const manifestBytes = fs.readFileSync(manifest, 'utf8');
      let spawned = false;
      const opts = { dataDir, fetchFn: offlineFetch, spawnFn: () => { spawned = true; } };
      await assert.rejects(ensureStudio(opts), /still be running or restarting/);
      await assert.rejects(installStudio(opts), /still be running or restarting/);
      assert.equal(fs.readFileSync(pidFile, 'utf8'), `${child.pid}\n`);
      // Recover the real process even when its recorded PID is dead or reused.
      for (const stale of [9999999, process.pid]) {
        fs.writeFileSync(pidFile, `${stale}\n`);
        await assert.rejects(ensureStudio(opts), /still be running or restarting/);
        await assert.rejects(installStudio(opts), /still be running or restarting/);
      }
      assert.equal(spawned, false);
      assert.equal(computeFileHash(bin), hash);
      assert.equal(fs.readFileSync(manifest, 'utf8'), manifestBytes);
      child.send('serve');
      const deadline = Date.now() + 10000;
      while ((await studioStatus({ dataDir })).status !== 'version_conflict') {
        assert.ok(Date.now() < deadline, 'replacement did not begin listening');
        await new Promise(r => setTimeout(r, 50));
      }
      await assert.rejects(ensureStudio({ dataDir }), /online updater/);
      let resetAfterExit = false;
      const fetchFn = async (...args) => {
        if (!resetAfterExit && (child.exitCode !== null || child.signalCode !== null)) {
          resetAfterExit = true;
          throw Object.assign(new Error('pooled connection reset after exit'), { code: 'ECONNRESET' });
        }
        return fetch(...args);
      };
      assert.deepEqual(await stopStudio({ dataDir, fetchFn }), { stopped: true });
      assert.equal(resetAfterExit, true);
      await exited;
      assert.equal(fs.existsSync(pidFile), false);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });

  it('a child that exits during startup does not leave backend.pid behind', { skip: process.platform === 'win32' }, async () => {
    const { dataDir } = installedStandIn('exited-child');
    await assert.rejects(ensureStudio({ dataDir, fetchFn: offlineFetch, startTimeoutMs: 2000 }), /exited during startup/);
    assert.equal(fs.existsSync(path.join(dataDir, 'backend.pid')), false);
  });

  it('Windows process discovery uses the full binary path and listener ownership', () => {
    const calls = [];
    const run = (...args) => { calls.push(args); return '123\r\n123\r\n456\r\n'; };
    assert.deepEqual(studioProcessPids('/custom dir/package/aistudio2api.exe', 'win32', run), [123, 456]);
    assert.equal(calls[0][2].env.TARGET_BINARY, path.resolve('/custom dir/package/aistudio2api.exe'));
    assert.match(calls[0][1].at(-1), /Get-CimInstance Win32_Process -Filter "Name='aistudio2api\.exe'"/);
    assert.match(calls[0][1].at(-1), /ExecutablePath -eq \$env:TARGET_BINARY/);
    assert.equal(calls[0][2].timeout, 20000);
    assert.deepEqual(studioListenerPids(2048, 'win32', run), [123, 456]);
    assert.equal(calls[1][2].env.TARGET_PORT, '2048');
    assert.equal(calls[1][2].timeout, 20000);
    assert.match(calls[1][1].at(-1), /Get-NetTCPConnection.*OwningProcess/);
    assert.throws(() => studioListenerPids('2048;bad', 'win32', run), /Invalid listener port/);
  });

  it('Windows process inspection failures explain recovery with the correct data directory', () => {
    const dataDir = path.join(tmpRoot, 'powershell failure');
    const bin = path.join(dataDir, 'package', 'aistudio2api.exe');
    for (const code of ['ETIMEDOUT', 'ENOENT', 'EACCES']) {
      const cause = Object.assign(new Error('PowerShell unavailable'), { code });
      assert.throws(() => studioProcessPids(bin, 'win32', () => { throw cause; }), err => {
        assert.match(err.message, /Cannot check for remaining AIStudio2API processes/);
        assert.ok(err.message.includes(studioCommand('stop', { dataDir })));
        assert.equal(err.cause, cause);
        return true;
      });
    }
  });

  it('package permission hardening failures do not block a healthy service', { skip: process.platform === 'win32' }, async t => {
    const { dataDir } = installedStandIn('best-effort-protection');
    const pkg = path.join(dataDir, 'package');
    const chmod = fs.chmodSync;
    let attempts = 0;
    const patch = t.mock.method(fs, 'chmodSync', (file, mode) => {
      if (file === pkg) {
        attempts++;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return chmod(file, mode);
    });
    try {
      const fetchFn = adminFetch(() => runningStatus({ total: 1, ready: 1, busy: 0 }));
      const local = await ensureStudio({ dataDir, fetchFn });
      assert.equal(local.dataDir, dataDir);
      assert.equal(attempts, 1);
      chmod(pkg, 0o555);
      await ensureStudio({ dataDir, fetchFn });
      assert.equal(attempts, 1, 'an already protected package does not need chmod again');
    } finally { patch.mock.restore(); }
  });

  it('9. startup lock dead owner recovery', async () => {
    const dataDir = path.join(tmpRoot, 'lock-recovery-test');
    ensureStudioConfig(dataDir);
    const lockPath = path.join(dataDir, '.setup.lock');

    // Write a lock file pointing to a dead PID (9999999)
    fs.writeFileSync(lockPath, `9999999\n${Date.now()}\nfake-token\n`, { mode: 0o600 });

    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    const bin = path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const pin = PINNED_ARCHIVES[`${process.platform}-${process.arch}`];
    fs.writeFileSync(path.join(dataDir, 'install-manifest.json'), JSON.stringify({
      version: STUDIO_VERSION.slice(1),
      platform: process.platform,
      arch: process.arch,
      archiveSha256: pin.sha256,
      binarySha256: computeFileHash(bin)
    }, null, 2) + '\n', { mode: 0o600 });

    let spawnCount = 0;
    const mockSpawn = () => {
      spawnCount++;
      return { pid: 23456, on: () => {}, unref: () => {} };
    };

    // Mock fetchFn returning down until spawn, then ready
    const mockFetch = async (url) => {
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify({ authenticated: true }), {
          headers: { 'Set-Cookie': 'aistudio_admin=tok; Path=/' }
        });
      }
      if (url.includes('/api/status')) {
        if (spawnCount === 0) {
          const err = new Error('ECONNREFUSED');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        return Response.json({ version: STUDIO_VERSION, running: true, ready: true, accounts: { total: 0 } });
      }
      return Response.json({});
    };

    const local = await ensureStudio({ dataDir, fetchFn: mockFetch, spawnFn: mockSpawn });
    assert.ok(local, 'Should recover dead lock and return local setup');
    assert.equal(spawnCount, 1, 'Spawn must be executed after reclaiming lock');
    assert.equal(fs.existsSync(lockPath), false, 'Lock file must be cleaned up on completion');
  });

  it('10. startup concurrency spawns exactly one child', async () => {
    const dataDir = path.join(tmpRoot, 'singleflight-test');
    ensureStudioConfig(dataDir);
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    const bin = path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const pin = PINNED_ARCHIVES[`${process.platform}-${process.arch}`];
    const manifest = {
      version: STUDIO_VERSION.slice(1),
      platform: process.platform,
      arch: process.arch,
      archiveSha256: pin.sha256,
      binarySha256: computeFileHash(bin)
    };
    fs.writeFileSync(path.join(dataDir, 'install-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

    let spawnCount = 0;
    const mockSpawn = () => {
      spawnCount++;
      return { pid: 12345, on: () => {}, unref: () => {} };
    };

    const mockFetch = async (url) => {
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify({ authenticated: true }), {
          headers: { 'Set-Cookie': 'aistudio_admin=tok; Path=/' }
        });
      }
      if (url.includes('/api/status')) {
        if (spawnCount === 0) {
          const err = new Error('ECONNREFUSED');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        return Response.json({ version: STUDIO_VERSION, running: true, ready: true, accounts: { total: 0 } });
      }
      return Response.json({});
    };

    // Run 3 concurrent ensureStudio calls
    const results = await Promise.all([
      ensureStudio({ dataDir, fetchFn: mockFetch, spawnFn: mockSpawn }),
      ensureStudio({ dataDir, fetchFn: mockFetch, spawnFn: mockSpawn }),
      ensureStudio({ dataDir, fetchFn: mockFetch, spawnFn: mockSpawn })
    ]);

    assert.equal(spawnCount, 1, 'Singleflight must spawn only one child');
    assert.equal(results.length, 3);
  });

  it('11. failed checksum keeps previous install', async () => {
    const dataDir = path.join(tmpRoot, 'checksum-rollback-test');
    ensureStudioConfig(dataDir);
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    const bin = path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.writeFileSync(bin, '#!/bin/sh\necho original\n', { mode: 0o755 });
    const originalHash = computeFileHash(bin);

    // Corrupt archive
    const corruptArchive = path.join(tmpRoot, 'corrupt.tar.gz');
    fs.writeFileSync(corruptArchive, 'bad-bytes', { mode: 0o600 });

    await assert.rejects(async () => {
      await installStudio({ dataDir, archivePath: corruptArchive, fetchFn: offlineFetch });
    }, /SHA256 checksum mismatch/);

    assert.equal(computeFileHash(bin), originalHash, 'Previous binary must be preserved');
  });

  it('12. import source preserved, no overwrite on conflict, and invalid dirs refused', async () => {
    const dataDir = path.join(tmpRoot, 'import-test');
    ensureStudioConfig(dataDir);

    const srcDir = path.join(tmpRoot, 'import-src');
    fs.mkdirSync(srcDir, { recursive: true, mode: 0o700 });

    // Invalid dir without storage-state.json
    const emptyAccount = path.join(srcDir, 'empty-acc');
    fs.mkdirSync(emptyAccount, { recursive: true, mode: 0o700 });

    // Valid account dir
    const validAccount = path.join(srcDir, 'user@example.com');
    fs.mkdirSync(validAccount, { recursive: true, mode: 0o700 });
    const validState = {
      cookies: [{ name: 'SAPISID', value: 'secret123', domain: '.google.com' }],
      origins: []
    };
    const srcStateFile = path.join(validAccount, 'storage-state.json');
    fs.writeFileSync(srcStateFile, JSON.stringify(validState, null, 2) + '\n', { mode: 0o600 });
    const originalBytes = fs.readFileSync(srcStateFile);

    // Run import via child process or script
    const studioScript = path.resolve('scripts/studio.mjs');
    const child1 = spawn(process.execPath, [studioScript, 'import', srcDir, '--data-dir', dataDir], {
      encoding: 'utf8'
    });
    const [code1] = await Promise.all([
      new Promise(r => child1.on('close', r))
    ]);
    assert.equal(code1, 0, 'Initial import should succeed');

    // Verify imported
    const destFile = path.join(dataDir, 'auth', 'user@example.com', 'storage-state.json');
    assert.ok(fs.existsSync(destFile));
    assert.equal(fs.statSync(destFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dataDir, 'auth', 'user@example.com')).mode & 0o777, 0o700);

    // Source bytes preserved
    assert.deepEqual(fs.readFileSync(srcStateFile), originalBytes);

    // Re-importing same bytes succeeds without error
    const child2 = spawn(process.execPath, [studioScript, 'import', srcDir, '--data-dir', dataDir], {
      encoding: 'utf8'
    });
    const [code2] = await Promise.all([
      new Promise(r => child2.on('close', r))
    ]);
    assert.equal(code2, 0, 'Re-importing identical bytes must succeed');

    // Modify destination file to cause conflict
    fs.writeFileSync(destFile, '{"conflicting": true}', { mode: 0o600 });

    // Conflicting import must be rejected without overwriting
    const child3 = spawn(process.execPath, [studioScript, 'import', srcDir, '--data-dir', dataDir], {
      encoding: 'utf8'
    });
    let stderr3 = '';
    child3.stderr.on('data', d => { stderr3 += d; });
    const [code3] = await Promise.all([
      new Promise(r => child3.on('close', r))
    ]);
    assert.notEqual(code3, 0, 'Conflicting import must fail');
    assert.ok(stderr3.includes('Conflict') || stderr3.includes('already exists'));
    assert.equal(fs.readFileSync(destFile, 'utf8'), '{"conflicting": true}', 'Conflicting file must not be overwritten');
  });

  it('13. cached admin cookie + server closed returns down (causes preserved)', async () => {
    let requests = [];
    const server = http.createServer((req, res) => {
      res.setHeader('Connection', 'close');
      requests.push(req.url);
      if (req.url === '/api/auth/login') {
        res.writeHead(200, {
          'Set-Cookie': 'aistudio_admin=valid_cookie; Path=/',
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({ authenticated: true }));
        return;
      }
      if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: STUDIO_VERSION, running: true, ready: false, accounts: { total: 0 } }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const local = {
      origin: `http://127.0.0.1:${port}`,
      baseURL: `http://127.0.0.1:${port}/v1`,
      adminUsername: 'magpie',
      adminPassword: 'pw'
    };

    try {
      // First call caches cookie
      const initialHealth = await checkStudioHealth(local, globalThis.fetch);
      assert.equal(initialHealth.state, 'up');

      server.closeAllConnections?.();
      await new Promise(r => server.close(r));

      // Calling checkStudioHealth with cached cookie must return 'down', not 'foreign'!
      const closedHealth = await checkStudioHealth(local, globalThis.fetch);
      assert.equal(closedHealth.state, 'down', 'Must return down on ECONNREFUSED even with cached cookie');
    } finally {
      server.closeAllConnections?.();
      try { server.close(); } catch {}
    }
  });

  it('14. readiness helper polls and handles state transitions properly', async () => {
    const dataDir = path.join(tmpRoot, 'readiness-test');
    ensureStudioConfig(dataDir);
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    const bin = path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const pin = PINNED_ARCHIVES[`${process.platform}-${process.arch}`];
    fs.writeFileSync(path.join(dataDir, 'install-manifest.json'), JSON.stringify({
      version: STUDIO_VERSION.slice(1),
      platform: process.platform,
      arch: process.arch,
      archiveSha256: pin.sha256,
      binarySha256: computeFileHash(bin)
    }, null, 2) + '\n', { mode: 0o600 });

    // Transition: LAUNCHING -> RUNNING (requires >= 2 status polls); running is true only in RUNNING
    let polls = 0;
    let startTriggered = 0;
    const mockFetchTransition = async (url, init) => {
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify({ authenticated: true }), { headers: { 'Set-Cookie': 'aistudio_admin=t; Path=/' } });
      }
      if (url.includes('/api/control/start')) {
        startTriggered++;
        return Response.json({ success: true });
      }
      if (url.includes('/api/status')) {
        polls++;
        if (polls < 3) {
          return Response.json({ version: STUDIO_VERSION, running: false, ready: false, state: 'LAUNCHING', accounts: { total: 1, ready: 0 } });
        }
        return Response.json({ version: STUDIO_VERSION, running: true, ready: true, state: 'RUNNING', accounts: { total: 1, ready: 1 } });
      }
      if (url.includes('/models')) {
        return Response.json({ object: 'list', data: [] });
      }
      return Response.json({});
    };

    const localReady = await ensureStudio({ dataDir, fetchFn: mockFetchTransition });
    assert.ok(localReady);
    assert.ok(polls >= 2, 'Must poll status at least twice during LAUNCHING');

    // Always not ready with low generationTimeoutMs rejects
    const mockFetchNeverReady = async (url) => {
      if (url.includes('/api/auth/login')) return new Response(JSON.stringify({ authenticated: true }), { headers: { 'Set-Cookie': 'aistudio_admin=t; Path=/' } });
      if (url.includes('/api/status')) return Response.json({ version: STUDIO_VERSION, running: false, ready: false, state: 'LAUNCHING', accounts: { total: 1, ready: 0 } });
      return Response.json({});
    };
    await assert.rejects(async () => {
      await ensureStudio({ dataDir, fetchFn: mockFetchNeverReady, generationTimeoutMs: 20 });
    }, /AI Studio generation did not become ready/);

    // Start HTTP 500 rejects
    const mockFetchStart500 = async (url) => {
      if (url.includes('/api/auth/login')) return new Response(JSON.stringify({ authenticated: true }), { headers: { 'Set-Cookie': 'aistudio_admin=t; Path=/' } });
      if (url.includes('/api/control/start')) return new Response(JSON.stringify({ error: 'fail' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/status')) return Response.json({ version: STUDIO_VERSION, running: false, ready: false, state: 'STOPPED', accounts: { total: 1, ready: 0 } });
      return Response.json({});
    };
    await assert.rejects(async () => {
      await ensureStudio({ dataDir, fetchFn: mockFetchStart500 });
    }, /500/);

    // managementOnly: true does not wait for generation start
    let startCalledManagementOnly = false;
    const mockFetchManagementOnly = async (url) => {
      if (url.includes('/api/auth/login')) return new Response(JSON.stringify({ authenticated: true }), { headers: { 'Set-Cookie': 'aistudio_admin=t; Path=/' } });
      if (url.includes('/api/control/start')) { startCalledManagementOnly = true; return Response.json({}); }
      if (url.includes('/api/status')) return Response.json({ version: STUDIO_VERSION, running: false, ready: false, state: 'STOPPED', accounts: { total: 1, ready: 0 } });
      return Response.json({});
    };
    const localMgmt = await ensureStudio({ dataDir, fetchFn: mockFetchManagementOnly, managementOnly: true });
    assert.ok(localMgmt);
    assert.equal(startCalledManagementOnly, false, 'managementOnly: true must not trigger control/start');
  });

  it('15. verifyProcessIdentity rejects child named like binary with different path', async () => {
    const dummyDir = path.join(tmpRoot, 'other-path-test');
    fs.mkdirSync(dummyDir, { recursive: true, mode: 0o700 });
    const dummyBin = path.join(dummyDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');

    // Create a dummy node script and spawn it
    fs.writeFileSync(dummyBin, '#!/bin/sh\nexec node -e "setInterval(()=>{},1000)"\n', { mode: 0o755 });
    const child = spawn(dummyBin, [], { stdio: 'ignore' });
    const pid = child.pid;

    const expectedDir = path.join(tmpRoot, 'expected-path-test');
    fs.mkdirSync(expectedDir, { recursive: true, mode: 0o700 });
    const expectedBin = path.join(expectedDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.writeFileSync(expectedBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    try {
      const match = verifyProcessIdentity(pid, expectedBin);
      assert.equal(match, false, 'verifyProcessIdentity must return false when paths differ');
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });

  it('16. import preflight rejects new account containing symlink without creating destination', async () => {
    const dataDir = path.join(tmpRoot, 'import-symlink-test');
    ensureStudioConfig(dataDir);

    const srcDir = path.join(tmpRoot, 'import-symlink-src');
    fs.mkdirSync(srcDir, { recursive: true, mode: 0o700 });

    const accDir = path.join(srcDir, 'symlink-user@example.com');
    fs.mkdirSync(accDir, { recursive: true, mode: 0o700 });

    const validState = {
      cookies: [{ name: 'SAPISID', value: 'secret123', domain: '.google.com' }],
      origins: []
    };
    fs.writeFileSync(path.join(accDir, 'storage-state.json'), JSON.stringify(validState, null, 2) + '\n', { mode: 0o600 });

    // Create an extra symlink file inside the account
    const fixtureTarget = path.join(srcDir, 'dummy-target.txt');
    fs.writeFileSync(fixtureTarget, 'fixture content\n');
    fs.symlinkSync(fixtureTarget, path.join(accDir, 'evil-symlink.txt'));

    const studioScript = path.resolve('scripts/studio.mjs');
    const child = spawn(process.execPath, [studioScript, 'import', srcDir, '--data-dir', dataDir], {
      encoding: 'utf8'
    });
    const [code] = await Promise.all([
      new Promise(r => child.on('close', r))
    ]);

    assert.notEqual(code, 0, 'Import must fail when an account contains a symlink');
    const destAccDir = path.join(dataDir, 'auth', 'symlink-user@example.com');
    assert.equal(fs.existsSync(destAccDir), false, 'Destination account directory must NOT be created');
    assert.ok(fs.existsSync(fixtureTarget), 'Source fixture must be unchanged');
  });

  it('17. an earlier install still running is reported outdated, not foreign, and install refuses', async () => {
    const dataDir = path.join(tmpRoot, 'outdated-status-test');
    ensureStudioConfig(dataDir);
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const health = await checkStudioHealth(localStudio({ dataDir }), earlierVersionFetch);
    assert.equal(health.state, 'outdated');
    assert.match(health.reason, /v0\.2\.11/);

    const status = await studioStatus({ dataDir, fetchFn: earlierVersionFetch });
    assert.equal(status.status, 'outdated');
    assert.equal(status.version, 'v0.2.11');
    assert.equal(status.expected, STUDIO_VERSION);

    await assert.rejects(
      installStudio({ dataDir, fetchFn: earlierVersionFetch }),
      /while v0\.2\.11 from an earlier install is running/
    );
  });

  it('18. ensureStudio stops an earlier install still running and starts the pinned version', async () => {
    const dataDir = path.join(tmpRoot, 'outdated-replace-test');
    const port = await freePort();
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      version: 1, port, apiKey: 'outdated-key', adminUsername: 'magpie', adminPassword: 'outdated-pw', proxy: ''
    }) + '\n', { mode: 0o600 });

    // The earlier install: a copy of node at the binary's path, so the PID passes the identity check
    const bin = path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.copyFileSync(process.execPath, bin, fs.constants.COPYFILE_FICLONE);
    writeValidManifest(dataDir, bin);
    // A node linked to its own libnode (Homebrew) finds it next to the original
    const nodeLib = path.join(path.dirname(fs.realpathSync(process.execPath)), '..', 'lib');
    const earlier = spawn(bin, ['-e', STAND_IN_SERVICE], {
      env: { ...process.env, PORT: String(port), VERSION: 'v0.2.11', DYLD_LIBRARY_PATH: nodeLib, LD_LIBRARY_PATH: nodeLib },
      stdio: 'ignore'
    });
    const earlierExit = new Promise(resolve => earlier.on('exit', resolve));
    fs.writeFileSync(path.join(dataDir, 'backend.pid'), `${earlier.pid}\n`, { mode: 0o600 });

    let pinned;
    let spawned = 0;
    try {
      const deadline = Date.now() + 10000;
      while ((await studioStatus({ dataDir })).status !== 'outdated') {
        assert.ok(Date.now() < deadline, 'stand-in for the earlier install did not come up');
        await new Promise(r => setTimeout(r, 100));
      }

      const spawnPinned = () => {
        spawned++;
        pinned = http.createServer((req, res) => {
          if (req.url === '/api/auth/login') {
            res.writeHead(200, { 'Set-Cookie': 'aistudio_admin=p; Path=/', 'Content-Type': 'application/json' });
            return res.end('{}');
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (req.url === '/api/status') {
            return res.end(JSON.stringify({ version: STUDIO_VERSION, ready: true, running: true, state: 'RUNNING', accounts: { total: 1, ready: 1 } }));
          }
          res.end(JSON.stringify({ object: 'list', data: [] }));
        }).listen(port, '127.0.0.1');
        return { pid: 999999, on: () => {}, unref: () => {} };
      };

      const local = await ensureStudio({ dataDir, spawnFn: spawnPinned });
      assert.equal(local.port, port);
      assert.equal(spawned, 1, 'the pinned version must be started once');
      await earlierExit;
      assert.equal((await studioStatus({ dataDir })).status, 'running');
    } finally {
      try { earlier.kill('SIGKILL'); } catch {}
      pinned?.closeAllConnections?.();
      if (pinned) await new Promise(r => pinned.close(r));
    }
  });

  it('19. an earlier install whose process cannot be verified is left running with a clear error', async () => {
    const dataDir = path.join(tmpRoot, 'outdated-unverified-test');
    ensureStudioConfig(dataDir);
    const pkgDir = path.join(dataDir, 'package');
    fs.mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
    const bin = path.join(pkgDir, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeValidManifest(dataDir, bin);
    // No backend.pid: nothing says which process to stop

    let spawned = false;
    await assert.rejects(
      ensureStudio({ dataDir, fetchFn: earlierVersionFetch, spawnFn: () => { spawned = true; return { pid: 1, on: () => {}, unref: () => {} }; } }),
      /v0\.2\.11 from an earlier install is still running and could not be stopped/
    );
    assert.equal(spawned, false, 'nothing may be started while the earlier install holds the port');
  });

  // installedStandIn sets up dataDir as an installed setup whose binary is a placeholder.
  function installedStandIn(name) {
    const dataDir = path.join(tmpRoot, name);
    ensureStudioConfig(dataDir);
    const bin = path.join(dataDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.mkdirSync(path.dirname(bin), { recursive: true, mode: 0o700 });
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeValidManifest(dataDir, bin);
    return { dataDir, bin };
  }

  it('20. a service that answers with errors or times out is unresponsive, not foreign', async () => {
    const { dataDir } = installedStandIn('unresponsive-test');
    const local = localStudio({ dataDir });

    const loginFails = status => async () => new Response('busy', { status });
    assert.equal((await checkStudioHealth(local, loginFails(503))).state, 'unresponsive');
    assert.equal((await checkStudioHealth(local, loginFails(429))).state, 'unresponsive');
    assert.equal((await checkStudioHealth(local, loginFails(401))).state, 'foreign');

    const statusTimesOut = async url => {
      if (url.includes('/api/auth/login')) {
        return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=t; Path=/' } });
      }
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    assert.equal((await checkStudioHealth(local, statusTimesOut)).state, 'unresponsive');
    assert.equal((await studioStatus({ dataDir, fetchFn: loginFails(503) })).status, 'unresponsive');

    // One that stays so is reported as not responding, and nothing is started over it
    let spawned = false;
    await assert.rejects(
      ensureStudio({ dataDir, fetchFn: loginFails(503), unresponsiveTimeoutMs: 300, spawnFn: () => { spawned = true; return { pid: 1, on: () => {}, unref: () => {} }; } }),
      err => /not responding/.test(err.message) && !/another service/.test(err.message)
    );
    assert.equal(spawned, false);
  });

  it('21. a service that answers with errors while it starts is waited for', async () => {
    const { dataDir } = installedStandIn('starting-errors-test');
    let spawned = 0;
    let loginsAfterSpawn = 0;
    const fetchFn = async url => {
      if (!spawned) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      if (url.includes('/api/auth/login')) {
        if (++loginsAfterSpawn <= 3) return new Response('starting', { status: 503 });
        return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=t; Path=/' } });
      }
      if (url.includes('/api/status')) return Response.json(runningStatus({ total: 1, ready: 1, busy: 0, cooldown: 0, auth_required: 0 }));
      return Response.json({ object: 'list', data: [] });
    };
    const spawnFn = () => { spawned++; return { pid: 9999999, on: () => {}, unref: () => {} }; };

    const local = await ensureStudio({ dataDir, fetchFn, spawnFn, startTimeoutMs: 5000 });
    assert.ok(local);
    assert.equal(spawned, 1);
    assert.ok(loginsAfterSpawn > 3, 'the 503 answers were waited out');
  });

  it('22. RUNNING takes requests with no account ready; accounts that all need to sign in fail fast', async () => {
    const { dataDir } = installedStandIn('readiness-accounts-test');

    // All accounts cooling down: the backend answers requests saying so, nothing to wait for
    const started = Date.now();
    await ensureStudio({ dataDir, fetchFn: adminFetch(() => runningStatus({ total: 1, ready: 0, busy: 0, cooldown: 1, auth_required: 0 })) });
    assert.ok(Date.now() - started < 2000, 'must not wait for an account to come out of cooldown');

    let starts = 0;
    const signedOut = state => adminFetch(() => launchingStatus(state, { total: 2, ready: 0, busy: 0, cooldown: 0, auth_required: 2 }), () => { starts++; });
    await assert.rejects(ensureStudio({ dataDir, fetchFn: signedOut('LAUNCHING') }), /need to sign in again \(2 of 2\)/);
    await assert.rejects(ensureStudio({ dataDir, fetchFn: signedOut('STOPPED') }), /need to sign in again/);
    assert.equal(starts, 0, 'generation is not started for accounts that cannot serve');
  });

  it('23. a management-only caller does not wait for generation, and a full caller is not answered by one', async () => {
    const { dataDir } = installedStandIn('mixed-callers-test');
    let launched = false;
    const fetchFn = adminFetch(() => launched
      ? runningStatus({ total: 1, ready: 1, busy: 0, cooldown: 0, auth_required: 0 })
      : launchingStatus('LAUNCHING', { total: 1, ready: 0, busy: 0, cooldown: 0, auth_required: 0 }));

    // A full caller in flight: a management-only caller must not wait for it
    const full = ensureStudio({ dataDir, fetchFn, generationTimeoutMs: 5000 });
    let fullDone = false;
    full.then(() => { fullDone = true; }, () => {});
    await ensureStudio({ dataDir, fetchFn, managementOnly: true });
    assert.equal(fullDone, false, 'generation is still launching');
    launched = true;
    await full;

    // A management-only caller in flight: a full caller must still wait for generation
    launched = false;
    const management = ensureStudio({ dataDir, fetchFn, managementOnly: true });
    const full2 = ensureStudio({ dataDir, fetchFn, generationTimeoutMs: 5000 });
    let full2Done = false;
    full2.then(() => { full2Done = true; }, () => {});
    await management;
    await new Promise(r => setTimeout(r, 300));
    assert.equal(full2Done, false, 'a full caller waits for RUNNING');
    launched = true;
    await full2;
  });

  it('24. stop without a live process in backend.pid reports a service that still answers', async () => {
    const { dataDir } = installedStandIn('stop-no-pid-test');
    const pidFile = path.join(dataDir, 'backend.pid');
    const up = adminFetch(() => runningStatus({ total: 1, ready: 1, busy: 0, cooldown: 0, auth_required: 0 }));

    const noPid = await stopStudio({ dataDir, fetchFn: up });
    assert.equal(noPid.stopped, false);
    assert.match(noPid.reported, /Cannot identify a verified AIStudio2API process/);

    fs.writeFileSync(pidFile, '9999999\n', { mode: 0o600 });
    const stalePid = await stopStudio({ dataDir, fetchFn: up });
    assert.equal(stalePid.stopped, false);
    assert.equal(fs.existsSync(pidFile), false, 'a stale pid file is removed');

    assert.deepEqual(await stopStudio({ dataDir, fetchFn: offlineFetch }), { stopped: true });
  });

  it('25. a download goes through the proxy saved in config.json', { skip: process.platform === 'win32' }, async () => {
    const dataDir = path.join(tmpRoot, 'saved-proxy-test');
    ensureStudioConfig(dataDir, 'http://127.0.0.1:1082');

    // A curl that records its arguments and fails like a refused download
    const fakeBin = path.join(tmpRoot, 'fake-curl-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CURL_ARGS"\necho "curl: (7) Failed to connect to 127.0.0.1 port 1082" >&2\nexit 7\n', { mode: 0o755 });
    const argsFile = path.join(tmpRoot, 'curl-args.txt');
    const curlArgs = () => fs.readFileSync(argsFile, 'utf8').split('\n');

    const saved = { PATH: process.env.PATH, AI_STUDIO_PROXY: process.env.AI_STUDIO_PROXY, CURL_ARGS: process.env.CURL_ARGS };
    try {
      process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
      delete process.env.AI_STUDIO_PROXY;
      process.env.CURL_ARGS = argsFile;

      // The error says why curl failed
      await assert.rejects(installStudio({ dataDir }), /via curl \(status: 7\): curl: \(7\) Failed to connect to 127\.0\.0\.1 port 1082/);
      assert.equal(curlArgs()[curlArgs().indexOf('--proxy') + 1], 'http://127.0.0.1:1082');

      // An explicit empty proxy turns it off
      await assert.rejects(installStudio({ dataDir, proxy: '' }), /via curl/);
      assert.ok(!curlArgs().includes('--proxy'));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('26. the admin session cookie is found among several Set-Cookie headers', async () => {
    let sentCookie;
    const fetchFn = async (url, init) => {
      if (url.includes('/api/auth/login')) {
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Set-Cookie', 'theme=dark; Path=/');
        headers.append('Set-Cookie', 'aistudio_admin=second; Path=/; HttpOnly');
        return new Response('{}', { headers });
      }
      sentCookie = init.headers.get('Cookie');
      return Response.json({ ok: true });
    };
    const local = {
      origin: 'http://127.0.0.1:1',
      baseURL: 'http://127.0.0.1:1/v1',
      adminUsername: 'magpie',
      adminPassword: crypto.randomBytes(8).toString('hex')
    };
    await studioAdmin(local, 'GET', '/api/status', null, { fetchFn });
    assert.equal(sentCookie, 'aistudio_admin=second');
  });

  it('27. a new setup takes the default port only when nothing uses it, and keeps an existing one', async () => {
    const free = await freePort();
    assert.equal(await pickStudioPort(free), free);

    // Taken on loopback, or on all addresses (which on macOS still lets 127.0.0.1 be bound)
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      const taken = http.createServer();
      await new Promise(r => taken.listen(0, host, r));
      const { port } = taken.address();
      try {
        const picked = await pickStudioPort(port);
        assert.notEqual(picked, port, `a port used on ${host} is not picked`);
        assert.ok(picked > 0);
      } finally {
        await new Promise(r => taken.close(r));
      }
    }

    // A first start with its preferred port taken writes another one, and starts on it
    const taken = http.createServer();
    await new Promise(r => taken.listen(0, '127.0.0.1', r));
    const busy = taken.address().port;
    try {
      const { dataDir, bin } = installedStandIn('first-port-test');
      fs.rmSync(path.join(dataDir, 'config.json'));
      let spawned = 0;
      const fetchFn = async (url) => {
        if (!spawned) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
        return adminFetch(() => runningStatus({ total: 0, ready: 0, busy: 0, cooldown: 0, auth_required: 0 }))(url);
      };
      const local = await ensureStudio({ dataDir, fetchFn, preferredPort: busy, spawnFn: () => { spawned++; return { pid: 1, on: () => {}, unref: () => {} }; } });
      assert.ok(fs.existsSync(bin));
      assert.notEqual(local.port, busy);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).port, local.port);

      // Once written, the port is kept even when it is the one taken
      const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ ...config, port: busy }) + '\n', { mode: 0o600 });
      assert.equal(ensureStudioConfig(dataDir).port, busy);
    } finally {
      await new Promise(r => taken.close(r));
    }
  });

  it('28. a start sets a large backend.log aside', async () => {
    const dataDir = path.join(tmpRoot, 'log-rotate-test');
    installedStandIn('log-rotate-test');
    ensureStudioConfig(dataDir);
    const log = path.join(dataDir, 'backend.log');
    fs.writeFileSync(`${log}.1`, 'older');
    fs.writeFileSync(log, 'big');
    fs.truncateSync(log, 11 * 1024 * 1024);

    let spawned = 0;
    const fetchFn = async (url) => {
      if (!spawned) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      return adminFetch(() => runningStatus({ total: 0, ready: 0, busy: 0, cooldown: 0, auth_required: 0 }))(url);
    };
    const spawnFn = () => { spawned++; return { pid: 9999999, on: () => {}, unref: () => {} }; };
    await ensureStudio({ dataDir, fetchFn, spawnFn });
    assert.equal(fs.statSync(`${log}.1`).size, 11 * 1024 * 1024, 'the large log replaces the one set aside before');
    assert.equal(fs.statSync(log).size, 0);

    // A small log is kept as it is
    fs.writeFileSync(log, 'small');
    spawned = 0;
    await ensureStudio({ dataDir, fetchFn, spawnFn });
    assert.equal(fs.readFileSync(log, 'utf8'), 'small');
  });

  it('29. messages that ask for a command give one that runs from anywhere', async () => {
    const command = studioCommand('relogin');
    const [, script] = /^node "(.+)" relogin$/.exec(command);
    assert.ok(path.isAbsolute(script) && fs.existsSync(script), 'the CLI is named by its full path');

    const dataDir = path.join(tmpRoot, 'relogin-hint-test');
    installedStandIn('relogin-hint-test');
    ensureStudioConfig(dataDir);
    const signedOut = adminFetch(() => launchingStatus('STOPPED', { total: 1, ready: 0, busy: 0, cooldown: 0, auth_required: 1 }));
    await assert.rejects(ensureStudio({ dataDir, fetchFn: signedOut }), err => err.message.includes('用 Google 账号登录（推荐）') && err.message.includes(studioCommand('relogin', { dataDir })));
  });

  // The release archive this machine installed, if any, to install again from without a download.
  const pin = PINNED_ARCHIVES[`${process.platform}-${process.arch}`];
  const realArchive = pin && (process.env.AI_STUDIO_TEST_ARCHIVE || path.join(studioDataDir(), pin.asset));
  const haveRealArchive = Boolean(realArchive && fs.existsSync(realArchive) && computeFileHash(realArchive) === pin.sha256);

  it('30. an install takes the archive an earlier one kept only when it checks out', async () => {
    const dataDir = path.join(tmpRoot, 'kept-archive-test');
    ensureStudioConfig(dataDir, '');
    // A damaged copy is downloaded again (here: offline, so the install fails saying so)
    fs.writeFileSync(path.join(dataDir, pin.asset), 'damaged', { mode: 0o600 });
    await assert.rejects(installStudio({ dataDir, fetchFn: offlineFetch }), /offline fixture/);
  });

  it('30b. a kept archive installs offline, and older versions\' archives are removed', { skip: process.platform === 'win32' || !haveRealArchive }, async t => {
    const dataDir = path.join(tmpRoot, 'kept-archive-ok-test');
    ensureStudioConfig(dataDir, '');
    fs.copyFileSync(realArchive, path.join(dataDir, pin.asset));
    const older = pin.asset.replace(`v${STUDIO_VERSION.slice(1)}`, 'v0.2.11');
    fs.writeFileSync(path.join(dataDir, older), 'old');
    fs.writeFileSync(path.join(dataDir, 'notes.tar.gz'), 'not ours');
    // Offline: only the kept archive can install it
    const local = await installStudio({ dataDir, fetchFn: offlineFetch });
    assert.ok(local && fs.existsSync(path.join(dataDir, 'package')));
    assert.ok(fs.existsSync(path.join(dataDir, pin.asset)));
    assert.equal(fs.existsSync(path.join(dataDir, older)), false);
    assert.ok(fs.existsSync(path.join(dataDir, 'notes.tar.gz')));

    // Simulate a stopped admin-updated executable. Recovery must reinstall from the
    // verified archive, preserving accounts/config and refusing to execute changed bytes.
    const bin = path.join(dataDir, 'package', 'aistudio2api');
    const verifiedHash = computeFileHash(bin);
    const configBefore = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
    fs.mkdirSync(path.join(dataDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'auth', 'sentinel'), 'account data');
    fs.appendFileSync(bin, '\nchanged by updater');
    let spawned = false;
    const fetchFn = async (url, init) => {
      if (!spawned) return offlineFetch();
      return adminFetch(() => runningStatus({ total: 0 }))(url, init);
    };
    await ensureStudio({ dataDir, fetchFn, spawnFn: file => {
      assert.equal(computeFileHash(file), verifiedHash);
      spawned = true;
      return { on() {}, unref() {} };
    } });
    assert.equal(spawned, true);
    assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), configBefore);
    assert.equal(fs.readFileSync(path.join(dataDir, 'auth', 'sentinel'), 'utf8'), 'account data');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'install-manifest.json'))).binarySha256, verifiedHash);
    assert.equal(fs.statSync(path.join(dataDir, 'package')).mode & 0o777, 0o555);
    assert.throws(() => fs.writeFileSync(path.join(dataDir, 'package', '.aistudio2api.new'), 'update'), /EACCES|EPERM/);
    // An explicit install can replace a protected package and remove its backup.
    await installStudio({ dataDir, fetchFn: offlineFetch });
    assert.equal(fs.statSync(path.join(dataDir, 'package')).mode & 0o777, 0o555);
    assert.equal(fs.readdirSync(dataDir).some(n => n.startsWith('.package.backup.')), false);

    // Failure after swapping must restore the previous protected directory and manifest.
    const previousManifest = fs.readFileSync(path.join(dataDir, 'install-manifest.json'), 'utf8');
    const chmod = fs.chmodSync;
    let injected = false;
    const patch = t.mock.method(fs, 'chmodSync', (file, mode) => {
      if (!injected && file === path.join(dataDir, 'install-manifest.json')) {
        injected = true;
        throw new Error('simulated manifest permission failure');
      }
      return chmod(file, mode);
    });
    try {
      await assert.rejects(installStudio({ dataDir, fetchFn: offlineFetch }), /simulated manifest permission failure/);
    } finally { patch.mock.restore(); }
    assert.equal(computeFileHash(bin), verifiedHash);
    assert.equal(fs.readFileSync(path.join(dataDir, 'install-manifest.json'), 'utf8'), previousManifest);
    assert.equal(fs.statSync(path.join(dataDir, 'package')).mode & 0o777, 0o555);
    assert.equal(fs.readdirSync(dataDir).some(n => n.startsWith('.package.backup.')), false);
  });
});
