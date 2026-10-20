import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import release from './studio-release.json' with { type: 'json' };
import { controlState, assertCanStart } from './studio-control-state.mjs';

export const STUDIO_VERSION = `v${release.version}`;
export const PINNED_ARCHIVES = release.binaries;
// The port a new setup tries first: AIStudio2API's own default.
export const DEFAULT_STUDIO_PORT = 2048;
// backend.log is set aside as backend.log.1 when a start finds it past this size.
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

const adminSessions = new Map();
const inFlightStarts = new Map();
const inFlightReady = new Map();

export function studioDataDir(env = process.env) {
  return env.AI_STUDIO_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'magpie-ai-studio');
}

export function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// studioCommand is a command line for this plugin's own management CLI, to quote in messages.
// Magpie installs the plugin where its user doesn't look, so `npm run studio:*` from a checkout
// is no help to them; the CLI's full path also keeps its pinned version the plugin's own.
export function studioCommand(action, { dataDir } = {}) {
  const script = fileURLToPath(new URL('../scripts/studio.mjs', import.meta.url));
  const command = `node "${script}" ${action}`;
  if (!dataDir) return command;
  const quoted = process.platform === 'win32'
    ? `"${dataDir.replaceAll('"', '""')}"`
    : `'${dataDir.replaceAll("'", "'\\''")}'`;
  return `${command} --data-dir ${quoted}`;
}

// pickStudioPort is the port for a new setup: preferred when nothing uses it, else one the system
// has free. A user who already runs AIStudio2API keeps it on its default port, which a new setup
// would otherwise find taken on every start.
export async function pickStudioPort(preferred = DEFAULT_STUDIO_PORT) {
  if (!(await portAnswers(preferred)) && await canListen(preferred)) return preferred;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// portAnswers says whether something accepts connections on the port. Listening alone doesn't
// tell: on macOS a listener on 0.0.0.0 lets another bind 127.0.0.1 to the same port.
function portAnswers(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = answered => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(1000, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', err => done(err.code !== 'ECONNREFUSED'));
  });
}

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

// newConfigPort is the port to write when dataDir has no config.json yet (options.preferredPort
// tried first), else undefined.
async function newConfigPort(dataDir, options = {}) {
  if (fs.existsSync(path.join(dataDir, 'config.json'))) return undefined;
  return pickStudioPort(options.preferredPort ?? DEFAULT_STUDIO_PORT);
}

export function binaryPath(dataDir, platform = process.platform) {
  return path.join(dataDir, 'package', platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
}

export function validateProxy(proxy) {
  if (proxy === undefined || proxy === null || proxy === '') return '';
  if (typeof proxy !== 'string') {
    throw new Error('Proxy URL must be a string');
  }
  const trimmed = proxy.trim();
  if (!trimmed) return '';
  if (/[\r\n]/.test(trimmed)) throw new Error('Proxy URL must not contain newlines');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid proxy URL');
  }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    throw new Error('Proxy URL must use http, https, or socks5 protocol');
  }
  return trimmed;
}

// pluginProxy is the proxy this plugin sets for the service over the one saved in its .env: the
// one given (studio.proxy, or a CLI --proxy), else AI_STUDIO_PROXY, with where it comes from. An
// empty one names none, so the saved one applies; null when neither names one.
export function pluginProxy(explicit) {
  const given = validateProxy(explicit);
  if (given) return { proxy: given, source: 'option' };
  const env = validateProxy(process.env.AI_STUDIO_PROXY);
  if (env) return { proxy: env, source: 'env' };
  return null;
}

// downloadProxy is the proxy an install downloads through: the one given (an empty one turns it
// off), else AI_STUDIO_PROXY, else the service's saved one, else the one an older config.json kept.
function downloadProxy(dataDir, explicit, savedConfig) {
  if (controlState(dataDir)) return firstProxy(readStudioEnv(dataDir).PROXY);
  if (explicit !== undefined) return validateProxy(explicit);
  if (process.env.AI_STUDIO_PROXY !== undefined) return validateProxy(process.env.AI_STUDIO_PROXY);
  let saved;
  try {
    saved = readStudioEnv(dataDir).PROXY;
  } catch {}
  return saved !== undefined ? firstProxy(saved) : validateProxy(savedConfig?.proxy);
}

// firstProxy is the first of a PROXY list (upstream takes several, comma-separated, as a pool).
function firstProxy(value) {
  return proxyList(value)[0] ?? '';
}

function proxyList(value) {
  return [...new Set(String(value ?? '').split(',').map(p => p.trim()).filter(Boolean))];
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Configuration must be an object');
  }
  if (config.version !== 1) {
    throw new Error(`Unsupported configuration version: ${config.version}`);
  }
  const port = config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port number in configuration: ${port}`);
  }
  if (typeof config.apiKey !== 'string' || !config.apiKey || /[\r\n]/.test(config.apiKey)) {
    throw new Error('Invalid apiKey in configuration: must be non-empty string without newlines');
  }
  if (typeof config.adminUsername !== 'string' || !config.adminUsername || /[\r\n]/.test(config.adminUsername)) {
    throw new Error('Invalid adminUsername in configuration: must be non-empty string without newlines');
  }
  if (typeof config.adminPassword !== 'string' || !config.adminPassword || /[\r\n]/.test(config.adminPassword)) {
    throw new Error('Invalid adminPassword in configuration: must be non-empty string without newlines');
  }
  const proxy = validateProxy(config.proxy);
  return {
    version: 1,
    port,
    apiKey: config.apiKey,
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
    proxy
  };
}

// ENV_KEYS are the settings upstream reads from .env, in the order it writes them (config.configKeys).
const ENV_KEYS = [
  'AISTUDIO_AUTH_STATES', 'LISTEN_ADDR', 'PROXY_API_KEY', 'PROXY', 'INIT_TIMEOUT', 'REQUEST_TIMEOUT',
  'WARM_WORKER_LIMIT', 'MAX_ACTIVE_WORKERS', 'WARM_STARTUP_CONCURRENCY', 'PER_ACCOUNT_CONCURRENCY',
  'ROUTING_STRATEGY', 'UPSTREAM_CHANNELS', 'MODEL_MAPPING', 'TEMPORARY_CHAT', 'WAA_BACKEND', 'AUTO_START',
  'REQUEST_BODY_LOG', 'LOG_FILE', 'LOG_MAX_TOTAL_MB', 'ADMIN_AUTH_ENABLED', 'ADMIN_USERNAME', 'ADMIN_PASSWORD',
  'BUILD_NATIVE_NONSTREAM'
];

// SETTING_DEFAULTS are the settings the admin page owns, as a new setup has them. They are written
// to .env when it lacks them and left as the admin page saves them after that.
const SETTING_DEFAULTS = {
  REQUEST_BODY_LOG: 'false',
  LOG_FILE: 'false',
  TEMPORARY_CHAT: 'true',
  PER_ACCOUNT_CONCURRENCY: '1',
  WARM_WORKER_LIMIT: '1',
  MAX_ACTIVE_WORKERS: '1',
  WARM_STARTUP_CONCURRENCY: '1',
  ROUTING_STRATEGY: 'fill-first',
  REQUEST_TIMEOUT: '30m',
  INIT_TIMEOUT: '2m'
};

// pluginEnv is the settings this plugin depends on to reach, trust and drive the service. The
// service is started with them in its environment, which upstream reads over .env, so saving
// others in the admin page can't break them.
function pluginEnv(dataDir, config) {
  const authDir = path.resolve(dataDir, 'auth');
  if (/[\r\n]/.test(authDir) || /[\r\n]/.test(config.apiKey) || /[\r\n]/.test(config.adminUsername) || /[\r\n]/.test(config.adminPassword)) {
    throw new Error('Configuration paths or credentials must not contain newlines');
  }
  return {
    LISTEN_ADDR: `127.0.0.1:${config.port}`,
    AISTUDIO_AUTH_STATES: authDir,
    PROXY_API_KEY: config.apiKey,
    ADMIN_AUTH_ENABLED: 'true',
    ADMIN_USERNAME: config.adminUsername,
    ADMIN_PASSWORD: config.adminPassword,
    AUTO_START: 'true',
    WAA_BACKEND: 'go',
    UPSTREAM_CHANNELS: 'playground',
    BUILD_NATIVE_NONSTREAM: 'false'
  };
}

// serviceEnv is the environment the service is started with: this plugin's settings, and PROXY
// only when the plugin sets one (see pluginProxy). Without it the service takes the PROXY saved
// in .env, which the admin page changes.
export function serviceEnv(dataDir, config, options = {}) {
  const env = pluginEnv(dataDir, config);
  if (controlState(dataDir)) return env;
  const owned = pluginProxy(options.proxy);
  if (owned) env.PROXY = owned.proxy;
  return env;
}

// parseEnvValue and formatEnvValue read and write a .env value as upstream does.
function parseEnvValue(raw, where) {
  if (!raw) return '';
  if (raw[0] === "'") {
    if (raw.length < 2 || !raw.endsWith("'")) throw new Error(`${where}: unterminated single quote`);
    return raw.slice(1, -1);
  }
  if (raw[0] === '"') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${where}: invalid double-quoted value`);
    }
  }
  const comment = raw.indexOf(' #');
  return comment >= 0 ? raw.slice(0, comment).trim() : raw;
}

