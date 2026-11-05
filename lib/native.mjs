import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { validateProxyURL } from './setup.mjs';
import { verifyProcessIdentity, studioProcessPids, studioListenerPids } from './studio-native.mjs';
import release from './backend-release.json' with { type: 'json' };

export const BACKEND_VERSION = `v${release.version}`;
const RELEASE_BASE = `https://github.com/${release.repository}/releases/download/${release.tag}/`;
export const PINNED_BINARIES = release.binaries;

const UPSTREAM_VERSION = 'v4.27.0';
const UPSTREAM_BASE = `https://github.com/zexadev/gemini-web2api-go/releases/download/${UPSTREAM_VERSION}/`;
// Retained for an explicit, checksum-verified rollback to the upstream release.
export const UPSTREAM_BINARIES = {
  'darwin-arm64': { asset: 'gemini-web2api-go_v4.27.0_darwin_arm64', sha256: '0cc9b5628e24624aa6d6c6c2fadbbc4702632f9c2387b9271e0f596d6d2a44af' },
  'darwin-x64': { asset: 'gemini-web2api-go_v4.27.0_darwin_amd64', sha256: '424e2c7c91922941a9e1beef72d1936da595aa74719f50132998fb2d2e57f20b' },
  'linux-x64': { asset: 'gemini-web2api-go_v4.27.0_linux_amd64', sha256: '5320ff87c6158b648c074b9ae6c700a75b672c8f7119b62e6f22b034e970cfca' },
  'linux-arm64': { asset: 'gemini-web2api-go_v4.27.0_linux_arm64', sha256: '66392aa8c67151ead0f5e2baa1f686e97754f8cc54b856e3605ae1e26633af01' },
  'win32-x64': { asset: 'gemini-web2api-go_v4.27.0_windows_amd64.exe', sha256: 'd8e051abbb657bcaa2edf68faa5a077be881ba4de26facc87fc1f6b8fde04b81' },
  'win32-arm64': { asset: 'gemini-web2api-go_v4.27.0_windows_arm64.exe', sha256: 'faae38bb2d88e583a0c7ef96f7dceb687b2ecf167675a20f0d75e011884d74a4' }
};

export function pinnedBinary(platform = process.platform, arch = process.arch, channel = 'optimized') {
  if (channel !== 'optimized' && channel !== 'upstream') throw new Error(`Invalid backend channel: ${channel}`);
  const pins = channel === 'upstream' ? UPSTREAM_BINARIES : PINNED_BINARIES;
  const base = channel === 'upstream' ? UPSTREAM_BASE : RELEASE_BASE;
  const version = channel === 'upstream' ? UPSTREAM_VERSION : BACKEND_VERSION;
  const pin = pins[`${platform}-${arch}`];
  if (!pin) {
    throw new Error(`No gemini-web2api-go ${version} build for ${platform}/${arch}. See ${base.slice(0, -1).replace('/download/', '/tag/')}`);
  }
  return { url: base + pin.asset, sha256: pin.sha256 };
}

export function backendChannel(dataDir = getDataDir()) {
  try {
    const { channel } = JSON.parse(fs.readFileSync(path.join(dataDir, 'backend-channel.json'), 'utf8'));
    if (channel !== 'optimized' && channel !== 'upstream') throw new Error('Expected optimized or upstream');
    return channel;
  } catch (error) {
    if (error.code === 'ENOENT') return 'optimized';
    throw new Error(`Invalid backend-channel.json: ${error.message}`);
  }
}

function saveBackendChannel(dataDir, channel) {
  const file = path.join(dataDir, 'backend-channel.json');
  const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ channel }) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function getDataDir(env = process.env) {
  return env.GEMINI_WEB_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'magpie-gemini-web');
}

