import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { controlState, writeControlState } from './studio-control-state.mjs';
import { studioDataDir, localStudio, studioStatus, studioProxy, ensureStudio, stopStudio, readStudioEnv, saveStudioProxy, validateProxy, redactProxy } from './studio-native.mjs';

const self = fileURLToPath(import.meta.url);
const ui = fileURLToPath(new URL('../ui/', import.meta.url));
const KIND = 'magpie-studio-console-v2';
const stateFile = dataDir => path.join(dataDir, 'console-server.json');
const appFile = dataDir => path.join(dataDir, 'console-app.json');

function application(dataDir) {
  try {
    const owner = JSON.parse(fs.readFileSync(appFile(dataDir), 'utf8'));
    return Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

// 只绑定桌面应用的父进程，不把短命的插件宿主或独立 MCP 命令误认成应用。
export async function attachApplication(dataDir) {
  if (process.platform !== 'win32' || !process.versions.bun) return;
  const owner = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process -Filter "ProcessId = $env:STUDIO_APP_PID" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'
  ], { env: { ...process.env, STUDIO_APP_PID: String(process.ppid) }, windowsHide: true, timeout: 8000, encoding: 'utf8' }, (error, stdout) => {
    if (error) return reject(error);
    try { resolve(JSON.parse(stdout || 'null')); } catch (error) { reject(error); }
  }));
  if (!owner || !/^magpie.*\.exe$/i.test(owner.Name) || !/\s+(?:gui|tray)(?:\s|$)/i.test(owner.CommandLine || '')) return;
  const previous = application(dataDir);
  if (previous && previous.pid !== owner.ProcessId && processAlive(previous.pid)) return;
  const tmp = `${appFile(dataDir)}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: owner.ProcessId }), { mode: 0o600 });
  fs.renameSync(tmp, appFile(dataDir));
  const state = controlState(dataDir);
  if (state?.appStopped) writeControlState(dataDir, { version: 1, paused: false });
  await ensureConsole(dataDir);
}

export function watchApplication({ dataDir, busy, stop, close, report, isAlive = processAlive, interval = 3000 }) {
  let checking = false;
  let finished = false;
  async function tick() {
    if (checking || finished) return;
    checking = true;
    try {
      const owner = application(dataDir);
      if (!owner || isAlive(owner.pid) || busy()) return;
      finished = true;
      const state = controlState(dataDir);
      writeControlState(dataDir, { version: 1, paused: true, appStopped: !state?.paused || !!state.appStopped });
      const result = await stop({ dataDir, waitForStart: true });
      if (!result.stopped) throw new Error(result.reported || '后端尚未确认退出。');
      close();
    } catch (error) { report(`Magpie 退出后的服务关闭失败：${error.message}`); }
    finally { checking = false; }
  }
  const timer = setInterval(tick, interval);
  timer.unref();
  return () => clearInterval(timer);
}

export function initializeControl(dataDir, legacyProxy) {
  if (controlState(dataDir)) return;
  fs.mkdirSync(dataDir, { recursive: true });
  const envFile = path.join(dataDir, '.env');
  if (fs.existsSync(envFile)) {
    try { fs.copyFileSync(envFile, path.join(dataDir, '.env.before-console'), fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const inherited = validateProxy(legacyProxy || process.env.AI_STUDIO_PROXY || '');
  if (inherited) saveStudioProxy(dataDir, inherited);
  writeControlState(dataDir, { version: 1, paused: false });
}

export function openURL(url, platform = process.platform, run = execFile) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) {
    throw new Error('只能打开此插件的本机 HTTP 管理地址。');
  }
  const [file, args] = platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href]]
    : platform === 'darwin' ? ['open', [parsed.href]] : ['xdg-open', [parsed.href]];
  return new Promise((resolve, reject) => run(file, args, { windowsHide: true, timeout: 8000 }, error => error ? reject(new Error('无法打开默认浏览器，请检查系统的默认浏览器设置。')) : resolve()));
}

function fail(status, message) { return Object.assign(new Error(message), { status }); }

async function bodyJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, '请求必须使用 JSON。');
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString('utf8');
    if (Buffer.byteLength(text) > 8192) throw fail(413, '请求内容过长。');
  }
  let value;
  try { value = JSON.parse(text); } catch { throw fail(400, '请求不是有效的 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, '请求必须是 JSON 对象。');
  return value;
}

function proxyInput(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail(400, '代理必须是长度不超过 2048 的地址。');
  let proxy;
  try { proxy = validateProxy(value); } catch (error) { throw fail(400, error.message); }
  if (proxy && !new URL(proxy).hostname) throw fail(400, '代理必须填写主机地址。');
  return proxy;
}

// 仅接受明确的固定操作；浏览器不能提交命令、路径或要打开的 URL。
export function createConsole({ dataDir = studioDataDir(), token = crypto.randomBytes(32).toString('hex'), services = {} } = {}) {
  const api = { local: localStudio, status: studioStatus, proxy: studioProxy, start: ensureStudio, stop: stopStudio, open: openURL, ...services };
  let operation = null;
  let shuttingDown = false;
  let reading;
  let origin;
  const options = { dataDir };

  async function snapshot() {
    const backend = await api.status(options);
    const local = api.local(options);
    let proxy = null;
    let proxyError = null;
    if (local && backend.status === 'running') {
      try { proxy = await api.proxy(local, { standalone: true }); }
      catch { proxyError = '暂时无法读取后端的实际代理，未推断为直连。'; }
    }
    const saved = readStudioEnv(dataDir).PROXY || '';
    const containsPassword = saved.split(',').some(value => { try { return !!new URL(value.trim()).password; } catch { return false; } });
    return {
      kind: KIND, source: self, paused: !!controlState(dataDir)?.paused,
      backend: { status: backend.status, state: backend.state, ready: backend.ready, running: backend.running, version: backend.version,
        accounts: { total: backend.accounts?.total || 0, ready: backend.accounts?.ready || 0, busy: backend.accounts?.busy || 0 }, reason: backend.reason },
      proxy, proxyError, savedProxy: containsPassword ? null : saved, savedDisplay: redactProxy(saved), containsPassword,
      adminURL: local?.origin || null, applicationBound: !!application(dataDir), operation
    };
  }

  function readStatus() {
    if (!reading) reading = snapshot().finally(() => { reading = null; });
    return reading;
  }

  async function perform(action, input) {
    const previous = controlState(dataDir);
    if (!previous) throw fail(409, '控制台尚未初始化，请重新从 Magpie 打开。');
    if (action === 'save') {
      saveStudioProxy(dataDir, input.proxy);
      return;
    }
    if (action === 'admin') {
      const local = api.local(options);
      if (!local || (await api.status(options)).status === 'stopped') throw fail(409, '请先启动本地服务，再打开管理页。');
      await api.open(local.origin);
      return;
    }
    // 先关闭自动拉起，再操作进程；失败时保留暂停，避免请求在恢复途中创建另一个实例。
    writeControlState(dataDir, { version: 1, paused: true });
    if (action === 'stop' || action === 'restart' || action === 'apply') {
      const stopped = await api.stop({ ...options, waitForStart: true });
      if (!stopped.stopped) throw new Error(stopped.reported || '后端未确认退出，已取消后续操作。');
    }
    if (action === 'apply') saveStudioProxy(dataDir, input.proxy);
    if (action !== 'stop') {
      await api.start({ ...options, allowPaused: true, managementOnly: true });
      writeControlState(dataDir, { version: 1, paused: false });
    }
  }

  const server = http.createServer({ requestTimeout: 10000, headersTimeout: 5000, maxHeaderSize: 8192 }, async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
        throw fail(403, '拒绝非本机控制台来源的请求。');
      }
      const pathname = new URL(req.url, origin).pathname;
      if (pathname.startsWith('/api/')) {
        const given = Buffer.from(req.headers.authorization || '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw fail(401, '控制台访问凭证无效，请重新从 Magpie 打开。');
        if (req.method === 'GET' && pathname === '/api/ping') return json(200, { kind: KIND, source: self });
        if (req.method === 'GET' && pathname === '/api/state') return json(200, await readStatus());
        if (req.method !== 'POST') throw fail(405, '不支持此请求方法。');
        if (shuttingDown) throw fail(409, 'Magpie 已退出，正在关闭本地服务。');
        const action = pathname.slice('/api/'.length);
        if (!['start', 'stop', 'restart', 'save', 'apply', 'admin', 'close'].includes(action)) throw fail(404, '不支持此操作。');
        if (operation?.state === 'running') throw fail(409, '上一项操作还在进行，请等待完成。');
        const input = await bodyJSON(req);
        if (operation?.state === 'running') throw fail(409, '上一项操作还在进行，请等待完成。');
        if (['stop', 'restart', 'apply', 'close'].includes(action) && input.confirm !== true) throw fail(409, '此操作需要先确认。');
        if (action === 'close') {
          json(200, { closed: true });
          server.close();
          server.closeIdleConnections();
          return;
        }
        if (['save', 'apply'].includes(action)) input.proxy = proxyInput(input.proxy);
        operation = { id: crypto.randomUUID(), action, state: 'running', message: '正在处理' };
        const task = operation;
        Promise.resolve().then(() => perform(action, input)).then(() => {
          task.state = 'done'; task.message = '操作完成';
        }, error => {
          task.state = 'failed'; task.message = error.message || '操作失败';
        });
        return json(202, { operation: task });
      }
      if (req.method !== 'GET') throw fail(405, '不支持此请求方法。');
      const files = { '/': ['console.html', 'text/html'], '/console.js': ['console.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const file = files[pathname];
      if (!file) throw fail(404, '页面不存在。');
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
      res.end(fs.readFileSync(path.join(ui, file[0])));
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.message || '读取本地服务失败。' });
      else res.end();
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.maxConnections = 32;
  const unwatch = watchApplication({
    dataDir, busy: () => operation?.state === 'running', stop: options => { shuttingDown = true; return api.stop(options); },
    close: () => { server.close(); server.closeIdleConnections(); },
    report: message => { shuttingDown = false; operation = { id: crypto.randomUUID(), action: 'stop', state: 'failed', message }; }
  });
  server.once('close', unwatch);
  return {
    server, token,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    }
  };
}

async function existingConsole(dataDir) {
  try {
    const record = JSON.parse(fs.readFileSync(stateFile(dataDir), 'utf8'));
    if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || !/^[a-f0-9]{64}$/.test(record.token) || record.source !== self) return null;
    const origin = `http://127.0.0.1:${record.port}`;
    const result = await fetch(`${origin}/api/ping`, { headers: { Authorization: `Bearer ${record.token}` }, redirect: 'error', signal: AbortSignal.timeout(700), proxy: '' });
    const info = await result.json();
    return result.ok && info.kind === KIND && info.source === self ? { ...record, origin } : null;
  } catch { return null; }
}

