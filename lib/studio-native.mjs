import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveStudioRelease } from './studio-upstream.mjs';

// execFileAsync is execFile awaited: unpacking a download this way leaves the plugin host free to answer
// meanwhile, a sign-in's progress page among others.
const execFileAsync = promisify(execFile);

// The port a new setup tries first: AIStudio2API's own default.
export const DEFAULT_STUDIO_PORT = 2048;
const DEFAULT_PREVIEW_PORT = 2050;
// backend.log is set aside as backend.log.1 when a start finds it past this size.
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

const adminSessions = new Map();
const inFlightStarts = new Map();
const inFlightReady = new Map();
// setupSteps is where a start of the service stands, by data dir, while one is in flight:
// { step: 'download', received, total } (bytes; total 0 while unknown), { step: 'install' } or
// { step: 'start' }. A sign-in's progress page reads it (setupStep).
const setupSteps = new Map();

// setupStep is where the start of the service in dataDir stands, null when none is in flight or
// it hasn't got to a step yet (as while it waits for another's lock).
export function setupStep(dataDir) {
  return setupSteps.get(dataDir) ?? null;
}

export function studioDataDir(env = process.env) {
  return path.resolve(env.AI_STUDIO_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'magpie-ai-studio'));
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
  if (preferred > 0 && !(await portAnswers(preferred)) && await canListen(preferred)) return preferred;
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