export function binaryPath(dataDir, platform = process.platform) {
  return path.join(dataDir, 'bin', platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go');
}

export function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function installBackend(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const channel = options.channel ?? 'optimized';
  const pin = options.expectedHash && options.url ? null : pinnedBinary(platform, arch, channel);
  const expectedHash = options.expectedHash || pin.sha256;
  const downloadUrl = options.url || pin.url;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const proxy = validateProxyURL(options.proxy ?? process.env.GEMINI_WEB_PROXY ?? '');

  const dataDir = options.dataDir || getDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);

  const binDir = path.join(dataDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(binDir, 0o700);

  const binPath = binaryPath(dataDir, platform);
  let binaryReady = false;

  if (fs.existsSync(binPath)) {
    const existingHash = computeFileHash(binPath);
    if (existingHash === expectedHash) {
      binaryReady = true;
      console.log(`Backend binary verified: ${binPath}`);
    }
  }

  if (!binaryReady) {
    console.log(`Downloading backend binary from ${downloadUrl}...`);
    const tmpPath = path.join(binDir, `gemini-web2api-go.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
    try {
      // A slow download goes on while data keeps coming; a minute without any gives it up.
      if (proxy && (!options.fetchFn || options.fetchFn === globalThis.fetch)) {
        const curlArgs = [
          '--fail', '--location', '--silent', '--show-error',
          '--connect-timeout', '15', '--speed-limit', '1', '--speed-time', '60',
          '--proxy', proxy,
          '-o', tmpPath, downloadUrl
        ];
        await new Promise((resolve, reject) => {
          execFile('curl', curlArgs, (err, _stdout, stderr) => {
            if (!err) return resolve();
            const status = err.code || err.status || 'failed';
            const reason = String(stderr || '').trim().slice(0, 500);
            reject(new Error(`Failed to download binary via curl (status: ${status})${reason ? `: ${reason}` : ''}`));
          });
        });
        fs.chmodSync(tmpPath, 0o700);
      } else {
        const stall = new AbortController();
        let timer;
        const rearm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => stall.abort(new Error('Failed to download binary: no data for 60 s')), 60000);
        };
        const chunks = [];
        try {
          rearm();
          const res = await fetchFn(downloadUrl, {
            ...(proxy ? { proxy } : {}),
            signal: stall.signal
          });
          if (!res.ok) {
            throw new Error(`Failed to download binary: HTTP ${res.status}`);
          }
          for await (const chunk of res.body) {
            chunks.push(chunk);
            rearm();
          }
        } finally {
          clearTimeout(timer);
        }
        fs.writeFileSync(tmpPath, Buffer.concat(chunks), { mode: 0o700 });
      }

      const downloadedHash = computeFileHash(tmpPath);
      if (downloadedHash !== expectedHash) {
        throw new Error(`SHA256 checksum mismatch: expected ${expectedHash}, got ${downloadedHash}`);
      }

      fs.renameSync(tmpPath, binPath);
      fs.chmodSync(binPath, 0o700);
      console.log(`Backend binary installed: ${binPath}`);
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }
  }

  const files = ensureDataFiles(dataDir);
  // A local custom build keeps the user's channel. Official installs record their
  // selection only after verification and replacement succeeded.
  if ((!options.expectedHash && !options.url) || options.channel !== undefined) saveBackendChannel(dataDir, channel);
  onBackendAssetInstalled?.();
  return { binPath, ...files };
}

// ensureDataFiles creates config.json and secrets.json when missing; existing ones are kept.
function ensureDataFiles(dataDir) {
  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      host: "127.0.0.1",
      port: 8083,
      log_requests: false,
      multi_turn: false,
      temporary_chat: true
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    console.log(`Created default config: ${configPath}`);
  } else {
    fs.chmodSync(configPath, 0o600);
  }

  const secretsPath = path.join(dataDir, 'secrets.json');
  if (!fs.existsSync(secretsPath)) {
    const defaultSecrets = {
      apiKey: 'gw_' + crypto.randomBytes(32).toString('hex'),
      adminToken: crypto.randomBytes(32).toString('hex')
    };
    fs.writeFileSync(secretsPath, JSON.stringify(defaultSecrets, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(secretsPath, 0o600);
    console.log(`Created secrets: ${secretsPath}`);
  } else {
    fs.chmodSync(secretsPath, 0o600);
  }

  return { configPath, secretsPath };
}

export function startBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const expectedHash = options.expectedHash || pinnedBinary(process.platform, process.arch, backendChannel(dataDir)).sha256;
  const spawnFn = options.spawnFn || spawn;
  const { binPath, args, env } = prepareLaunch(dataDir, [expectedHash]);

  const child = spawnFn(binPath, args, {
    env,
    stdio: 'inherit'
  });

  const onSigInt = () => child.kill('SIGINT');
  const onSigTerm = () => child.kill('SIGTERM');
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  const cleanupListeners = () => {
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
  };

  child.on('error', () => {
    cleanupListeners();
    console.error('Failed to start backend process');
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    cleanupListeners();
    if (typeof options.exitFn === 'function') {
      options.exitFn(code, signal);
      return;
    }
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  return child;
}

// prepareLaunch checks the installed backend before it is run: a binary whose hash is one of
// trustedHashes, a loopback-only config and well-formed secrets. It returns what to spawn.
function prepareLaunch(dataDir, trustedHashes, platform = process.platform) {
  const binPath = binaryPath(dataDir, platform);
  const configPath = path.join(dataDir, 'config.json');
  const secretsPath = path.join(dataDir, 'secrets.json');

  if (!fs.existsSync(binPath)) {
    throw new Error(`Binary not found at ${binPath}. Run 'npm run backend:install' first.`);
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration not found at ${configPath}. Run 'npm run backend:install' first.`);
  }
  if (!fs.existsSync(secretsPath)) {
    throw new Error(`Secrets not found at ${secretsPath}. Run 'npm run backend:install' first.`);
  }

  const actualHash = computeFileHash(binPath);
  if (!trustedHashes.includes(actualHash)) {
    throw new Error(`Binary integrity verification failed: expected ${trustedHashes.join(' or ')}, got ${actualHash}`);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error(`Failed to parse configuration file at ${configPath}`);
  }

  if (config.host !== '127.0.0.1') {
    throw new Error(`Security validation failed: host must be strictly 127.0.0.1, got ${config.host}`);
  }

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`Invalid port number in configuration: ${config.port}`);
  }

  let secrets;
  try {
    secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch {
    throw new Error(`Failed to parse secrets file at ${secretsPath}`);
  }

  if (!secrets.apiKey || typeof secrets.apiKey !== 'string' || !secrets.adminToken || typeof secrets.adminToken !== 'string') {
    throw new Error('Invalid secrets format in secrets.json');
  }

  const dbPath = path.join(dataDir, 'gemini.db');
  const args = ['--config', configPath, '--db', dbPath];
  const env = {
    ...process.env,
    API_KEY: secrets.apiKey,
    ADMIN_TOKEN: secrets.adminToken
  };

  return { binPath, args, env, port: config.port, secrets };
}