export async function ensureConsole(dataDir = studioDataDir()) {
  const existing = await existingConsole(dataDir);
  if (existing) return existing;
  const lock = path.join(dataDir, 'console-start.lock');
  let owner = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); owner = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      try { process.kill(pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') fs.rmSync(lock); else throw probe; }
      if (!fs.existsSync(lock)) return ensureConsole(dataDir);
    }
    if (owner) {
      const found = await existingConsole(dataDir);
      if (found) return found;
      const log = fs.openSync(path.join(dataDir, 'console.log'), 'a', 0o600);
      try {
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/^(?:https?|all|ai_studio)_proxy$/i.test(key)) delete env[key];
        Object.assign(env, { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' });
        const child = spawn(process.execPath, [self, 'serve', dataDir], { cwd: dataDir, env, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
        let failed;
        child.on('error', error => { failed = error; });
        child.unref();
        for (let i = 0; i < 40; i++) {
          if (failed) throw failed;
          const result = await existingConsole(dataDir);
          if (result) return result;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } finally { fs.closeSync(log); }
      throw new Error('控制台启动超时，请检查本机数据目录中的 console.log。');
    }
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const result = await existingConsole(dataDir);
      if (result) return result;
    }
    throw new Error('控制台正由另一个进程启动，请稍后重试。');
  } finally { if (owner) fs.rmSync(lock, { force: true }); }
}

export async function handleConsoleOpen(request, dataDir = studioDataDir()) {
  if (!request || !/^[a-f0-9]{32}$/.test(request.id) || !Number.isSafeInteger(request.at) || Math.abs(Date.now() - request.at) > 90000) return;
  const claim = path.join(dataDir, `console-open-${request.id}`);
  try { fs.writeFileSync(claim, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  const record = await ensureConsole(dataDir);
  await openURL(`${record.origin}/#${record.token}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === self && process.argv[2] === 'serve') {
  const dataDir = process.argv[3];
  if (!path.isAbsolute(dataDir || '') || !controlState(dataDir)) throw new Error('控制台必须由已初始化的本地插件启动。');
  const consoleServer = createConsole({ dataDir });
  const origin = await consoleServer.listen();
  const record = { pid: process.pid, port: new URL(origin).port * 1, token: consoleServer.token, source: self };
  fs.writeFileSync(stateFile(dataDir), JSON.stringify(record), { mode: 0o600 });
  console.error('[ai-studio-console] listening on loopback');
}
