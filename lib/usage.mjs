// Reads how much of each Gemini account's usage limits is gone, the way the Usage page at
// gemini.google.com/usage does: a persisted GraphQL query whose getUsageInfo lists a 5-hour and
// a weekly pool. The cookies come from the local backend's account pool, which also writes back
// the cookies Google rotates, so the copy there is always the live one.
import path from 'node:path';
import { getDataDir } from './native.mjs';

const EXECUTE_QUERY = 'https://gemini.google.com/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery';
// UsagePageQuery, and the variables the Usage page sends with it.
const USAGE_QUERY = '2/dWbCvkVB0X16r9NPnxifeOAAqdCqMf0xeWvau9yPy7g=';
const USAGE_VARIABLES = {
  g1Request: {
    entrypoints: [
      'GEMINI_USAGE_SETTINGS_UPGRADE_BANNER',
      'GEMINI_USAGE_SETTINGS_AI_CREDITS_UPSELL_CARD',
      'GEMINI_USAGE_SETTINGS_UPGRADE_AND_CREDITS_BANNER'
    ]
  },
  workspaceRequest: {
    recommendationsForSurfaceRequests: [{
      recommendationSurface: { rpOnramp: 'GEMINI_CHAT_USAGE_LIMITS_UPSELL', version: '1' },
      maxRecommendationCount: 1
    }]
  }
};
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// The pools the Usage page shows, under the names Magpie gives the same windows elsewhere.
const POOLS = [
  { type: 'GXU_FIVE_HOURLY', name: '5 hours', span: 5 * 3600 },
  { type: 'GXU_WEEKLY', name: '7 days', span: 7 * 24 * 3600 }
];

// openReadOnly opens the backend's SQLite database without writing to it: bun:sqlite under
// Magpie's Bun, node:sqlite under Node.
async function openReadOnly(file) {
  if (globalThis.Bun) {
    const { Database } = await import('bun:sqlite');
    const db = new Database(file, { readonly: true });
    return { all: sql => db.query(sql).all(), close: () => db.close() };
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  return { all: sql => db.prepare(sql).all(), close: () => db.close() };
}

// poolAccounts lists the enabled accounts in the backend's pool, each with the proxy it is
// bound to, if any.
export async function poolAccounts(dataDir = getDataDir()) {
  const db = await openReadOnly(path.join(dataDir, 'gemini.db'));
  try {
    return db.all(`SELECT a.id, a.label, a.cookie, p.url AS proxy
      FROM accounts a LEFT JOIN proxies p ON p.id = a.proxy_id AND p.enabled = 1
      WHERE a.status = 'enabled' ORDER BY a.id`);
  } finally {
    db.close();
  }
}

// parseUsage takes the pools out of an executeQuery reply: a JSON array of payloads, which
// may start with the )]}' guard.
export function parseUsage(text) {
  const start = text.indexOf('[');
  if (start < 0) throw new Error('Gemini 返回了无法识别的用量数据');
  const payloads = JSON.parse(text.slice(start));
  for (const p of Array.isArray(payloads) ? payloads : []) {
    const info = p?.data?.viewer?.rpcs?.getUsageInfo;
    if (info) return { tier: info.subscriptionTier, pools: Array.isArray(info.pools) ? info.pools : [] };
    if (p?.errors?.length) throw new Error(`Gemini 拒绝了用量查询：${p.errors[0]?.message || 'unknown error'}`);
  }
  throw new Error('Gemini 的回复里没有用量数据');
}

// geminiRequest is one signed-in request to gemini.google.com as the account, through the
// proxy the backend bound it to. A redirect is Google sending a dead cookie to sign-in.
async function geminiRequest(url, account, headers, options) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const init = {
    headers: { ...headers, Cookie: account.cookie, 'User-Agent': USER_AGENT },
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 15000)
  };
  // Bun's fetch takes an HTTP proxy; an account bound to one reaches Google only through it.
  if (/^https?:\/\//i.test(account.proxy || '')) init.proxy = account.proxy;
  const res = await fetchFn(url, init);
  if (res.status >= 300 && res.status < 400 || res.status === 401 || res.status === 403) {
    throw new Error('Cookie 已失效，请重新走一遍一键配置');
  }
  if (!res.ok) throw new Error(`Gemini 返回 HTTP ${res.status}`);
  return res.text();
}

// accountUsage asks Gemini for one account's usage pools.
export async function accountUsage(account, options = {}) {
  const url = `${EXECUTE_QUERY}?${new URLSearchParams({ query_signature: USAGE_QUERY, variables: JSON.stringify(USAGE_VARIABLES) })}`;
  return parseUsage(await geminiRequest(url, account, {
    Accept: 'application/json',
    Origin: 'https://gemini.google.com',
    Referer: 'https://gemini.google.com/usage'
  }, options));
}

