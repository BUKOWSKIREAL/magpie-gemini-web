import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawn, execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import {
  useStudioBinary, useDefaultStudio, validateStudioBinary, binaryPath, localStudio,
  ensureStudio, ensureStudioConfig, checkStudioHealth, studioStatus, installStudio,
  stopStudio, cleanStudio, hasStudioAssets, readStudioEnv, saveStudioProxy, serviceEnv,
  computeFileHash, pickStudioPort, nodeFetch
} from '../lib/studio-native.mjs';
import { cleanDownloadedAssets } from '../lib/cleanup.mjs';

const execFileAsync = promisify(execFile);
const offline = async () => { throw Object.assign(new Error('fixture offline'), { code: 'ECONNREFUSED' }); };
const status = version => ({ version, running: true, ready: true, state: 'RUNNING', accounts: { total: 1, ready: 1 } });
function responding(version = 'v99.0.0') {
  return async url => {
    if (url.includes('/api/auth/login')) return new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'aistudio_admin=user-test; Path=/' }
    });
    if (url.includes('/api/status')) return Response.json(status(version));
    return Response.json({ object: 'list', data: [] });
  };
}

function fixture(t, name = 'data with spaces') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-user-studio-'));
  const dataDir = path.join(root, name);
  const bin = path.join(root, process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
  fs.writeFileSync(bin, 'user version one', { mode: 0o755 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, bin, options: { dataDir, fetchFn: offline, preferredPort: 0 } };
}

const STAND_IN = `
const http = require('node:http');
function listen() {
  http.createServer((req, res) => {
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/api/auth/login') { res.setHeader('Set-Cookie', 'aistudio_admin=user-test; Path=/'); return json({}); }
    if (req.url === '/api/status') return json({ version: 'v99.0.0', running: true, ready: true, state: 'RUNNING', accounts: { total: 0 } });
    if (req.url === '/v1/models') return json({ object: 'list', data: [] });
    if (req.url === '/api/control/stop') return json({});
    res.writeHead(404); res.end();
  }).listen(Number(process.env.PORT), '127.0.0.1', () => process.send?.('listening'));
}
if (process.env.WAIT_FOR_SERVE) { process.on('message', listen); process.send('waiting'); }
else listen();
`;

async function startStandIn(bin, dataDir, port, wait = false) {
  const libDir = path.join(path.dirname(fs.realpathSync(process.execPath)), '..', 'lib');
  const child = spawn(bin, ['-e', STAND_IN, '--', `-auth=${path.join(dataDir, 'auth')}`], {
    env: { ...process.env, PORT: String(port), WAIT_FOR_SERVE: wait ? '1' : '', DYLD_LIBRARY_PATH: libDir, LD_LIBRARY_PATH: libDir },
    cwd: dataDir, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture did not start: ' + stderr)); }, 10000);
    child.once('message', () => { clearTimeout(timer); resolve(); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('fixture exited: ' + stderr)); });
  });
  return child;
}
async function endChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
}