// trustedHashes accepts the selected release channel and any explicitly installed local build.
function trustedHashes(dataDir, platform, arch) {
  const hashes = [];
  try {
    hashes.push(pinnedBinary(platform, arch, backendChannel(dataDir)).sha256);
  } catch {}
  try {
    const argon = JSON.parse(fs.readFileSync(path.join(dataDir, 'argon-build.json'), 'utf8'));
    if (/^[a-f0-9]{64}$/.test(argon.sha256)) hashes.push(argon.sha256);
  } catch {}
  return hashes;
}

function readLocalSetup(dataDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
    if (config.host !== '127.0.0.1' || !Number.isInteger(config.port) || typeof secrets.apiKey !== 'string' || typeof secrets.adminToken !== 'string') {
      return null;
    }
    const origin = `http://127.0.0.1:${config.port}`;
    return { origin, baseURL: `${origin}/v1`, apiKey: secrets.apiKey, adminToken: secrets.adminToken };
  } catch {
    return null;
  }
}

// localSetup returns the saved configuration and credentials in dataDir ({ origin, baseURL,
// apiKey, adminToken }), or null when none has been configured there, even if the binary was
// cleaned up.
export function localSetup(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  return readLocalSetup(dataDir);
}

// localBackend returns the backend this plugin manages in dataDir ({ origin, baseURL, apiKey,
// adminToken }), or null when none has been set up there.
export function localBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const platform = options.platform || process.platform;
  if (!fs.existsSync(binaryPath(dataDir, platform))) return null;
  return readLocalSetup(dataDir);
}

// backendState says whether the backend at setup answers with this setup's API key.
async function backendState(setup, fetchFn) {
  let res;
  try {
    res = await fetchFn(`${setup.baseURL}/models`, {
      headers: { Authorization: `Bearer ${setup.apiKey}` },
      signal: AbortSignal.timeout(2000)
    });
  } catch {
    return 'down';
  }
  return res.ok ? 'up' : 'foreign';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// withLock serializes setup across plugin hosts (Magpie may run more than one) by a lock file.
async function withLock(dataDir, fn, timeoutMs) {
  const lockPath = path.join(dataDir, '.setup.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx', 0o600));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > timeoutMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`Timed out waiting for another Gemini Web setup (${lockPath})`);
      await sleep(300);
    }
  }
  // A download has no overall deadline, so the holder keeps the lock fresh while it works;
  // only a lock left by a process that is gone goes stale.
  const keepFresh = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch {}
  }, Math.max(1000, Math.floor(timeoutMs / 4)));
  keepFresh.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(keepFresh);
    fs.rmSync(lockPath, { force: true });
  }
}