export function readStudioConfig(dataDir) {
  try {
    return validateConfig(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function binaryPath(dataDir, platform = process.platform) {
  const selected = readStudioConfig(dataDir)?.backend?.binaryPath;
  if (selected) return selected;
  if (platform === 'win32') {
    const root = path.join(dataDir, 'aistudio2api.exe');
    let layout;
    try { layout = JSON.parse(fs.readFileSync(path.join(dataDir, 'install-manifest.json'), 'utf8')).binaryLayout; } catch {}
    if (layout === 'data' || fs.existsSync(root)) return root;
    const legacy = path.join(dataDir, 'package', 'aistudio2api.exe');
    return fs.existsSync(legacy) ? legacy : root;
  }
  return path.join(dataDir, 'package', 'aistudio2api');
}

// A user-selected executable stays in the user's own directory. Its contents and version may
// change between starts; selecting it never copies, chmods or pins the file.
export function validateStudioBinary(value, { dataDir = studioDataDir(), platform = process.platform } = {}) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Choose the path to an extracted AIStudio2API executable');
  }
  const expanded = value.trim().replace(/^~(?=[/\\])/, os.homedir());
  const selected = path.resolve(expanded);
  try {
    if (!fs.statSync(selected).isFile()) throw new Error('not a file');
    fs.accessSync(selected, platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK);
  } catch {
    throw new Error(`AIStudio2API executable is missing or not executable: ${selected}`);
  }
  const real = fs.realpathSync(selected);
  const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
  for (const root of [dataDir, pluginRoot]) {
    const resolved = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
    const relative = path.relative(resolved, real);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Keep a user-managed executable outside the plugin and AI Studio data directories, so plugin cleanup cannot remove it');
    }
  }
  return selected;
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
export function downloadProxy(dataDir, explicit, savedConfig) {
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
  if (config.autoUpdate !== undefined && typeof config.autoUpdate !== 'boolean') {
    throw new Error('Invalid autoUpdate in configuration');
  }
  if (config.defaultsPolicy !== undefined && !['upstream', 'legacy-migrated'].includes(config.defaultsPolicy)) {
    throw new Error('Invalid defaultsPolicy in configuration');
  }
  let backend;
  if (config.backend !== undefined) {
    if (!config.backend || config.backend.mode !== 'user' ||
        typeof config.backend.binaryPath !== 'string' || !path.isAbsolute(config.backend.binaryPath) ||
        /[\x00-\x1f\x7f]/.test(config.backend.binaryPath)) {
      throw new Error('Invalid backend configuration: expected user mode and an absolute binaryPath');
    }
    backend = { mode: 'user', binaryPath: config.backend.binaryPath };
  }
  return {
    version: 1,
    ...(config.defaultsPolicy ? { defaultsPolicy: config.defaultsPolicy } : {}),
    ...(config.autoUpdate !== undefined ? { autoUpdate: config.autoUpdate } : {}),
    port,
    apiKey: config.apiKey,
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
    proxy,
    ...(backend ? { backend } : {})
  };
}

// ENV_KEYS are the settings upstream reads from .env, in the order it writes them (config.configKeys).
const ENV_KEYS = [
  'AISTUDIO_AUTH_STATES', 'LISTEN_ADDR', 'PREVIEW_LISTEN_ADDR', 'PROXY_API_KEY', 'API_KEY_ACCOUNTS', 'PROXY', 'INIT_TIMEOUT', 'REQUEST_TIMEOUT',
  'WARM_WORKER_LIMIT', 'MAX_ACTIVE_WORKERS', 'WARM_STARTUP_CONCURRENCY', 'PER_ACCOUNT_CONCURRENCY',
  'ROUTING_STRATEGY', 'ACCOUNT_ORDER', 'MAX_ACCOUNT_SWITCHES', 'UPSTREAM_CHANNELS', 'MODEL_MAPPING', 'MODEL_CHANNELS', 'MODEL_ACCOUNTS', 'WAA_BACKEND',
  'MEDIA_OUTPUT', 'MEDIA_BASE_URL', 'AUTO_START', 'HIDE_DOCK_ICON', 'REQUEST_BODY_LOG', 'LOG_FILE', 'LOG_MAX_TOTAL_MB',
  'ADMIN_AUTH_ENABLED', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'BUILD_NATIVE_NONSTREAM',
  'NONSTREAM_KEEPALIVE', 'FAKE_STREAM', 'YOUTUBE_LINKS', 'STRIP_THOUGHT_SIGNATURES', 'SEARCH_MODEL_ALIASES', 'DISCOVER_HIDDEN_MODELS', 'GOOGLE_SEARCH',
  'FIRST_EVENT_HEDGE', 'FIRST_EVENT_HEDGE_MODELS', 'CONTINUATION_REWRITE', 'CONTINUATION_PROMPT'
];

// parseAccountOrder splits ACCOUNT_ORDER into ordered, deduplicated account IDs, matching upstream accountOrder().
export function parseAccountOrder(value) {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const id = String(raw ?? '').trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function validateAccountOrder(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (/[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Invalid studio.accountOrder: must not contain newlines or control characters');
    }
    const ids = parseAccountOrder(value);
    for (const id of ids) {
      if (/[,|\s\x00-\x1f\x7f]/.test(id)) {
        throw new Error(`Invalid studio.accountOrder: invalid account ID "${id}"`);
      }
    }
    return ids.join(',');
  }
  if (Array.isArray(value)) {
    const ids = [];
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== 'string') {
        throw new Error('Invalid studio.accountOrder: array entries must be strings');
      }
      const id = item.trim();
      if (!id || /[,|\s\x00-\x1f\x7f]/.test(id)) {
        throw new Error('Invalid studio.accountOrder: entries must be non-empty account IDs without commas or whitespace');
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids.join(',');
  }
  throw new Error('Invalid studio.accountOrder: must be a comma-separated string or an array of account IDs');
}

// parseModelAccounts parses MODEL_ACCOUNTS ("model:acc1|acc2,model2:acc3") into a Map<modelId, accountIds[]>,
// matching upstream config.ParseModelAccounts.
export function parseModelAccounts(value, { strict = false } = {}) {
  const accounts = new Map();
  if (value === undefined || value === null || value === '') return accounts;
  if (value instanceof Map) {
    for (const [k, v] of value) {
      const model = String(k ?? '').trim().replace(/^models\//, '');
      const ids = Array.isArray(v) ? v.map(s => String(s ?? '').trim()).filter(Boolean) : parseAccountOrder(String(v ?? '').replaceAll('|', ','));
      if (model && ids.length) accounts.set(model, [...new Set(ids)]);
    }
    return accounts;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (strict) {
      return parseModelAccounts(validateModelAccounts(value), { strict: true });
    }
    try {
      return parseModelAccounts(validateModelAccounts(value), { strict: false });
    } catch {
      return accounts;
    }
  }
  for (const rawItem of String(value).split(',')) {
    const item = rawItem.trim();
    if (!item) continue;
    const index = item.lastIndexOf(':');
    const model = index >= 0 ? item.slice(0, index).trim().replace(/^models\//, '') : '';
    const ids = index >= 0
      ? [...new Set(item.slice(index + 1).split('|').map(id => id.trim()).filter(Boolean))]
      : [];
    if (index < 0 || !model || !ids.length || /[,|:\s\x00-\x1f\x7f]/.test(model) || ids.some(id => /[:\s\x00-\x1f\x7f]/.test(id))) {
      if (strict) {
        throw new Error(`Invalid studio.modelAccounts entry: must be "model:account|account" (got "${item}")`);
      }
      continue;
    }
    if (accounts.has(model)) {
      if (strict) {
        throw new Error(`Invalid studio.modelAccounts: duplicate model "${model}"`);
      }
      continue;
    }
    accounts.set(model, ids);
  }
  return accounts;
}

export function validateModelAccounts(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (/[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Invalid studio.modelAccounts: must not contain newlines or control characters');
    }
    const parsed = parseModelAccounts(value, { strict: true });
    return [...parsed.entries()].map(([model, ids]) => `${model}:${ids.join('|')}`).join(',');
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const parsed = new Map();
    for (const [rawModel, rawAccounts] of Object.entries(value)) {
      const model = String(rawModel).trim().replace(/^models\//, '');
      if (!model || /[,|:\s\x00-\x1f\x7f]/.test(model)) {
        throw new Error(`Invalid studio.modelAccounts: invalid model ID "${rawModel}"`);
      }
      if (parsed.has(model)) {
        throw new Error(`Invalid studio.modelAccounts: duplicate model "${model}"`);
      }
      let list;
      if (typeof rawAccounts === 'string') {
        if (/[\x00-\x1f\x7f]/.test(rawAccounts)) {
          throw new Error(`Invalid studio.modelAccounts: accounts for ${model} must not contain control characters`);
        }
        list = rawAccounts.split(/[|,]/).map(s => s.trim()).filter(Boolean);
      } else if (Array.isArray(rawAccounts)) {
        list = rawAccounts.map(item => {
          if (typeof item !== 'string') {
            throw new Error(`Invalid studio.modelAccounts: account entries for ${model} must be strings`);
          }
          const trimmed = item.trim();
          if (!trimmed || /[,|:\s\x00-\x1f\x7f]/.test(trimmed)) {
            throw new Error(`Invalid studio.modelAccounts: invalid account ID for ${model}: "${item}"`);
          }
          return trimmed;
        });
      } else {
        throw new Error(`Invalid studio.modelAccounts: accounts for ${model} must be an array of account IDs or a "|"-separated string`);
      }
      const ids = [...new Set(list)];
      if (!ids.length || ids.some(id => /[,|:\s\x00-\x1f\x7f]/.test(id))) {
        throw new Error(`Invalid studio.modelAccounts: ${model} must specify at least one valid account ID`);
      }
      parsed.set(model, ids);
    }
    return [...parsed.entries()].map(([model, ids]) => `${model}:${ids.join('|')}`).join(',');
  }
  throw new Error('Invalid studio.modelAccounts: must be a "model:account|account" string or an object mapping model IDs to accounts');
}

// PROXY_ENV are the proxy variables the service would fall back to with no PROXY of its own.
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];

// Apply once to existing configurations only. Upstream Save may omit values equal to its
// defaults; reapplying this on every start would silently undo the user's later choices.
const LEGACY_DEFAULTS = {
  SEARCH_MODEL_ALIASES: 'false', PER_ACCOUNT_CONCURRENCY: '1',
  WARM_WORKER_LIMIT: '1', MAX_ACTIVE_WORKERS: '1', WARM_STARTUP_CONCURRENCY: '1',
  ROUTING_STRATEGY: 'fill-first', REQUEST_TIMEOUT: '30m', INIT_TIMEOUT: '2m',
  FIRST_EVENT_HEDGE: 'off', NONSTREAM_KEEPALIVE: 'false', REQUEST_BODY_LOG: 'false', LOG_FILE: 'false',
  WAA_BACKEND: 'spidermonkey', UPSTREAM_CHANNELS: 'playground', BUILD_NATIVE_NONSTREAM: 'false'
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
    AUTO_START: 'true'
  };
}

// serviceEnv is the environment the service is started with: this plugin's settings, and PROXY
// only when the plugin sets one (see pluginProxy). Without it the service takes the PROXY saved
// in .env, which the admin page changes.
export function serviceEnv(dataDir, config, options = {}) {
  const env = pluginEnv(dataDir, config);
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
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${envPath}:${i + 1}: invalid setting name`);
    Object.defineProperty(values, key, {
      value: parseEnvValue(line.slice(eq + 1).trim(), `${envPath}:${i + 1}`),
      enumerable: true, configurable: true, writable: true
    });
  });
  return values;
}

function writeStudioEnv(dataDir, values) {
  const envPath = path.join(dataDir, '.env');
  const keys = [...new Set([...ENV_KEYS, ...Object.keys(values)])];
  // A comment also keeps official upstream releases from re-migrating this file as an old
  // complete configuration. New settings must survive proxy changes and preview-port updates.
  const content = '# Managed connection settings; other settings belong to AIStudio2API.\n' +
    keys.filter(k => Object.hasOwn(values, k) && values[k] !== undefined).map(k => `${k}=${formatEnvValue(String(values[k]))}\n`).join('');
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

function previewPort(addr) {
  const match = /^.+:(\d+)$/.exec(String(addr ?? '').trim());
  if (!match) return 0;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

function defaultPreviewPort(studioPort) {
  return studioPort === DEFAULT_PREVIEW_PORT ? DEFAULT_PREVIEW_PORT + 1 : DEFAULT_PREVIEW_PORT;
}

// syncStudioEnv brings .env up to date with config.json, keeping what the admin page saved: this
// plugin's connection settings are written over. The backend owns all other defaults. A missing PROXY is the one
// given, else the one an older config.json kept (which nothing reads after that).
function syncStudioEnv(dataDir, config, seedProxy, options = {}) {
  const values = readStudioEnv(dataDir);
  if (!config.defaultsPolicy) {
    for (const [key, value] of Object.entries(LEGACY_DEFAULTS)) values[key] ??= value;
  }
  Object.assign(values, pluginEnv(dataDir, config));
  const accountOrder = validateAccountOrder(options.accountOrder);
  if (accountOrder !== undefined && !values.ACCOUNT_ORDER) values.ACCOUNT_ORDER = accountOrder;
  const modelAccounts = validateModelAccounts(options.modelAccounts);
  if (modelAccounts !== undefined && !values.MODEL_ACCOUNTS) values.MODEL_ACCOUNTS = modelAccounts;
  const preview = previewPort(values.PREVIEW_LISTEN_ADDR);
  if (!preview || preview === config.port) {
    values.PREVIEW_LISTEN_ADDR = `127.0.0.1:${defaultPreviewPort(config.port)}`;
  }
  values.PROXY ??= validateProxy(seedProxy) || config.proxy;
  writeStudioEnv(dataDir, values);
}

// ensurePreviewPort makes sure PREVIEW_LISTEN_ADDR in .env is on a free port other than
// studioPort before the service starts: upstream listens on both and exits when either is taken.
async function ensurePreviewPort(dataDir, studioPort) {
  const values = readStudioEnv(dataDir);
  const current = previewPort(values.PREVIEW_LISTEN_ADDR);
  if (current && current !== studioPort && !(await portAnswers(current)) && await canListen(current)) return;
  let port = await pickStudioPort(defaultPreviewPort(studioPort));
  while (port === studioPort) port = await pickStudioPort(0);
  values.PREVIEW_LISTEN_ADDR = `127.0.0.1:${port}`;
  writeStudioEnv(dataDir, values);
}

// saveStudioProxy saves the service's proxy in its .env, as the admin page does. The service
// takes it the next time its generation service starts.
export function saveStudioProxy(dataDir, proxy) {
  const values = readStudioEnv(dataDir);
  values.PROXY = validateProxy(proxy);
  writeStudioEnv(dataDir, values);
}

function writeStudioConfig(dataDir, config) {
  const configPath = path.join(dataDir, 'config.json');
  const tmp = `${configPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configPath);
  fs.chmodSync(configPath, 0o600);
}

// The selection belongs to the data directory, so a plugin upgrade and an existing Magpie
// login keep using it. Changing ownership requires the previous service to be fully stopped.
async function selectStudioBackend(backend, options) {
  const dataDir = options.dataDir || studioDataDir();
  const platform = options.platform || process.platform;
  validateProxy(options.proxy);
  validateAccountOrder(options.accountOrder);
  validateModelAccounts(options.modelAccounts);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return withLock(dataDir, async () => {
    const saved = readStudioConfig(dataDir);
    if (saved && JSON.stringify(saved.backend) === JSON.stringify(backend)) return localStudio({ dataDir, platform });
    const local = localStudio({ dataDir, platform });
    const occupied = local
      ? (await checkStudioHealth(local, options.fetchFn || globalThis.fetch)).state !== 'down'
      : saved && await portAnswers(saved.port);
    if (occupied) {
      throw new Error(`Stop the current AI Studio service before changing backends: ${studioCommand('stop', { dataDir })}`);
    }
    assertStudioExited(dataDir, platform);
    if (backend && studioProcessPids(backend.binaryPath, platform).some(pid => hasStudioAuthArg(pid, dataDir, platform) !== false)) {
      throw new Error('The selected AIStudio2API is still running for this data directory; wait for it to exit before changing backends');
    }
    readStudioEnv(dataDir); // Validate before changing the saved selection.
    if (saved) {
      const next = { ...saved };
      if (backend) next.backend = backend;
      else delete next.backend;
      writeStudioConfig(dataDir, next);
    }
    ensureStudioConfig(dataDir, options.proxy, {
      port: await newConfigPort(dataDir, options), backend,
      accountOrder: options.accountOrder, modelAccounts: options.modelAccounts
    });
    fs.rmSync(path.join(dataDir, LAUNCH_RECORD), { force: true });
    adminSessions.clear();
    return localStudio({ dataDir, platform });
  }, options.lockTimeoutMs ?? 600000);
}

export async function useStudioBinary(value, options = {}) {
  const selected = validateStudioBinary(value, options);
  return selectStudioBackend({ mode: 'user', binaryPath: selected }, options);
}

export async function useDefaultStudio(options = {}) {
  return selectStudioBackend(undefined, options);
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
        defaultsPolicy: 'upstream',
        port: options.port ?? DEFAULT_STUDIO_PORT,
        apiKey: 'as_' + crypto.randomBytes(32).toString('hex'),
        adminUsername: 'magpie',
        adminPassword: crypto.randomBytes(32).toString('hex'),
        ...(options.backend ? { backend: options.backend } : {})
      };
      config = validateConfig(created);
      writeStudioConfig(dataDir, created);
    } else {
      throw err;
    }
  }

  syncStudioEnv(dataDir, config, explicitProxy, options);
  if (!config.defaultsPolicy) {
    // Mark only after .env is saved successfully. Repeated starts leave sparse user settings alone.
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.defaultsPolicy = 'legacy-migrated';
    writeStudioConfig(dataDir, { ...saved, defaultsPolicy: config.defaultsPolicy });
  }

  const authDir = path.join(dataDir, 'auth');
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(authDir, 0o700);

  return config;
}

