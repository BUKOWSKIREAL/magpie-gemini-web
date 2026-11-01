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
// The browser the backend says it is when it reaches Google (gemini-web2api-go v4.22.0:
// ChromeUA and applyChromeHeaders in client.go), so these reads come from the same client as
// its own requests on the account. The TLS handshake is still Bun's, as the backend's own is
// Go's when it goes through a proxy.
const CLIENT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-CH-UA': '"Chromium";v="146", "Google Chrome";v="146", "Not?A_Brand";v="24"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"'
};

// When an account's pools are read again: whenever Magpie asks, once the last reading is
// USAGE_FRESH_MS old. Magpie keeps an account's reading a minute itself (loginUsageCache in its
// internal/provider/login_usage.go) and dates the card by when it got it, so a reading kept here
// any longer would show old figures as new, and a refresh would show them again (#34); use from
// the Gemini app, the website or another device leaves no trace here to read again on. On its
// own Magpie asks about once a minute while its Usage page or tray panel is open, whenever it
// brings the menu bar's allowances up to date (every 3 minutes unless set otherwise) and, a
// minute apart, while it routes requests among the accounts; it asks sooner only when it puts
// its minute aside. USAGE_FRESH_MS takes in asks that come together, a refresh pressed twice; a
// read under way is shared.
// A failed read stands USAGE_RETRY_MS, so a cookie Google turned away, or an account it is
// limiting, isn't asked about again every minute. Magpie asking again within
// USAGE_ASKED_AGAIN_MS of the last time tries it again at once: it does that only when it put
// its minute aside, for a card's refresh button, the Usage page or tray panel brought up or
// refreshed, `magpie quota` or a sign-in check. Its hook doesn't tell a refresh (auth.usage is
// given getAuth and the provider alone), so one pressed later than that tries again only when
// pressed once more.
export const USAGE_FRESH_MS = 30 * 1000;
export const USAGE_RETRY_MS = 10 * 60 * 1000;
export const USAGE_ASKED_AGAIN_MS = 60 * 1000;

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
// bound to, if any, and whether that proxy is enabled (proxyEnabled), and whether the pool has
// proxies at all (pooled: disabled ones count, as they do for the backend).
export async function poolAccounts(dataDir = getDataDir()) {
  const db = await openReadOnly(path.join(dataDir, 'gemini.db'));
  try {
    return db.all(`SELECT a.id, a.label, a.cookie, p.url AS proxy, p.enabled AS proxyEnabled,
        EXISTS (SELECT 1 FROM proxies) AS pooled
      FROM accounts a LEFT JOIN proxies p ON p.id = a.proxy_id
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

// The variables that send Bun's fetch, or Node's with NODE_USE_ENV_PROXY, through a proxy
// even when the request names none.
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

// egress is the proxy a read for the account goes through: the way the backend reaches Google
// for it, since a read from anywhere else would show Google the session at a second address.
// A read is made only when that way is certain, as poolAccounts tells it:
//   - a pool without proxies (none at all, not just none enabled): the backend goes direct,
//     and so does the read, unless proxy variables would take it elsewhere;
//   - an account bound to an enabled proxy: that proxy, which its requests and keepalive both
//     take. Only Bun's fetch takes a proxy (a fetchFn passed in stands for it), and only an
//     HTTP(S) one;
//   - anything else is unknown: an account not bound yet (the backend binds one on its first
//     request, and keeps it alive direct until then), one bound to a disabled proxy (its
//     requests take another, its keepalive still that one), or one poolAccounts didn't list.
function egress(account, options) {
  if (account.pooled == null) throw new Error('不知道后端给这个账号走哪个出口，先不读用量');
  if (!account.pooled) {
    const env = options.env ?? process.env;
    const set = PROXY_ENV.find(k => env[k]);
    if (set) throw new Error(`后端直连 Google，但这里设置了 ${set}，读取会改走代理，先不读用量`);
    return undefined;
  }
  if (!account.proxy) throw new Error('这个账号还没绑定代理池里的出口（第一次请求后后端会自动绑定），先不读用量，免得从别的 IP 访问 Google');
  if (!account.proxyEnabled) throw new Error('这个账号绑定的代理已停用，后端的请求和保活会走不同出口，先不读用量');
  if (!/^https?:\/\//i.test(account.proxy) || !(options.fetchFn || globalThis.Bun)) {
    throw new Error('这个账号绑定的代理插件用不了（只支持 HTTP / HTTPS 代理），不读用量，免得从别的 IP 访问 Google');
  }
  return account.proxy;
}

// geminiRequest is one signed-in request to gemini.google.com as the account, the way out the
// backend takes (egress). It always names its proxy, none included: Magpie's host gives a fetch
// that names none Magpie's own proxy, which the backend doesn't take. A redirect is Google
// sending a dead cookie to sign-in.
async function geminiRequest(url, account, headers, options) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const init = {
    headers: { ...CLIENT_HEADERS, ...headers, Cookie: account.cookie },
    redirect: 'manual',
    proxy: egress(account, options),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15000)
  };
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
    Referer: 'https://gemini.google.com/usage',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  }, options));
}

// The last read of each account: id -> { at, read, pools, failed }, pools once it has
// succeeded, failed once it hasn't, neither while it is under way.
const reads = new Map();
// When Magpie last asked for each account's usage: id -> ms.
const asked = new Map();

// due says whether the account's last read is to be made again (see USAGE_FRESH_MS); one under
// way never is. again: Magpie asked within USAGE_ASKED_AGAIN_MS of the time before.
function due(last, again, options) {
  const age = Date.now() - last.at;
  const fresh = options.freshMs ?? USAGE_FRESH_MS;
  if (last.pools) return age >= fresh;
  return !!last.failed && age >= (again ? fresh : (options.retryMs ?? USAGE_RETRY_MS));
}

function readUsage(account, options) {
  const now = Date.now();
  const again = now - asked.get(account.id) < (options.askedAgainMs ?? USAGE_ASKED_AGAIN_MS);
  asked.set(account.id, now);
  const last = reads.get(account.id);
  if (last && !due(last, again, options)) return last.read;
  const entry = { at: now };
  entry.read = accountUsage(account, options).then(
    u => ((entry.pools = u.pools), u),
    err => { entry.failed = true; throw err; }
  );
  reads.set(account.id, entry);
  return entry.read;
}

// The Google account's email, from the signed-in app page's bootstrap data (WIZ_global_data's
// oPEP7c), kept per backend account: the page is large and the email doesn't change. A page
// that didn't give it is asked for again no sooner than EMAIL_RETRY_MS: the email only names
// a card. An account with no certain way out (egress) isn't asked yet, and that isn't a try.
const emails = new Map(); // id -> { email }, or { at } since the last try that got none
const EMAIL_FIELD = /"oPEP7c":"([^"@\s]+@[^"\s]+)"/;
const EMAIL_RETRY_MS = 6 * 3600 * 1000;

export async function accountEmail(account, options = {}) {
  const known = emails.get(account.id);
  if (known?.email) return known.email;
  if (known && Date.now() - known.at < (options.emailRetryMs ?? EMAIL_RETRY_MS)) return undefined;
  egress(account, options);
  emails.set(account.id, { at: Date.now() });
  const page = await geminiRequest('https://gemini.google.com/app', account, {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  }, options);
  const email = EMAIL_FIELD.exec(page)?.[1];
  if (email) emails.set(account.id, { email });
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
// An account is read from Google again only when due (see USAGE_FRESH_MS).
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
    // The sign-in already names its account's email: no app page to fetch for it.
    if (typeof options.email === 'string' && options.email && !emails.get(options.account)?.email) {
      emails.set(options.account, { email: options.email });
    }
  }
  if (!accounts.length) return { error: '本地后端里没有启用的 Google 账号', windows: [] };

  const read = await Promise.all(accounts.map(async a => {
    const [u, email] = await Promise.allSettled([readUsage(a, options), accountEmail(a, options)]);
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
