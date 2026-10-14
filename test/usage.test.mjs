import { describe, it } from 'node:test';
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

  it('sends the Usage page query with the account cookie and its HTTP proxy', async () => {
    const calls = [];
    await accountUsage({ cookie: 'c1', proxy: 'http://127.0.0.1:7890' }, { fetchFn: fakeFetch({ c1: reply(0, 0) }, calls) });
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://gemini.google.com/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery');
    assert.match(url.searchParams.get('query_signature'), /^2\//);
    assert.ok(JSON.parse(url.searchParams.get('variables')).g1Request);
    assert.equal(calls[0].init.headers.Cookie, 'c1');
    assert.equal(calls[0].init.proxy, 'http://127.0.0.1:7890');
    assert.equal(calls[0].init.redirect, 'manual');

    await accountUsage({ cookie: 'c1', proxy: 'socks5://127.0.0.1:1080' }, { fetchFn: fakeFetch({ c1: reply(0, 0) }, calls) });
    assert.equal(calls[1].init.proxy, undefined);
  });

  it('says a cookie Google sends to sign-in has expired', async () => {
    await assert.rejects(accountUsage({ cookie: 'c1' }, { fetchFn: fakeFetch({ c1: 302 }) }), /Cookie 已失效/);
    await assert.rejects(accountUsage({ cookie: 'c1' }, { fetchFn: fakeFetch({ c1: 500 }) }), /HTTP 500/);
  });

  it('reads the account email from the app page and keeps it', async () => {
    const calls = [];
    const fetchFn = fakeFetch({ c1: reply(0, 0) }, calls, { c1: 'a@gmail.com' });
    assert.equal(await accountEmail({ id: 101, cookie: 'c1' }, { fetchFn }), 'a@gmail.com');
    assert.equal(await accountEmail({ id: 101, cookie: 'c1' }, { fetchFn }), 'a@gmail.com');
    assert.equal(calls.length, 1);
    assert.equal(await accountEmail({ id: 102, cookie: 'c2' }, { fetchFn: fakeFetch({ c2: reply(0, 0) }) }), undefined);
  });

  it('shows several accounts as one card at its tightest account, each account in the tooltip', async () => {
    const accounts = [{ id: 5, cookie: 'c5' }, { id: 6, cookie: 'c6' }, { id: 7, cookie: 'c7' }];
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
      poolAccounts: async () => [{ id: 11, cookie: 'a' }, { id: 12, cookie: 'b' }],
      fetchFn: fakeFetch({ a: later, b: reply(0.5, 0.1) })
    });
    assert.equal(out.windows[0].resetsAt, '2026-10-14T11:48:06.036Z');
  });

  it('reports every account when none can be read', async () => {
    const out = await usage({ poolAccounts: async () => [{ id: 13, cookie: 'a' }, { id: 14, cookie: 'b' }], fetchFn: fakeFetch({ a: 302, b: 500 }) });
    assert.deepEqual(out.windows, []);
    assert.match(out.error, /#13：Cookie 已失效.*；#14：Gemini 返回 HTTP 500/);
  });

  it('makes a single account the card\'s user and reports when nothing can be read', async () => {
    const one = await usage({
      poolAccounts: async () => [{ id: 8, cookie: 'c8' }],
      fetchFn: fakeFetch({ c8: reply(0.1, 0.2) }, [], { c8: 'one@gmail.com' })
    });
    assert.deepEqual(one.windows.map(w => w.name), ['5 hours', '7 days']);
    assert.equal(one.user, 'one@gmail.com');

    const dead = await usage({ poolAccounts: async () => [{ id: 9, cookie: 'c9' }], fetchFn: fakeFetch({ c9: 302 }) });
    assert.deepEqual(dead.windows, []);
    assert.match(dead.error, /Cookie 已失效/);

    assert.match((await usage({ poolAccounts: async () => [] })).error, /没有启用/);
    assert.match((await usage({ poolAccounts: async () => { throw new Error('no db'); } })).error, /no db/);
  });

  it('reads only the account a sign-in is bound to', async () => {
    const accounts = async () => [{ id: 21, cookie: 'a' }, { id: 22, cookie: 'b' }];
    const fetchFn = fakeFetch({ a: reply(0.9, 0.5), b: reply(0.1, 0.2) }, [], { b: 'b@gmail.com' });
    const out = await usage({ poolAccounts: accounts, fetchFn, account: 22 });
    assert.equal(out.user, 'b@gmail.com');
    assert.deepEqual(out.windows.map(w => [w.name, w.used, w.display]), [['5 hours', 10, undefined], ['7 days', 20, undefined]]);
    assert.match((await usage({ poolAccounts: accounts, fetchFn, account: 99 })).error, /已经没有这个账号（#99）/);
  });

  it('reads enabled accounts and their enabled proxy from the backend database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-gemini-web-usage-'));
    const db = new DatabaseSync(path.join(dir, 'gemini.db'));
    db.exec(`CREATE TABLE proxies (id INTEGER PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER);
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, label TEXT, cookie TEXT, status TEXT, proxy_id INTEGER);
      INSERT INTO proxies VALUES (1, 'p1', 'http://p1', 1), (2, 'p2', 'http://p2', 0);
      INSERT INTO accounts VALUES (5, 'a', 'c5', 'enabled', 1), (6, 'b', 'c6', 'disabled', 0), (7, 'c', 'c7', 'enabled', 2);`);
    db.close();
    const rows = (await poolAccounts(dir)).map(r => ({ ...r }));
    assert.deepEqual(rows, [
      { id: 5, label: 'a', cookie: 'c5', proxy: 'http://p1' },
      { id: 7, label: 'c', cookie: 'c7', proxy: null }
    ]);
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
