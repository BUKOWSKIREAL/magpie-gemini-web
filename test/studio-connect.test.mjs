import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
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
      assert.equal(new URL(url).origin, new URL(f.page.url).origin);
      assert.equal(new URL(url).pathname, '/');
      assert.equal(new URL(url).searchParams.get('tab'), 'accounts');
      assert.notEqual(new URL(url).origin, f.local.origin);
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

  it('keeps the host async context for status and management fetches', async () => {
    const als = new AsyncLocalStorage();
    const seen = [];
    const local = { origin: 'http://127.0.0.1:2048', apiKey: 'k', adminUsername: 'u', adminPassword: 'p' };
    const page = await als.run({ flow: 'agent2api' }, async () => {
      const opened = await openStudioConnect({
        prepare: async () => local,
        deadline: Date.now() + 10000,
        pollMs: 60000,
        fetchFn: async (url) => {
          const path = new URL(url).pathname;
          seen.push({ path, store: als.getStore() });
          if (path === '/api/auth/login') {
            return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'aistudio_admin=test-session; Path=/api; HttpOnly' } });
          }
          return Response.json({ tasks: [], accounts: [], magpie_signin: 1 });
        }
      });
      opened.start().catch(() => {});
      return opened;
    });
    try {
      let status;
      for (let i = 0; i < 20; i++) {
        status = await (await fetch(page.url + '/status')).json();
        if (status.ready) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(status.ready, true);
      assert.equal(seen.some(entry => entry.path === '/api/accounts'), false);
      const origin = new URL(page.url).origin;
      const manage = await fetch(page.url + '/manage', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}'
      });
      assert.equal(manage.status, 200);
      const accounts = seen.filter(entry => entry.path === '/api/accounts');
      assert.ok(accounts.length >= 1);
      for (const entry of accounts) assert.deepEqual(entry.store, { flow: 'agent2api' });
    } finally { page.close(); }
  });

  it('keeps the existing manual flow usable with an older pinned backend', async () => {
    const f = await fixture({ legacy: true });
    try {
      const { result, url } = await f.start();
      assert.equal(new URL(url).hostname, '127.0.0.1');
      assert.equal(new URL(url).origin, new URL(f.page.url).origin);
      assert.notEqual(new URL(url).origin, f.local.origin);
      assert.match(await (await fetch(url)).text(), /连接到 Magpie/);
      const accountPage = new URL((await (await fetch(url + '/manage', {
        method: 'POST', headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: '{}'
      })).json()).url);
      assert.equal(accountPage.origin, new URL(url).origin);
      assert.equal(`${accountPage.pathname}${accountPage.search}`, '/?tab=accounts');
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

  it('forwards only the managed account UI on the authorization origin', async () => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      const hit = { method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin };
      seen.push(hit);
      if (req.url === '/redirect-off') {
        res.writeHead(302, { Location: 'https://evil.example/phish' }).end();
        return;
      }
      if (req.url === '/redirect-self') {
        res.writeHead(302, { Location: `http://${hit.host}/assets/app.js` }).end();
        return;
      }
      if (req.url === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: hello\n\n');
        return;
      }
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        hit.body = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'extra=1; Domain=evil.example; Path=/' });
        res.end(`upstream ${req.url}`);
      });
    });
    upstream.on('upgrade', (req, socket) => {
      seen.push({ upgrade: req.url, host: req.headers.host, origin: req.headers.origin });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nready');
      socket.on('data', chunk => socket.write(chunk));
      // Node does not finish an upgraded socket on peer EOF, and closeAllConnections skips it.
      socket.on('end', () => socket.destroy());
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
    const local = { origin: upstreamOrigin, apiKey: 'never-expose-key', adminUsername: 'u', adminPassword: 'p' };
    const page = await openStudioConnect({
      prepare: async () => local, deadline: Date.now() + 10000, pollMs: 20,
      fetchFn: async (url) => {
        const path = new URL(url).pathname;
        if (path === '/api/auth/login') return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'aistudio_admin=test-session; Path=/api; HttpOnly' } });
        if (path === '/api/accounts/tasks') return Response.json({ tasks: [], magpie_signin: 1 });
        return Response.json({ accounts: [] });
      }
    });
    const pageOrigin = new URL(page.url).origin;
    const ask = (path, init = {}) => fetch(pageOrigin + path, init);
    try {
      assert.equal((await ask('/?tab=accounts')).status, 404, 'nothing is forwarded before the managed service is known');
      page.start().catch(() => {});
      let ready = false;
      for (let i = 0; i < 20 && !ready; i++) {
        ready = (await (await fetch(page.url + '/status')).json()).ready;
        if (!ready) await new Promise(resolve => setTimeout(resolve, 20));
      }
      const managed = await (await fetch(page.url + '/manage', {
        method: 'POST', headers: { Origin: pageOrigin, 'Content-Type': 'application/json' }, body: '{}'
      })).json();
      const accountPage = new URL(managed.url);
      assert.equal(accountPage.origin, pageOrigin);
      assert.notEqual(accountPage.origin, upstreamOrigin);
      const shown = await ask(`/?tab=accounts&url=${encodeURIComponent('http://evil.example/steal')}`);
      assert.equal(shown.status, 200);
      assert.equal(shown.headers.get('set-cookie').includes('Domain='), false);
      assert.match(await shown.text(), /upstream \/\?tab=accounts/);
      assert.equal(seen.at(-1).host, new URL(upstreamOrigin).host);
      assert.equal(seen.at(-1).origin, upstreamOrigin);
      const beforeBody = seen.length;
      const posted = await ask('/api/accounts', {
        method: 'POST', headers: { Origin: pageOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://evil.example/steal', path: '/v1/models' })
      });
      assert.equal(posted.status, 200);
      assert.equal(seen.at(-1).url, '/api/accounts');
      assert.match(seen.at(-1).body, /evil\.example/);
      assert.equal((await ask('/api/accounts', {
        method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}'
      })).status, 403);
      assert.equal(seen.length, beforeBody + 1);
      const picked = await ask('/api/paths?path=' + encodeURIComponent('/Users/secret'));
      assert.equal(picked.status, 200);
      assert.equal(seen.at(-1).url, '/api/paths?path=%2FUsers%2Fsecret');
      assert.equal((await ask('/v1/models')).status, 404);
      assert.equal((await ask('/v1%2fmodels')).status, 404);
      const target = new URL(pageOrigin);
      const traversal = await new Promise((resolve, reject) => {
        http.get({ hostname: target.hostname, port: target.port, path: '/assets/%2e%2e/v1/models' }, res => {
          res.resume();
          resolve(res.statusCode);
        }).on('error', reject);
      });
      assert.equal(traversal, 404);
      assert.equal(seen.some(hit => String(hit.url).includes('/v1')), false);
      const foreign = await ask('/redirect-off', { redirect: 'manual' });
      assert.equal(foreign.status, 502);
      assert.equal(foreign.headers.get('location'), null);
      assert.doesNotMatch(await foreign.text(), /evil\.example|never-expose/);
      const rewritten = await ask('/redirect-self', { redirect: 'manual' });
      assert.equal(rewritten.status, 302);
      assert.equal(rewritten.headers.get('location'), `${pageOrigin}/assets/app.js`);
      const events = await new Promise((resolve, reject) => {
        const req = http.get(pageOrigin + '/api/events', res => {
          res.once('data', chunk => { res.destroy(); resolve(chunk.toString()); });
        });
        req.on('error', reject);
      });
      assert.match(events, /data: hello/);
      const view = await new Promise((resolve, reject) => {
        const target = new URL('/api/login-view/abc123', pageOrigin);
        const req = http.request({
          hostname: target.hostname, port: target.port, path: target.pathname,
          headers: {
            Connection: 'Upgrade', Upgrade: 'websocket', Origin: pageOrigin, Host: target.host,
            'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
          }
        });
        req.on('upgrade', (res, socket, head) => {
          const chunks = [head];
          const finish = () => { socket.destroy(); resolve(Buffer.concat(chunks).toString()); };
          if (head.includes('ready')) finish();
          else socket.once('data', chunk => { chunks.push(chunk); finish(); });
        });
        req.on('error', reject);
        req.end();
      });
      assert.match(view, /ready/);
      assert.equal(seen.at(-1).upgrade, '/api/login-view/abc123');
      assert.equal(seen.at(-1).origin, upstreamOrigin);
      const upgrades = seen.filter(hit => hit.upgrade).length;
      const denied = await new Promise(resolve => {
        const target = new URL(pageOrigin);
        const req = http.request({
          hostname: target.hostname, port: target.port, path: '/api/login-view/../v1',
          headers: {
            Connection: 'Upgrade', Upgrade: 'websocket', Origin: pageOrigin, Host: target.host,
            'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
          }
        });
        req.on('upgrade', () => resolve('upgraded'));
        req.on('response', res => { res.resume(); resolve('response'); });
        req.on('error', () => resolve('error'));
        req.setTimeout(1000, () => { req.destroy(); resolve('closed'); });
        req.end();
      });
      assert.notEqual(denied, 'upgraded');
      assert.equal(seen.filter(hit => hit.upgrade).length, upgrades);
      const blockedHost = await new Promise((resolve, reject) => {
        const hostTarget = new URL(pageOrigin);
        http.get({ hostname: hostTarget.hostname, port: hostTarget.port, path: '/?tab=accounts', headers: { Host: 'evil.example' } }, res => {
          res.resume(); resolve(res.statusCode);
        }).on('error', reject);
      });
      assert.equal(blockedHost, 404);
    } finally {
      page.close();
      await new Promise(resolve => upstream.close(resolve));
    }
  });

  it('does not cross two managed services', async () => {
    async function start(marker) {
      const upstream = http.createServer((req, res) => { res.end(`${marker} ${req.url}`); });
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${upstream.address().port}`;
      const page = await openStudioConnect({
        prepare: async () => ({ origin, apiKey: 'k', adminUsername: marker, adminPassword: 'p' }),
        deadline: Date.now() + 10000, pollMs: 20,
        fetchFn: async (url) => {
          const path = new URL(url).pathname;
          if (path === '/api/auth/login') return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': `aistudio_admin=${marker}; Path=/api; HttpOnly` } });
          if (path === '/api/accounts/tasks') return Response.json({ tasks: [], magpie_signin: 1 });
          return Response.json({ accounts: [] });
        }
      });
      page.start().catch(() => {});
      for (let i = 0; i < 20; i++) {
        if ((await (await fetch(page.url + '/status')).json()).ready) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return { upstream, page };
    }
    const a = await start('alpha');
    const b = await start('beta');
    try {
      assert.equal(await (await fetch(new URL(a.page.url).origin + '/only-a')).text(), 'alpha /only-a');
      assert.equal(await (await fetch(new URL(b.page.url).origin + '/only-b')).text(), 'beta /only-b');
    } finally {
      a.page.close();
      b.page.close();
      await new Promise(resolve => a.upstream.close(resolve));
      await new Promise(resolve => b.upstream.close(resolve));
    }
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
