// Sign-in helpers for the one-click setup: turn what the user pasted into a Cookie header and
// add it to the local backend's account pool through its admin API.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Do not infer support from a version: upstream and local builds can have the same version
// while silently ignoring proxy_id. Recheck at submission too, in case the service restarted.
export async function requireLoginBackend(setup, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  let res, info;
  try {
    res = await fetchFn(`${setup.origin}/`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await res.json();
  } catch (err) {
    throw new Error(`无法确认本地 Gemini Web 后端的登录能力（${setup.origin}）：${err.message}`);
  }
  if (info?.capabilities?.account_proxy_binding === true) return;
  const dataDir = options.dataDir || process.env.GEMINI_WEB_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'magpie-gemini-web');
  const platform = options.platform || process.platform;
  const script = fileURLToPath(new URL('../scripts/backend.mjs', import.meta.url));
  // PowerShell and POSIX shells both accept single-quoted literal arguments, but escape
  // apostrophes differently. Never interpolate credentials or proxy URLs into the hint.
  const quote = value => `'${value.replaceAll("'", platform === 'win32' ? "''" : "'\\''")}'`;
  const command = `node ${quote(script)} install --data-dir=${quote(path.resolve(dataDir))}`;
  const stop = platform === 'win32'
    ? '在任务管理器的「详细信息」中结束本数据目录对应的 gemini-web2api-go.exe'
    : '在活动监视器或进程管理器中停止本数据目录对应的 gemini-web2api-go';
  throw new Error(`正在运行的 Gemini Web 后端不支持登录时绑定代理，请先升级。先退出 Magpie，${stop}，再执行：\n${command}\n数据目录：${path.resolve(dataDir)}。如下载需要代理，请先设置 GEMINI_WEB_PROXY 环境变量。升级后重新打开 Magpie 并登录；账号和配置会保留。`);
}

// The sign-in cookies a gemini.google.com request carries; without these the backend serves
// the request anonymously (or the account check fails).
export const REQUIRED_COOKIES = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID'];

// Domains whose cookies the browser sends to gemini.google.com.
const GEMINI_COOKIE_DOMAIN = /^\.?(gemini\.)?google\.com$/i;

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function pairsFromHeader(text) {
  const pairs = [];
  for (const part of text.split(/;|\r?\n/)) {
    const p = part.trim();
    const i = p.indexOf('=');
    if (i > 0) pairs.push([p.slice(0, i).trim(), p.slice(i + 1).trim()]);
  }
  return pairs;
}

// DevTools › Application › Cookies rows copied as text: name, value, domain, path, … separated
// by tabs. Only cookies for google.com / gemini.google.com are kept.
function pairsFromTable(text) {
  const pairs = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split('\t').map(c => c.trim());
    if (cols.length < 3 || !COOKIE_NAME.test(cols[0]) || !cols[1]) continue;
    if (GEMINI_COOKIE_DOMAIN.test(cols[2])) pairs.push([cols[0], cols[1]]);
  }
  return pairs;
}

function pairsFromJSON(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(v)) {
    // Cookie-editor style exports: [{ name, value, domain }, …]
    return v.filter(c => c && typeof c.name === 'string' && typeof c.value === 'string' &&
      (typeof c.domain !== 'string' || GEMINI_COOKIE_DOMAIN.test(c.domain)))
      .map(c => [c.name, c.value]);
  }
  if (v && typeof v === 'object') {
    if (typeof v.cookie === 'string') return pairsFromHeader(v.cookie);
    return Object.entries(v).filter(([, val]) => typeof val === 'string').map(([k, val]) => [k, val]);
  }
  return null;
}

// parseCookieInput accepts the Cookie request header (with or without the "cookie:" prefix),
// rows copied from DevTools' cookie table, or a JSON export, and returns a "k=v; k=v" header.
// It throws a message meant for the user when the sign-in cookies are missing.
export function parseCookieInput(input) {
  let text = String(input ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
  text = text.replace(/^cookie\s*:\s*/i, '');
  if (!text) throw new Error('没有收到 Cookie：请粘贴 gemini.google.com 请求头里 cookie 一行的值');

  let pairs = null;
  if (text.startsWith('{') || text.startsWith('[')) pairs = pairsFromJSON(text);
  if (!pairs && text.includes('\t')) pairs = pairsFromTable(text);
  if (!pairs) pairs = pairsFromHeader(text);

  const cookies = new Map();
  for (const [name, value] of pairs) {
    if (!COOKIE_NAME.test(name) || /[\x00-\x1f\x7f;]/.test(value) || !value) continue;
    if (!cookies.has(name)) cookies.set(name, value);
  }

  const missing = REQUIRED_COOKIES.filter(n => !cookies.has(n));
  if (missing.length) {
    throw new Error(`Cookie 不完整，缺少 ${missing.join('、')}。请在开发者工具 Network 面板里，从发往 gemini.google.com 的请求的请求头复制 cookie 一行的完整值（不要从 Application 面板逐条复制）。`);
  }
  return [...cookies].map(([n, v]) => `${n}=${v}`).join('; ');
}

const ADMIN_TIMEOUT_MS = 60000;
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

// validateProxyURL checks a proxy URL meant for the backend's proxy pool (http, https, socks5,
// or socks5h). An empty or omitted value returns '', meaning no proxy is set here.
export function validateProxyURL(proxy) {
  if (proxy === undefined || proxy === null || proxy === '') return '';
  if (typeof proxy !== 'string') {
    throw new Error('Invalid option proxy: must be a string');
  }
  const trimmed = proxy.trim();
  if (!trimmed) return '';
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('Invalid proxy URL: must not contain newlines');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('代理地址格式无效：请填写完整的 URL，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080');
  }
  if (!PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('代理地址必须以 http://、https://、socks5:// 或 socks5h:// 开头');
  }
  return trimmed;
}

