import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { openStudioConnect } from '../lib/studio-connect.mjs';

async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test timed out')), 2000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(options = {}) {
  let accounts = [], tasks = [], prepared = 0;
  const requests = [];
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ path, ...init });
    if (path === '/api/auth/login') return new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'aistudio_admin=test-session; Path=/api; HttpOnly' }
    });
    assert.equal(new Headers(init.headers).get('Cookie'), 'aistudio_admin=test-session');
    if (path === '/api/accounts/tasks') {
      await options.beforeTasks?.();
      return Response.json({ tasks, magpie_signin: options.legacy ? undefined : 1 });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    assert.equal(path, '/api/accounts');
    return Response.json({ accounts });
  };
  const local = { origin: 'http://127.0.0.1:2048', apiKey: 'never-expose-key', adminUsername: crypto.randomUUID(), adminPassword: 'never-expose-password' };
  const page = await openStudioConnect({
    prepare: async () => { prepared++; return local; },
    progress: () => '正在下载', deadline: Date.now() + 10000, pollMs: 10, fetchFn, ...options
  });
  const origin = new URL(page.url).origin;
  const post = (route, headers = {}) => fetch(page.url + route, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: '{}'
  });
  const status = async () => (await fetch(page.url + '/status')).json();
  async function start() {
    const result = page.start();
    await new Promise(resolve => setImmediate(resolve));
    const response = await post('/manage');
    const { url } = await response.json();
    const state = new URLSearchParams(new URL(url).hash.slice(1));
    return { result, response, url, client: state.get('magpie'), callback: state.get('callback') };
  }
  return { page, post, status, start, local, requests, prepared: () => prepared, setAccounts: list => { accounts = list; }, setTasks: list => { tasks = list; } };
}
const ready = { id: 'one@example.com', label: 'One', enabled: true, state: 'ready', cookie: 'must-not-leak' };
const completed = (client, ids = [ready.id]) => ({ id: 'task', client_id: client, state: 'done', items: ids.map(account_id => ({ account_id, label: 'untrusted display label', state: 'done' })) });