function formatEnvValue(value) {
  return /[ \t\r\n#"']/.test(value) ? JSON.stringify(value) : value;
}

// readStudioEnv is the settings saved in the service's .env (none when it has no .env).
export function readStudioEnv(dataDir) {
  const envPath = path.join(dataDir, '.env');
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const values = {};
  text.split(/\r?\n/).forEach((line, i) => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`${envPath}:${i + 1}: missing "="`);
    const key = line.slice(0, eq).trim();
    if (ENV_KEYS.includes(key)) values[key] = parseEnvValue(line.slice(eq + 1).trim(), `${envPath}:${i + 1}`);
  });
  return values;
}

function writeStudioEnv(dataDir, values) {
  const envPath = path.join(dataDir, '.env');
  const content = ENV_KEYS.filter(k => values[k] !== undefined).map(k => `${k}=${formatEnvValue(String(values[k]))}\n`).join('');
  let current;
  try {
    current = fs.readFileSync(envPath, 'utf8');
  } catch {}
  if (current !== content) {
    const tmpEnv = `${envPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpEnv, content, { mode: 0o600 });
    fs.renameSync(tmpEnv, envPath);
  }
  fs.chmodSync(envPath, 0o600);
}

// syncStudioEnv brings .env up to date with config.json, keeping what the admin page saved: this
// plugin's settings are written over, the others only when missing. A missing PROXY is the one
// given, else the one an older config.json kept (which nothing reads after that).
function syncStudioEnv(dataDir, config, seedProxy) {
  const values = readStudioEnv(dataDir);
  Object.assign(values, pluginEnv(dataDir, config));
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) values[key] ??= value;
  values.PROXY ??= validateProxy(seedProxy) || config.proxy;
  writeStudioEnv(dataDir, values);
}

// saveStudioProxy saves the service's proxy in its .env, as the admin page does. The service
// takes it the next time its generation service starts.
export function saveStudioProxy(dataDir, proxy) {
  const values = readStudioEnv(dataDir);
  values.PROXY = validateProxy(proxy);
  writeStudioEnv(dataDir, values);
}

// ensureStudioConfig reads config.json, writing a new one if there is none: on options.port when
// given (see pickStudioPort), else on DEFAULT_STUDIO_PORT. It then brings .env up to date (see
// syncStudioEnv), with explicitProxy as the proxy to save if .env has none yet.
export function ensureStudioConfig(dataDir, explicitProxy = undefined, options = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);

  const configPath = path.join(dataDir, 'config.json');
  let config;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new Error(`Invalid JSON in configuration file ${configPath}: ${parseErr.message}`);
    }
    config = validateConfig(parsed);
    fs.chmodSync(configPath, 0o600);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const created = {
        version: 1,
        port: options.port ?? DEFAULT_STUDIO_PORT,
        apiKey: 'as_' + crypto.randomBytes(32).toString('hex'),
        adminUsername: 'magpie',
        adminPassword: crypto.randomBytes(32).toString('hex')
      };
      const tmp = `${configPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(created, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, configPath);
      fs.chmodSync(configPath, 0o600);
      config = validateConfig(created);
    } else {
      throw err;
    }
  }

  syncStudioEnv(dataDir, config, explicitProxy);

  const authDir = path.join(dataDir, 'auth');
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(authDir, 0o700);

  return config;
}

export function localStudio(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  const platform = options.platform || process.platform;
  const binPath = binaryPath(dataDir, platform);
  if (!fs.existsSync(binPath)) return null;

  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) return null;
  let config;
  try {
    config = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch {
    return null;
  }

  const origin = `http://127.0.0.1:${config.port}`;
  return {
    origin,
    baseURL: `${origin}/v1`,
    apiKey: config.apiKey,
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
    port: config.port,
    dataDir
  };
}

