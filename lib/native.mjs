import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const BACKEND_VERSION = 'v4.22.0';
const RELEASE_BASE = `https://github.com/zexadev/gemini-web2api-go/releases/download/${BACKEND_VERSION}/`;

// Upstream release assets by `${process.platform}-${process.arch}`, SHA-256 from the release's SHA256SUMS.txt.
export const PINNED_BINARIES = {
  'darwin-arm64': { asset: 'gemini-web2api-go_v4.22.0_darwin_arm64', sha256: 'c69ca75cf43017cf2a62dbf5c12b07f6bde66f403f714c32209b1ad350ed24c9' },
  'darwin-x64': { asset: 'gemini-web2api-go_v4.22.0_darwin_amd64', sha256: '384e617bcc30aacac6b7c4e4d0490e88d282b13b29f7a0a20d645b69514cd405' },
  'linux-x64': { asset: 'gemini-web2api-go_v4.22.0_linux_amd64', sha256: '21fcc81e0ad8ce0921e6b6c2cafce1089852530142b37e0289355c6e72df5299' },
  'linux-arm64': { asset: 'gemini-web2api-go_v4.22.0_linux_arm64', sha256: 'f2822fa0f1a7d2b37c2bc9cbb30a95c2e8028462453a110389511408bdfd4fd7' },
  'win32-x64': { asset: 'gemini-web2api-go_v4.22.0_windows_amd64.exe', sha256: '17e37f7e5c813b2a8d90c9a0265e6cde3bcfa4e814822af999fe8c4178f02729' },
  'win32-arm64': { asset: 'gemini-web2api-go_v4.22.0_windows_arm64.exe', sha256: 'b42e951bfc08d7fe8bdb436dca87fc6a1b7948bb8d10e110653bcf13a790756c' }
};

export function pinnedBinary(platform = process.platform, arch = process.arch) {
  const pin = PINNED_BINARIES[`${platform}-${arch}`];
  if (!pin) {
    throw new Error(`No gemini-web2api-go ${BACKEND_VERSION} build for ${platform}/${arch}. Download one manually from https://github.com/zexadev/gemini-web2api-go/releases/tag/${BACKEND_VERSION}`);
  }
  return { url: RELEASE_BASE + pin.asset, sha256: pin.sha256 };
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
  const pin = options.expectedHash && options.url ? null : pinnedBinary(platform, arch);
  const expectedHash = options.expectedHash || pin.sha256;
  const downloadUrl = options.url || pin.url;
  const fetchFn = options.fetchFn || globalThis.fetch;

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
    } else {
      fs.unlinkSync(binPath);
    }
  }

  if (!binaryReady) {
    console.log(`Downloading backend binary from ${downloadUrl}...`);
    const res = await fetchFn(downloadUrl, {
      signal: AbortSignal.timeout(300000)
    });
    if (!res.ok) {
      throw new Error(`Failed to download binary: HTTP ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const downloadedHash = crypto.createHash('sha256').update(buffer).digest('hex');

    if (downloadedHash !== expectedHash) {
      throw new Error(`SHA256 checksum mismatch: expected ${expectedHash}, got ${downloadedHash}`);
    }

    const tmpPath = path.join(binDir, `gemini-web2api-go.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.writeFileSync(tmpPath, buffer, { mode: 0o700 });
      fs.renameSync(tmpPath, binPath);
      fs.chmodSync(binPath, 0o700);
      console.log(`Backend binary installed: ${binPath}`);
    } finally {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    }
  }

  return { binPath, ...ensureDataFiles(dataDir) };
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
  const expectedHash = options.expectedHash || pinnedBinary().sha256;
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

// trustedHashes is what a backend binary in dataDir may hash to: the pinned upstream build for
// this platform, plus a local Argon build installed by `backend:install:argon`.
function trustedHashes(dataDir, platform, arch) {
  const hashes = [];
  try {
    hashes.push(pinnedBinary(platform, arch).sha256);
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
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

// ensureBackend makes sure the local backend is installed and running, and returns how to reach
// it. A backend already answering with this setup's key is left alone. Otherwise a missing or
// untrusted binary is (re)installed from the pinned upstream release, config and secrets are
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
      await installBackend({ dataDir, platform, arch, fetchFn });
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
    try {
      const child = spawnFn(launch.binPath, launch.args, {
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