// ensureBackend makes sure the local backend is installed and running, and returns how to reach
// it. A backend already answering with this setup's key is left alone. Otherwise a missing or
// untrusted binary is (re)installed from the selected release channel, config and secrets are
// created when missing, and the backend is started in the background (logging to backend.log)
// so it outlives the caller.
export async function ensureBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const spawnFn = options.spawnFn || spawn;
  const startTimeoutMs = options.startTimeoutMs ?? 20000;

  let setup = readLocalSetup(dataDir);
  if (setup && fs.existsSync(binaryPath(dataDir, platform)) && await backendState(setup, fetchFn) === 'up') {
    return setup;
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return withLock(dataDir, async () => {
    setup = readLocalSetup(dataDir);
    if (setup && fs.existsSync(binaryPath(dataDir, platform)) && await backendState(setup, fetchFn) === 'up') {
      return setup;
    }

    const trusted = trustedHashes(dataDir, platform, arch);
    const binPath = binaryPath(dataDir, platform);
    if (!fs.existsSync(binPath) || !trusted.includes(computeFileHash(binPath))) {
      await installBackend({ dataDir, platform, arch, fetchFn, channel: backendChannel(dataDir), proxy: options.proxy });
    } else {
      ensureDataFiles(dataDir);
    }
    setup = readLocalSetup(dataDir);
    if (!setup) throw new Error(`Invalid Gemini Web backend config in ${dataDir}`);
    if (await backendState(setup, fetchFn) === 'foreign') {
      throw new Error(`${setup.origin} is already used by another service; change "port" in ${path.join(dataDir, 'config.json')}`);
    }

    const launch = prepareLaunch(dataDir, trusted, platform);
    const logPath = path.join(dataDir, 'backend.log');
    const log = fs.openSync(logPath, 'a', 0o600);
    let child;
    try {
      child = spawnFn(launch.binPath, launch.args, {
        env: launch.env,
        detached: true,
        stdio: ['ignore', log, log],
        windowsHide: true
      });
      child.on?.('error', () => {});
      if (child.pid) fs.writeFileSync(path.join(dataDir, 'backend.pid'), `${child.pid}\n`, { mode: 0o600 });
      child.unref?.();
    } finally {
      fs.closeSync(log);
    }

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (await backendState(setup, fetchFn) === 'up') return setup;
      await sleep(300);
    }
    try { child?.kill?.('SIGTERM'); } catch {}
    if (child?.pid && typeof child?.kill !== 'function') {
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
    }
    fs.rmSync(path.join(dataDir, 'backend.pid'), { force: true });
    throw new Error(`Gemini Web backend did not start within ${Math.round(startTimeoutMs / 1000)}s; see ${logPath}`);
  }, 600000);
}

export async function statusBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const configPath = path.join(dataDir, 'config.json');
  const fetchFn = options.fetchFn || globalThis.fetch;

  let host = '127.0.0.1';
  let port = 8083;

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.host === '127.0.0.1') host = config.host;
      if (Number.isInteger(config.port) && config.port > 0) port = config.port;
    } catch {}
  }

  const statusUrl = `http://${host}:${port}/`;
  let res;
  try {
    res = await fetchFn(statusUrl, {
      signal: AbortSignal.timeout(2000)
    });
  } catch (err) {
    throw new Error(`Failed to connect to backend at ${statusUrl}: ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`Backend returned HTTP ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Backend returned invalid JSON response');
  }

  const version = data.version || 'unknown';
  const models = Array.isArray(data.models) ? data.models.join(', ') : 'none';

  console.log(`Backend status: ok`);
  console.log(`Version: ${version}`);
  console.log(`Available models: ${models}`);

  return { status: 'ok', version, models: data.models };
}

let onBackendAssetInstalled = null;