export async function studioAdmin(local, method, pathname, body = null, options = {}) {
  if (!local || typeof local !== 'object') {
    throw new Error('localStudio configuration required for studioAdmin');
  }
  const fetchFn = options.fetchFn || globalThis.fetch;
  const origin = local.origin;
  const sessionKey = `${origin}\n${local.adminUsername}\n${local.adminPassword}`;

  let timeoutMs = options.timeoutMs;
  if (!timeoutMs) {
    if (pathname === '/api/accounts' && method.toUpperCase() === 'POST') {
      timeoutMs = 15 * 60 * 1000;
    } else if (pathname.includes('/control/start')) {
      timeoutMs = 180 * 1000;
    } else {
      timeoutMs = 5 * 1000;
    }
  }

  async function login() {
    const loginUrl = `${origin}/api/auth/login`;
    let res;
    try {
      res = await fetchFn(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: local.adminUsername, password: local.adminPassword }),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(timeoutMs, 10000))
      });
    } catch (err) {
      adminSessions.delete(sessionKey);
      if (err.foreign) throw err;
      if (err.cause?.message?.includes('redirect') || err.message?.includes('redirect')) {
        const e = new Error('Admin login returned redirect; foreign listener detected');
        e.foreign = true;
        throw e;
      }
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      adminSessions.delete(sessionKey);
      const err = new Error('Admin login returned redirect; foreign listener detected');
      err.foreign = true;
      throw err;
    }
    if (!res.ok) {
      adminSessions.delete(sessionKey);
      const err = new Error(`Admin login failed: HTTP ${res.status}`);
      err.status = res.status;
      // A server error or a rate limit is the service having trouble; any other refusal of this
      // setup's credentials means the service isn't this setup's.
      err.foreign = res.status < 500 && res.status !== 429;
      throw err;
    }
    // Each Set-Cookie on its own: joined, a cookie set after another one isn't found by name.
    const cookie = res.headers.getSetCookie()
      .map(line => /^\s*(aistudio_admin=[^;]+)/.exec(line)?.[1])
      .find(Boolean);
    if (!cookie) {
      const err = new Error('Admin login did not provide aistudio_admin session cookie');
      err.foreign = true;
      throw err;
    }
    adminSessions.set(sessionKey, cookie);
    return cookie;
  }

  let cookie = adminSessions.get(sessionKey);
  if (!cookie) {
    cookie = await login();
  }

  async function executeRequest(activeCookie) {
    const url = `${origin}${pathname}`;
    const headers = new Headers();
    if (activeCookie) headers.set('Cookie', activeCookie);
    let payload = null;
    if (body !== null && body !== undefined) {
      if (typeof body === 'object') {
        payload = JSON.stringify(body);
        headers.set('Content-Type', 'application/json');
      } else {
        payload = String(body);
      }
    }
    return fetchFn(url, {
      method,
      headers,
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
  }

  let res;
  try {
    res = await executeRequest(cookie);
  } catch (err) {
    if (err.foreign) throw err;
    if (err.cause?.message?.includes('redirect') || err.message?.includes('redirect')) {
      const e = new Error(`Admin request ${method} ${pathname} returned redirect; foreign listener detected`);
      e.foreign = true;
      throw e;
    }
    const e = new Error(`Admin request ${method} ${pathname} failed: ${err.message}`, { cause: err });
    if (err.code) e.code = err.code;
    throw e;
  }

  if (res.status >= 300 && res.status < 400) {
    const err = new Error(`Admin request ${method} ${pathname} returned redirect; foreign listener detected`);
    err.foreign = true;
    throw err;
  }

  if (res.status === 401) {
    cookie = await login();
    try {
      res = await executeRequest(cookie);
    } catch (err) {
      if (err.foreign) throw err;
      if (err.cause?.message?.includes('redirect') || err.message?.includes('redirect')) {
        const e = new Error(`Admin request ${method} ${pathname} returned redirect on retry`);
        e.foreign = true;
        throw e;
      }
      const e = new Error(`Admin request ${method} ${pathname} retry failed: ${err.message}`, { cause: err });
      if (err.code) e.code = err.code;
      throw e;
    }
    if (res.status >= 300 && res.status < 400) {
      const err = new Error(`Admin request ${method} ${pathname} returned redirect on retry`);
      err.foreign = true;
      throw err;
    }
  }

  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json?.error?.message || json?.message || `Admin request failed: HTTP ${res.status}`);
    }
    return json;
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Admin request failed: HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return text;
}

export async function studioAccounts(options = {}) {
  const local = localStudio(options);
  if (!local) return [];
  const res = await studioAdmin(local, 'GET', '/api/accounts', null, options);
  const accounts = Array.isArray(res?.accounts) ? res.accounts : [];
  return accounts.filter(a => a.enabled !== false);
}

// PROXY_SOURCES names where the proxy the service goes out through comes from.
export const PROXY_SOURCES = {
  option: '插件选项 studio.proxy',
  env: '环境变量 AI_STUDIO_PROXY',
  saved: '管理页',
  startup: '服务启动时的设置',
  unknown: '来源待确认',
  system: '自动检测：HTTPS_PROXY 环境变量或系统代理',
  direct: '直连'
};

// redactProxy hides the passwords in a PROXY list.
export function redactProxy(value) {
  return proxyList(value).map(p => {
    try {
      const u = new URL(p);
      if (u.password) u.password = '***';
      return u.toString().replace(/\/$/, '');
    } catch {
      return p;
    }
  }).join(',');
}

// LAUNCH_RECORD says, for the service process this plugin last started, whether it was started
// with a PROXY of the plugin's over the saved one, and whose: 'option' or 'env' (see pluginProxy),
// null for none. A caller that doesn't know the plugin's options (the CLI) reads it from there.
const LAUNCH_RECORD = 'backend.launch.json';

function writeLaunchRecord(dataDir, pid, proxy) {
  const record = { pid, proxy: controlState(dataDir) ? null : pluginProxy(proxy)?.source ?? null };
  try {
    fs.writeFileSync(path.join(dataDir, LAUNCH_RECORD), JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch {}
}

// launchRecord is the record of the running service's start, or null when the running service
// isn't the one it was written for (or an older plugin started it, which wrote none).
function launchRecord(dataDir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, LAUNCH_RECORD), 'utf8'));
    if (record?.pid !== recordedPid(dataDir) || !(record.proxy === null || record.proxy in PROXY_SOURCES)) return null;
    return record;
  } catch {
    return null;
  }
}

// studioProxy is how the running service reaches Google:
//   active  the proxy it goes out through now ('' for none), and source where that comes from (a
//           PROXY_SOURCES key; 'unknown' when the service can't tell it from a change not yet applied);
//   saved   the proxy saved in .env, as the admin page shows it;
//   overridden, when another one is used over a saved one: whose it is ('option' or 'env'), or
//           'unknown' when the service was started with another one in its environment and
//           nothing tells whose;
//   pending what it takes for the one set (wanted, from wantedSource) to apply: 'restart', the
//           service must start again; 'generation', its generation service must; null, nothing.
// A standalone caller (the CLI) doesn't know the plugin's options, so it can't tell what the
// service will be started with next: it reads what it was started with from the launch record.
// Passwords are hidden.
export async function studioProxy(local, options = {}) {
  const saved = proxyList(readStudioEnv(local.dataDir).PROXY).join(',');
  const controlled = !!controlState(local.dataDir);
  const override = options.standalone || controlled ? null : pluginProxy(options.proxy);
  const cfg = await studioAdmin(local, 'GET', '/api/config', null, { timeoutMs: 3000, fetchFn: options.fetchFn });
  // What the service reads as its PROXY now: .env, or the environment it was started with over it
  const loaded = proxyList(cfg?.proxy).join(',');
  const active = proxyList(cfg?.active_proxy).join(',');

  let want = override ? override.proxy : saved;
  let wantedSource = override ? override.source : 'saved';
  let overridden = override && saved && saved !== override.proxy ? override.source : null;
  if (options.standalone && !controlled && loaded !== saved) {
    // Started with another proxy in its environment: one of the plugin's, which applies as long as
    // it is set, or, with no record of whose, one a restart may or may not set again
    const launched = launchRecord(local.dataDir)?.proxy;
    overridden = launched || 'unknown';
    if (launched) {
      want = loaded;
      wantedSource = launched;
    }
  }

  let pending = null;
  if (loaded !== want) pending = 'restart';
  else if (want && active !== want) pending = 'generation';
  // Saved none, going out through one: the system's, or one saved before that the generation
  // service still has. A change not yet applied leaves which it is open.
  const unsure = !want && active && cfg?.service_restart_required === true;
  if (unsure) pending = 'generation';

  let source;
  if (!active) source = 'direct';
  else if (unsure) source = 'unknown';
  else if (pending) source = 'startup';
  else if (!loaded) source = 'system';
  else source = wantedSource;

  return {
    active: redactProxy(active),
    source,
    saved: redactProxy(saved),
    overridden,
    wanted: redactProxy(want),
    wantedSource,
    pending
  };
}