// The Google account's email, from the signed-in app page's bootstrap data (WIZ_global_data's
// oPEP7c), kept per backend account: the page is large and the email doesn't change.
const emails = new Map();
const EMAIL_FIELD = /"oPEP7c":"([^"@\s]+@[^"\s]+)"/;

export async function accountEmail(account, options = {}) {
  const known = emails.get(account.id);
  if (known) return known;
  const page = await geminiRequest('https://gemini.google.com/app', account, { Accept: 'text/html' }, options);
  const email = EMAIL_FIELD.exec(page)?.[1];
  if (email) emails.set(account.id, email);
  return email;
}

// windowsOf turns an account's pools into Magpie usage windows, 5 hours then 7 days.
export function windowsOf(pools) {
  const out = [];
  for (const { type, name, span } of POOLS) {
    const p = pools.find(x => x?.poolType === type);
    if (typeof p?.percentageUsed !== 'number' || !(p.percentageUsed >= 0)) continue;
    const w = { name, used: Math.min(100, Math.round(p.percentageUsed * 100)) };
    const at = Date.parse(p.gxu?.windowRefreshesAt ?? '');
    if (Number.isFinite(at)) w.resetsAt = new Date(at).toISOString();
    w.span = span;
    out.push(w);
  }
  return out;
}

const shortName = who => who.replace(/@gmail\.com$/i, '');
const soonest = w => (w.resetsAt ? Date.parse(w.resetsAt) : Infinity);

// poolWindows makes one card of several accounts. The backend takes them in turn, so the pool
// runs short once any one does: each window is its tightest account's, the most used and of
// those the soonest to start again, as Magpie's own card reads a family of model windows. The
// accounts' own figures, and any account that couldn't be read, go in its tooltip.
export function poolWindows(read) {
  const out = [];
  for (const { name } of POOLS) {
    const each = read.flatMap(r => (r.windows || []).filter(w => w.name === name).map(w => ({ ...w, who: r.who })));
    if (!each.length) continue;
    const top = each.reduce((a, b) => (b.used > a.used || (b.used === a.used && soonest(b) < soonest(a)) ? b : a));
    const { who, ...w } = top;
    const parts = each.map(x => `${shortName(x.who)} ${x.used}%`);
    for (const r of read) if (r.error) parts.push(`${shortName(r.who)} 读取失败`);
    out.push({ ...w, display: `各账号已用 ${parts.join('，')}` });
  }
  return out;
}

// usage is the Magpie usage card: one account's 5-hour and weekly windows, as
// gemini.google.com/usage shows them, when the sign-in names its backend account; else the
// whole pool's, as one card. Accounts go by their Google emails (#id until that is known).
// Magpie hides a card's windows behind an error, so a pool account that can't be read only
// says so in the tooltip while the others still show.
export async function usage(options = {}) {
  let accounts;
  try {
    accounts = await (options.poolAccounts || poolAccounts)(options.dataDir);
  } catch (err) {
    return { error: `读不到本地后端的账号池：${err?.message || err}`, windows: [] };
  }
  if (options.account !== undefined) {
    accounts = accounts.filter(a => a.id === options.account);
    if (!accounts.length) return { error: `本地后端里已经没有这个账号（#${options.account}），可能被停用或删除了`, windows: [] };
  }
  if (!accounts.length) return { error: '本地后端里没有启用的 Google 账号', windows: [] };

  const read = await Promise.all(accounts.map(async a => {
    const [u, email] = await Promise.allSettled([accountUsage(a, options), accountEmail(a, options)]);
    const who = (email.status === 'fulfilled' && email.value) || `#${a.id}`;
    return u.status === 'fulfilled' ? { who, windows: windowsOf(u.value.pools) } : { who, error: u.reason?.message || String(u.reason) };
  }));
  const user = read.length > 1 ? `${read[0].who} +${read.length - 1}` : read[0].who;
  const several = read.length > 1;
  const windows = several ? poolWindows(read) : read[0].windows || [];
  if (!windows.length) {
    const error = read.filter(r => r.error).map(r => (several ? `${r.who}：` : '') + r.error).join('；');
    return { user, error: error || 'Gemini 没有返回用量窗口', windows: [] };
  }
  return { user, windows };
}

// poolChoices lists the pool's accounts for a sign-in to pick one, each by its email.
export async function poolChoices(options = {}) {
  const accounts = await (options.poolAccounts || poolAccounts)(options.dataDir);
  return Promise.all(accounts.map(async a => {
    const email = await accountEmail(a, options).catch(() => undefined);
    return { id: a.id, email, label: email || `#${a.id}`, hint: email ? `#${a.id}` : a.label };
  }));
}
