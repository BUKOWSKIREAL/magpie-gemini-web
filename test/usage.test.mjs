import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GeminiWebPlugin } from '../index.mjs';
import { parseUsage, windowsOf, accountUsage, accountEmail, poolAccounts, usage } from '../lib/usage.mjs';

// A reply the Usage page's query gets, cut to what the plugin reads.
function reply(five, week) {
  return JSON.stringify([{
    data: {
      viewer: {
        rpcs: {
          getUsageInfo: {
            subscriptionTier: 'TIER1',
            pools: [
              { poolType: 'GXU_FIVE_HOURLY', percentageUsed: five, gxu: { windowRefreshesAt: '2026-10-14T11:48:06.036796Z' } },
              { poolType: 'GXU_WEEKLY', percentageUsed: week, gxu: { windowRefreshesAt: '2026-10-20T23:48:06.036949Z' } }
            ]
          }
        }
      }
    },
    path: []
  }]);
}

// fakeFetch answers each cookie's usage query from byCookie (a reply, or a status), and its
// app page with the email in emails, if any.
function fakeFetch(byCookie, calls = [], emails = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    const cookie = init.headers.Cookie;
    const r = byCookie[cookie];
    if (typeof r === 'number') return new Response('', { status: r });
    if (url === 'https://gemini.google.com/app') {
      const page = emails[cookie] ? `<script>window.WIZ_global_data = {"oPEP7c":"${emails[cookie]}","qwAQke":"BardChatUi"};</script>` : '<html></html>';
      return new Response(page, { status: 200 });
    }
    return new Response(r, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('28. Gemini usage limits', () => {
  // Reads are made as Magpie's host makes them, with no proxy variables of its own.
  const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const saved = {};
  before(() => PROXY_ENV.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; }));
  after(() => PROXY_ENV.forEach(k => { if (saved[k] !== undefined) process.env[k] = saved[k]; }));

  it('parses the pools, with or without the )]}\' guard', () => {
    assert.equal(parseUsage(reply(0.35, 0.05)).pools.length, 2);
    assert.equal(parseUsage(`)]}'\n${reply(0.35, 0.05)}`).tier, 'TIER1');
    assert.throws(() => parseUsage(JSON.stringify([{ errors: [{ message: 'unknown query' }] }])), /unknown query/);
    assert.throws(() => parseUsage('<html>'), /无法识别/);
  });

  it('turns the pools into 5-hour and weekly windows in percent', () => {
    const { pools } = parseUsage(reply(0.35, 0.0503));
    assert.deepEqual(windowsOf(pools), [
      { name: '5 hours', used: 35, span: 18000, resetsAt: '2026-10-14T11:48:06.036Z' },
      { name: '7 days', used: 5, span: 604800, resetsAt: '2026-10-20T23:48:06.036Z' }
    ]);
    assert.equal(windowsOf(parseUsage(reply(1.2, 0)).pools)[0].used, 100);
    assert.deepEqual(windowsOf([{ poolType: 'GXU_WEEKLY' }]), []);
  });

  it('sends the Usage page query with the account cookie, the way out the backend takes', async () => {
    const calls = [];
    await accountUsage({ cookie: 'c1', proxy: 'http://127.0.0.1:7890', proxyEnabled: 1, pooled: 1 }, { fetchFn: fakeFetch({ c1: reply(0, 0) }, calls) });
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://gemini.google.com/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery');
    assert.match(url.searchParams.get('query_signature'), /^2\//);
    assert.ok(JSON.parse(url.searchParams.get('variables')).g1Request);
    assert.equal(calls[0].init.headers.Cookie, 'c1');
    assert.equal(calls[0].init.proxy, 'http://127.0.0.1:7890');
    assert.equal(calls[0].init.redirect, 'manual');

    await assert.rejects(
      accountUsage({ cookie: 'c1', proxy: 'socks5://127.0.0.1:1080', proxyEnabled: 1, pooled: 1 }, { fetchFn: fakeFetch({ c1: reply(0, 0) }, calls) }),
      /只支持 HTTP \/ HTTPS 代理/
    );
    assert.equal(calls.length, 1);

    // The backend goes direct when its pool has no proxy, and so does the read: it names no
    // proxy, so Magpie's host doesn't give it Magpie's own.
    await accountUsage({ cookie: 'c1', pooled: 0 }, { fetchFn: fakeFetch({ c1: reply(0, 0) }, calls) });
    assert.ok('proxy' in calls[1].init);
    assert.equal(calls[1].init.proxy, undefined);

    // Unless proxy variables would take it through a proxy all the same.
    await assert.rejects(
      accountUsage({ cookie: 'c1', pooled: 0 }, { fetchFn: fakeFetch({ c1: reply(0, 0) }, calls), env: { https_proxy: 'http://127.0.0.1:1082' } }),
      /设置了 https_proxy/
    );

    // No known way out, no read: an account the backend hasn't bound to one of its pool's
    // proxies yet, one bound to a disabled proxy (also when every proxy is), one the pool
    // didn't describe.
    const fetchFn = fakeFetch({ c1: reply(0, 0) }, calls);
    await assert.rejects(accountUsage({ cookie: 'c1', proxy: null, pooled: 1 }, { fetchFn }), /还没绑定代理池里的出口/);
    await assert.rejects(
      accountUsage({ cookie: 'c1', proxy: 'http://127.0.0.1:7890', proxyEnabled: 0, pooled: 1 }, { fetchFn }),
      /绑定的代理已停用/
    );
    await assert.rejects(accountUsage({ cookie: 'c1' }, { fetchFn }), /不知道后端给这个账号走哪个出口/);
    assert.equal(calls.length, 2);
  });

  it('asks for no email without a way out, and asks once there is one', async () => {
    const calls = [];
    const fetchFn = fakeFetch({ c1: reply(0, 0) }, calls, { c1: 'later@gmail.com' });
    const account = { id: 111, cookie: 'c1', proxy: null, pooled: 1 };
    await assert.rejects(accountEmail(account, { fetchFn }), /还没绑定代理池里的出口/);
    await assert.rejects(accountEmail({ id: 111 }, { fetchFn }), /不知道后端给这个账号走哪个出口/);
    assert.equal(calls.length, 0);
    Object.assign(account, { proxy: 'http://127.0.0.1:7890', proxyEnabled: 1 });
    assert.equal(await accountEmail(account, { fetchFn }), 'later@gmail.com');
    assert.equal(calls[0].init.proxy, 'http://127.0.0.1:7890');
  });

  it('presents the browser the backend does', async () => {
    const calls = [];
    const fetchFn = fakeFetch({ c1: reply(0, 0) }, calls, { c1: 'h@gmail.com' });
    await accountUsage({ cookie: 'c1', pooled: 0 }, { fetchFn });
    await accountEmail({ id: 151, cookie: 'c1', pooled: 0 }, { fetchFn });
    for (const { init } of calls) {
      assert.match(init.headers['User-Agent'], /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\).* Chrome\/146\.0\.0\.0 /);
      assert.match(init.headers['Sec-CH-UA'], /"Google Chrome";v="146"/);
      assert.equal(init.headers['Sec-CH-UA-Platform'], '"Windows"');
      assert.equal(init.headers['Accept-Language'], 'en-US,en;q=0.9');
    }
    assert.equal(calls[0].init.headers['Sec-Fetch-Mode'], 'cors');
    assert.equal(calls[1].init.headers['Sec-Fetch-Mode'], 'navigate');
  });

  it('reads an account again once it has been used since, no sooner than USAGE_MIN_GAP_MS', async () => {
    const calls = [];
    const reads = () => calls.filter(c => c.url.includes('executeQuery')).length;
    const fetchFn = fakeFetch({ c31: reply(0.2, 0.1) }, calls, { c31: 'r@gmail.com' });
    const account = { id: 31, cookie: 'c31', pooled: 0, usedAt: 0 };
    const pool = async () => [account];
    const first = await usage({ poolAccounts: pool, fetchFn });
    assert.equal(reads(), 1);

    // Not used since: the last read stands, however long ago it was made.
    assert.deepEqual(await usage({ poolAccounts: pool, fetchFn, minGapMs: 0 }), first);
    assert.equal(reads(), 1);

    // Used since: read again, once the gap is up.
    account.usedAt = Math.floor(Date.now() / 1000);
    await usage({ poolAccounts: pool, fetchFn });
    assert.equal(reads(), 1);
    await usage({ poolAccounts: pool, fetchFn, minGapMs: 0 });
    assert.equal(reads(), 2);

    // And in any case once USAGE_MAX_AGE_MS is up, for use from the Gemini app itself.
    account.usedAt = 0;
    await usage({ poolAccounts: pool, fetchFn, minGapMs: 0, maxAgeMs: 0 });
    assert.equal(reads(), 3);
  });

  it('reads an account again once a window it showed has started over', async () => {
    const calls = [];
    const reads = () => calls.filter(c => c.url.includes('executeQuery')).length;
    const soon = new Date(Date.now() + 30).toISOString();
    const fetchFn = fakeFetch({ c33: reply(0.5, 0.1).replace('2026-10-14T11:48:06.036796Z', soon) }, calls, { c33: 's@gmail.com' });
    const pool = async () => [{ id: 33, cookie: 'c33', pooled: 0, usedAt: 0 }];
    await usage({ poolAccounts: pool, fetchFn, minGapMs: 0 });
    await usage({ poolAccounts: pool, fetchFn, minGapMs: 0 });
    assert.equal(reads(), 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    await usage({ poolAccounts: pool, fetchFn, minGapMs: 0 });
    assert.equal(reads(), 2);
    // That read still says the window started over then: no more reads for it.
    await usage({ poolAccounts: pool, fetchFn, minGapMs: 0 });
    assert.equal(reads(), 2);
  });

  it('reads an account whose last read failed again after USAGE_MIN_GAP_MS', async () => {
    const calls = [];
    const reads = () => calls.filter(c => c.url.includes('executeQuery')).length;
    const fetchFn = fakeFetch({ c32: 429 }, calls);
    const pool = async () => [{ id: 32, cookie: 'c32', pooled: 0, usedAt: 0 }];
    const first = await usage({ poolAccounts: pool, fetchFn });
    assert.match(first.error, /HTTP 429/);
    assert.deepEqual(await usage({ poolAccounts: pool, fetchFn }), first);
    assert.equal(reads(), 1);
    await usage({ poolAccounts: pool, fetchFn, minGapMs: 0 });
    assert.equal(reads(), 2);
  });

  it('takes a bound account\'s email from its sign-in instead of the app page', async () => {
    const calls = [];
    const out = await usage({
      poolAccounts: async () => [{ id: 41, cookie: 'c41', pooled: 0 }],
      fetchFn: fakeFetch({ c41: reply(0.1, 0.1) }, calls),
      account: 41,
      email: 'known@gmail.com'
    });
    assert.equal(out.user, 'known@gmail.com');
    assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery']);
  });

  it('says a cookie Google sends to sign-in has expired', async () => {
    await assert.rejects(accountUsage({ cookie: 'c1', pooled: 0 }, { fetchFn: fakeFetch({ c1: 302 }) }), /Cookie 已失效/);
    await assert.rejects(accountUsage({ cookie: 'c1', pooled: 0 }, { fetchFn: fakeFetch({ c1: 500 }) }), /HTTP 500/);
  });

  it('reads the account email from the app page and keeps it', async () => {
    const calls = [];
    const fetchFn = fakeFetch({ c1: reply(0, 0) }, calls, { c1: 'a@gmail.com' });
    assert.equal(await accountEmail({ id: 101, cookie: 'c1', pooled: 0 }, { fetchFn }), 'a@gmail.com');
    assert.equal(await accountEmail({ id: 101, cookie: 'c1', pooled: 0 }, { fetchFn }), 'a@gmail.com');
    assert.equal(calls.length, 1);
    const noEmail = [];
    const pageFetch = fakeFetch({ c2: reply(0, 0) }, noEmail);
    assert.equal(await accountEmail({ id: 102, cookie: 'c2', pooled: 0 }, { fetchFn: pageFetch }), undefined);
    assert.equal(await accountEmail({ id: 102, cookie: 'c2', pooled: 0 }, { fetchFn: pageFetch }), undefined);
    assert.equal(noEmail.length, 1);
    await accountEmail({ id: 102, cookie: 'c2', pooled: 0 }, { fetchFn: pageFetch, maxAgeMs: 0 });
    assert.equal(noEmail.length, 2);
  });

  it('shows several accounts as one card at its tightest account, each account in the tooltip', async () => {
    const accounts = [{ id: 5, cookie: 'c5', pooled: 0 }, { id: 6, cookie: 'c6', pooled: 0 }, { id: 7, cookie: 'c7', pooled: 0 }];
    const out = await usage({
      poolAccounts: async () => accounts,
      fetchFn: fakeFetch({ c5: reply(0.35, 0.05), c6: reply(0.37, 0.02), c7: 302 }, [], { c5: 'five@gmail.com' })
    });
    assert.equal(out.user, 'five@gmail.com +2');
    assert.equal(out.error, undefined);
    assert.deepEqual(out.windows.map(w => [w.name, w.used]), [['5 hours', 37], ['7 days', 5]]);
    assert.equal(out.windows[0].display, '各账号已用 five 35%，#6 37%，#7 读取失败');
    assert.equal(out.windows[1].resetsAt, '2026-10-20T23:48:06.036Z');
  });

  it('takes the soonest reset among equally used accounts', async () => {
    const later = reply(0.5, 0.1).replace('2026-10-14T11:48:06.036796Z', '2026-10-14T15:00:00Z');
    const out = await usage({
      poolAccounts: async () => [{ id: 11, cookie: 'a', pooled: 0 }, { id: 12, cookie: 'b', pooled: 0 }],
      fetchFn: fakeFetch({ a: later, b: reply(0.5, 0.1) })
    });
    assert.equal(out.windows[0].resetsAt, '2026-10-14T11:48:06.036Z');
  });

  it('reports every account when none can be read', async () => {
    const out = await usage({ poolAccounts: async () => [{ id: 13, cookie: 'a', pooled: 0 }, { id: 14, cookie: 'b', pooled: 0 }], fetchFn: fakeFetch({ a: 302, b: 500 }) });
    assert.deepEqual(out.windows, []);
    assert.match(out.error, /#13：Cookie 已失效.*；#14：Gemini 返回 HTTP 500/);
  });

  it('makes a single account the card\'s user and reports when nothing can be read', async () => {
    const one = await usage({
      poolAccounts: async () => [{ id: 8, cookie: 'c8', pooled: 0 }],
      fetchFn: fakeFetch({ c8: reply(0.1, 0.2) }, [], { c8: 'one@gmail.com' })
    });
    assert.deepEqual(one.windows.map(w => w.name), ['5 hours', '7 days']);
    assert.equal(one.user, 'one@gmail.com');

    const dead = await usage({ poolAccounts: async () => [{ id: 9, cookie: 'c9', pooled: 0 }], fetchFn: fakeFetch({ c9: 302 }) });
    assert.deepEqual(dead.windows, []);
    assert.match(dead.error, /Cookie 已失效/);

    assert.match((await usage({ poolAccounts: async () => [] })).error, /没有启用/);
    assert.match((await usage({ poolAccounts: async () => { throw new Error('no db'); } })).error, /no db/);
  });

  it('reads only the account a sign-in is bound to', async () => {
    const accounts = async () => [{ id: 21, cookie: 'a', pooled: 0 }, { id: 22, cookie: 'b', pooled: 0 }];
    const fetchFn = fakeFetch({ a: reply(0.9, 0.5), b: reply(0.1, 0.2) }, [], { b: 'b@gmail.com' });
    const out = await usage({ poolAccounts: accounts, fetchFn, account: 22 });
    assert.equal(out.user, 'b@gmail.com');
    assert.deepEqual(out.windows.map(w => [w.name, w.used, w.display]), [['5 hours', 10, undefined], ['7 days', 20, undefined]]);
    assert.match((await usage({ poolAccounts: accounts, fetchFn, account: 99 })).error, /已经没有这个账号（#99）/);
  });

  it('reads enabled accounts, their proxy, whether the pool has any and when they were last used from the backend database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-gemini-web-usage-'));
    const db = new DatabaseSync(path.join(dir, 'gemini.db'));
    db.exec(`CREATE TABLE proxies (id INTEGER PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER);
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, label TEXT, cookie TEXT, status TEXT, proxy_id INTEGER,
        last_used_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE requests (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, account_id INTEGER);
      INSERT INTO proxies VALUES (1, 'p1', 'http://p1', 1), (2, 'p2', 'http://p2', 0);
      INSERT INTO accounts VALUES (5, 'a', 'c5', 'enabled', 1, 100), (6, 'b', 'c6', 'disabled', 0, 0),
        (7, 'c', 'c7', 'enabled', 2, 300);
      INSERT INTO requests (ts, account_id) VALUES (150, 5), (120, 5), (250, 7), (400, 6);`);
    const rows = async () => (await poolAccounts(dir)).map(r => ({ ...r }));
    assert.deepEqual(await rows(), [
      { id: 5, label: 'a', cookie: 'c5', proxy: 'http://p1', proxyEnabled: 1, pooled: 1, usedAt: 150 },
      { id: 7, label: 'c', cookie: 'c7', proxy: 'http://p2', proxyEnabled: 0, pooled: 1, usedAt: 300 }
    ]);

    // A pool whose proxies are all disabled is still a pool: the backend doesn't go direct.
    db.exec('UPDATE proxies SET enabled = 0');
    assert.deepEqual((await rows()).map(r => [r.id, r.proxyEnabled, r.pooled]), [[5, 0, 1], [7, 0, 1]]);
    db.exec('DELETE FROM proxies');
    assert.deepEqual((await rows()).map(r => [r.id, r.proxy, r.pooled]), [[5, null, 0], [7, null, 0]]);
    db.close();
  });

  it('reads no usage for a backend the plugin does not manage', async () => {
    const plugin = await GeminiWebPlugin({}, {});
    const out = await plugin.auth.usage(async () => ({ type: 'api', key: 'k', metadata: { baseURL: 'http://127.0.0.1:9/v1' } }));
    assert.deepEqual(out.windows, []);
    assert.match(out.error, /本地后端/);
    assert.equal(out.signIn, 'kept');
    assert.match((await plugin.auth.usage(async () => undefined)).error, /还没有登录/);
  });
});