export function localStudio(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  const platform = options.platform || process.platform;
  let config;
  try {
    config = readStudioConfig(dataDir);
    if (!config) return null;
    if (!config.backend && !fs.existsSync(binaryPath(dataDir, platform))) return null;
  } catch {
    return null;
  }

  return studioConnection(config, dataDir, platform);
}

function studioConnection(config, dataDir, platform) {
  const origin = `http://127.0.0.1:${config.port}`;
  return {
    origin,
    baseURL: `${origin}/v1`,
    apiKey: config.apiKey,
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
    port: config.port,
    dataDir,
    backendMode: config.backend ? 'user' : 'local',
    binaryPath: binaryPath(dataDir, platform)
  };
}

// nodeFetch is fetch over node:http, bounded only by its signal.
export function nodeFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const options = { method: init.method, headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal };
    const req = http.request(url, options, res => {
      const headers = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      resolve(new Response(res.statusCode === 204 ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.on('error', reject);
    req.end(init.body ?? undefined);
  });
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
    // Bun's fetch drops a connection idle for 300 s; the signal sets the deadline instead.
    return fetchFn(url, {
      method,
      headers,
      body: payload,
      redirect: 'error',
      timeout: false,
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

// Give the browser the same authenticated management session as the plugin. Validate it with
// a protected endpoint first, so a stale session is renewed by studioAdmin's usual 401 retry.
// Only the local sign-in page uses this value, in an HttpOnly Set-Cookie response.
export async function studioBrowserSession(local, options = {}) {
  await studioAdmin(local, 'GET', '/api/accounts', null, options);
  return adminSessions.get(`${local.origin}\n${local.adminUsername}\n${local.adminPassword}`);
}

export async function studioAccounts(options = {}) {
  const local = localStudio(options);
  if (!local) return [];
  const res = await studioAdmin(local, 'GET', '/api/accounts', null, options);
  const accounts = Array.isArray(res?.accounts) ? res.accounts : [];
  return accounts.filter(a => a.enabled !== false);
}

// Browser preparation runs in the backend independently of Magpie's ten-minute sign-in.
// A CLI timeout stops polling only; it never cancels the download or creates a login task.
export async function prepareStudioBrowser(local, options = {}) {
  const deadline = options.deadline ?? Date.now() + 60 * 60 * 1000;
  const request = (method, route) => studioAdmin(local, method, route, null, {
    fetchFn: options.fetchFn, timeoutMs: 10000
  });
  let status = await request('POST', '/api/camoufox/download');
  while (true) {
    const browser = status?.camoufox;
    if (!browser || typeof browser.ready !== 'boolean') throw new Error('This backend does not report browser preparation; use its account management page');
    options.onProgress?.(browser);
    if (browser.ready) return browser;
    if (browser.error && !browser.preparing) throw new Error(browser.error);
    if (Date.now() >= deadline) throw new Error('Browser preparation is still running in the backend. Check its management page; reconnect in Magpie after preparation finishes.');
    await sleep(Math.min(options.pollMs ?? 2000, Math.max(1, deadline - Date.now())));
    status = await request('GET', '/api/status');
  }
}

// studioLogin starts an AIStudio2API account login (accountId null) or relogin task, waits for it
// to finish, and deletes the task on exit (which cancels a running task and closes its browser
// window if the deadline passes first).
export async function studioLogin(local, accountId = null, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const deadline = options.deadline ?? (Date.now() + (options.timeoutMs ?? 15 * 60 * 1000));
  const pollMs = options.pollMs ?? 250;
  const pathname = accountId ? `/api/accounts/${encodeURIComponent(accountId)}/login` : '/api/accounts';
  const request = async (method, route, body = null) => {
    const timeout = cause => Object.assign(new Error('Login timed out', { cause }), { timedOut: true });
    if (Date.now() >= deadline) throw timeout();
    try {
      return await studioAdmin(local, method, route, body, {
        fetchFn, timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now()))
      });
    } catch (err) {
      // A deadline can expire inside fetch/body consumption, not just between task polls.
      // Keep shorter request timeouts distinct from exhaustion of the whole login budget.
      if (!err.foreign && Date.now() >= deadline &&
          [err.name, err.cause?.name].some(name => name === 'TimeoutError' || name === 'AbortError')) throw timeout(err);
      throw err;
    }
  };
  const res = await request('POST', pathname, {});
  if (res?.account && !res?.task) return res.account;
  const taskId = res?.task?.id;
  if (typeof taskId !== 'string' || !taskId) {
    throw new Error('AIStudio2API did not start a login task');
  }
  try {
    let task = res.task;
    while (task.state === 'running' || task.state === 'pending') {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const err = new Error('Login timed out');
        err.timedOut = true;
        throw err;
      }
      await new Promise(r => setTimeout(r, Math.min(pollMs, remaining)));
      if (Date.now() >= deadline) {
        const err = new Error('Login timed out');
        err.timedOut = true;
        throw err;
      }
      const list = await request('GET', '/api/accounts/tasks');
      task = Array.isArray(list?.tasks) ? list.tasks.find(t => t?.id === taskId) : null;
      if (!task) throw new Error('Login task disappeared before completion');
    }
    const item = Array.isArray(task.items) ? task.items[0] : null;
    if (task.state === 'failed' || item?.state === 'failed') {
      throw new Error(item?.error || 'Google login failed');
    }
    if (task.state !== 'done') {
      throw new Error(`Unexpected login task state: ${task.state}`);
    }
    const accountsRes = await request('GET', '/api/accounts');
    const accounts = Array.isArray(accountsRes?.accounts) ? accountsRes.accounts : [];
    const wanted = String(accountId || item?.label || '').trim().toLowerCase();
    return (wanted && accounts.find(a => a && (String(a.id || '').toLowerCase() === wanted || String(a.label || '').toLowerCase() === wanted))) || null;
  } finally {
    await studioAdmin(local, 'DELETE', `/api/accounts/tasks/${encodeURIComponent(taskId)}`, null, {
      fetchFn,
      timeoutMs: 3000
    }).catch(() => {});
  }
}

// PROXY_SOURCES names where the proxy the service goes out through comes from.
export const PROXY_SOURCES = {
  option: '插件选项 studio.proxy',
  env: '环境变量 AI_STUDIO_PROXY',
  saved: '管理页',
  startup: '服务启动时的设置',
  unknown: '来源待确认',
  system: '自动检测：系统代理设置',
  legacy: '旧版插件启动的服务自动检测到的，可能来自启动时的环境变量或系统代理设置',
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
// proxyEnv 'none' says it was started with no *_PROXY in its environment (see launchStudio); a
// record without it is an older plugin's, whose service may have had one: Magpie's, a shell's,
// or none, which nothing kept tells apart.
const LAUNCH_RECORD = 'backend.launch.json';

function writeLaunchRecord(dataDir, pid, proxy, platform) {
  const record = { pid, proxy: pluginProxy(proxy)?.source ?? null, proxyEnv: 'none',
    processStarted: processStarted(pid, platform), binaryPath: binaryPath(dataDir, platform), authDir: path.resolve(dataDir, 'auth') };
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
  const override = options.standalone ? null : pluginProxy(options.proxy);
  const cfg = await studioAdmin(local, 'GET', '/api/config', null, { timeoutMs: 3000, fetchFn: options.fetchFn });
  // What the service reads as its PROXY now: .env, or the environment it was started with over it
  const loaded = proxyList(cfg?.proxy).join(',');
  const active = proxyList(cfg?.active_proxy).join(',');

  let want = override ? override.proxy : saved;
  let wantedSource = override ? override.source : 'saved';
  let overridden = override && saved && saved !== override.proxy ? override.source : null;
  if (options.standalone && loaded !== saved) {
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
  else if (!loaded) {
    // An older plugin started it, maybe with a proxy in its environment, which the system's can't
    // be told from
    const record = launchRecord(local.dataDir);
    source = record && record.proxyEnv !== 'none' ? 'legacy' : 'system';
  } else source = wantedSource;

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
    if (current.code === 'ECONNREFUSED' || current.code === 'ConnectionRefused' || current.code === 'ENOENT') return true;
    if (Array.isArray(current.errors)) {
      for (const sub of current.errors) {
        if (isConnectRefused(sub)) return true;
      }
    }
    current = current.cause;
  }
  return false;
}

// Identify this instance through admin authentication, status shape and API-key verification.
// The executable version is informational; upgrades and downgrades belong to the user.
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

  return { state: 'up', status };
}

// CAMOUFOX_EXECUTABLES are where upstream's Camoufox, the browser it signs Google accounts in
// with, has its executable in its folder, by platform (camoufoxnative.camoufoxExecutablePath).
const CAMOUFOX_EXECUTABLES = {
  win32: 'camoufox.exe',
  linux: 'camoufox-bin',
  darwin: path.join('Camoufox.app', 'Contents', 'MacOS', 'camoufox')
};
// How much of the end of backend.log camoufoxState reads for the download's size
const LOG_TAIL_BYTES = 256 * 1024;
// Upstream chooses and validates its browser version. Report installed files and download
// progress without tying readiness to a version bundled with this plugin.
export function camoufoxState(dataDir, platform = process.platform, env = process.env) {
  const exe = CAMOUFOX_EXECUTABLES[platform];
  if (!exe || env.CAMOUFOX_PATH?.trim()) return { ready: true };
  const runtime = path.join(dataDir, 'runtime');
  const candidates = [path.join(runtime, 'camoufox', exe), path.join(dataDir, 'package', 'runtime', 'camoufox', exe)];
  if (platform === 'win32' && env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'camoufox', 'camoufox', 'Cache', exe));
  if (candidates.some(exe => { try { return fs.statSync(exe).isFile(); } catch { return false; } })) return { ready: true };

  let names = [];
  try { names = fs.readdirSync(runtime); } catch {}
  const part = names.find(n => /^camoufox-.+\.zip\.part$/.test(n));
  let received = 0;
  try { if (part) received = fs.statSync(path.join(runtime, part)).size; } catch {}
  const total = camoufoxSize(path.join(dataDir, 'backend.log'));
  return {
    ready: false,
    received,
    // the log rounds the size down to a MiB
    total: total && Math.max(total, received),
    unpacking: names.some(n => n.startsWith('.camoufox-stage-'))
  };
}

