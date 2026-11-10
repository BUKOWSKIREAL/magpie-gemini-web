import http from 'node:http';
import crypto from 'node:crypto';
import { studioAdmin, studioBrowserSession } from './studio-native.mjs';

const LINGER_MS = 2 * 60 * 1000;
const TIMEOUT = '超过了 Magpie 等登录的 10 分钟。已导入的账号和已下载的文件会保留，请重新登录并选择账号。';
const eligible = account => typeof account?.id === 'string' && account.id && account.enabled !== false &&
  !['auth_required', 'disabled'].includes(account.state);

// Keep the upstream account UI on its own origin, including its SSE and login-view WebSocket.
// This short-lived page only prepares the managed service and returns a user-selected account
// to the plugin. No API key, admin password or Google cookie is placed in HTML or URLs.
export async function openStudioConnect({ prepare, progress = () => '', deadline, accountId, fetchFn }) {
  const token = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(16).toString('base64');
  let origin, local, started, ended = false, error = '', chosen, linger;
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {}); // authorize may return before the host starts its callback
  const adminOptions = () => ({ fetchFn, timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) });

  function finish(err, account) {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    error = err?.message || '';
    chosen = account;
    if (err) rejectResult(err);
    else resolveResult({ local, account });
    linger = setTimeout(close, LINGER_MS);
    linger.unref();
  }
  function close() {
    if (!ended) finish(new Error('登录页面已关闭，请在 Magpie 中重新登录。'));
    clearTimeout(linger);
    server.close();
    server.closeAllConnections?.();
  }
  async function accounts() {
    const response = await studioAdmin(local, 'GET', '/api/accounts', null, adminOptions());
    return (Array.isArray(response?.accounts) ? response.accounts : [])
      .filter(a => a && typeof a.id === 'string' && (!accountId || a.id === accountId));
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
    if (req.headers.host !== new URL(origin).host || ![base, `${base}/status`, `${base}/manage`, `${base}/select`, `${base}/cancel`].includes(route)) {
      res.writeHead(404, headers).end();
      return;
    }
    // The random URL protects reads. Mutations additionally require the page's exact origin;
    // another localhost port must not be able to select an account or obtain an admin session.
    if (req.method === 'POST' && (req.headers.origin !== origin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))) {
      res.writeHead(403, headers).end();
      return;
    }
    if (req.method === 'GET' && route === base) {
      res.writeHead(200, {
        ...headers, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`
      }).end(PAGE.replace('NONCE', nonce));
      return;
    }
    if (req.method === 'GET' && route === `${base}/status`) {
      const list = local && !ended ? await accounts() : [];
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({
        ready: !!local, done: ended, error, account: chosen?.id,
        detail: local ? '在账号管理页完成导入或登录，然后回到这里选择账号。' : progress(),
        accounts: list.map(a => ({ id: a.id, label: String(a.label || a.id), state: a.state, available: !!eligible(a) }))
      }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, headers).end();
      return;
    }
    if (ended) {
      res.writeHead(410, headers).end(JSON.stringify({ error: error || '登录已经完成，请回到 Magpie。' }));
      return;
    }
    if (route === `${base}/cancel`) {
      finish(new Error('已取消登录。已导入的账号会保留，可以稍后在 Magpie 中选择。'));
      res.writeHead(204, headers).end();
      return;
    }
    if (!local) {
      res.writeHead(409, headers).end(JSON.stringify({ error: '本地服务还在准备中。' }));
      return;
    }
    if (route === `${base}/manage`) {
      const cookie = await studioBrowserSession(local, adminOptions());
      if (ended) { res.writeHead(410, headers).end(); return; }
      if (!/^aistudio_admin=[A-Za-z0-9._~-]+$/.test(cookie || '')) throw new Error('本地服务没有返回有效的管理会话。');
      // Cookies are host-scoped, not port-scoped: both this page and the managed service use
      // 127.0.0.1. The backend receives its own session cookie when the browser opens its UI.
      res.writeHead(200, {
        ...headers, 'Set-Cookie': `${cookie}; Path=/api; HttpOnly; SameSite=Strict`,
        'Content-Type': 'application/json'
      }).end(JSON.stringify({ url: `${local.origin}/?tab=accounts` }));
      return;
    }
    if (route === `${base}/select`) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) { res.writeHead(413, headers).end(); return; }
      }
      let id;
      try { id = JSON.parse(body).id; } catch { res.writeHead(400, headers).end(); return; }
      // Re-read at selection time: an account may have been removed, disabled or signed out
      // since the browser's last poll. Never trust account details submitted by the page.
      const account = (await accounts()).find(a => a.id === id && eligible(a));
      if (ended) { res.writeHead(410, headers).end(); return; }
      if (!account) {
        res.writeHead(409, headers).end(JSON.stringify({ error: '这个账号尚未登录、已停用或已移除，请在账号管理页处理后重试。' }));
        return;
      }
      finish(null, account);
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
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
    url: `${origin}/${token}`,
    close,
    start() {
      if (!started && !ended) {
        started = Promise.resolve().then(prepare).then(value => {
          if (ended) return;
          const target = new URL(value.origin);
          if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
            throw new Error('账号管理只支持插件托管的本机 AI Studio 服务。');
          }
          local = value;
        }).catch(err => finish(err));
      }
      return result;
    }
  };
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>连接 Google AI Studio</title>
<style>
:root { color-scheme: light dark; font: 15px/1.65 system-ui, sans-serif; }
body { max-width: 640px; margin: 48px auto; padding: 0 24px; }
h1 { font-size: 24px; } h2 { font-size: 18px; margin-top: 28px; }
p { opacity: .8; } button, select { font: inherit; padding: 9px 14px; border-radius: 8px; }
button { cursor: pointer; } button:disabled { cursor: default; opacity: .5; }
select { display: block; width: 100%; margin: 12px 0; } #message { white-space: pre-wrap; }
#message.error { color: #d33; } .actions { display: flex; gap: 12px; flex-wrap: wrap; }
</style></head><body>
<h1>连接 Google AI Studio</h1>
<p id="detail" role="status">正在准备本地服务，请稍候…</p>
<section id="connect" hidden>
<h2>1. 添加或登录 Google 账号</h2>
<p>打开账号管理页，在“添加账户”中选择 Chrome 导入、粘贴 Cookie 或浏览器登录。可用方式由系统和服务决定；已有账号可以直接进行下一步。</p>
<button id="manage">打开账号管理页 ↗</button>
<h2>2. 选择账号，连接到 Magpie</h2>
<p>完成导入后回到此页，账号列表会自动刷新。一次连接一个账号；导入多个账号后，可以在 Magpie 中再次登录并选择。</p>
<label for="account">Google 账号</label><select id="account"><option value="">等待账号…</option></select>
</section>
<div class="actions"><button id="submit" disabled>连接到 Magpie</button><button id="cancel">取消</button></div>
<p id="message" role="status" aria-live="polite"></p>
<script nonce="NONCE">
const base = location.pathname;
const account = document.getElementById('account');
const submit = document.getElementById('submit');
const cancel = document.getElementById('cancel');
const message = document.getElementById('message');
const manage = document.getElementById('manage');
let stopped = false, busy = false, accountList = '';
function say(text, error = false) { message.textContent = text; message.className = error ? 'error' : ''; }
function stop() {
  stopped = true; submit.disabled = true; cancel.disabled = true;
  manage.disabled = true; account.disabled = true;
}
async function post(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.error || '操作没有完成，请重试。'); }
  return res.status === 204 ? null : res.json();
}
manage.onclick = async () => {
  // Open during the click to avoid popup blocking while the management session is fetched.
  const target = window.open('about:blank', '_blank');
  if (!target) { say('浏览器阻止了账号管理页，请允许本页打开新窗口后重试。', true); return; }
  target.opener = null;
  manage.disabled = true;
  try {
    const data = await post('/manage');
    if (stopped) { target.close(); return; }
    target.location.replace(data.url);
  } catch (err) { target.close(); say(err.message, true); }
  finally { manage.disabled = stopped; }
};
account.onchange = () => { submit.disabled = stopped || busy || !account.value; };
submit.onclick = async () => {
  busy = true; submit.disabled = true;
  try { await post('/select', { id: account.value }); stop(); say('连接完成，可以关闭此页并回到 Magpie。'); }
  catch (err) { say(err.message, true); }
  finally { busy = false; submit.disabled = stopped || !account.value; }
};
cancel.onclick = async () => {
  try { await post('/cancel'); stop(); say('已取消登录。已导入的账号会保留。'); }
  catch (err) { say(err.message, true); }
};
async function poll() {
  if (stopped) return;
  try {
    const res = await fetch(base + '/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('暂时无法读取账号，请确认本地服务仍在运行。');
    const state = await res.json();
    if (stopped) return;
    document.getElementById('detail').textContent = state.detail || '正在准备本地服务…';
    document.getElementById('connect').hidden = !state.ready;
    if (state.done) { stop(); say(state.error || '连接完成，可以关闭此页并回到 Magpie。', !!state.error); return; }
    const nextList = JSON.stringify(state.accounts);
    if (nextList !== accountList) {
      accountList = nextList;
      const previous = account.value;
      account.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = state.accounts.length ? '请选择账号' : '等待导入或登录账号…';
      account.append(placeholder);
      for (const item of state.accounts) {
        const option = document.createElement('option'); option.value = item.id;
        option.textContent = item.label + (item.available ? '' : '（需要登录或启用）'); option.disabled = !item.available;
        account.append(option);
      }
      account.value = previous;
      if (account.selectedOptions[0]?.disabled) account.value = '';
    }
    submit.disabled = busy || !account.value;
  } catch (err) { if (!stopped) say(err.message, true); }
  if (!stopped) setTimeout(poll, 1500);
}
poll();
</script></body></html>`;
