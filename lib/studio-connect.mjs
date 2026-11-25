import http from 'node:http';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { studioAdmin, studioBrowserSession } from './studio-native.mjs';
import { createStudioConnect as createLegacyConnect } from './studio-connect-legacy.mjs';

const LINGER_MS = 2 * 60 * 1000;
const TIMEOUT = 'Magpie 本轮连接等待已到 10 分钟。已导入的账号和下载的文件会保留；浏览器仍在准备时，请等下载完成再发起连接。也可按插件说明先运行 studio:prepare-browser。';
const OFFICIAL_TIMEOUT = 'Magpie 本轮连接等待已到 10 分钟。已打开的官方账号管理页仍可继续下载浏览器和登录，已导入的账号会保留。请等准备完成，再回到 Magpie 选「添加账号并连接（推荐）」并选择已有账号。';
const eligible = account => typeof account?.id === 'string' && account.id && account.enabled !== false &&
  !['auth_required', 'disabled'].includes(account.state);

// Only installation progress and the final result live here. The same tab automatically enters
// a capable backend's focused login UI. Its tasks carry a unique client_id; neither existing
// accounts nor another browser window's tasks can complete this sign-in.
export async function openStudioConnect({ prepare, progress = () => '', deadline, accountId, fetchFn, pollMs = 750 }) {
  // Request callbacks do not inherit AsyncLocalStorage. Agent2API's fetch throws without the
  // store that was active when this page opened, so restore that context for every request.
  const bindContext = AsyncLocalStorage.snapshot();
  const token = crypto.randomBytes(24).toString('hex');
  const client = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(16).toString('base64');
  let origin, local, legacy, started, ended = false, error = '', selected = [], linger, monitor, checking, closing;
  const imported = new Set();
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {});
  const adminOptions = () => ({ fetchFn, timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) });

  async function ownTasks() {
    const response = await studioAdmin(local, 'GET', '/api/accounts/tasks', null, adminOptions());
    return (Array.isArray(response?.tasks) ? response.tasks : []).filter(task => task?.client_id === client);
  }
  async function cancelTasks(all = false) {
    if (!local || legacy) return;
    // At exit also remove completed/failed banners, after the UI has had time to return.
    // Imported accounts and tasks owned by other windows stay intact.
    const tasks = await studioAdmin(local, 'GET', '/api/accounts/tasks', null, { fetchFn, timeoutMs: 3000 });
    await Promise.allSettled((tasks?.tasks || [])
      .filter(task => task.client_id === client && (all || ['running', 'pending'].includes(task.state)))
      .map(task => studioAdmin(local, 'DELETE', `/api/accounts/tasks/${encodeURIComponent(task.id)}`, null, { fetchFn, timeoutMs: 3000 })));
  }
  function finish(err, accounts = []) {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    clearInterval(monitor);
    error = err?.message || '';
    selected = accounts;
    if (err) {
      void cancelTasks().catch(() => {});
      rejectResult(err);
    } else resolveResult({ local, accounts });
    linger = setTimeout(close, LINGER_MS);
    linger.unref();
  }
  const upstreamSockets = new Set();
  function close() {
    if (closing) return closing;
    if (!ended) finish(new Error('登录页面已关闭，请在 Magpie 中重新登录。'));
    clearTimeout(linger);
    legacy?.close();
    for (const socket of upstreamSockets) socket.destroy();
    upstreamSockets.clear();
    server.close();
    server.closeAllConnections?.();
    closing = cancelTasks(true).catch(() => {});
    return closing;
  }
  function checkTasks() {
    if (ended) return Promise.resolve();
    if (!checking) checking = inspectTasks().finally(() => { checking = null; });
    return checking;
  }
  async function inspectTasks() {
    try {
      const tasks = await ownTasks();
      if (ended) return;
      if (!accountId) {
        for (const task of tasks) for (const item of task.items || []) {
          if (item.state === 'done' && typeof item.account_id === 'string' && item.account_id) imported.add(item.account_id);
        }
      }
      const completed = tasks.find(task => task.state === 'done');
      if (!completed) return; // A partially failed task may contribute accounts, but cannot finish sign-in.
      const items = completed.items;
      if (!Array.isArray(items) || !items.length || items.some(item => item.state !== 'done' || typeof item.account_id !== 'string' || !item.account_id)) {
        finish(new Error('导入任务没有返回完整的账号信息，请重新登录。'));
        return;
      }
      const ids = accountId ? [...new Set(items.map(item => item.account_id))] : [...imported];
      if (accountId && (ids.length !== 1 || ids[0] !== accountId)) {
        finish(new Error('重新登录的账号与原账号不一致，请重试。'));
        return;
      }
      const response = await studioAdmin(local, 'GET', '/api/accounts', null, adminOptions());
      if (ended) return;
      const accounts = ids.map(id => response?.accounts?.find(a => a.id === id && eligible(a)));
      if (accounts.some(a => !a)) {
        finish(new Error('导入的账号尚未登录、已停用或已移除，请重新登录。'));
        return;
      }
      finish(null, accounts);
    } catch {
      // A transient management request failure must not discard a successful Google login.
      // Retry within the same deadline; the upstream page continues to show task progress.
    }
  }

  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const base = `/${token}`;
  const server = http.createServer((req, res) => {
    bindContext(() => {
      handle(req, res).catch(err => {
        if (!res.headersSent) res.writeHead(502, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
  });
  server.on('upgrade', (req, socket, head) => {
    bindContext(() => {
      proxyUpgrade(req, socket, head).catch(() => socket.destroy());
    });
  });
  async function handle(req, res) {
    const route = requestPath(req.url);
    if (!origin || req.headers.host !== new URL(origin).host || !route) {
      res.writeHead(404, headers).end();
      return;
    }
    if (legacy && (route === legacy.base || route.startsWith(`${legacy.base}/`))) {
      await legacy.handle(req, res);
      return;
    }
    if (![base, `${base}/finish`, `${base}/status`, `${base}/manage`, `${base}/cancel`].includes(route)) {
      if (await proxyRequest(req, res)) return;
      res.writeHead(404, headers).end();
      return;
    }
    if (req.method === 'POST' && (req.headers.origin !== origin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))) {
      res.writeHead(403, headers).end();
      return;
    }
    if (req.method === 'GET' && [base, `${base}/finish`].includes(route)) {
      res.writeHead(200, {
        ...headers, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`
      }).end(PAGE.replace('NONCE', nonce));
      return;
    }
    if (req.method === 'GET' && route === `${base}/status`) {
      if (local && !legacy && !ended) await checkTasks();
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({
        ready: !!local, done: ended, error, accounts: selected.map(a => String(a.label || a.id)),
        detail: local ? '正在完成 Magpie 配置…' : progress()
      }));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, headers).end(); return; }
    if (ended) {
      res.writeHead(410, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error || '登录已经完成，请回到 Magpie。' }));
      return;
    }
    if (route === `${base}/cancel`) {
      legacy?.close();
      finish(new Error('已取消登录。已导入的账号会保留。'));
      res.writeHead(204, headers).end();
      return;
    }
    if (!local) {
      res.writeHead(409, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: '本地服务还在准备中。' }));
      return;
    }
    if (route === `${base}/manage`) {
      if (legacy) {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ url: `${origin}${legacy.base}` }));
        return;
      }
      const cookie = await studioBrowserSession(local, adminOptions());
      if (ended) { res.writeHead(410, headers).end(); return; }
      if (!/^aistudio_admin=[A-Za-z0-9._~-]+$/.test(cookie || '')) throw new Error('本地服务没有返回有效的管理会话。');
      const fragment = new URLSearchParams({ magpie: client, callback: `${origin}${base}/finish`, deadline: String(deadline) });
      if (accountId) fragment.set('account', accountId);
      // The embedded window may open only this authorization origin. The account UI is served
      // from here and forwarded to the managed service; the fragment still names this page.
      res.writeHead(200, {
        ...headers, 'Set-Cookie': `${cookie}; Path=/api; HttpOnly; SameSite=Strict`,
        'Content-Type': 'application/json'
      }).end(JSON.stringify({ url: `${origin}/?tab=accounts#${fragment}` }));
      return;
    }
    res.writeHead(404, headers).end();
  }

  // Agent2API allows navigation only to this page's host:port. Account pages, /api, SSE and the
  // login-view socket are forwarded to the one managed loopback service. The request target cannot
  // select another host, and generation routes stay on the service itself.
  const blockedProxyPrefixes = ['/v1', '/v1beta', '/upload', '/health', '/media'];
  const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization']);
  function parseLoopbackPath(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('\0') || raw.includes('://')) return null;
    let parsed;
    try { parsed = new URL(raw, 'http://127.0.0.1'); }
    catch { return null; }
    if (parsed.username || parsed.password || parsed.host !== '127.0.0.1') return null;
    let decoded = parsed.pathname;
    for (let i = 0; i < 3; i++) {
      let next;
      try { next = decodeURIComponent(decoded); }
      catch { return null; }
      if (next === decoded) break;
      decoded = next;
    }
    if (!decoded.startsWith('/') || decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) return null;
    return { pathname: parsed.pathname, decoded, forward: parsed.pathname + parsed.search };
  }
  function requestPath(raw) {
    return parseLoopbackPath(raw)?.pathname || null;
  }
  function blockedProxyPath(pathname) {
    return blockedProxyPrefixes.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%2f`) || pathname.startsWith(`${prefix}%2F`));
  }
  function managedTarget() {
    if (!local?.origin) return null;
    let target;
    try { target = new URL(local.origin); }
    catch { return null; }
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) return null;
    return target;
  }
  function trackUpstream(socket) {
    if (!socket || upstreamSockets.has(socket)) return;
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  }
  function samePageMutation(req) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
    if (req.headers.origin !== origin) return false;
    return !(req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin');
  }
  function upstreamHeaders(req, target) {
    const forwarded = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (hopHeaders.has(key) || key === 'host' || key === 'origin' || key === 'referer' || key === 'forwarded' || key === 'expect' || key.startsWith('x-forwarded-')) continue;
      forwarded[key] = value;
    }
    forwarded.host = target.host;
    forwarded.origin = target.origin;
    return forwarded;
  }
  function headerList(value) {
    return (Array.isArray(value) ? value : [value]).filter(item => item != null).map(item => String(item).replace(/[\r\n]/g, ''));
  }
  function forwardedHeaders(received, target) {
    const copy = {};
    for (const [key, value] of Object.entries(received)) {
      if (hopHeaders.has(key) || key.startsWith('access-control-')) continue;
      copy[key] = value;
    }
    if (copy.location) {
      let next;
      try { next = new URL(headerList(copy.location)[0], target.origin); }
      catch { return null; }
      if (next.origin !== target.origin || next.username || next.password) return null;
      copy.location = `${origin}${next.pathname}${next.search}${next.hash}`;
    }
    if (copy['set-cookie']) copy['set-cookie'] = headerList(copy['set-cookie']).map(cookie => cookie.replace(/;\s*Domain=[^;]*/ig, ''));
    return copy;
  }
  function proxyAllowed(method, parsed) {
    if (blockedProxyPath(parsed.pathname) || blockedProxyPath(parsed.decoded)) return false;
    if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')) return ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    return method === 'GET' || method === 'HEAD';
  }
  function proxyRequest(req, res) {
    const parsed = parseLoopbackPath(req.url);
    const target = managedTarget();
    if (!parsed || !target || !proxyAllowed(req.method, parsed)) return Promise.resolve(false);
    if (!samePageMutation(req)) {
      res.writeHead(403, headers).end();
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      const sendBody = req.method !== 'GET' && req.method !== 'HEAD';
      const headersToSend = upstreamHeaders(req, target);
      // A GET has no body. Leaving a copied length would make the managed service wait.
      if (!sendBody) delete headersToSend['content-length'];
      const upstream = http.request({
        hostname: '127.0.0.1', port: target.port, method: req.method, path: parsed.forward,
        headers: headersToSend
      }, response => {
        upstream.setTimeout(0);
        trackUpstream(response.socket);
        const forwarded = forwardedHeaders(response.headers, target);
        if (!forwarded) {
          response.resume();
          if (!res.headersSent) res.writeHead(502, { ...headers, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '账号管理页暂时无法连接。' }));
          resolve(true);
          return;
        }
        res.writeHead(response.statusCode || 502, forwarded);
        response.on('error', () => res.destroy());
        response.pipe(res);
        resolve(true);
      });
      upstream.on('socket', trackUpstream);
      // Headers must arrive promptly. A live event stream or file download is not cut off afterwards.
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '账号管理页暂时无法连接。' }));
        resolve(true);
      });
      // 'close' also fires when a finished request is consumed. Destroy only if the browser leaves early.
      res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
      // Piping a request whose body already ended never signals the upstream, so the response hangs.
      if (!sendBody) upstream.end();
      else if (req.readableEnded) {
        const chunks = [];
        let chunk;
        while ((chunk = req.read()) !== null) chunks.push(chunk);
        upstream.end(chunks.length ? Buffer.concat(chunks) : undefined);
      } else req.pipe(upstream);
    });
  }
  function proxyUpgrade(req, socket, head) {
    const parsed = parseLoopbackPath(req.url);
    const target = managedTarget();
    const match = parsed && /^\/api\/login-view\/([^/]+)$/.exec(parsed.pathname);
    let view = '';
    try { view = match ? decodeURIComponent(match[1]) : ''; }
    catch { view = ''; }
    if (!target || !/^[A-Za-z0-9._~-]{1,128}$/.test(view) || req.headers.host !== new URL(origin).host || req.headers.origin !== origin || !req.headers['sec-websocket-key']) {
      socket.destroy();
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const headersToSend = upstreamHeaders(req, target);
      headersToSend.connection = 'Upgrade';
      headersToSend.upgrade = 'websocket';
      const upstream = http.request({
        hostname: '127.0.0.1', port: target.port, method: 'GET', path: parsed.forward, headers: headersToSend
      });
      upstream.on('socket', trackUpstream);
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.on('upgrade', (response, upSocket, upHead) => {
        upstream.setTimeout(0);
        trackUpstream(upSocket);
        const forwarded = forwardedHeaders(response.headers, target);
        if (!forwarded) {
          upSocket.destroy();
          socket.destroy();
          resolve();
          return;
        }
        let raw = 'HTTP/1.1 101 Switching Protocols\r\n';
        for (const [key, value] of Object.entries(forwarded)) for (const item of headerList(value)) raw += `${key}: ${item}\r\n`;
        if (!Object.keys(forwarded).some(key => key.toLowerCase() === 'upgrade')) raw += 'Upgrade: websocket\r\n';
        if (!Object.keys(forwarded).some(key => key.toLowerCase() === 'connection')) raw += 'Connection: Upgrade\r\n';
        socket.write(`${raw}\r\n`);
        if (upHead?.length) socket.write(upHead);
        if (head?.length) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
        socket.on('close', () => upSocket.destroy());
        upSocket.on('close', () => socket.destroy());
        socket.on('error', () => upSocket.destroy());
        upSocket.on('error', () => socket.destroy());
        resolve();
      });
      upstream.on('response', response => { response.resume(); socket.destroy(); resolve(); });
      upstream.on('error', () => { socket.destroy(); resolve(); });
      upstream.end();
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => finish(new Error(legacy ? OFFICIAL_TIMEOUT : TIMEOUT)), Math.max(1, deadline - Date.now()));
  timer.unref();
  return {
    url: `${origin}/${token}`, close,
    start() {
      if (!started && !ended) {
        started = Promise.resolve().then(prepare).then(async value => {
          if (ended) return;
          const target = new URL(value.origin);
          if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
            throw new Error('账号管理只支持插件托管的本机 AI Studio 服务。');
          }
          const capability = await studioAdmin(value, 'GET', '/api/accounts/tasks', null, adminOptions());
          if (ended) return;
          // Official and custom backends can keep the manual flow without Magpie's task tags.
          // Never send the automatic UI to a binary that cannot attribute tasks to a sign-in.
          if (capability?.magpie_signin !== 1) {
            legacy = createLegacyConnect({
              prepare: async () => value, progress, deadline, accountId, fetchFn,
              originOf: () => origin,
              accountsURL: () => `${origin}/?tab=accounts`
            });
            if (ended) { legacy.close(); return; }
            legacy.start().then(({ account }) => finish(null, [account]), err => finish(err));
          }
          local = value;
          if (legacy) return;
          monitor = setInterval(() => void checkTasks(), pollMs);
          monitor.unref();
          void checkTasks();
        }).catch(err => finish(err));
      }
      return result;
    }
  };
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 Google AI Studio</title>
<style>
:root { color-scheme: light dark; font: 16px/1.7 system-ui, sans-serif; }
body { max-width: 600px; margin: 15vh auto; padding: 0 24px; }
h1 { font-size: 26px; } p { white-space: pre-wrap; opacity: .85; }
button { font: inherit; padding: 8px 18px; border-radius: 8px; cursor: pointer; }
.error { color: #d33; }
</style></head><body>
<h1 id="title">正在准备 Google AI Studio</h1>
<p id="detail" role="status" aria-live="polite">首次使用会自动下载并启动官方 AIStudio2API。添加 Google 账号后，回到连接页选择账号并确认连接；以后由你决定何时更新后端。</p>
<button id="cancel">取消</button>
<script nonce="NONCE">
const finishing = location.pathname.endsWith('/finish');
const base = finishing ? location.pathname.slice(0, -7) : location.pathname;
const detail = document.getElementById('detail');
const title = document.getElementById('title');
const cancel = document.getElementById('cancel');
let stopped = false;
async function post(route) {
  const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || '暂时无法连接本地服务，请重试。'); }
  return res.status === 204 ? null : res.json();
}
cancel.onclick = async () => {
  try { await post('/cancel'); } catch (err) { detail.textContent = err.message; }
};
async function poll() {
  if (stopped) return;
  try {
    const response = await fetch(base + '/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('连接已结束，请回到 Magpie 查看结果。');
    const state = await response.json();
    if (state.done) {
      stopped = true; cancel.hidden = true;
      title.textContent = state.error ? '登录没有完成' : '已连接到 Magpie';
      detail.className = state.error ? 'error' : '';
      detail.textContent = state.error || '可以回到 Magpie 选择模型使用。' + (state.accounts.length > 1 ? '\\n已导入 ' + state.accounts.length + ' 个账号。' : '');
      return;
    }
    detail.textContent = state.detail || '正在准备本地服务…';
    if (state.ready && !finishing) {
      const data = await post('/manage');
      location.replace(data.url);
      return;
    }
  } catch (err) { detail.textContent = err.message; }
  if (!stopped) setTimeout(poll, 1000);
}
if (finishing && location.hash !== '#cancel') {
  title.textContent = '正在完成 Magpie 配置';
  cancel.hidden = true;
}
if (location.hash === '#cancel') {
  title.textContent = '正在取消登录';
  cancel.hidden = true;
  post('/cancel').catch(err => { detail.textContent = err.message; }).finally(poll);
}
else poll();
</script></body></html>`;