// Camoufox download logs retain size_mib across UI languages. Ignore unrelated downloads.
function camoufoxSize(logPath) {
  let tail;
  try {
    const fd = fs.openSync(logPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, LOG_TAIL_BYTES);
      tail = Buffer.alloc(length);
      fs.readSync(fd, tail, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
  const lines = tail.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (!/camoufox/i.test(entry.msg || '')) continue;
      const mib = entry.size_mib;
      if (Number.isFinite(mib) && mib > 0) return mib * 1024 * 1024;
    } catch {}
  }
  return 0;
}

export async function studioStatus(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const local = localStudio({ dataDir, platform });
  if (!local) return { status: 'not_installed', dataDir };

  const details = {
    port: local.port, dataDir, backendMode: local.backendMode, binaryPath: local.binaryPath
  };
  const health = await checkStudioHealth(local, fetchFn);
  if (health.state === 'up') {
    return { ...health.status, status: 'running', ...details };
  }
  if (health.state === 'down') {
    return { status: 'stopped', ...details };
  }
  return { status: health.state, reason: health.reason, ...details };
}

function sameExecutable(actual, expected) {
  if (!actual) return false;
  actual = actual.trim().replace(/ \(deleted\)$/, '');
  const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  if (!path.isAbsolute(actual)) return false;
  if (normalize(actual) === normalize(expected)) return true;
  try { return normalize(fs.realpathSync(actual)) === normalize(fs.realpathSync(expected)); } catch { return false; }
}

function replacedExecutable(actual, expected) {
  // The official CLI updater moves the old image here before unlinking it. Its launch argv
  // still identifies the original path on macOS; /proc/exe retains the renamed image on Linux.
  return sameExecutable(actual, path.join(path.dirname(expected), '.' + path.basename(expected) + '.old'));
}

function launchedFrom(command, bin) {
  return [bin, '"' + bin + '"'].some(prefix => command === prefix || command.startsWith(prefix + ' '));
}

// true = verified executable, false = another/dead process, null = inspection unavailable.
// File replacement is a pathname change, not evidence that a running PID has exited.
export function verifyProcessIdentity(pid, expectedBinaryPath, platform = process.platform, run = execFileSync) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const opts = { encoding: 'utf8', timeout: 5000, windowsHide: true, env: { ...process.env,
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8', LANG: process.env.LANG || 'en_US.UTF-8' } };
  try {
    if (platform === 'win32') {
      const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter "ProcessId = $env:TARGET_PID" | Select-Object -ExpandProperty ExecutablePath'],
      { ...opts, timeout: 20000, env: { ...process.env, TARGET_PID: String(pid) } }).trim();
      if (!out) return processAlive(pid) ? null : false;
      if (sameExecutable(out, expectedBinaryPath)) return true;
      if (!replacedExecutable(out, expectedBinaryPath)) return false;
      const command = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_Process -Filter "ProcessId = $env:TARGET_PID").CommandLine'],
      { ...opts, timeout: 20000, env: { ...process.env, TARGET_PID: String(pid) } }).trim();
      return command ? launchedFrom(command, expectedBinaryPath) : null;
    }
    if (platform === 'linux' && run === execFileSync) {
      const exe = fs.readlinkSync('/proc/' + pid + '/exe');
      if (sameExecutable(exe, expectedBinaryPath)) return true;
      if (!replacedExecutable(exe, expectedBinaryPath)) return false;
      return sameExecutable(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0')[0], expectedBinaryPath);
    }
    const comm = run('ps', ['-p', String(pid), '-o', 'comm='], opts).trim();
    if (!comm) return processAlive(pid) ? null : false;
    if (sameExecutable(comm, expectedBinaryPath)) return true;
    if (!replacedExecutable(comm, expectedBinaryPath) &&
        (path.isAbsolute(comm) || path.basename(comm.replace(/ \(deleted\)$/, '')) !== path.basename(expectedBinaryPath))) return false;
    const command = run('ps', ['-ww', '-p', String(pid), '-o', 'command='], opts).trim();
    return command ? launchedFrom(command, expectedBinaryPath) : processAlive(pid) ? null : false;
  } catch { return processAlive(pid) ? null : false; }
}

function processStarted(pid, platform = process.platform) {
  if (!processAlive(pid)) return null;
  try {
    if (platform === 'linux') {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    const opts = { encoding: 'utf8', timeout: 5000, windowsHide: true };
    return (platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance Win32_Process -Filter "ProcessId = $env:TARGET_PID").CreationDate.ToUniversalTime().ToString("O")'],
        { ...opts, timeout: 20000, env: { ...process.env, TARGET_PID: String(pid) } })
      : execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { ...opts, env: { ...process.env, LC_ALL: 'C' } })).trim() || null;
  } catch { return null; }
}