// These tests use isolated data and never replace a real AIStudio2API installation.
describe('User-managed AIStudio2API', () => {
  it('persists the selected executable and preserves an existing account, port and credentials', async t => {
    const f = fixture(t);
    const before = ensureStudioConfig(f.dataDir, '', { port: await pickStudioPort(0) });
    fs.writeFileSync(path.join(f.dataDir, 'auth', 'account.json'), 'keep account');
    const selected = await useStudioBinary(f.bin, f.options);
    const again = localStudio({ dataDir: f.dataDir });
    assert.deepEqual(again, selected);
    assert.equal(again.backendMode, 'user');
    assert.equal(binaryPath(f.dataDir), f.bin);
    for (const key of ['port', 'apiKey', 'adminUsername', 'adminPassword']) assert.equal(again[key], before[key]);
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'auth', 'account.json'), 'utf8'), 'keep account');
    assert.equal(fs.readFileSync(f.bin, 'utf8'), 'user version one');
    assert.equal(fs.existsSync(path.join(f.dataDir, 'package')), false);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'install-manifest.json')), false);
  });

  it('accepts newer, older and custom versions without weakening authentication or status checks', async t => {
    const f = fixture(t);
    const local = await useStudioBinary(f.bin, f.options);
    for (const version of ['v0.3.7', 'v99.0.0', 'v0.2.19', 'custom-build']) {
      assert.equal((await checkStudioHealth(local, responding(version))).state, 'up');
      const report = await studioStatus({ dataDir: f.dataDir, fetchFn: responding(version) });
      assert.equal(report.status, 'running');
      assert.equal(report.version, version);
      assert.equal(report.backendMode, 'user');
    }
    const wrongKey = async (url, init) => url.endsWith('/models') ? new Response('', { status: 401 }) : responding()(url, init);
    assert.equal((await checkStudioHealth(local, wrongKey)).state, 'foreign');
    const malformed = async (url, init) => url.endsWith('/api/status') ? Response.json({ version: 'v99.0.0' }) : responding()(url, init);
    assert.equal((await checkStudioHealth(local, malformed)).state, 'foreign');
    await assert.rejects(ensureStudio({ dataDir: f.dataDir, fetchFn: wrongKey }), /another service/);
  });

  it('starts the selected file again after replacement, without installing or enforcing a hash', async t => {
    const f = fixture(t);
    await useStudioBinary(f.bin, f.options);
    fs.writeFileSync(path.join(f.dataDir, 'install-manifest.json'), '{old invalid manifest}');
    let running = false;
    const launches = [];
    const fetchFn = async (url, init) => {
      assert.ok(new URL(url).hostname === '127.0.0.1', 'no download or update lookup');
      return running ? responding()(url, init) : offline();
    };
    const spawnFn = (file, args, options) => {
      launches.push({ file, args, options }); running = true;
      return { pid: 9999999, on() {}, unref() {} };
    };
    const options = { dataDir: f.dataDir, fetchFn, spawnFn, managementOnly: true };
    await ensureStudio(options);
    assert.equal(launches[0].file, f.bin);
    assert.deepEqual(launches[0].args, ['-open-ui=false', `-auth=${path.join(f.dataDir, 'auth')}`]);
    assert.equal(launches[0].options.cwd, f.dataDir);
    await ensureStudio(options);
    assert.equal(launches.length, 1, 'reuse the healthy custom backend');
    running = false;
    fs.writeFileSync(f.bin, 'user version two');
    await ensureStudio(options);
    assert.equal(launches.length, 2);
    assert.equal(fs.readFileSync(f.bin, 'utf8'), 'user version two');
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'install-manifest.json'), 'utf8'), '{old invalid manifest}');
    assert.equal(fs.existsSync(path.join(f.dataDir, 'package')), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.bin).mode & 0o777, 0o755);
  });

  it('retains new upstream settings, sparse defaults and the chosen generation backend across restarts', async t => {
    const f = fixture(t);
    await useStudioBinary(f.bin, f.options);
    fs.appendFileSync(path.join(f.dataDir, '.env'), 'NEW_UPSTREAM_SETTING="value with spaces # kept"\nWAA_BACKEND=camoufox\nUPSTREAM_CHANNELS=playground,assistant\nREQUEST_TIMEOUT=45m\n');
    const savedHost = process.env.NEW_UPSTREAM_SETTING;
    process.env.NEW_UPSTREAM_SETTING = 'host must not override saved value';
    t.after(() => { if (savedHost === undefined) delete process.env.NEW_UPSTREAM_SETTING; else process.env.NEW_UPSTREAM_SETTING = savedHost; });
    const config = ensureStudioConfig(f.dataDir);
    saveStudioProxy(f.dataDir, 'http://127.0.0.1:7890');
    const env = readStudioEnv(f.dataDir);
    assert.equal(env.NEW_UPSTREAM_SETTING, 'value with spaces # kept');
    assert.equal(env.WAA_BACKEND, 'camoufox');
    assert.equal(env.UPSTREAM_CHANNELS, 'playground,assistant');
    assert.equal(env.REQUEST_TIMEOUT, '45m');
    assert.equal(env.FIRST_EVENT_HEDGE, undefined, 'upstream owns omitted defaults');
    assert.equal(env.SEARCH_MODEL_ALIASES, undefined);
    assert.equal(serviceEnv(f.dataDir, config).WAA_BACKEND, undefined);
    let launch;
    await ensureStudio({
      dataDir: f.dataDir, managementOnly: true,
      fetchFn: (url, init) => launch ? responding()(url, init) : offline(),
      spawnFn: (_file, _args, options) => { launch = options; return { on() {}, unref() {} }; }
    });
    assert.equal(launch.env.NEW_UPSTREAM_SETTING, undefined);
    assert.equal(readStudioEnv(f.dataDir).NEW_UPSTREAM_SETTING, env.NEW_UPSTREAM_SETTING);
  });

  it('fails clearly for a removed executable and refuses official installs until explicitly switched', async t => {
    const f = fixture(t);
    await useStudioBinary(f.bin, f.options);
    fs.rmSync(f.bin);
    await assert.rejects(ensureStudio({ ...f.options, spawnFn() { assert.fail('must not spawn'); } }), /missing or not executable/);
    await assert.rejects(installStudio(f.options), /custom executable/);
    assert.equal(localStudio(f.options).binaryPath, f.bin, 'missing file must not erase the selection');
    assert.equal(fs.existsSync(path.join(f.dataDir, 'package')), false);
    await useDefaultStudio(f.options);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json'))).backend, undefined);
  });

  it('rejects bad selections and refuses to fall back from corrupt backend configuration', async t => {
    const f = fixture(t);
    assert.throws(() => validateStudioBinary('', f.options), /executable/);
    assert.throws(() => validateStudioBinary(f.root, f.options), /not executable/);
    assert.throws(() => validateStudioBinary(f.bin + '\n', f.options), /executable/);
    ensureStudioConfig(f.dataDir);
    const ownedBin = path.join(f.dataDir, 'aistudio2api');
    fs.copyFileSync(f.bin, ownedBin);
    assert.throws(() => validateStudioBinary(ownedBin, f.options), /outside/);
    if (process.platform !== 'win32') {
      const link = path.join(f.root, 'symlink-to-owned');
      fs.symlinkSync(ownedBin, link);
      assert.throws(() => validateStudioBinary(link, f.options), /outside/);
      fs.chmodSync(f.bin, 0o600);
      assert.throws(() => validateStudioBinary(f.bin, f.options), /not executable/);
    }
    const configPath = path.join(f.dataDir, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath));
    config.backend = { mode: 'typo', binaryPath: f.bin };
    fs.writeFileSync(configPath, JSON.stringify(config));
    await assert.rejects(ensureStudio(f.options), /Invalid backend configuration/);
    await assert.rejects(cleanStudio(f.options), /Invalid backend configuration/);
    assert.equal(hasStudioAssets(f.dataDir), false);
    assert.equal(fs.readFileSync(ownedBin, 'utf8'), 'user version one');
  });

  it('requires a stopped service before changing selection and keeps files on explicit return to the default directory', async t => {
    const f = fixture(t);
    const selected = await useStudioBinary(f.bin, f.options);
    const second = path.join(f.root, 'another-backend');
    fs.copyFileSync(f.bin, second);
    const saved = fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8');
    await assert.rejects(useStudioBinary(second, { ...f.options, fetchFn: responding() }), /Stop the current/);
    await assert.rejects(useDefaultStudio({ ...f.options, fetchFn: responding() }), /Stop the current/);
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8'), saved);
    assert.deepEqual(await useStudioBinary(f.bin, { ...f.options, fetchFn: responding() }), selected, 'selecting the active path is a no-op');
    await useDefaultStudio(f.options);
    const after = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'config.json')));
    assert.equal(after.backend, undefined);
    assert.equal(after.apiKey, selected.apiKey);
    assert.equal(fs.readFileSync(f.bin, 'utf8'), 'user version one');
    assert.equal(fs.existsSync(path.join(f.dataDir, 'package')), false, 'selection alone never downloads');
  });

  it('recovers a replacement PID without stopping another instance of the same user executable', { timeout: 30000 }, async t => {
    const f = fixture(t);
    fs.copyFileSync(process.execPath, f.bin, fs.constants.COPYFILE_FICLONE);
    const local = await useStudioBinary(f.bin, f.options);
    const otherDir = path.join(f.dataDir, 'auth another data directory'); // shares the entire auth prefix plus a space
    fs.mkdirSync(otherDir);
    const other = await startStandIn(f.bin, otherDir, await pickStudioPort(0));
    let ours;
    try {
      ours = await startStandIn(f.bin, f.dataDir, local.port, true);
      // A stale record points at another instance using exactly the same executable.
      fs.writeFileSync(path.join(f.dataDir, 'backend.pid'), String(other.pid));
      await assert.rejects(ensureStudio({ ...f.options, spawnFn() { assert.fail('must not launch in restart gap'); } }), /still be running or restarting/);
      await assert.rejects(useDefaultStudio(f.options), /still be running or restarting/);
      const listening = new Promise(resolve => ours.once('message', resolve));
      ours.send('serve');
      await listening;
      assert.equal((await studioStatus({ dataDir: f.dataDir, fetchFn: nodeFetch })).status, 'running');
      assert.equal((await stopStudio({ dataDir: f.dataDir, fetchFn: nodeFetch })).stopped, true);
      process.kill(other.pid, 0);
      assert.equal((await stopStudio({ ...f.options })).stopped, true, 'an unrelated instance does not count as this service');
    } finally {
      if (ours) await endChild(ours);
      await endChild(other);
    }
  });

  for (const mode of ['local', 'user']) it(mode + ' keeps an uninspectable PID and recovers scope only with the same recorded process start', { timeout: 60000 }, async t => {
    const f = fixture(t);
    fs.copyFileSync(process.execPath, f.bin, fs.constants.COPYFILE_FICLONE);
    await useStudioBinary(f.bin, f.options);
    if (mode === 'local') {
      await useDefaultStudio(f.options);
      fs.mkdirSync(path.join(f.dataDir, 'package'));
      fs.copyFileSync(f.bin, binaryPath(f.dataDir), fs.constants.COPYFILE_FICLONE);
    }
    let child, ready;
    const libDir = path.join(path.dirname(fs.realpathSync(process.execPath)), '..', 'lib');
    await ensureStudio({ ...f.options, managementOnly: true, fetchFn: (url, init) => child ? responding()(url, init) : offline(),
      spawnFn(file, args, options) {
        child = spawn(file, ['-e', STAND_IN, '--', ...args], { ...options,
          env: { ...options.env, WAIT_FOR_SERVE: '1', DYLD_LIBRARY_PATH: libDir, LD_LIBRARY_PATH: libDir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        ready = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
        return child;
      }
    });
    await ready;
    let phase = 'identity';
    const exec = childProcess.execFileSync, readlink = fs.readlinkSync, read = fs.readFileSync;
    const denied = () => { throw Object.assign(new Error('fixture inspection denied'), { code: 'EACCES' }); };
    const ps = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
      const thisPid = args.includes(String(child.pid)) || options?.env?.TARGET_PID === String(child.pid);
      if (thisPid && ((phase === 'identity' && (args.includes('comm=') || args.at(-1).includes('ExecutablePath'))) ||
          (phase === 'scope' && (args.includes('command=') || args.at(-1).includes('CommandLine'))))) return denied();
      return exec(command, args, options);
    });
    const exe = t.mock.method(fs, 'readlinkSync', (file, ...args) => phase === 'identity' && String(file) === '/proc/' + child.pid + '/exe' ? denied() : readlink(file, ...args));
    const cmd = t.mock.method(fs, 'readFileSync', (file, ...args) => phase === 'scope' && String(file) === '/proc/' + child.pid + '/cmdline' ? denied() : read(file, ...args));
    syncBuiltinESMExports();
    try {
      const options = { ...f.options, spawnFn() { assert.fail('must not launch a duplicate'); } };
      await assert.rejects(ensureStudio(options), /still be running or restarting/);
      assert.equal((await stopStudio(f.options)).stopped, false);
      if (mode === 'local') assert.equal((await cleanStudio(f.options)).cleaned, false, 'uninspectable live process keeps its executable and records');
      assert.equal(Number(fs.readFileSync(path.join(f.dataDir, 'backend.pid'), 'utf8')), child.pid);
      phase = 'scope';
      const recordPath = path.join(f.dataDir, 'backend.launch.json');
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      assert.ok(record.processStarted);
      fs.writeFileSync(recordPath, JSON.stringify({ ...record, processStarted: 'different process start' }));
      assert.equal((await stopStudio(f.options)).stopped, false, 'a reused PID cannot prove ownership');
      fs.writeFileSync(recordPath, JSON.stringify(record));
      await assert.rejects(ensureStudio(options), /still be running or restarting/);
      assert.equal((await stopStudio(f.options)).stopped, true, 'known launch identity recovers an unreadable command line');
    } finally {
      ps.mock.restore(); exe.mock.restore(); cmd.mock.restore(); syncBuiltinESMExports();
      await endChild(child);
    }
  });

  it('cleanup and uninstall preserve the running custom backend, runtime and configuration', { timeout: 20000 }, async t => {
    const f = fixture(t);
    fs.copyFileSync(process.execPath, f.bin, fs.constants.COPYFILE_FICLONE);
    const local = await useStudioBinary(f.bin, f.options);
    fs.mkdirSync(path.join(f.dataDir, 'runtime', 'camoufox'), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, 'runtime', 'camoufox', 'keep'), 'user runtime');
    fs.mkdirSync(path.join(f.dataDir, 'package'));
    fs.writeFileSync(path.join(f.dataDir, 'package', 'old-asset'), 'previous bundled asset');
    const child = await startStandIn(f.bin, f.dataDir, local.port);
    try {
      fs.writeFileSync(path.join(f.dataDir, 'backend.pid'), String(child.pid));
      const hash = computeFileHash(f.bin);
      assert.equal(hasStudioAssets(f.dataDir), false);
      const result = await cleanStudio(f.options);
      assert.equal(result.skipped, 'user_backend');
      assert.deepEqual(result.removed, []);
      await cleanDownloadedAssets({ studioDir: f.dataDir, webDir: path.join(f.root, 'unused-web') });
      process.kill(child.pid, 0);
      assert.equal(computeFileHash(f.bin), hash);
      assert.equal(localStudio(f.options).backendMode, 'user');
      assert.equal(fs.readFileSync(path.join(f.dataDir, 'runtime', 'camoufox', 'keep'), 'utf8'), 'user runtime');
      assert.equal(fs.readFileSync(path.join(f.dataDir, 'package', 'old-asset'), 'utf8'), 'previous bundled asset');
    } finally { await endChild(child); }
  });

  it('exposes selection, status and non-destructive cleanup through the CLI', async t => {
    const f = fixture(t);
    const cli = (...args) => execFileAsync(process.execPath, ['scripts/studio.mjs', ...args, '--data-dir', f.dataDir]);
    assert.match((await cli('use', f.bin)).stdout, /User-managed AIStudio2API selected/);
    const report = (await cli('status')).stdout;
    assert.match(report, /Service status: stopped/);
    assert.ok(report.includes(f.bin));
    assert.match((await cli('clean')).stdout, /were kept/);
    await assert.rejects(cli('install'), /custom executable/);
    assert.match((await cli('use-default')).stdout, /Default local AIStudio2API directory selected/);
    assert.equal(fs.readFileSync(f.bin, 'utf8'), 'user version one');
  });
});
