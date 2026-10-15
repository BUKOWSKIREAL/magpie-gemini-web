import child_process from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_ROOT = fileURLToPath(new URL('../bridge', import.meta.url));
const startupMap = new Map();
const MAX_BODY = 1024 * 1024;

export function getDefaultDataDir() {
  return path.resolve(process.env.GEMINI_NATIVE_TASK_DATA_DIR || path.join(os.homedir(), '.local/share/gemini-native-task'));
}

export function ensurePrivateDataDir(dataDir, { create = false } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('Invalid data directory.');
  const dir = path.resolve(dataDir);
  if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o077)) {
    throw new Error('Data directory must be private and owned by the current user.');
  }
  return fs.realpathSync(dir);
}

export function loadLocalConfig(dataDir) {
  const dir = ensurePrivateDataDir(dataDir);
  const cfgPath = path.join(dir, 'config.json');
  const st = fs.lstatSync(cfgPath);
  if (!st.isFile() || st.size > 16384 || (st.mode & 0o077) ||
      (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error('Configuration must be a private, owned, regular file.');
  }
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (raw?.version !== 1 || typeof raw.api_key !== 'string' || raw.api_key.length < 16 ||
      typeof raw.instance_id !== 'string' || !raw.instance_id || raw.instance_id.length > 128 ||
      !Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535 ||
      typeof raw.subject_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.subject_sha256)) {
    throw new Error('Invalid local bridge configuration.');
  }
  return { ...raw, dataDir: dir };
}

// Bound consumption, including streams without Content-Length. Cancel upstream
// immediately on overflow or abort rather than buffering the rest of the body.
export async function boundedBytes(stream, limit, signal) {
  signal?.throwIfAborted();
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) return Buffer.concat(parts, size);
      size += value.byteLength;
      if (size > limit) throw Object.assign(new Error('Body size limit exceeded.'), { code: 'body_too_large' });
      parts.push(Buffer.from(value));
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export async function probeHealth(baseURL, apiKey, instanceId, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseURL}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal, redirect: 'error',
    });
    if (res.status !== 200) {
      void res.body?.cancel();
      throw new Error(`Health check returned unexpected status ${res.status}`);
    }
    let body;
    const bytes = await boundedBytes(res.body, 16384, controller.signal);
    try { body = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('Health check response is not valid JSON.'); }
    if (body?.service !== 'gemini-native-task') throw new Error('Port is in use by an unexpected service.');
    if (body.instance_id !== instanceId) throw new Error('Port is in use by a mismatching instance ID.');
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Health check timed out.');
    if (error.code === 'body_too_large') throw new Error('Health check response exceeds 16KiB limit.');
    if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') return null;
    throw error;
  } finally { clearTimeout(timer); }
}

export async function ensureService(options = {}, deps = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(k => !['dataDir', 'startupTimeoutMs'].includes(k)) ||
      (options.dataDir !== undefined && (typeof options.dataDir !== 'string' || !options.dataDir)) ||
      (options.startupTimeoutMs !== undefined && (!Number.isFinite(options.startupTimeoutMs) ||
        options.startupTimeoutMs < 1000 || options.startupTimeoutMs > 60000))) {
    throw new Error('Invalid bridge runtime options.');
  }
  const dir = ensurePrivateDataDir(options.dataDir ?? getDefaultDataDir());
  if (!startupMap.has(dir)) {
    const pending = startService(dir, options.startupTimeoutMs ?? 15000, deps);
    startupMap.set(dir, pending);
    void pending.finally(() => startupMap.delete(dir)).catch(() => {});
  }
  return startupMap.get(dir);
}

async function startService(dataDir, timeoutMs, deps) {
  const config = loadLocalConfig(dataDir);
  const baseURL = `http://127.0.0.1:${config.port}`;
  const probe = deps.probeHealth ?? probeHealth;
  const result = { baseURL, apiKey: config.api_key, instance_id: config.instance_id, dataDir };
  const deadline = Date.now() + timeoutMs;
  if (await probe(baseURL, config.api_key, config.instance_id, Math.min(2000, timeoutMs))) return result;
  const pythonPath = path.join(dataDir, '.venv/bin/python');
  if (!deps.spawn && !fs.existsSync(pythonPath)) throw new Error('Run setup to install the bridge virtual environment.');
  const logPath = path.join(dataDir, 'daemon.log');
  const logFd = fs.openSync(logPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  let child;
  try {
    const st = fs.fstatSync(logFd);
    if (!st.isFile() || (st.mode & 0o077)) throw new Error('Daemon log must be private.');
    child = (deps.spawn ?? child_process.spawn)(pythonPath,
      ['-m', 'gemini_native_bridge', 'serve', '--data-dir', dataDir], {
        detached: true, stdio: ['ignore', logFd, logFd], cwd: BRIDGE_ROOT,
        env: { ...process.env, PYTHONPATH: BRIDGE_ROOT },
      });
  } catch { throw new Error('Could not start the local bridge process.'); }
  finally { fs.closeSync(logFd); }
  let exited = false;
  child.on('error', () => { exited = true; });
  child.on('exit', () => { exited = true; });
  child.unref();
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (exited) throw new Error('Local bridge process exited before becoming ready.');
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (await probe(baseURL, config.api_key, config.instance_id, Math.min(1000, remaining))) return result;
  }
  throw new Error('Timed out waiting for the local bridge.');
}

function errorResponse(status, code, message) {
  return new Response(JSON.stringify({ error: { code, type: 'invalid_request_error', message, param: null } }), {
    status, headers: { 'Content-Type': 'application/json', 'X-Magpie-Sign-In': 'kept' },
  });
}

export function createForwarder(serviceInfo, fetchImpl = globalThis.fetch) {
  return async (input, init = {}) => {
    try {
      const original = input instanceof Request ? input : null;
      const parsed = new URL(original?.url ?? String(input), serviceInfo.baseURL);
      if (!['/v1/chat/completions', '/v1/models', '/health'].includes(parsed.pathname)) {
        return errorResponse(404, 'not_found', 'Unsupported bridge path.');
      }
      const method = (init.method ?? original?.method ?? 'GET').toUpperCase();
      const headers = new Headers(original?.headers);
      new Headers(init.headers).forEach((v, k) => headers.set(k, v));
      headers.delete('content-length');
      headers.delete('transfer-encoding');
      headers.set('authorization', `Bearer ${serviceInfo.apiKey}`);
      const signal = init.signal ?? original?.signal;
      signal?.throwIfAborted();
      let body;
      if (!['GET', 'HEAD'].includes(method)) {
        const source = init.body !== undefined ? init.body : original?.body;
        if (source != null) {
          body = await boundedBytes(new Response(source).body, MAX_BODY, signal);
        }
      }
      return await fetchImpl(`${serviceInfo.baseURL}${parsed.pathname}${parsed.search}`, {
        method, headers, body, signal, redirect: 'error',
      });
    } catch (error) {
      if (error.code === 'body_too_large') return errorResponse(400, 'request_too_large', 'Request exceeds 1 MiB limit.');
      return errorResponse(409, 'bridge_network_error', 'Failed to communicate with local gemini-native-task bridge.');
    }
  };
}