function recordedInstance(pid, dataDir, platform) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, LAUNCH_RECORD), 'utf8'));
    return record.pid === pid && record.processStarted &&
      record.authDir === path.resolve(dataDir, 'auth') &&
      sameExecutable(record.binaryPath, binaryPath(dataDir, platform)) &&
      record.processStarted === processStarted(pid, platform);
  } catch { return false; }
}

function studioAuthArg(dataDir) {
  return `-auth=${path.resolve(dataDir, 'auth')}`;
}

// Several installations may share one user-owned executable. Its launch arguments identify
// this data directory even after an updater replaces the PID or temporarily closes HTTP.
function hasStudioAuthArg(pid, dataDir, platform) {
  const arg = studioAuthArg(dataDir);
  try {
    if (platform === 'linux') {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      return args.includes(arg) ? true : args.some(a => /^--?auth(?:=|$)/.test(a)) ? false : undefined;
    }
    const command = platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          '[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter "ProcessId = $env:TARGET_PID" | Select-Object -ExpandProperty CommandLine'],
        { env: { ...process.env, TARGET_PID: String(pid) }, encoding: 'utf8', timeout: 20000, windowsHide: true })
      : execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000,
          env: { ...process.env, LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8', LANG: process.env.LANG || 'en_US.UTF-8' } });
    if (!command.trim()) return processAlive(pid) ? null : false;
    const escaped = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Our auth argument is last; upstream can append only -open-ui=false on relaunch.
    // An arbitrary whitespace boundary would also match '/ours/auth another-dir/auth'.
    if (new RegExp('(?:^|\\s)(?:"' + escaped + '"|' + escaped + ')(?:\\s+-open-ui=false)?\\s*$', platform === 'win32' ? 'i' : '').test(command)) return true;
    return /(?:^|[\s"])--?auth(?:=|\s)/.test(command) ? false : undefined;
  } catch { return processAlive(pid) ? null : false; }
}

function belongsToStudio(pid, dataDir, platform) {
  const scope = hasStudioAuthArg(pid, dataDir, platform);
  if (scope === undefined) return readStudioConfig(dataDir)?.backend?.mode !== 'user';
  // A temporarily unavailable command line must not strand a process we launched. Match
  // its start time as well as its PID and instance; a reused PID is never sufficient.
  return scope === null && recordedInstance(pid, dataDir, platform) ? true : scope;
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
        '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:TARGET_BINARY -or $_.ExecutablePath -eq $env:TARGET_OLD_BINARY } | Select-Object -ExpandProperty ProcessId'],
      { ...opts, env: { ...process.env, TARGET_BINARY: path.resolve(bin), TARGET_OLD_BINARY: path.join(path.dirname(path.resolve(bin)), '.' + path.basename(bin) + '.old') } });
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
  const psOpts = run === execFileSync
    ? {
        ...opts,
        env: {
          ...process.env,
          LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
          LANG: process.env.LANG || 'en_US.UTF-8'
        }
      }
    : opts;
  const pids = new Set();
  output = run('ps', ['-axo', 'pid=,comm='], psOpts);
  for (const line of String(output).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match && (sameExecutable(match[2], bin) || replacedExecutable(match[2], bin))) pids.add(Number(match[1]));
  }
  // On macOS an unlinked image may lose its absolute comm pathname. The launch argv survives
  // the official rename/unlink/exec sequence, including an HTTP-down restart window.
  const commands = run('ps', ['-ww', '-axo', 'pid=,command='], psOpts);
  for (const line of String(commands).split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match && launchedFrom(match[2], bin)) pids.add(Number(match[1]));
  }
  return [...pids];
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
  const alive = processAlive(tracked);
  const identity = alive ? verifyProcessIdentity(tracked, bin, platform) : false;
  if (alive && identity !== false && belongsToStudio(tracked, dataDir, platform) !== false) {
    // Unknown identity is not evidence of exit. Keep its record and refuse another launch.
    pids = [tracked];
  } else {
    // A live PID can belong to an unrelated process after a crash or reboot.
    fs.rmSync(path.join(dataDir, 'backend.pid'), { force: true });
    pids = studioProcessPids(bin, platform).filter(pid => belongsToStudio(pid, dataDir, platform) !== false);
  }
  if (pids.length) {
    throw new Error(`AI Studio may still be running or restarting (PID ${pids.join(', ')}), even though its HTTP port is closed. Wait for it to finish restarting, or run: ${studioCommand('stop', { dataDir })}. No binary was replaced or new process started.`);
  }
}