// adminCall is one request to the backend's admin API. A request that gets no answer within
// ADMIN_TIMEOUT_MS fails with timeoutMessage when one is given: the backend was reached, but what
// it does for the request took too long.
async function adminCall(setup, fetchFn, method, path, body, timeoutMessage) {
  let res;
  try {
    res = await fetchFn(`${setup.origin}/admin/api/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${setup.adminToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS)
    });
  } catch (err) {
    if (timeoutMessage && err?.name === 'TimeoutError') throw new Error(timeoutMessage);
    throw new Error(`连不上本地 Gemini Web 后端（${setup.origin}）：${err?.message || err}`);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(`本地后端拒绝了请求（HTTP ${res.status}）：${data.error || 'unknown error'}`);
  return data;
}

// ensureProxy makes sure the given proxy URL is present, enabled, and not circuit-broken in the
// backend's proxy pool before the backend reaches gemini.google.com to check a cookie.
export async function ensureProxy(setup, proxy, options = {}) {
  const url = validateProxyURL(proxy);
  if (!url) return null;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const name = options.name || 'Magpie';
  const listed = await adminCall(setup, fetchFn, 'GET', 'proxies');
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const exact = items.find(p => p && p.url === url && Number.isInteger(p.id));
  if (exact) {
    if (!exact.enabled) {
      await adminCall(setup, fetchFn, 'PATCH', `proxies/${exact.id}`, { enabled: true });
    }
    if ((exact.fail_count ?? 0) > 0) {
      await adminCall(setup, fetchFn, 'POST', `proxies/${exact.id}/reset`);
    }
    return { id: exact.id, url };
  }
  const managed = items.find(p => p && p.name === name && Number.isInteger(p.id));
  if (managed) {
    await adminCall(setup, fetchFn, 'PATCH', `proxies/${managed.id}`, { name, url, enabled: true });
    if ((managed.fail_count ?? 0) > 0) {
      await adminCall(setup, fetchFn, 'POST', `proxies/${managed.id}/reset`);
    }
    return { id: managed.id, url };
  }
  const created = await adminCall(setup, fetchFn, 'POST', 'proxies', { name, url, weight: 1 });
  return { id: created.id, url };
}

// The check is the backend fetching gemini.google.com with the cookie, directly or through the
// backend's own proxy pool: neither Magpie's proxy nor HTTP_PROXY reach it.
function proxyHint(setup) {
  return `后端不走 Magpie 的代理，也不读系统代理（HTTP_PROXY / HTTPS_PROXY）：需要代理才能访问 Google 的话，请在登录时填写代理地址（或设置插件选项 proxy / 环境变量 GEMINI_WEB_PROXY，也可以在管理面板 ${setup.origin}/admin 的代理池里添加，登录口令是数据目录 secrets.json 里的 adminToken），然后重试。`;
}

// checkFailure is the error for a check that came back not ok. The backend words the cookie's
// own verdicts (signed out, redirected to sign-in, rate limited) itself and prefixes everything
// else, a failed fetch of gemini.google.com among it, with "检测失败" (explainCookieFailure).
function checkFailure(setup, detail) {
  if (detail.startsWith('检测失败')) {
    return new Error(`后端没能访问 gemini.google.com 来检测这个 Cookie（${detail}）。${proxyHint(setup)}`);
  }
  return new Error(`这个 Cookie 无法登录 Gemini：${detail || '检测未通过'}`);
}

// importCookie adds the cookie to the backend's account pool and checks it signs in. An
// account that fails the check is removed again, and the error says why.
export async function importCookie(setup, cookie, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  await requireLoginBackend(setup, options);
  let proxyId = Number.isInteger(options.proxyId) ? options.proxyId : undefined;
  if (options.proxy) {
    const ensured = await ensureProxy(setup, options.proxy, { fetchFn });
    if (ensured && Number.isInteger(ensured.id)) proxyId = ensured.id;
  }
  const label = options.label || `Magpie ${new Date().toISOString().slice(0, 10)}`;
  const added = await adminCall(setup, fetchFn, 'POST', 'cookies', {
    label,
    cookie,
    note: 'Added by Magpie one-click setup',
    ...(proxyId !== undefined ? { proxy_id: proxyId } : {})
  });
  if (!Number.isInteger(added.id)) throw new Error('本地后端没有返回新账号的 id');

  let check;
  try {
    check = await adminCall(setup, fetchFn, 'POST', `cookies/${added.id}/check`, undefined,
      `后端 ${ADMIN_TIMEOUT_MS / 1000} 秒内没检测完这个 Cookie：检测要由后端访问 gemini.google.com，这一步一直没有返回，多半是后端连不上 Google。${proxyHint(setup)}`);
  } catch (err) {
    await adminCall(setup, fetchFn, 'DELETE', `cookies/${added.id}`).catch(() => {});
    throw err;
  }
  if (!check.ok) {
    await adminCall(setup, fetchFn, 'DELETE', `cookies/${added.id}`).catch(() => {});
    throw checkFailure(setup, check.detail || '');
  }
  return { id: added.id, detail: check.detail || '' };
}