export function isConnectRefused(err) {
  if (!err) return false;
  const visited = new Set();
  let current = err;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current.code === 'ECONNREFUSED' || current.code === 'ENOENT') return true;
    if (Array.isArray(current.errors)) {
      for (const sub of current.errors) {
        if (isConnectRefused(sub)) return true;
      }
    }
    current = current.cause;
  }
  return false;
}

// checkStudioHealth says what answers on the setup's port: 'down' (nothing), 'up' (this setup's
// service, at the pinned version), 'outdated' (an older official version),
// 'version_conflict' (a newer or custom version installed outside this plugin),
// 'foreign' (something else) or 'unresponsive' (something that times out or fails, as the
// service can while it starts or when it hangs).
export async function checkStudioHealth(local, fetchFn) {
  let status;
  try {
    status = await studioAdmin(local, 'GET', '/api/status', null, { fetchFn, timeoutMs: 2000 });
  } catch (err) {
    if (isConnectRefused(err)) {
      return { state: 'down', reason: 'ECONNREFUSED' };
    }
    return { state: err.foreign ? 'foreign' : 'unresponsive', reason: err.message };
  }

  if (!status || typeof status !== 'object') {
    return { state: 'foreign', reason: 'Status response is not an object' };
  }
  if (typeof status.ready !== 'boolean' || typeof status.running !== 'boolean') {
    return { state: 'foreign', reason: 'Missing boolean ready or running in status' };
  }
  if (!status.accounts || typeof status.accounts !== 'object') {
    return { state: 'foreign', reason: 'Missing accounts object in status' };
  }

  if (status.ready) {
    try {
      const modelsRes = await fetchFn(`${local.baseURL}/models`, {
        headers: { Authorization: `Bearer ${local.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(2000)
      });
      await modelsRes.body?.cancel();
      if (modelsRes.status === 401 || (modelsRes.status >= 300 && modelsRes.status < 400)) {
        return { state: 'foreign', reason: 'Models auth key mismatch' };
      }
    } catch (err) {
      if (isConnectRefused(err)) {
        return { state: 'down', reason: 'ECONNREFUSED' };
      }
      return { state: 'unresponsive', reason: err.message };
    }
  }

  // Official releases at or below our upstream base can move to the managed
  // build. Newer/custom installations require an explicit recovery decision.
  const runningVersion = String(status.version).replace(/^v/, '');
  if (runningVersion !== release.version) {
    const parts = /^\d+\.\d+\.\d+$/.test(runningVersion) ? runningVersion.split('.').map(Number) : null;
    const expected = release.upstream.version.split('.').map(Number);
    const different = parts?.findIndex((n, i) => n !== expected[i]);
    const older = parts && (different === -1 || parts[different] < expected[different]);
    return { state: older ? 'outdated' : 'version_conflict', status, reason: `Running version ${status.version}, expected ${STUDIO_VERSION}` };
  }

  return { state: 'up', status };
}

export async function studioStatus(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const local = localStudio({ dataDir, platform });
  if (!local) return { status: 'not_installed', dataDir };

  const health = await checkStudioHealth(local, fetchFn);
  if (health.state === 'up') {
    return { status: 'running', ...health.status, port: local.port, dataDir };
  }
  if (health.state === 'down') {
    return { status: 'stopped', port: local.port, dataDir };
  }
  if (health.state === 'outdated' || health.state === 'version_conflict') {
    return { ...health.status, status: health.state, expected: STUDIO_VERSION, port: local.port, dataDir,
      ...(health.state === 'version_conflict' ? { reason: studioVersionConflict(local, health).message } : {}) };
  }
  return { status: health.state, reason: health.reason, port: local.port, dataDir };
}

export function verifyProcessIdentity(pid, expectedBinaryPath, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!fs.existsSync(expectedBinaryPath)) return false;

  const expectedReal = fs.realpathSync(expectedBinaryPath);

  if (platform === 'win32') {
    try {
      const out = execFileSync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = $env:TARGET_PID" | Select-Object -ExpandProperty ExecutablePath`
      ], {
        env: { ...process.env, TARGET_PID: String(pid) },
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true
      }).trim();
      if (!out) return false;
      return fs.realpathSync(out).toLowerCase() === expectedReal.toLowerCase();
    } catch {
      return false;
    }
  }

  // Linux /proc/<pid>/exe
  const linuxProcExe = `/proc/${pid}/exe`;
  if (fs.existsSync(linuxProcExe)) {
    try {
      const targetReal = fs.realpathSync(linuxProcExe);
      return targetReal === expectedReal;
    } catch {}
  }

  // macOS / fallback: ps -p <pid> -o comm=
  try {
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    if (!comm) return false;
    if (fs.existsSync(comm)) {
      return fs.realpathSync(comm) === expectedReal;
    }
    if (path.basename(comm) === path.basename(expectedReal)) {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
      const firstArg = command.split(' ')[0];
      if (fs.existsSync(firstArg) && fs.realpathSync(firstArg) === expectedReal) {
        return true;
      }
    }
  } catch {}

  return false;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function recordedPid(dataDir) {
  try { return Number(fs.readFileSync(path.join(dataDir, 'backend.pid'), 'utf8').trim()); } catch { return NaN; }
}

// A self-update can close HTTP before exec (Unix), or spawn a replacement PID
// (Windows). Inspect processes as well as the port before replacing or launching.
export function studioProcessPids(bin, platform = process.platform, run = execFileSync) {
  const opts = { encoding: 'utf8', timeout: platform === 'win32' ? 20000 : 5000, windowsHide: true };
  let output;
  if (platform === 'win32') {
    try {
      output = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process -Filter "Name=\'aistudio2api.exe\'" | Where-Object { $_.ExecutablePath -eq $env:TARGET_BINARY } | Select-Object -ExpandProperty ProcessId'],
      { ...opts, env: { ...process.env, TARGET_BINARY: path.resolve(bin) } });
    } catch (err) {
      const dataDir = path.dirname(path.dirname(bin));
      throw new Error(`Cannot check for remaining AIStudio2API processes. Check that PowerShell/CIM is available and permitted, then run: ${studioCommand('stop', { dataDir })}. No binary was replaced or new process started.`, { cause: err });
    }
    return [...new Set(String(output).trim().split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  }
  if (platform === 'linux' && run === execFileSync) {
    // Linux ps comm is often only a basename. /proc retains the launch path
    // even while the updater has renamed/unlinked the running executable.
    return fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(n => {
      try {
        const command = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0')[0];
        return path.isAbsolute(command) && path.resolve(command) === path.resolve(bin) ? [Number(n)] : [];
      } catch { return []; }
    });
  }
  output = run('ps', ['-axo', 'pid=,comm='], opts);
  return String(output).split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return [];
    const command = match[2].replace(/ \(deleted\)$/, '');
    return path.isAbsolute(command) && path.resolve(command) === path.resolve(bin) ? [Number(match[1])] : [];
  });
}

export function studioListenerPids(port, platform = process.platform, run = execFileSync) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener port');
  const opts = { encoding: 'utf8', timeout: platform === 'win32' ? 20000 : 5000, windowsHide: true };
  let output;
  if (platform === 'win32') {
    output = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Get-NetTCPConnection -State Listen -LocalPort $env:TARGET_PORT | Select-Object -ExpandProperty OwningProcess -Unique'],
    { ...opts, env: { ...process.env, TARGET_PORT: String(port) } });
  } else {
    try {
      output = run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], opts);
    } catch (err) {
      if (platform !== 'linux') throw err;
      const rows = run('ss', ['-H', '-ltnp', `sport = :${port}`], opts);
      output = [...String(rows).matchAll(/pid=(\d+)/g)].map(m => m[1]).join('\n');
    }
  }
  return [...new Set(String(output).trim().split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0))];
}