export function setBackendAssetHook(fn) {
  onBackendAssetInstalled = typeof fn === 'function' ? fn : null;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function recordedBackendPid(dataDir) {
  try { return Number(fs.readFileSync(path.join(dataDir, 'backend.pid'), 'utf8').trim()); } catch { return NaN; }
}

export function hasBackendAssets(dataDir = getDataDir(), platform = process.platform) {
  if (!fs.existsSync(dataDir)) return false;
  for (const name of ['bin', 'backend-channel.json', 'argon-build.json']) {
    if (fs.existsSync(path.join(dataDir, name))) return true;
  }
  const pidFile = path.join(dataDir, 'backend.pid');
  if (fs.existsSync(pidFile)) {
    const pid = recordedBackendPid(dataDir);
    const bin = binaryPath(dataDir, platform);
    if (processAlive(pid) && verifyProcessIdentity(pid, bin, platform)) {
      return true;
    }
    try { fs.rmSync(pidFile, { force: true }); } catch {}
  }
  return false;
}

function forceRemoveBackendPath(target, platform) {
  if (!fs.existsSync(target)) return false;
  try {
    if (platform !== 'win32') {
      const st = fs.lstatSync(target);
      if (st.isDirectory()) {
        try { fs.chmodSync(target, (st.mode & 0o777) | 0o700); } catch {}
      }
    }
    fs.rmSync(target, { recursive: true, force: true });
    return !fs.existsSync(target);
  } catch {
    return false;
  }
}

export async function stopBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const pidFile = path.join(dataDir, 'backend.pid');
  const bin = binaryPath(dataDir, platform);

  if (!fs.existsSync(dataDir)) return { stopped: true };

  const setup = readLocalSetup(dataDir);
  const state = setup ? await backendState(setup, fetchFn) : 'down';
  if (state === 'foreign') {
    throw new Error(`Cannot stop unknown or foreign process listening on ${setup.origin}`);
  }

  const candidates = [];
  const tracked = recordedBackendPid(dataDir);
  if (Number.isInteger(tracked) && tracked > 0) candidates.push(tracked);
  if (fs.existsSync(bin)) {
    try {
      candidates.push(...studioProcessPids(bin, platform));
    } catch {}
    if (setup && state === 'up') {
      const port = Number(new URL(setup.origin).port);
      try {
        candidates.push(...studioListenerPids(port, platform));
      } catch {}
    }
  }

  const verified = [...new Set(candidates)].filter(p => processAlive(p) && verifyProcessIdentity(p, bin, platform));
  if (!verified.length) {
    try { fs.rmSync(pidFile, { force: true }); } catch {}
    if (state === 'up') {
      return { stopped: false, reported: `Cannot identify a verified gemini-web2api-go process for ${setup.origin}` };
    }
    return { stopped: true };
  }

  for (const pid of verified) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (verified.every(p => !processAlive(p))) break;
    await sleep(100);
  }

  if (options.force && verified.some(p => processAlive(p))) {
    for (const pid of verified) {
      if (processAlive(pid) && verifyProcessIdentity(pid, bin, platform)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline) {
      if (verified.every(p => !processAlive(p))) break;
      await sleep(50);
    }
  }

  if (verified.some(p => processAlive(p))) {
    return { stopped: false, reported: `Process ${verified.filter(p => processAlive(p)).join(', ')} did not exit after SIGTERM` };
  }

  try { fs.rmSync(pidFile, { force: true }); } catch {}

  if (setup && state === 'up') {
    const closeDeadline = Date.now() + 2000;
    while (Date.now() < closeDeadline) {
      if (await backendState(setup, fetchFn) === 'down') break;
      await sleep(100);
    }
    if (await backendState(setup, fetchFn) !== 'down') {
      return { stopped: false, reported: `${setup.origin} is still responding after stop` };
    }
  }

  return { stopped: true };
}

// cleanBackend stops any running managed gemini-web2api-go process in dataDir and deletes the
// downloaded binary and channel metadata while preserving config.json, secrets.json, gemini.db,
// and logs.
export async function cleanBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const platform = options.platform || process.platform;

  if (!fs.existsSync(dataDir)) {
    return { stopped: true, cleaned: true, removed: [], dataDir };
  }

  return withLock(dataDir, async () => {
    await stopBackend({ dataDir, platform, fetchFn: options.fetchFn, force: true }).catch(() => {});

    const removed = [];
    for (const name of ['bin', 'backend.pid', 'backend-channel.json', 'argon-build.json']) {
      if (forceRemoveBackendPath(path.join(dataDir, name), platform)) {
        removed.push(name);
      }
    }

    return { stopped: true, cleaned: true, removed, dataDir };
  }, options.lockTimeoutMs ?? 600000);
}