function writablePackage(dataDir, platform) {
  if (platform === 'win32' || readStudioConfig(dataDir)?.backend?.mode === 'user') return;
  // Undo old releases' read-only package directory so upstream's updater can replace its file.
  try {
    const pkg = path.join(dataDir, 'package');
    const mode = fs.statSync(pkg).mode & 0o777;
    if ((mode & 0o700) !== 0o700) fs.chmodSync(pkg, mode | 0o700);
  } catch {
    // Keep a healthy service usable even on a read-only filesystem. Its updater reports write errors.
  }
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

// downloadProgress is a download's step as curl writes it: the bytes in file so far, of the
// Content-Length the last response in headersFile gave (the archive's, after GitHub's redirects),
// 0 while that isn't known.
export function downloadProgress(file, headersFile) {
  let received = 0;
  let total = 0;
  try { received = fs.statSync(file).size; } catch {}
  try {
    const lengths = [...fs.readFileSync(headersFile, 'latin1').matchAll(/^content-length:\s*(\d+)/gim)];
    if (lengths.length) total = Number(lengths.at(-1)[1]);
  } catch {}
  return { step: 'download', received, total: total >= received ? total : 0 };
}

export async function installStudio(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return withLock(dataDir, async () => {
    const local = await installStudioFiles({ ...options, dataDir });
    if (options.version !== undefined) {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      writeStudioConfig(dataDir, { ...raw, autoUpdate: false });
    }
    return local;
  }, options.lockTimeoutMs ?? 600000)
    .finally(() => setupSteps.delete(dataDir));
}

async function installStudioFiles(options) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;

  const dataDir = options.dataDir || studioDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);

  // Validate ownership before touching any installation files.
  const savedConfig = readStudioConfig(dataDir);
  if (savedConfig?.backend?.mode === 'user') {
    throw new Error(`This AI Studio backend uses a custom executable. Update it yourself, or stop it and select the default installation directory: ${studioCommand('use-default', { dataDir })}`);
  }

  validateProxy(options.proxy);
  validateAccountOrder(options.accountOrder);
  validateModelAccounts(options.modelAccounts);
  readStudioEnv(dataDir);
  const requireStopped = async () => {
    // Check the saved port even when an old executable is missing or being replaced.
    const current = readStudioConfig(dataDir);
    const local = current ? studioConnection(current, dataDir, platform) : null;
    if (local) {
      const health = await checkStudioHealth(local, options.fetchFn || globalThis.fetch);
      if (health.state === 'up') throw new Error('Cannot install or update AIStudio2API while service is running. Stop the service first.');
      if (health.state === 'foreign') throw portTaken(local);
      if (health.state === 'unresponsive') throw notResponding(local, health);
    }
    assertStudioExited(dataDir, platform);
  };
  await requireStopped();
  const proxy = downloadProxy(dataDir, options.proxy, savedConfig);
  setupSteps.set(dataDir, { step: 'download', received: 0, total: 0 });
  const selectedRelease = await resolveStudioRelease({ ...options, platform, arch, proxy });
  const expectedHash = selectedRelease.sha256;
  let archivePath = options.archivePath;
  // An explicit install can reuse the exact requested official archive after verifying it.
  const retainedArchive = path.join(dataDir, selectedRelease.asset);
  if (!archivePath && fs.existsSync(retainedArchive) && computeFileHash(retainedArchive) === expectedHash) {
    archivePath = retainedArchive;
  }
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
      const downloadUrl = selectedRelease.url;
      archivePath = path.join(stageDir, selectedRelease.asset);
      setupSteps.set(dataDir, { step: 'download', received: 0, total: 0 });

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
        const curlArgs = ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--speed-limit', '1', '--speed-time', '60', '--max-time', '600'];
        if (proxy) {
          curlArgs.push('--proxy', proxy);
        }
        // The headers curl dumps as they come say the archive's size, and the file it writes says
        // how much has come: together they show the download's progress.
        const headersPath = path.join(stageDir, 'headers.txt');
        curlArgs.push('-D', headersPath, '-o', archivePath, downloadUrl);
        const watch = setInterval(() => setupSteps.set(dataDir, downloadProgress(archivePath, headersPath)), 500);
        try {
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
        } finally {
          clearInterval(watch);
        }
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

    setupSteps.set(dataDir, { step: 'install' });
    const extractDir = path.join(stageDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });

    if (platform === 'win32') {
      await execFileAsync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop';
        Add-Type -AssemblyName System.IO.Compression.FileSystem;
        $zip = [System.IO.Compression.ZipFile]::OpenRead($env:ARCHIVE_PATH);
        try {
          foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\\', '/');
            $kind = ($entry.ExternalAttributes -shr 16) -band 61440;
            if ($name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or ($name.Split('/') -contains '..') -or ($kind -ne 0 -and $kind -ne 32768 -and $kind -ne 16384)) {
              throw 'Dangerous member or special file in archive rejected';
            }
          }
        } finally { $zip.Dispose() }
        Expand-Archive -LiteralPath $env:ARCHIVE_PATH -DestinationPath $env:DEST_PATH -Force`
      ], {
        env: { ...process.env, ARCHIVE_PATH: archivePath, DEST_PATH: extractDir },
        windowsHide: true
      });
    } else {
      const listOutput = (await execFileAsync('tar', ['-tvf', archivePath], { encoding: 'utf8' })).stdout.split('\n').filter(Boolean);
      for (const line of listOutput) {
        const parts = line.split(/\s+/);
        const mode = parts[0];
        if (!mode.startsWith('-') && !mode.startsWith('d')) {
          throw new Error(`Symlinks or special files in archive rejected: ${line}`);
        }
      }
      const listing = (await execFileAsync('tar', ['-tf', archivePath], { encoding: 'utf8' })).stdout.split('\n').filter(Boolean);
      for (const entry of listing) {
        const entryParts = entry.replace(/\\/g, '/').split('/');
        if (entryParts.includes('..') || entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry)) {
          throw new Error(`Dangerous member in archive rejected: ${entry}`);
        }
      }
      await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir]);
    }

    let topDir = extractDir;
    const entries = fs.readdirSync(extractDir);
    if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
      topDir = path.join(extractDir, entries[0]);
    }

    const binName = platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api';
    const foundBin = path.join(topDir, binName);
    if (!fs.existsSync(foundBin) || !fs.lstatSync(foundBin).isFile()) {
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

    // Download/extraction can take minutes: recheck HTTP and process ownership before the swap.
    await requireStopped();
    const port = await newConfigPort(dataDir, options);
    fs.renameSync(topDir, stagePackageDir);

    let hasBackup = false;
    let installedNewFinal = false;
    let rootBackedUp = false, installedRoot = false;
    const rootBinary = path.join(dataDir, binName);
    const rootBackup = path.join(backupPackageDir, '.root-executable');
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
      // The official Windows build is a desktop executable: it changes cwd to
      // its executable directory. Keep that executable beside .env and runtime/.
      if (platform === 'win32') {
        if (fs.existsSync(rootBinary)) {
          fs.mkdirSync(backupPackageDir, { recursive: true });
          fs.renameSync(rootBinary, rootBackup);
          rootBackedUp = true;
        }
        fs.renameSync(path.join(finalPackageDir, binName), rootBinary);
        installedRoot = true;
      }

      const manifest = {
        source: 'official',
        repository: selectedRelease.repository,
        asset: selectedRelease.asset,
        version: selectedRelease.version.slice(1),
        platform,
        arch,
        ...(platform === 'win32' ? { binaryLayout: 'data' } : {}),
        archiveSha256: expectedHash,
        binarySha256
      };
      const tmpManifest = `${manifestPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmpManifest, manifestPath);
      fs.chmodSync(manifestPath, 0o600);

      ensureStudioConfig(dataDir, options.proxy, { port, accountOrder: options.accountOrder, modelAccounts: options.modelAccounts });
      writablePackage(dataDir, platform);

    } catch (swapErr) {
      if (installedRoot) { try { fs.rmSync(rootBinary, { force: true }); } catch {} }
      if (rootBackedUp) { try { fs.renameSync(rootBackup, rootBinary); } catch {} }
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
    // A failure deleting an old backup must not roll a successful installation back to a
    // partially deleted directory. Keep any leftover backup for later cleanup.
    if (hasBackup || rootBackedUp) {
      try { removePackage(backupPackageDir, platform); } catch {}
    }
    removeOtherArchives(dataDir, selectedRelease.asset);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  onStudioAssetInstalled?.();
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
  const fetchFn = options.fetchFn || globalThis.fetch;
  let status = initial;
  if (status.running || status.accounts.total === 0) return local;
  if (status.state === 'STOPPED' && !needsSignIn(status.accounts)) {
    await studioAdmin(local, 'POST', '/api/control/start', null, { fetchFn, timeoutMs: 180000 });
  }
  const deadline = Date.now() + (options.generationTimeoutMs ?? 120000);
  for (;;) {
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
  const { local, status } = await shared(inFlightStarts, dataDir,
    () => launchStudio({ ...options, dataDir }).finally(() => setupSteps.delete(dataDir)));
  if (options.managementOnly) return local;
  return shared(inFlightReady, dataDir, () => readyStudio(local, status, options));
}

// needsRoutingSeed checks whether options.accountOrder or options.modelAccounts should seed an
// unset/empty key in .env, without mutating disk.
function needsRoutingSeed(dataDir, options) {
  const accountOrder = validateAccountOrder(options.accountOrder);
  const modelAccounts = validateModelAccounts(options.modelAccounts);
  if (!accountOrder && !modelAccounts) return null;
  let env = {};
  try {
    env = readStudioEnv(dataDir);
  } catch {
    return null;
  }
  const seedOrder = accountOrder && !env.ACCOUNT_ORDER ? accountOrder : null;
  const seedModels = modelAccounts && !env.MODEL_ACCOUNTS ? modelAccounts : null;
  if (!seedOrder && !seedModels) return null;
  return { seedOrder, seedModels };
}

async function seedRunningStudioRouting(local, dataDir, options, fetchFn) {
  const seed = needsRoutingSeed(dataDir, options);
  if (!seed) return;
  try {
    const current = await studioAdmin(local, 'GET', '/api/config', null, { fetchFn, timeoutMs: 3000 });
    if (current && typeof current === 'object') {
      const next = { ...current };
      let changed = false;
      if (seed.seedOrder && !String(current.account_order || '').trim()) {
        next.account_order = seed.seedOrder;
        changed = true;
      }
      if (seed.seedModels && !String(current.model_accounts || '').trim()) {
        next.model_accounts = seed.seedModels;
        changed = true;
      }
      if (changed) {
        await studioAdmin(local, 'PUT', '/api/config', next, { fetchFn, timeoutMs: 3000 });
      }
      return;
    }
  } catch {
    // Fall back to .env sync below when the running listener is a test stub without /api/config.
  }
  ensureStudioConfig(dataDir, options.proxy, {
    accountOrder: options.accountOrder,
    modelAccounts: options.modelAccounts
  });
}

// launchStudio installs the official CLI only when the default executable is absent, and
// returns how to reach it with the status it last reported.
async function launchStudio(options) {
  const { dataDir } = options;
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;

  const local = localStudio({ dataDir, platform });
  if (local) {
    const health = await checkStudioHealth(local, fetchFn);
    if (health.state === 'up' && !needsRoutingSeed(dataDir, options)) {
      writablePackage(dataDir, platform);
      return { local, status: health.status };
    }
    if (health.state === 'foreign') throw portTaken(local);
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return withLock(dataDir, () => launchLockedStudio(options));
}

// The caller holds the setup lock, including through automatic-update rollback.
async function launchLockedStudio(options) {
    const { dataDir } = options;
    const platform = options.platform || process.platform;
    const arch = options.arch || process.arch;
    const fetchFn = options.fetchFn || globalThis.fetch;
    const spawnFn = options.spawnFn || spawn;
    const startTimeoutMs = options.startTimeoutMs ?? 60000;
    let local = localStudio({ dataDir, platform });
    if (local) {
      const health = await settle(local, await checkStudioHealth(local, fetchFn), fetchFn, options.unresponsiveTimeoutMs ?? 10000);
      if (health.state === 'up') {
        await seedRunningStudioRouting(local, dataDir, options, fetchFn);
        writablePackage(dataDir, platform);
        return { local, status: health.status };
      }
      if (health.state === 'foreign') throw portTaken(local);
      if (health.state === 'unresponsive') throw notResponding(local, health);
    }
    assertStudioExited(dataDir, platform);

    // Check config validity before touching binaries
    const configPath = path.join(dataDir, 'config.json');
    if (fs.existsSync(configPath)) {
      validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    }

    const userManaged = readStudioConfig(dataDir)?.backend?.mode === 'user';
    const binPath = binaryPath(dataDir, platform);
    if (userManaged) validateStudioBinary(binPath, { dataDir, platform });
    if (!userManaged && !fs.existsSync(binPath)) {
      await installStudioFiles({
        dataDir,
        platform,
        arch,
        fetchFn,
        archivePath: options.archivePath,
        version: options.version,
        proxy: options.proxy ?? options.savedProxy,
        preferredPort: options.preferredPort,
        accountOrder: options.accountOrder,
        modelAccounts: options.modelAccounts
      });
    }

    const config = ensureStudioConfig(dataDir, options.proxy, {
      port: await newConfigPort(dataDir, options),
      accountOrder: options.accountOrder,
      modelAccounts: options.modelAccounts
    });
    if (options.savedProxy !== undefined) saveStudioProxy(dataDir, options.savedProxy);
    local = localStudio({ dataDir, platform });
    if (!local) throw new Error(`Invalid AI Studio configuration in ${dataDir}`);

    const health = await checkStudioHealth(local, fetchFn);
    if (health.state === 'up') return { local, status: health.status };
    if (health.state === 'foreign') throw portTaken(local);
    if (health.state !== 'down') throw notResponding(local, health);
    assertStudioExited(dataDir, platform);
    await ensurePreviewPort(dataDir, config.port);
    writablePackage(dataDir, platform);

    // Clean environment: no host AISTUDIO_* or WAA_* vars, nor any of upstream's settings, which
    // would hide the ones saved in .env
    const cleanEnv = {};
    const savedKeys = new Set(Object.keys(readStudioEnv(dataDir)).map(k => k.toUpperCase()));
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('AISTUDIO_') && !k.startsWith('WAA_') && !ENV_KEYS.includes(k.toUpperCase()) && !savedKeys.has(k.toUpperCase()) && !PROXY_ENV.includes(k.toUpperCase())) {
        cleanEnv[k] = v;
      }
    }
    // Nor a proxy of the starter's: the service outlives Magpie, whose plugin host gives a program it
    // starts with none of these the proxy of the request it starts in, or Magpie's own, which may be
    // gone by the time the service uses it. Empty ones keep the host from adding its own.
    for (const k of PROXY_ENV) cleanEnv[k] = '';
    Object.assign(cleanEnv, serviceEnv(dataDir, config, { proxy: options.proxy }));

    setupSteps.set(dataDir, { step: 'start' });
    const logPath = path.join(dataDir, 'backend.log');
    rotateLog(logPath);
    const logFd = fs.openSync(logPath, 'a', 0o600);
    let launchError;
    try {
      const args = ['-open-ui=false', studioAuthArg(dataDir)];
      const child = spawnFn(binPath, args, {
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
        writeLaunchRecord(dataDir, child.pid, options.proxy, platform);
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
      if (launchError) throw launchError;
      await sleep(250);
    }
    throw new Error(`AI Studio service did not start within ${Math.round(startTimeoutMs / 1000)}s; see ${logPath}`);
}

export async function stopStudio(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const pidFile = path.join(dataDir, 'backend.pid');

  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('Cannot stop: missing configuration in data directory');
  }
  let local;
  try {
    const config = readStudioConfig(dataDir);
    if (!config) throw new Error('invalid config');
    // During replacement the executable pathname can be absent while its old image is live.
    local = studioConnection(config, dataDir, platform);
  } catch {
    throw new Error('Cannot stop: invalid configuration in data directory');
  }

  let health = await checkStudioHealth(local, fetchFn);
  if (health.state === 'foreign') {
    throw new Error(`Cannot stop unknown or foreign process listening on port ${local.port}`);
  }

  let pid = recordedPid(dataDir);
  const bin = binaryPath(dataDir, platform);
  const trackedAlive = processAlive(pid);
  const trackedIdentity = trackedAlive ? verifyProcessIdentity(pid, bin, platform) : false;
  const trackedScope = trackedAlive ? belongsToStudio(pid, dataDir, platform) : false;
  let alive = trackedAlive && trackedIdentity === true && trackedScope === true;
  if (trackedAlive && trackedIdentity !== false && trackedScope !== false && !alive) {
    return { stopped: false, reported: `Cannot inspect AI Studio process ${pid} safely. Its PID record was kept. Check process-inspection permissions, wait for the update to finish, then retry: ${studioCommand('stop', { dataDir })}` };
  }
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
      const scoped = candidates.filter(p => belongsToStudio(p, dataDir, platform) !== false);
      discovered = scoped;
      const verified = scoped.filter(p => processAlive(p) && verifyProcessIdentity(p, bin, platform) && belongsToStudio(p, dataDir, platform) === true);
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

  if (!verifyProcessIdentity(pid, bin, platform) || !belongsToStudio(pid, dataDir, platform)) {
    throw new Error(`Process ${pid} does not match this AI Studio instance at ${bin}; refusal to signal unverified process`);
  }

  health = await checkStudioHealth(local, fetchFn);
  if (health.state === 'foreign') {
    throw new Error(`Cannot stop unknown or foreign process listening on port ${local.port}`);
  }

  if (health.state === 'up') {
    try {
      await studioAdmin(local, 'POST', '/api/control/stop', null, { fetchFn, timeoutMs: 5000 });
    } catch {}
  }

  if (!verifyProcessIdentity(pid, bin, platform) || !belongsToStudio(pid, dataDir, platform)) {
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

export function studioAutoUpdates(dataDir = studioDataDir()) {
  const config = readStudioConfig(dataDir);
  return !!config && config.backend?.mode !== 'user' && config.autoUpdate !== false;
}

export async function setStudioAutoUpdate(enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Automatic updates must be enabled or disabled');
  const dataDir = options.dataDir || studioDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return withLock(dataDir, async () => {
    ensureStudioConfig(dataDir, undefined, { port: await newConfigPort(dataDir, {}) });
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    validateConfig(raw);
    writeStudioConfig(dataDir, { ...raw, autoUpdate: enabled });
    // Explicitly enabling also retries a previously rejected release.
    if (enabled) fs.rmSync(path.join(dataDir, 'automatic-update.json'), { force: true });
    return studioAutoUpdates(dataDir);
  });
}

export { processStarted as studioProcessStarted };

// All automatic update work shares the lifecycle lock. The operation may download
// while HTTP stays up, then calls replace only after taking its request/login gate.
export async function withStudioUpdate(options, operation) {
  const dataDir = options.dataDir || studioDataDir();
  if (!studioAutoUpdates(dataDir)) return { state: 'disabled' };
  return withLock(dataDir, async () => {
    const local = localStudio({ ...options, dataDir });
    if (!local || !studioAutoUpdates(dataDir)) return { state: 'disabled' };
    return operation({ local, replace: prepared => replaceStudioPackage(prepared, { ...options, dataDir }) });
  }, options.lockTimeoutMs ?? 600000);
}

async function replaceStudioPackage(prepared, options) {
  const { dataDir } = options;
  const platform = options.platform || process.platform;
  const manifestPath = path.join(dataDir, 'install-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(path.join(prepared, 'install-manifest.json'), 'utf8'));
  const preparedBin = binaryPath(prepared, platform);
  if (manifest.source !== 'official' || computeFileHash(preparedBin) !== manifest.binarySha256) {
    throw new Error('Prepared official backend failed integrity verification');
  }
  const packageDir = path.join(dataDir, 'package');
  const stage = path.join(dataDir, `.package.stage.${crypto.randomUUID()}`);
  const backup = path.join(dataDir, `.package.backup.${crypto.randomUUID()}`);
  const oldManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null;
  fs.cpSync(path.join(prepared, 'package'), stage, { recursive: true });
  const rootBinary = path.join(dataDir, 'aistudio2api.exe');
  const rootBackup = path.join(backup, '.root-executable');
  if (platform === 'win32') fs.copyFileSync(preparedBin, path.join(stage, 'aistudio2api.exe'));
  let stopped = false, movedOld = false, installed = false, rootBackedUp = false, installedRoot = false, triedNew = false;
  try {
    const result = await stopStudio(options);
    if (!result.stopped) throw new Error(result.reported || 'Could not safely stop AI Studio for updating');
    stopped = true;
    assertStudioExited(dataDir, platform);
    writablePackage(dataDir, platform);
    if (fs.existsSync(packageDir)) {
      fs.renameSync(packageDir, backup);
      movedOld = true;
    } else fs.mkdirSync(backup);
    fs.renameSync(stage, packageDir);
    installed = true;
    if (platform === 'win32') {
      if (fs.existsSync(rootBinary)) {
        fs.renameSync(rootBinary, rootBackup);
        rootBackedUp = true;
      }
      fs.renameSync(path.join(packageDir, 'aistudio2api.exe'), rootBinary);
      installedRoot = true;
    }
    fs.copyFileSync(path.join(prepared, 'install-manifest.json'), manifestPath);
    fs.chmodSync(manifestPath, 0o600);
    triedNew = true;
    const launched = await launchLockedStudio(options);
    if (launched.status.version?.replace(/^v/, '') !== manifest.version) {
      throw new Error('Updated AI Studio did not report the prepared version');
    }
  } catch (err) {
    err.studioRejectedRelease = triedNew;
    if (stopped) {
      if (installed) {
        const result = await stopStudio(options);
        if (!result.stopped) throw Object.assign(new Error('Updated AI Studio could not be stopped safely; the previous executable backup was retained'), { studioRejectedRelease: true });
        if (installedRoot) fs.rmSync(rootBinary, { force: true });
        removePackage(packageDir, platform);
      }
      if (rootBackedUp) fs.renameSync(rootBackup, rootBinary);
      if (movedOld) fs.renameSync(backup, packageDir);
      if (oldManifest) fs.writeFileSync(manifestPath, oldManifest, { mode: 0o600 });
      else fs.rmSync(manifestPath, { force: true });
      await launchLockedStudio(options).catch(restoreError => {
        restoreError.studioRejectedRelease = triedNew;
        throw restoreError;
      });
    }
    throw err;
  } finally {
    try { removePackage(stage, platform); } catch {}
  }
  try { removePackage(backup, platform); } catch {}
  removeOtherArchives(dataDir, manifest.asset);
}

let onStudioAssetInstalled = null;

export function setStudioAssetHook(fn) {
  onStudioAssetInstalled = typeof fn === 'function' ? fn : null;
}

const STUDIO_ARCHIVE_RE = /^aistudio2api-v[^/\\]+\.(?:tar\.gz|zip)$/;
const CAMOUFOX_ARCHIVE_RE = /^camoufox-.+\.zip(?:\.part)?$/;

function isStudioStagingEntry(name) {
  return (
    STUDIO_ARCHIVE_RE.test(name) ||
    name.startsWith('.install.tmp.') ||
    name.startsWith('.package.stage.') ||
    name.startsWith('.package.backup.')
  );
}

function isCamoufoxRuntimeEntry(name) {
  return name === 'camoufox' || CAMOUFOX_ARCHIVE_RE.test(name) || name.startsWith('.camoufox-stage-');
}

export function hasStudioAssets(dataDir = studioDataDir(), platform = process.platform) {
  if (!fs.existsSync(dataDir)) return false;
  // User-owned backends and their runtimes survive uninstall, including a corrupt selection.
  try { if (readStudioConfig(dataDir)?.backend?.mode === 'user') return false; } catch { return false; }
  for (const name of ['package', 'install-manifest.json', ...(platform === 'win32' ? ['aistudio2api.exe'] : [])]) {
    if (fs.existsSync(path.join(dataDir, name))) return true;
  }
  try {
    if (fs.readdirSync(dataDir).some(isStudioStagingEntry)) return true;
  } catch {}
  const runtimeDir = path.join(dataDir, 'runtime');
  try {
    if (fs.existsSync(runtimeDir) && fs.readdirSync(runtimeDir).some(isCamoufoxRuntimeEntry)) return true;
  } catch {}
  const pidFile = path.join(dataDir, 'backend.pid');
  const launchFile = path.join(dataDir, LAUNCH_RECORD);
  if (fs.existsSync(pidFile) || fs.existsSync(launchFile)) {
    const pid = recordedPid(dataDir);
    const bin = binaryPath(dataDir, platform);
    if (processAlive(pid) && verifyProcessIdentity(pid, bin, platform) !== false) {
      return true;
    }
    try { fs.rmSync(pidFile, { force: true }); } catch {}
    try { fs.rmSync(launchFile, { force: true }); } catch {}
  }
  return false;
}

function unlockDirectoriesRecursive(target, platform) {
  if (platform === 'win32' || !fs.existsSync(target)) return;
  try {
    const st = fs.lstatSync(target);
    if (!st.isDirectory()) return;
    try { fs.chmodSync(target, (st.mode & 0o777) | 0o700); } catch {}
    let entries = [];
    try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      if (entry.isDirectory()) {
        unlockDirectoriesRecursive(path.join(target, entry.name), platform);
      }
    }
  } catch {}
}

function forceRemovePath(target, platform) {
  if (!fs.existsSync(target)) return false;
  try {
    unlockDirectoriesRecursive(target, platform);
    fs.rmSync(target, { recursive: true, force: true });
    return !fs.existsSync(target);
  } catch {
    return false;
  }
}

async function terminateVerifiedPids(pids, bin, platform, termWaitMs = 3000, owns = () => true) {
  const verified = [...new Set(pids)].filter(p => processAlive(p) && verifyProcessIdentity(p, bin, platform) === true && owns(p) === true);
  if (!verified.length) return;
  for (const pid of verified) {
    if (verifyProcessIdentity(pid, bin, platform) !== true || owns(pid) !== true) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + termWaitMs;
  while (Date.now() < deadline) {
    if (verified.every(p => !processAlive(p))) return;
    await sleep(100);
  }
  for (const pid of verified) {
    if (processAlive(pid) && verifyProcessIdentity(pid, bin, platform) === true && owns(pid) === true) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline) {
    if (verified.every(p => !processAlive(p))) return;
    await sleep(50);
  }
}

// cleanStudio stops any running managed AIStudio2API or Camoufox process in dataDir and deletes
// downloaded binaries, archives, and the Camoufox browser runtime while preserving accounts
// (auth/), configuration (config.json, .env), and logs.
export async function cleanStudio(options = {}) {
  const dataDir = options.dataDir || studioDataDir();
  const platform = options.platform || process.platform;
  const fetchFn = options.fetchFn || globalThis.fetch;

  if (!fs.existsSync(dataDir)) {
    return { stopped: true, cleaned: true, removed: [], dataDir };
  }

  return withLock(dataDir, async () => {
    if (readStudioConfig(dataDir)?.backend?.mode === 'user') {
      return { stopped: false, cleaned: false, removed: [], dataDir, skipped: 'user_backend' };
    }
    try {
      await stopStudio({ dataDir, platform, fetchFn });
    } catch {}

    const bin = binaryPath(dataDir, platform);
    if (fs.existsSync(bin)) {
      const candidates = [];
      const tracked = recordedPid(dataDir);
      if (Number.isInteger(tracked) && tracked > 0) candidates.push(tracked);
      try {
        candidates.push(...studioProcessPids(bin, platform));
      } catch {}
      await terminateVerifiedPids(candidates, bin, platform, 3000, pid => belongsToStudio(pid, dataDir, platform));
    }
    try { assertStudioExited(dataDir, platform); } catch (err) {
      return { stopped: false, cleaned: false, removed: [], dataDir, reported: err.message };
    }

    const camoufoxExe = CAMOUFOX_EXECUTABLES[platform];
    if (camoufoxExe) {
      for (const camoufoxBin of [
        path.join(dataDir, 'runtime', 'camoufox', camoufoxExe),
        path.join(dataDir, 'package', 'runtime', 'camoufox', camoufoxExe)
      ]) {
        if (!fs.existsSync(camoufoxBin)) continue;
        let pids = [];
        try {
          pids = studioProcessPids(camoufoxBin, platform);
        } catch {}
        await terminateVerifiedPids(pids, camoufoxBin, platform, 2000);
      }
    }

    adminSessions.clear();

    const removed = [];
    for (const name of ['package', 'install-manifest.json', 'backend.pid', LAUNCH_RECORD, ...(platform === 'win32' ? ['aistudio2api.exe'] : [])]) {
      if (forceRemovePath(path.join(dataDir, name), platform)) {
        removed.push(name);
      }
    }

    let rootEntries = [];
    try { rootEntries = fs.readdirSync(dataDir); } catch {}
    for (const name of rootEntries) {
      if (isStudioStagingEntry(name)) {
        if (forceRemovePath(path.join(dataDir, name), platform)) {
          removed.push(name);
        }
      }
    }

    const runtimeDir = path.join(dataDir, 'runtime');
    if (fs.existsSync(runtimeDir)) {
      let runtimeEntries = [];
      try { runtimeEntries = fs.readdirSync(runtimeDir); } catch {}
      for (const name of runtimeEntries) {
        if (isCamoufoxRuntimeEntry(name)) {
          if (forceRemovePath(path.join(runtimeDir, name), platform)) {
            removed.push(path.join('runtime', name));
          }
        }
      }
      try {
        if (fs.readdirSync(runtimeDir).length === 0) {
          fs.rmdirSync(runtimeDir);
        }
      } catch {}
    }

    return { stopped: true, cleaned: true, removed, dataDir };
  }, options.lockTimeoutMs ?? 600000);
}