function assertStudioExited(dataDir, platform) {
  const tracked = recordedPid(dataDir);
  const bin = binaryPath(dataDir, platform);
  let pids;
  if (processAlive(tracked) && verifyProcessIdentity(tracked, bin, platform)) {
    pids = [tracked];
  } else {
    // A live PID can belong to an unrelated process after a crash or reboot.
    fs.rmSync(path.join(dataDir, 'backend.pid'), { force: true });
    pids = studioProcessPids(bin, platform);
  }
  if (pids.length) {
    throw new Error(`AI Studio may still be running or restarting (PID ${pids.join(', ')}), even though its HTTP port is closed. Wait for it to finish restarting, or run: ${studioCommand('stop', { dataDir })}. No binary was replaced or new process started.`);
  }
}

function protectPackage(dataDir, platform) {
  if (platform === 'win32') return;
  // Best-effort package hardening. Online updates are disabled in the managed
  // backend itself; this permission is not the mechanism enforcing that policy.
  try {
    const pkg = path.join(dataDir, 'package');
    if ((fs.statSync(pkg).mode & 0o777) !== 0o555) fs.chmodSync(pkg, 0o555);
  } catch {}
}

function removePackage(dir, platform) {
  if (!fs.existsSync(dir)) return;
  if (platform !== 'win32') fs.chmodSync(dir, 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withLock(dataDir, fn, timeoutMs = 600000) {
  const lockPath = path.join(dataDir, '.setup.lock');
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n${token}\n`);
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      let ownerAlive = false;
      let ownerPid = NaN;
      let stat = null;
      try {
        stat = fs.statSync(lockPath);
        const content = fs.readFileSync(lockPath, 'utf8');
        const lines = content.split('\n');
        ownerPid = parseInt(lines[0], 10);
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
          process.kill(ownerPid, 0);
          ownerAlive = true;
        }
      } catch {
        ownerAlive = false;
      }

      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        if (!ownerAlive) {
          try {
            fs.rmSync(lockPath, { force: true });
            continue;
          } catch {}
        }
      } else if (stat && Date.now() - stat.mtimeMs > 30000) {
        try {
          fs.rmSync(lockPath, { force: true });
          continue;
        } catch {}
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for another AI Studio setup lock (${lockPath})`);
      }
      await sleep(250);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const current = fs.readFileSync(lockPath, 'utf8');
      if (current.includes(token)) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {}
  }
}

