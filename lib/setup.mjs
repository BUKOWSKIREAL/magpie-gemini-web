// Sign-in helpers for the one-click setup: turn what the user pasted into a Cookie header and
// add it to the local backend's account pool through its admin API.

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

async function adminCall(setup, fetchFn, method, path, body) {
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
      signal: AbortSignal.timeout(60000)
    });
  } catch (err) {
    throw new Error(`连不上本地 Gemini Web 后端（${setup.origin}）：${err?.message || err}`);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(`本地后端拒绝了请求（HTTP ${res.status}）：${data.error || 'unknown error'}`);
  return data;
}

// importCookie adds the cookie to the backend's account pool and checks it signs in. An
// account that fails the check is removed again, and the error says why.
export async function importCookie(setup, cookie, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const label = options.label || `Magpie ${new Date().toISOString().slice(0, 10)}`;
  const added = await adminCall(setup, fetchFn, 'POST', 'cookies', {
    label,
    cookie,
    note: 'Added by Magpie one-click setup'
  });
  if (!Number.isInteger(added.id)) throw new Error('本地后端没有返回新账号的 id');

  let check;
  try {
    check = await adminCall(setup, fetchFn, 'POST', `cookies/${added.id}/check`);
  } catch (err) {
    await adminCall(setup, fetchFn, 'DELETE', `cookies/${added.id}`).catch(() => {});
    throw err;
  }
  if (!check.ok) {
    await adminCall(setup, fetchFn, 'DELETE', `cookies/${added.id}`).catch(() => {});
    throw new Error(`这个 Cookie 无法登录 Gemini：${check.detail || '检测未通过'}`);
  }
  return { id: added.id, detail: check.detail || '' };
}