describe('Automatic upstream sign-in', () => {
  it('automatically enters the upstream UI and completes only its own successful task', async () => {
    const f = await fixture();
    try {
      const html = await (await fetch(f.page.url)).text();
      new vm.Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
      assert.doesNotMatch(html, /never-expose|<select|window.open|打开账号管理页|连接到 Magpie<\/button>/);
      assert.match(html, /location.replace/);
      assert.equal(f.prepared(), 0);
      const { result, response, url, client, callback } = await f.start();
      assert.strictEqual(f.page.start(), result);
      assert.match(response.headers.get('set-cookie'), /Path=\/api; HttpOnly; SameSite=Strict/);
      assert.equal(new URL(url).origin, f.local.origin);
      assert.equal(callback, f.page.url + '/finish');
      let navigate;
      const navigation = new Promise(resolve => { navigate = resolve; });
      const elements = new Map(['title', 'detail', 'cancel'].map(id => [id, {}]));
      vm.runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
        document: { getElementById: id => elements.get(id) },
        location: { pathname: new URL(f.page.url).pathname, hash: '', replace: navigate },
        fetch: (route, init = {}) => fetch(new URL(route, f.page.url), {
          ...init, headers: { ...init.headers, Origin: new URL(f.page.url).origin }
        }),
        setTimeout: (fn, ms) => setTimeout(fn, ms).unref()
      });
      assert.equal(await within(navigation), url, 'the page hands off without any user click');
      f.setAccounts([ready]);
      f.setTasks([completed('another-window'), completed(undefined)]);
      await new Promise(r => setTimeout(r, 40));
      assert.equal((await f.status()).done, false, 'existing accounts and other tasks cannot complete login');
      f.setTasks([completed(client)]);
      const signed = await within(result);
      assert.equal(signed.accounts[0].label, 'One', 'account metadata is re-read from the backend');
      const state = await f.status();
      assert.equal(state.done, true);
      assert.doesNotMatch(JSON.stringify(state), /must-not-leak|never-expose|test-session/);
      assert.equal((await fetch(callback)).status, 200);
      assert.equal((await f.post('/manage')).status, 410);
      assert.equal((await f.post('/select')).status, 404, 'the extra selection endpoint is gone');
    } finally { f.page.close(); }
  });

  it('imports all selected accounts without a second selection, and allows retry after failure', async () => {
    const f = await fixture();
    try {
      const { result, client } = await f.start();
      f.setAccounts([ready, { ...ready, id: 'two', label: 'Two' }]);
      f.setTasks([{ ...completed(client), state: 'failed' }]);
      await new Promise(r => setTimeout(r, 30));
      assert.equal((await f.status()).done, false);
      f.setTasks([completed(client, ['two', ready.id])]);
      assert.deepEqual((await within(result)).accounts.map(a => a.id), [ready.id, 'two']);
    } finally { f.page.close(); }
  });

  it('retains partial successes after a failed task is removed and merges only this sign-in', async () => {
    const f = await fixture({ pollMs: 60000 });
    try {
      const { result, client } = await f.start();
      f.setAccounts([ready, { ...ready, id: 'two' }, { ...ready, id: 'unrelated' }]);
      f.setTasks([
        { ...completed(client), id: 'partial', state: 'failed', items: [...completed(client).items, { state: 'failed', label: 'two' }] },
        completed('another-window', ['unrelated'])
      ]);
      assert.equal((await f.status()).done, false);
      f.setTasks([{ ...completed(client, ['two']), id: 'retry' }]);
      assert.equal((await f.status()).done, true, 'the finish-page poll checks tasks immediately');
      assert.deepEqual((await within(result)).accounts.map(a => a.id), [ready.id, 'two']);
    } finally { await f.page.close(); }
  });

  it('revalidates successes accumulated before retry and never borrows them for reauthentication', async () => {
    for (const accountId of [undefined, ready.id]) {
      const f = await fixture({ pollMs: 60000, accountId });
      try {
        const { result, client } = await f.start();
        f.setAccounts([{ ...ready, enabled: false }, { ...ready, id: 'two' }]);
        f.setTasks([{ ...completed(client), state: 'failed' }]);
        assert.equal((await f.status()).done, false);
        f.setTasks([completed(client, ['two'])]);
        await f.status();
        await assert.rejects(result, accountId ? /不一致/ : /停用/);
      } finally { await f.page.close(); }
    }
  });

  it('joins an in-flight task check and cleans up only its own banners on close', async () => {
    let gate, entered;
    const f = await fixture({ pollMs: 60000, beforeTasks: () => { entered?.(); return gate; } });
    try {
      const { result, client } = await f.start();
      let release;
      gate = new Promise(resolve => { release = resolve; });
      const reading = new Promise(resolve => { entered = resolve; });
      f.setAccounts([ready]);
      f.setTasks([completed(client), { ...completed(client), id: 'failed', state: 'failed' }, completed('other')]);
      const first = f.status();
      await reading;
      const second = f.status();
      release();
      gate = null;
      assert.equal((await first).done, true);
      assert.equal((await second).done, true);
      await within(result);
      assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 0, 'keep tasks until the frontend can return');
      await f.page.close();
      assert.deepEqual(f.requests.filter(r => r.method === 'DELETE').map(r => r.path).sort(), ['/api/accounts/tasks/failed', '/api/accounts/tasks/task']);
    } finally { await f.page.close(); }
  });

  it('revalidates results and confines reauthentication to the original account', async () => {
    for (const scenario of ['disabled', 'removed', 'expired', 'wrong', 'missing-id']) {
      const f = await fixture({ accountId: ready.id });
      try {
        const { result, client } = await f.start();
        f.setAccounts(scenario === 'removed' ? [] : [{ ...ready, enabled: scenario !== 'disabled', state: scenario === 'expired' ? 'auth_required' : 'ready' }]);
        f.setTasks([completed(client, [scenario === 'wrong' ? 'different' : scenario === 'missing-id' ? '' : ready.id])]);
        await assert.rejects(within(result), /账号|导入任务/);
      } finally { f.page.close(); }
    }
  });

  it('rejects foreign origins and rebound hosts; cancellation affects only this login', async () => {
    const f = await fixture();
    try {
      const { result, client } = await f.start();
      f.setTasks([{ ...completed(client), id: 'ours', state: 'running' }, { ...completed('other'), id: 'theirs', state: 'running' }]);
      assert.equal((await f.post('/manage', { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await f.post('/cancel', { Origin: 'http://127.0.0.1:9999' })).status, 403);
      assert.equal((await f.post('/cancel', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await fetch(f.page.url + '/manage')).status, 405);
      const url = new URL(f.page.url);
      const status = await new Promise((resolve, reject) => {
        http.get({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'evil.example' } }, res => {
          res.resume(); resolve(res.statusCode);
        }).on('error', reject);
      });
      assert.equal(status, 404);
      assert.equal((await f.post('/cancel')).status, 204);
      await assert.rejects(result, /取消/);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(f.requests.filter(r => r.method === 'DELETE').map(r => r.path), ['/api/accounts/tasks/ours']);
    } finally { f.page.close(); }
  });

  it('keeps the existing manual flow usable with an older pinned backend', async () => {
    const f = await fixture({ legacy: true });
    try {
      const { result, url } = await f.start();
      assert.equal(new URL(url).hostname, '127.0.0.1');
      assert.notEqual(new URL(url).origin, f.local.origin);
      assert.match(await (await fetch(url)).text(), /连接到 Magpie/);
      f.setAccounts([ready]);
      const response = await fetch(url + '/select', {
        method: 'POST', headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ready.id })
      });
      assert.equal(response.status, 200);
      assert.equal((await within(result)).accounts[0].id, ready.id);
    } finally { f.page.close(); }
  });

  it('expires during setup and never revives on late completion', async () => {
    let finishSetup;
    const f = await fixture({ deadline: Date.now() + 80, prepare: () => new Promise(resolve => { finishSetup = resolve; }) });
    try {
      await assert.rejects(within(f.page.start()), /10 分钟/);
      finishSetup(f.local);
      await new Promise(resolve => setImmediate(resolve));
      const state = await f.status();
      assert.equal(state.ready, false);
      assert.equal(state.done, true);
    } finally { f.page.close(); }
  });

  it('shows setup failures and refuses a non-local backend', async () => {
    for (const prepare of [async () => { throw new Error('download failed'); }, async () => ({ origin: 'https://example.com' })]) {
      const f = await fixture({ prepare });
      try {
        await assert.rejects(f.page.start(), /download failed|本机/);
        assert.equal((await f.status()).done, true);
      } finally { f.page.close(); }
    }
  });
});