export async function installStudio(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const pinKey = `${platform}-${arch}`;
  const pin = PINNED_ARCHIVES[pinKey];
  if (!pin) {
    throw new Error(`Unsupported platform/arch: ${platform}/${arch}. Only darwin-x64, darwin-arm64, linux-x64, linux-arm64, win32-x64 are supported.`);
  }

  const dataDir = options.dataDir || studioDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);

  // Validate existing config first, throw if corrupted
  const configPath = path.join(dataDir, 'config.json');
  const savedConfig = fs.existsSync(configPath)
    ? validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')))
    : null;

  // Refuse install/update while running or foreign
  const localExisting = localStudio({ dataDir, platform });
  if (localExisting) {
    const health = await checkStudioHealth(localExisting, options.fetchFn || globalThis.fetch);
    if (health.state === 'up') {
      throw new Error('Cannot install or update AIStudio2API while service is running. Stop the service first.');
    }
    if (health.state === 'version_conflict') throw studioVersionConflict(localExisting, health);
    if (health.state === 'outdated') {
      throw new Error(`Cannot install AIStudio2API ${STUDIO_VERSION} while ${health.status.version} from an earlier install is running. Stop the service first.`);
    }
    if (health.state === 'foreign') {
      throw new Error(`Cannot install AIStudio2API: Port ${localExisting.port} is occupied by an unknown/foreign listener. Change "port" in config.json.`);
    }
    if (health.state === 'unresponsive') {
      throw new Error(`Cannot install AIStudio2API while something on port ${localExisting.port} is not responding (${health.reason}). Stop the service first.`);
    }
  }

  assertStudioExited(dataDir, platform);
  const expectedHash = pin.sha256;
  let archivePath = options.archivePath;
  // The archive kept from an earlier install sets a damaged binary right again without a download.
  const retainedArchive = path.join(dataDir, pin.asset);
  if (!archivePath && fs.existsSync(retainedArchive) && computeFileHash(retainedArchive) === expectedHash) {
    archivePath = retainedArchive;
  }
  const port = await newConfigPort(dataDir, options);
  const stageDir = path.join(dataDir, `.install.tmp.${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });

  try {
    if (archivePath) {
      if (!fs.existsSync(archivePath)) {
        throw new Error(`Provided archive does not exist: ${archivePath}`);
      }
      const actualHash = computeFileHash(archivePath);
      if (actualHash !== expectedHash) {
        throw new Error(`SHA256 checksum mismatch for archive: expected ${expectedHash}, got ${actualHash}`);
      }
    } else {
      const downloadUrl = `https://github.com/${release.repository}/releases/download/${release.tag}/${pin.asset}`;
      archivePath = path.join(stageDir, pin.asset);
      const proxy = downloadProxy(dataDir, options.proxy, savedConfig);

      if (options.fetchFn && options.fetchFn !== globalThis.fetch) {
        const res = await options.fetchFn(downloadUrl, { signal: AbortSignal.timeout(300000) });
        if (!res.ok) {
          throw new Error(`Failed to download AIStudio2API archive from ${downloadUrl}: HTTP ${res.status}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const downloadedHash = crypto.createHash('sha256').update(buffer).digest('hex');
        if (downloadedHash !== expectedHash) {
          throw new Error(`SHA256 checksum mismatch for downloaded archive: expected ${expectedHash}, got ${downloadedHash}`);
        }
        fs.writeFileSync(archivePath, buffer, { mode: 0o600 });
      } else {
        // Without a progress meter curl's stderr holds just the reason a download failed.
        const curlArgs = ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '300'];
        if (proxy) {
          curlArgs.push('--proxy', proxy);
        }
        curlArgs.push('-o', archivePath, downloadUrl);
        await new Promise((resolve, reject) => {
          execFile('curl', curlArgs, (err, _stdout, stderr) => {
            if (err) {
              const status = err.code || err.status || 'failed';
              const reason = String(stderr || '').trim().slice(0, 500);
              reject(new Error(`Failed to download AIStudio2API archive via curl (status: ${status})${reason ? `: ${reason}` : ''}`));
            } else {
              resolve();
            }
          });
        });
        const downloadedHash = computeFileHash(archivePath);
        if (downloadedHash !== expectedHash) {
          throw new Error(`SHA256 checksum mismatch for downloaded archive: expected ${expectedHash}, got ${downloadedHash}`);
        }
      }
    }

    if (archivePath !== retainedArchive) {
      fs.copyFileSync(archivePath, retainedArchive);
      fs.chmodSync(retainedArchive, 0o600);
    }

    const extractDir = path.join(stageDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });

    if (platform === 'win32') {
      execFileSync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:ARCHIVE_PATH -DestinationPath $env:DEST_PATH -Force'
      ], {
        env: { ...process.env, ARCHIVE_PATH: archivePath, DEST_PATH: extractDir },
        windowsHide: true
      });
    } else {
      const listOutput = execFileSync('tar', ['-tvf', archivePath], { encoding: 'utf8' }).split('\n').filter(Boolean);
      for (const line of listOutput) {
        const parts = line.split(/\s+/);
        const mode = parts[0];
        if (mode.startsWith('l') || mode.startsWith('s')) {
          throw new Error(`Symlinks or special files in archive rejected: ${line}`);
        }
      }
      const listing = execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8' }).split('\n').filter(Boolean);
      for (const entry of listing) {
        const entryParts = entry.replace(/\\/g, '/').split('/');
        if (entryParts.includes('..') || entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry)) {
          throw new Error(`Dangerous member in archive rejected: ${entry}`);
        }
      }
      execFileSync('tar', ['-xzf', archivePath, '-C', extractDir]);
    }

    let topDir = extractDir;
    const entries = fs.readdirSync(extractDir);
    if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
      topDir = path.join(extractDir, entries[0]);
    }

    const binName = platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api';
    const foundBin = path.join(topDir, binName);
    if (!fs.existsSync(foundBin)) {
      throw new Error(`Could not find ${binName} in extracted package`);
    }
    fs.chmodSync(foundBin, 0o755);

    const binarySha256 = computeFileHash(foundBin);
    const manifestPath = path.join(dataDir, 'install-manifest.json');
    const oldManifestExists = fs.existsSync(manifestPath);
    const oldManifestBytes = oldManifestExists ? fs.readFileSync(manifestPath) : null;

    const finalPackageDir = path.join(dataDir, 'package');
    const stagePackageDir = path.join(dataDir, `.package.stage.${crypto.randomBytes(4).toString('hex')}`);
    const backupPackageDir = path.join(dataDir, `.package.backup.${crypto.randomBytes(4).toString('hex')}`);

    // Download/extraction can take minutes: recheck before the actual swap too.
    assertStudioExited(dataDir, platform);
    fs.renameSync(topDir, stagePackageDir);

    let hasBackup = false;
    let installedNewFinal = false;
    const oldPackageMode = platform !== 'win32' && fs.existsSync(finalPackageDir)
      ? fs.statSync(finalPackageDir).mode & 0o777 : null;

    try {
      if (fs.existsSync(finalPackageDir)) {
        // macOS can reject renaming a read-only directory even when its parent
        // is writable. Unlock only for this controlled swap and restore on failure.
        if (oldPackageMode !== null) fs.chmodSync(finalPackageDir, oldPackageMode | 0o700);
        fs.renameSync(finalPackageDir, backupPackageDir);
        hasBackup = true;
      }
      fs.renameSync(stagePackageDir, finalPackageDir);
      installedNewFinal = true;

      const manifest = {
        version: release.version,
        platform,
        arch,
        archiveSha256: expectedHash,
        binarySha256
      };
      const tmpManifest = `${manifestPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmpManifest, manifestPath);
      fs.chmodSync(manifestPath, 0o600);

      ensureStudioConfig(dataDir, options.proxy, { port });
      protectPackage(dataDir, platform);

      if (hasBackup) {
        removePackage(backupPackageDir, platform);
      }
      removeOtherArchives(dataDir, pin.asset);
    } catch (swapErr) {
      if (installedNewFinal) {
        try { removePackage(finalPackageDir, platform); } catch {}
      }
      if (hasBackup) {
        try { fs.renameSync(backupPackageDir, finalPackageDir); } catch {}
      }
      if (oldPackageMode !== null && fs.existsSync(finalPackageDir)) {
        try { fs.chmodSync(finalPackageDir, oldPackageMode); } catch {}
      }
      try { removePackage(stagePackageDir, platform); } catch {}
      if (oldManifestExists && oldManifestBytes) {
        try { fs.writeFileSync(manifestPath, oldManifestBytes, { mode: 0o600 }); } catch {}
      } else {
        try { fs.rmSync(manifestPath, { force: true }); } catch {}
      }
      throw swapErr;
    }
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  return localStudio({ dataDir, platform });
}

// removeOtherArchives deletes the release archives earlier installs kept, all but keep.
function removeOtherArchives(dataDir, keep) {
  for (const name of fs.readdirSync(dataDir)) {
    if (name !== keep && /^aistudio2api-v[^/\\]+\.(?:tar\.gz|zip)$/.test(name)) {
      try { fs.rmSync(path.join(dataDir, name), { force: true }); } catch {}
    }
  }
}

// readyStudio waits until the service takes generation requests, starting it when stopped.
// Once it is RUNNING it takes them: with no account ready, the backend answers each request
// saying why, so there is nothing to wait for.
async function readyStudio(local, initial, options = {}) {
  assertCanStart(local.dataDir, options.allowPaused);
  const fetchFn = options.fetchFn || globalThis.fetch;
  let status = initial;
  if (status.running || status.accounts.total === 0) return local;
  if (status.state === 'STOPPED' && !needsSignIn(status.accounts)) {
    await studioAdmin(local, 'POST', '/api/control/start', null, { fetchFn, timeoutMs: 180000 });
  }
  const deadline = Date.now() + (options.generationTimeoutMs ?? 120000);
  for (;;) {
    assertCanStart(local.dataDir, options.allowPaused);
    if (status.running) return local;
    if (needsSignIn(status.accounts)) {
      throw new Error(`AI Studio cannot start: its Google accounts need to sign in again (${status.accounts.auth_required} of ${status.accounts.total}). In Magpie, sign in to Google AI Studio with "用 Google 账号登录（推荐）" and choose the account, or run: ${studioCommand('relogin', { dataDir: local.dataDir })}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`AI Studio generation did not become ready (state ${status.state}, ${status.accounts.ready ?? 0}/${status.accounts.total} accounts ready); see ${path.join(local.dataDir, 'backend.log')}`);
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    const h = await checkStudioHealth(local, fetchFn);
    if (h.state === 'unresponsive') continue;
    if (h.state !== 'up') throw new Error('AI Studio became unavailable while starting');
    status = h.status;
  }
}

// needsSignIn says whether no account can serve until one signs in again: none is ready, busy
// or cooling down, and some need to sign in.
function needsSignIn(accounts) {
  const usable = (accounts.ready ?? 0) + (accounts.busy ?? 0) + (accounts.cooldown ?? 0);
  return usable === 0 && (accounts.auth_required ?? 0) > 0;
}

// settle waits out a service that answers but not properly, as one does while it starts, for up
// to ms.
async function settle(local, health, fetchFn, ms) {
  const deadline = Date.now() + ms;
  while (health.state === 'unresponsive' && Date.now() < deadline) {
    await sleep(250);
    health = await checkStudioHealth(local, fetchFn);
  }
  return health;
}

function portTaken(local) {
  return new Error(`Port ${local.port} is already used by another service; change "port" in ${path.join(local.dataDir, 'config.json')}`);
}

function notResponding(local, health) {
  return new Error(`The AI Studio service on port ${local.port} is not responding (${health.reason}). If it is stuck, run: ${studioCommand('stop', { dataDir: local.dataDir })}; if another program uses the port, change "port" in ${path.join(local.dataDir, 'config.json')}`);
}

// rotateLog sets a log past LOG_ROTATE_BYTES aside as <log>.1, replacing the one before.
function rotateLog(logPath) {
  try {
    if (fs.statSync(logPath).size > LOG_ROTATE_BYTES) fs.renameSync(logPath, `${logPath}.1`);
  } catch {}
}

// shared runs fn once for key while it is in flight: later callers get the same promise.
function shared(map, key, fn) {
  if (!map.has(key)) map.set(key, fn().finally(() => map.delete(key)));
  return map.get(key);
}

// ensureStudio makes sure the service is installed and running, and, unless managementOnly,
// that it takes generation requests. options.proxy is a proxy it is started with over the saved
// one (studio.proxy); options.savedProxy is one saved as the service's own before it starts, as
// the admin page saves one. Callers share one start of the service and one wait for
// it to take requests; a managementOnly caller doesn't wait for the latter.
export async function ensureStudio(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  assertCanStart(dataDir, options.allowPaused);
  const { local, status } = await shared(inFlightStarts, dataDir, () => launchStudio({ ...options, dataDir }));
  if (options.managementOnly) return local;
  return shared(inFlightReady, dataDir, () => readyStudio(local, status, options));
}

// launchStudio gets the service up, installing it when missing, outdated or untrusted, and
// returns how to reach it with the status it last reported.
async function launchStudio(options) {
  const { dataDir } = options;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const spawnFn = options.spawnFn || spawn;
  const startTimeoutMs = options.startTimeoutMs ?? 60000;

  let local = localStudio({ dataDir, platform });
  if (local) {
    const health = await checkStudioHealth(local, fetchFn);
    if (health.state === 'up') {
      protectPackage(dataDir, platform);
      return { local, status: health.status };
    }
    if (health.state === 'version_conflict') throw studioVersionConflict(local, health);
    if (health.state === 'foreign') throw portTaken(local);
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return withLock(dataDir, async () => {
    local = localStudio({ dataDir, platform });
    if (local) {
      const health = await settle(local, await checkStudioHealth(local, fetchFn), fetchFn, options.unresponsiveTimeoutMs ?? 10000);
      if (health.state === 'up') {
        protectPackage(dataDir, platform);
        return { local, status: health.status };
      }
      if (health.state === 'version_conflict') throw studioVersionConflict(local, health);
      if (health.state === 'foreign') throw portTaken(local);
      if (health.state === 'unresponsive') throw notResponding(local, health);
      if (health.state === 'outdated') await stopOutdated(local, health, { dataDir, platform, fetchFn });
    }
    assertStudioExited(dataDir, platform);

    // 控制台暂停期间，锁外已开始的自动启动也必须在执行前再次阻断。
    assertCanStart(dataDir, options.allowPaused);

    // Check config validity before touching binaries
    const configPath = path.join(dataDir, 'config.json');
    if (fs.existsSync(configPath)) {
      validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    }

    const binPath = binaryPath(dataDir, platform);
    const manifestPath = path.join(dataDir, 'install-manifest.json');
    const pin = PINNED_ARCHIVES[`${platform}-${arch}`];
    let manifestValid = false;

    if (fs.existsSync(binPath) && fs.existsSync(manifestPath) && pin) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const currentHash = computeFileHash(binPath);
        if (
          manifest.version === release.version &&
          manifest.platform === platform &&
          manifest.arch === arch &&
          manifest.archiveSha256 === pin.sha256
        ) {
          // A stopped service may have self-updated. Restore the pinned archive below;
          // never bless the replacement by rewriting its hash into the manifest.
          manifestValid = currentHash === manifest.binarySha256;
        }
      } catch {
        // Missing/invalid installation metadata also requires a verified reinstall.
      }
    }

    if (!manifestValid) {
      await installStudio({ dataDir, platform, arch, fetchFn, archivePath: options.archivePath, proxy: options.proxy ?? options.savedProxy, preferredPort: options.preferredPort });
    }

    const config = ensureStudioConfig(dataDir, options.proxy, { port: await newConfigPort(dataDir, options) });
    if (options.savedProxy !== undefined) saveStudioProxy(dataDir, options.savedProxy);
    local = localStudio({ dataDir, platform });
    if (!local) throw new Error(`Invalid AI Studio configuration in ${dataDir}`);

    const health = await checkStudioHealth(local, fetchFn);
    assertCanStart(dataDir, options.allowPaused);
    if (health.state === 'up') return { local, status: health.status };
    if (health.state === 'version_conflict') throw studioVersionConflict(local, health);
    if (health.state === 'foreign') throw portTaken(local);
    if (health.state !== 'down') throw notResponding(local, health);
    assertStudioExited(dataDir, platform);
    protectPackage(dataDir, platform);

    // Clean environment: no host AISTUDIO_* or WAA_* vars, nor any of upstream's settings, which
    // would hide the ones saved in .env
    const cleanEnv = {};
    const controlled = !!controlState(dataDir);
    for (const [k, v] of Object.entries(process.env)) {
      const inheritedProxy = controlled && ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(k.toUpperCase());
      if (!inheritedProxy && !k.startsWith('AISTUDIO_') && !k.startsWith('WAA_') && !ENV_KEYS.includes(k.toUpperCase())) {
        cleanEnv[k] = v;
      }
    }
    // 显式空值阻止宿主再次注入寿命仅限 Magpie 进程的代理中转。
    if (controlled) Object.assign(cleanEnv, { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' });
    Object.assign(cleanEnv, serviceEnv(dataDir, config, { proxy: options.proxy }));

    const logPath = path.join(dataDir, 'backend.log');
    rotateLog(logPath);
    const logFd = fs.openSync(logPath, 'a', 0o600);
    let launchError;
    try {
      const child = spawnFn(binPath, ['-open-ui=false'], {
        cwd: dataDir,
        env: cleanEnv,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true
      });
      const clearChildPid = () => {
        if (child.pid && recordedPid(dataDir) === child.pid) {
          try { fs.rmSync(path.join(dataDir, 'backend.pid'), { force: true }); } catch {}
        }
      };
      child.on?.('error', err => { launchError = err; clearChildPid(); });
      child.on?.('exit', (code, signal) => {
        launchError = new Error(`AIStudio2API exited during startup (${signal || code}); see ${logPath}`);
        clearChildPid();
      });
      if (child.pid) {
        fs.writeFileSync(path.join(dataDir, 'backend.pid'), `${child.pid}\n`, { mode: 0o600 });
        writeLaunchRecord(dataDir, child.pid, options.proxy);
      }
      child.unref?.();
    } finally {
      fs.closeSync(logFd);
    }

    // The service can answer with errors while it starts: only 'up' ends the wait.
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const h = await checkStudioHealth(local, fetchFn);
      if (h.state === 'up') return { local, status: h.status };
      if (h.state === 'foreign') throw portTaken(local);
      if (h.state === 'version_conflict') throw studioVersionConflict(local, h);
      if (h.state === 'outdated') {
        throw new Error(`AIStudio2API on port ${local.port} reports version ${h.status.version}, expected ${STUDIO_VERSION}`);
      }
      if (launchError) throw launchError;
      await sleep(250);
    }
    throw new Error(`AI Studio service did not start within ${Math.round(startTimeoutMs / 1000)}s; see ${logPath}`);
  });
}

function studioVersionConflict(local, health) {
  return new Error(`AI Studio is running ${health.status.version}, but this plugin manages ${STUDIO_VERSION}. ` +
    `Update magpie-gemini-web instead of using the backend admin's online updater. ` +
    `To restore ${STUDIO_VERSION}, run: ${studioCommand('stop', { dataDir: local.dataDir })}; ` +
    `after it stops, back up ${local.dataDir}, then run: ${studioCommand('install', { dataDir: local.dataDir })}; ` +
    `then ${studioCommand('start', { dataDir: local.dataDir })}. ` +
    `Existing data files are kept, but an older backend may not read data migrated by a newer release.`);
}

// stopOutdated stops an earlier install of the service that is still running, so the pinned
// version can be installed and started in its place.
async function stopOutdated(local, health, options) {
  const result = await stopStudio(options).catch(err => ({ stopped: false, reported: err.message }));
  const after = await checkStudioHealth(local, options.fetchFn);
  if (result.stopped && after.state === 'down') return;
  const why = result.stopped ? `it still answers on port ${local.port}` : result.reported;
  throw new Error(`AIStudio2API ${health.status.version} from an earlier install is still running and could not be stopped (${why}). End that process, then try again.`);
}

export async function stopStudio(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  if (options.waitForStart) return withLock(dataDir, () => stopStudio({ ...options, waitForStart: false }), 60000);
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const pidFile = path.join(dataDir, 'backend.pid');

  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('Cannot stop: missing configuration in data directory');
  }
  let local;
  try {
    local = localStudio({ dataDir, platform });
    if (!local) throw new Error('invalid config');
  } catch {
    throw new Error('Cannot stop: invalid configuration in data directory');
  }

  let health = await checkStudioHealth(local, fetchFn);
  if (health.state === 'foreign') {
    throw new Error(`Cannot stop unknown or foreign process listening on port ${local.port}`);
  }

  let pid = recordedPid(dataDir);
  const bin = binaryPath(dataDir, platform);
  let alive = processAlive(pid) && verifyProcessIdentity(pid, bin, platform);
  let discoveryError;
  let discovered = [];
  if (!alive) {
    fs.rmSync(pidFile, { force: true });
    // Upstream's Windows updater starts a new PID. Recover only an executable
    // at this installation's exact path; never signal a port owner by name alone.
    try {
      const candidates = health.state === 'down'
        ? studioProcessPids(bin, platform)
        : studioListenerPids(local.port, platform);
      discovered = candidates;
      const verified = candidates.filter(p => processAlive(p) && verifyProcessIdentity(p, bin, platform));
      if (verified.length === 1) {
        pid = verified[0];
        alive = true;
        fs.writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
      }
    } catch (err) { discoveryError = err.message; }
  }

  if (!alive) {
    fs.rmSync(pidFile, { force: true });
    if (health.state === 'down' && !discoveryError && discovered.length === 0) return { stopped: true };
    return { stopped: false, reported: `Cannot identify a verified AIStudio2API process for port ${local.port}. Wait for any update/restart to finish, then retry: ${studioCommand('stop', { dataDir })}. ${discoveryError ? `Process inspection failed: ${discoveryError}` : 'Check the listener PID and its executable path if this persists.'}` };
  }

  if (!verifyProcessIdentity(pid, bin, platform)) {
    throw new Error(`Process ${pid} does not match expected binary path ${bin}; refusal to signal unverified process`);
  }

  health = await checkStudioHealth(local, fetchFn);
  if (health.state === 'foreign') {
    throw new Error(`Cannot stop unknown or foreign process listening on port ${local.port}`);
  }

  if (health.state === 'up' || health.state === 'outdated' || health.state === 'version_conflict') {
    try {
      await studioAdmin(local, 'POST', '/api/control/stop', null, { fetchFn, timeoutMs: 5000 });
    } catch {}
  }

  if (!verifyProcessIdentity(pid, bin, platform)) {
    throw new Error(`Process identity changed before signal for PID ${pid}`);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await sleep(150);
    } catch {
      alive = false;
      break;
    }
  }

  if (alive) {
    return { stopped: false, reported: `Process ${pid} did not exit after SIGTERM` };
  }

  fs.rmSync(pidFile, { force: true });
  // A pooled HTTP connection may reset just after the process exits (especially
  // on Windows). Wait for a confirmed refusal, without treating a reset as proof
  // that the port is free or overlooking a replacement listener.
  let after = await checkStudioHealth(local, fetchFn);
  const closeDeadline = Date.now() + 5000;
  while (after.state === 'unresponsive' && Date.now() < closeDeadline) {
    await sleep(150);
    after = await checkStudioHealth(local, fetchFn);
  }
  if (after.state !== 'down') {
    return { stopped: false, reported: `Port ${local.port} is not confirmed closed (${after.state}: ${after.reason || 'service responds'}); retry: ${studioCommand('stop', { dataDir })}` };
  }
  return { stopped: true };
}
