import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { openStudioConnect } from '../lib/studio-connect.mjs';

async function fixture(options = {}) {
  let accounts = [], prepared = 0;
  const requests = [];
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ path, ...init });
    if (path === '/api/auth/login') return new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'aistudio_admin=test-session; Path=/; HttpOnly' }
    });
    assert.equal(path, '/api/accounts');
    assert.equal(new Headers(init.headers).get('Cookie'), 'aistudio_admin=test-session');
    return Response.json({ accounts });
  };
  const local = { origin: 'http://127.0.0.1:2048', apiKey: 'never-expose-key', adminUsername: crypto.randomUUID(), adminPassword: 'never-expose-password' };
  const page = await openStudioConnect({
    prepare: async () => { prepared++; return local; },
    progress: () => '正在下载', deadline: Date.now() + 10000, fetchFn, ...options
  });
  const origin = new URL(page.url).origin;
  const post = (route, body, headers = {}) => fetch(page.url + route, {
    method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {})
  });
  const status = async () => (await fetch(page.url + '/status')).json();
  async function start() {
    const result = page.start();
    await new Promise(resolve => setImmediate(resolve));
    return { result };
  }
  return { page, post, status, start, local, requests, prepared: () => prepared, setAccounts: list => { accounts = list; } };
}

const ready = { id: 'one@example.com', label: 'One', enabled: true, state: 'ready', cookie: 'must-not-leak' };

describe('Managed upstream account connector', () => {
  it('defers setup, hands the browser a session, and returns an explicitly selected account', async () => {
    const f = await fixture();
    try {
      const html = await (await fetch(f.page.url)).text();
      assert.match(html, /Chrome 导入/);
      new vm.Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
      assert.doesNotMatch(html, /never-expose/);
      assert.equal(f.prepared(), 0);
      assert.equal((await f.status()).detail, '正在下载');
      const { result } = await f.start();
      assert.equal(f.prepared(), 1);
      assert.strictEqual(f.page.start(), result, 'callback retries share the same sign-in');
      const manage = await f.post('/manage');
      assert.equal(manage.status, 200);
      assert.equal((await manage.json()).url, `${f.local.origin}/?tab=accounts`);
      assert.match(manage.headers.get('set-cookie'), /^aistudio_admin=test-session; Path=\/api; HttpOnly; SameSite=Strict$/);
      f.setAccounts([ready, { ...ready, id: 'two@example.com', label: 'Two' }]);
      const state = await f.status();
      assert.equal(state.done, false, 'imports alone must not choose an account');
      assert.equal(state.accounts.length, 2);
      assert.doesNotMatch(JSON.stringify(state), /must-not-leak|never-expose|test-session/);
      assert.equal((await f.post('/select', { id: 'two@example.com', label: 'forged' })).status, 200);
      const signed = await result;
      assert.equal(signed.account.id, 'two@example.com');
      assert.equal(signed.account.label, 'Two');
      assert.equal(signed.local.apiKey, 'never-expose-key');
      assert.equal((await f.status()).done, true);
      assert.equal((await f.post('/manage')).status, 410, 'no session handoff after completion');
    } finally { f.page.close(); }
  });

  it('revalidates selected accounts and confines relogin to the selected identity', async () => {
    const f = await fixture({ accountId: ready.id });
    try {
      const { result } = await f.start();
      for (const list of [[], [{ ...ready, enabled: false }], [{ ...ready, state: 'auth_required' }]]) {
        f.setAccounts(list);
        assert.equal((await f.post('/select', { id: ready.id })).status, 409);
      }
      f.setAccounts([ready, { ...ready, id: 'someone-else' }]);
      assert.equal((await f.status()).accounts.length, 1);
      assert.equal((await f.post('/select', { id: 'someone-else' })).status, 409);
      assert.equal((await f.post('/select', { id: ready.id })).status, 200);
      assert.equal((await result).account.id, ready.id);
    } finally { f.page.close(); }
  });

  it('rejects foreign origins, guessed paths and rebound hosts', async () => {
    const f = await fixture();
    try {
      const { result } = await f.start();
      result.catch(() => {});
      assert.equal((await f.post('/manage', {}, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await f.post('/cancel', {}, { Origin: 'http://127.0.0.1:9999' })).status, 403);
      assert.equal((await f.post('/cancel', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await fetch(f.page.url + '/manage')).status, 405, 'navigation cannot obtain a session');
      assert.equal((await fetch(new URL('/', f.page.url))).status, 404);
      const url = new URL(f.page.url);
      const status = await new Promise((resolve, reject) => {
        http.get({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'evil.example' } }, res => {
          res.resume(); resolve(res.statusCode);
        }).on('error', reject);
      });
      assert.equal(status, 404);
      assert.equal((await f.post('/cancel')).status, 204);
      await assert.rejects(result, /取消/);
      assert.equal(f.requests.length, 0, 'denied requests never authenticate to the backend');
    } finally { f.page.close(); }
  });

  it('expires during setup and does not revive when setup eventually finishes', async () => {
    let finishSetup;
    const f = await fixture({ deadline: Date.now() + 80, prepare: () => new Promise(resolve => { finishSetup = resolve; }) });
    try {
      const result = f.page.start();
      // The connector intentionally does not keep the plugin host alive on its own.
      await Promise.all([
        assert.rejects(result, /10 分钟/),
        new Promise(resolve => setTimeout(resolve, 100))
      ]);
      finishSetup(f.local);
      await new Promise(resolve => setImmediate(resolve));
      const state = await f.status();
      assert.equal(state.ready, false);
      assert.equal(state.done, true);
      assert.match(state.error, /账号.*保留/);
      assert.equal((await f.post('/select', { id: ready.id })).status, 410);
    } finally { f.page.close(); }
  });

  it('shows setup failures and refuses a non-local management handoff', async () => {
    for (const prepare of [async () => { throw new Error('download failed'); }, async () => ({ origin: 'https://example.com' })]) {
      const f = await fixture({ prepare });
      try {
        await assert.rejects(f.page.start(), /download failed|本机/);
        assert.equal((await f.status()).done, true);
        assert.equal((await f.post('/manage')).status, 410);
      } finally { f.page.close(); }
    }
  });
});
