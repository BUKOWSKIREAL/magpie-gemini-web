import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const PINNED_SHA256 = 'c69ca75cf43017cf2a62dbf5c12b07f6bde66f403f714c32209b1ad350ed24c9';
export const PINNED_URL = 'https://github.com/zexadev/gemini-web2api-go/releases/download/v4.22.0/gemini-web2api-go_v4.22.0_darwin_arm64';

export function getDataDir(env = process.env) {
  return env.GEMINI_WEB_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'magpie-gemini-web');
}

export function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function installBackend(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const expectedHash = options.expectedHash || PINNED_SHA256;
  const downloadUrl = options.url || PINNED_URL;
  const fetchFn = options.fetchFn || globalThis.fetch;

  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error('Automatic binary install currently supports macOS arm64 only. For other platforms, download gemini-web2api-go v4.22.0 manually from https://github.com/zexadev/gemini-web2api-go/releases/tag/v4.22.0');
  }

  const dataDir = options.dataDir || getDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);

  const binDir = path.join(dataDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(binDir, 0o700);

  const binPath = path.join(binDir, 'gemini-web2api-go');
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
      signal: AbortSignal.timeout(60000)
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

  return { binPath, configPath, secretsPath };
}

export function startBackend(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const binPath = path.join(dataDir, 'bin', 'gemini-web2api-go');
  const configPath = path.join(dataDir, 'config.json');
  const secretsPath = path.join(dataDir, 'secrets.json');
  const expectedHash = options.expectedHash || PINNED_SHA256;
  const spawnFn = options.spawnFn || spawn;

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
  if (actualHash !== expectedHash) {
    throw new Error(`Binary integrity verification failed: expected ${expectedHash}, got ${actualHash}`);
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
