import http from 'node:http';
import crypto from 'node:crypto';
import { studioAdmin, studioBrowserSession } from './studio-native.mjs';
import { openStudioConnect as openLegacyConnect } from './studio-connect-legacy.mjs';

const LINGER_MS = 2 * 60 * 1000;
const TIMEOUT = '超过了 Magpie 等登录的 10 分钟。已导入的账号和已下载的文件会保留，请重新登录。';
const eligible = account => typeof account?.id === 'string' && account.id && account.enabled !== false &&
  !['auth_required', 'disabled'].includes(account.state);

// Only installation progress and the final result live here. The same tab automatically enters
// the bundled upstream's focused login UI. Its tasks carry a unique client_id; neither existing
// accounts nor another browser window's tasks can complete this sign-in.
export async function openStudioConnect({ prepare, progress = () => '', deadline, accountId, fetchFn, pollMs = 750 }) {
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
  function close() {
    if (closing) return closing;
    if (!ended) finish(new Error('登录页面已关闭，请在 Magpie 中重新登录。'));
    clearTimeout(linger);
    legacy?.close();
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
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) res.writeHead(502, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  });
  async function handle(req, res) {
    const base = `/${token}`;
    const route = req.url;
    if (req.headers.host !== new URL(origin).host || ![base, `${base}/finish`, `${base}/status`, `${base}/manage`, `${base}/cancel`].includes(route)) {
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
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ url: legacy.url }));
        return;
      }
      const cookie = await studioBrowserSession(local, adminOptions());
      if (ended) { res.writeHead(410, headers).end(); return; }
      if (!/^aistudio_admin=[A-Za-z0-9._~-]+$/.test(cookie || '')) throw new Error('本地服务没有返回有效的管理会话。');
      const fragment = new URLSearchParams({ magpie: client, callback: `${origin}${base}/finish`, deadline: String(deadline) });
      if (accountId) fragment.set('account', accountId);
      res.writeHead(200, {
        ...headers, 'Set-Cookie': `${cookie}; Path=/api; HttpOnly; SameSite=Strict`,
        'Content-Type': 'application/json'
      }).end(JSON.stringify({ url: `${local.origin}/?tab=accounts#${fragment}` }));
      return;
    }
    res.writeHead(404, headers).end();
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => finish(new Error(TIMEOUT)), Math.max(1, deadline - Date.now()));
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
          // Until the rebuilt backend is published and pinned, preserve the working manual flow.
          // Never send the automatic UI to a binary that cannot attribute tasks to a sign-in.
          if (capability?.magpie_signin !== 1) {
            legacy = await openLegacyConnect({ prepare: async () => value, progress, deadline, accountId, fetchFn });
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
<p id="detail" role="status" aria-live="polite">首次使用需要下载本地服务，完成后会自动进入账号导入／登录页面。</p>
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
