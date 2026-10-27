import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { GeminiWebPlugin } from '../index.mjs';
import { ensureBackend, installBackend, localBackend, pinnedBinary } from '../lib/native.mjs';
import { parseCookieInput, importCookie, ensureProxy, validateProxyURL, requireLoginBackend, REQUIRED_COOKIES } from '../lib/setup.mjs';

const LOGIN_CAPABILITIES = { capabilities: { account_proxy_binding: true } };

const SIGNED_IN = REQUIRED_COOKIES.map(n => `${n}=v-${n}`).join('; ');

function makeDataDir({ port = 8083, binary = 'fake backend' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-gemini-web-setup-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  if (binary !== null) fs.writeFileSync(path.join(dir, 'bin', 'gemini-web2api-go'), binary, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port }));
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_test', adminToken: 'admin_test' }));
  return dir;
}

// trustBinary marks the fake binary as a known local build, the way backend:install:argon does.
function trustBinary(dir) {
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'bin', 'gemini-web2api-go'))).digest('hex');
  fs.writeFileSync(path.join(dir, 'argon-build.json'), JSON.stringify({ sha256 }));
}

function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    return child;
  };
}

describe('24. Cookie input parsing', () => {
  it('accepts the Cookie request header, with or without prefix and quotes', () => {
    assert.equal(parseCookieInput(SIGNED_IN), SIGNED_IN);
    assert.equal(parseCookieInput(`cookie: ${SIGNED_IN}`), SIGNED_IN);
    assert.equal(parseCookieInput(`"${SIGNED_IN}; NID=x"`), `${SIGNED_IN}; NID=x`);
  });

  it('keeps google.com rows from a DevTools cookie table and drops other domains', () => {
    const rows = REQUIRED_COOKIES.map(n => `${n}\tv-${n}\t.google.com\t/\t2027-01-01\t10`);
    rows.push('OTHER\tx\t.youtube.com\t/\t2027-01-01\t5');
    rows.push('_ga\ty\tgemini.google.com\t/\t2027-01-01\t5');
    assert.equal(parseCookieInput(rows.join('\n')), `${SIGNED_IN}; _ga=y`);
  });

  it('accepts cookie-editor JSON exports', () => {
    const json = REQUIRED_COOKIES.map(n => ({ name: n, value: `v-${n}`, domain: '.google.com' }));
    json.push({ name: 'OTHER', value: 'x', domain: '.example.com' });
    assert.equal(parseCookieInput(JSON.stringify(json)), SIGNED_IN);
    assert.equal(parseCookieInput(JSON.stringify({ cookie: SIGNED_IN })), SIGNED_IN);
  });

  it('names the sign-in cookies that are missing', () => {
    assert.throws(() => parseCookieInput(''), /没有收到 Cookie/);
    assert.throws(() => parseCookieInput('SID=a; HSID=b; NID=c'), /缺少 SSID、APISID、SAPISID、__Secure-1PSID/);
  });
});

describe('25. Cookie import through the admin API', () => {
  const setup = { origin: 'http://127.0.0.1:1', adminToken: 'admin_test' };

  function adminFetch(check, calls) {
    return async (url, init) => {
      calls.push({ path: new URL(url).pathname, method: init.method, auth: init.headers?.Authorization, body: init.body });
      if (new URL(url).pathname === '/') return Response.json(LOGIN_CAPABILITIES);
      if (init.method === 'POST' && url.endsWith('/cookies')) return Response.json({ id: 7 });
      if (url.endsWith('/check')) return check();
      return Response.json({ ok: true });
    };
  }

  it('adds the account and checks it', async () => {
    const calls = [];
    const r = await importCookie(setup, SIGNED_IN, { fetchFn: adminFetch(() => Response.json({ ok: true, detail: 'fine' }), calls) });
    assert.deepEqual(r, { id: 7, detail: 'fine' });
    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET /', 'POST /admin/api/cookies', 'POST /admin/api/cookies/7/check']);
    assert.equal(calls[1].auth, 'Bearer admin_test');
    assert.equal(JSON.parse(calls[1].body).cookie, SIGNED_IN);
  });

  it('removes an account that fails the check', async () => {
    const calls = [];
    await assert.rejects(
      importCookie(setup, SIGNED_IN, { fetchFn: adminFetch(() => Response.json({ ok: false, detail: 'signed out' }), calls) }),
      /无法登录 Gemini：signed out/
    );
    assert.equal(calls.at(-1).method, 'DELETE');
    assert.equal(calls.at(-1).path, '/admin/api/cookies/7');
  });

  it('removes the account when the check itself errors', async () => {
    const calls = [];
    await assert.rejects(
      importCookie(setup, SIGNED_IN, { fetchFn: adminFetch(() => Response.json({ error: 'boom' }, { status: 500 }), calls) }),
      /HTTP 500/
    );
    assert.equal(calls.at(-1).method, 'DELETE');
  });

  // The check is the backend fetching gemini.google.com; one that never answers is the backend
  // not reaching Google, not the plugin not reaching the backend.
  it('says a check that times out is the backend not reaching Google, and removes the account', async () => {
    const calls = [];
    const timeout = () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
    await assert.rejects(importCookie(setup, SIGNED_IN, { fetchFn: adminFetch(timeout, calls) }), err => {
      assert.match(err.message, /60 秒内没检测完这个 Cookie/);
      assert.match(err.message, /http:\/\/127\.0\.0\.1:1\/admin 的代理池/);
      assert.doesNotMatch(err.message, /连不上本地/);
      return true;
    });
    assert.equal(calls.at(-1).method, 'DELETE');
  });

  it('says the backend could not reach Google when its check fetch fails, not that the cookie is bad', async () => {
    const calls = [];
    const failed = () => Response.json({ ok: false, detail: '检测失败：dial tcp 1.2.3.4:443: i/o timeout' });
    await assert.rejects(importCookie(setup, SIGNED_IN, { fetchFn: adminFetch(failed, calls) }), err => {
      assert.match(err.message, /没能访问 gemini\.google\.com.*i\/o timeout/);
      assert.match(err.message, /代理池/);
      assert.doesNotMatch(err.message, /无法登录/);
      return true;
    });
    assert.equal(calls.at(-1).method, 'DELETE');
  });

  it('still says the backend is unreachable when the request itself fails', async () => {
    const refused = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(importCookie(setup, SIGNED_IN, { fetchFn: refused }), /无法确认本地 Gemini Web 后端的登录能力.*fetch failed/);
  });

  it('validates proxy URLs and configures the backend proxy pool before checking a cookie', async () => {
    assert.equal(validateProxyURL(''), '');
    assert.equal(validateProxyURL('  http://127.0.0.1:7890 '), 'http://127.0.0.1:7890');
    assert.equal(validateProxyURL('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
    assert.throws(() => validateProxyURL('127.0.0.1:7890'), /代理地址/);
    assert.throws(() => validateProxyURL('ftp://127.0.0.1:21'), /http:\/\/、https:\/\/、socks5:\/\//);

    const calls = [];
    let proxies = [];
    const fetchFn = async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push({ path: pathname, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      if (pathname === '/') return Response.json(LOGIN_CAPABILITIES);
      if (pathname === '/admin/api/proxies' && init.method === 'GET') return Response.json({ items: proxies });
      if (pathname === '/admin/api/proxies' && init.method === 'POST') {
        proxies = [{ id: 3, name: 'Magpie', url: JSON.parse(init.body).url, enabled: true, fail_count: 0 }];
        return Response.json({ id: 3 });
      }
      if (pathname === '/admin/api/proxies/3' && init.method === 'PATCH') {
        Object.assign(proxies[0], JSON.parse(init.body));
        return Response.json({ ok: true });
      }
      if (pathname === '/admin/api/proxies/3/reset' && init.method === 'POST') {
        proxies[0].fail_count = 0;
        return Response.json({ ok: true });
      }
      if (pathname === '/admin/api/cookies' && init.method === 'POST') return Response.json({ id: 7 });
      if (pathname === '/admin/api/cookies/7/check') return Response.json({ ok: true, detail: 'via proxy' });
      return Response.json({ ok: true });
    };

    const r = await importCookie(setup, SIGNED_IN, { proxy: 'http://127.0.0.1:7890', fetchFn });
    assert.deepEqual(r, { id: 7, detail: 'via proxy' });
    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), [
      'GET /',
      'GET /admin/api/proxies',
      'POST /admin/api/proxies',
      'POST /admin/api/cookies',
      'POST /admin/api/cookies/7/check'
    ]);
    assert.equal(calls.find(c => c.path === '/admin/api/cookies').body.proxy_id, 3, 'account must be bound to the chosen proxy before check');

    // Updating the Magpie proxy URL and resetting failures reuses the existing pool row in-place.
    calls.length = 0;
    proxies[0].enabled = false;
    proxies[0].fail_count = 5;
    await ensureProxy(setup, 'http://127.0.0.1:10809', { fetchFn });
    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), [
      'GET /admin/api/proxies',
      'PATCH /admin/api/proxies/3',
      'POST /admin/api/proxies/3/reset'
    ]);
    assert.equal(proxies[0].url, 'http://127.0.0.1:10809');
    assert.equal(proxies[0].enabled, true);
    assert.equal(proxies[0].fail_count, 0);
  });

  it('rejects legacy, upstream and unadvertised builds before sending cookies or changing proxies', async () => {
    for (const info of [
      { version: '4.22.0-magpie.1' }, { version: '4.26.0' },
      { version: '4.26.0-magpie.1' }, { capabilities: { account_proxy_binding: 'true' } }
    ]) {
      const calls = [];
      await assert.rejects(importCookie(setup, SIGNED_IN, {
        proxy: 'http://127.0.0.1:7890',
        fetchFn: async (url, init) => { calls.push([url, init]); return Response.json(info); }
      }), /不支持登录时绑定代理/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], `${setup.origin}/`);
      assert.equal(calls[0][1].method, 'GET');
      assert.equal(calls[0][1].body, undefined);
    }
  });

  it('includes the correct custom data directory and PowerShell literal quoting in recovery instructions', async () => {
    await assert.rejects(requireLoginBackend(setup, {
      platform: 'win32', dataDir: path.resolve("review user's $data space"),
      fetchFn: async () => Response.json({ version: '4.22.0-magpie.1' })
    }), err => {
      assert.match(err.message, /任务管理器.*gemini-web2api-go\.exe/);
      assert.match(err.message, /backend\.mjs' install --data-dir='/);
      assert.ok(err.message.includes("user''s $data space'"));
      assert.match(err.message, /GEMINI_WEB_PROXY/);
      return true;
    });
  });
});

describe('26. ensureBackend', () => {
  it('leaves a backend that already answers with this key alone', async () => {
    const dataDir = makeDataDir();
    const spawned = [];
    const setup = await ensureBackend({
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      fetchFn: async (url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer gw_test');
        return Response.json({ data: [] });
      },
      spawnFn: fakeSpawn(spawned)
    });
    assert.equal(setup.baseURL, 'http://127.0.0.1:8083/v1');
    assert.equal(setup.apiKey, 'gw_test');
    assert.equal(spawned.length, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts a trusted backend in the background and waits for it', async () => {
    const dataDir = makeDataDir();
    trustBinary(dataDir);
    const spawned = [];
    const setup = await ensureBackend({
      dataDir,
      platform: 'darwin',
      arch: 'arm64',
      fetchFn: async () => {
        if (!spawned.length) throw new Error('ECONNREFUSED');
        return Response.json({ data: [] });
      },
      spawnFn: fakeSpawn(spawned)
    });
    assert.equal(setup.origin, 'http://127.0.0.1:8083');
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, path.join(dataDir, 'bin', 'gemini-web2api-go'));
    assert.equal(spawned[0].opts.detached, true);
    assert.equal(spawned[0].opts.env.API_KEY, 'gw_test');
    assert.equal(spawned[0].opts.env.ADMIN_TOKEN, 'admin_test');
    assert.equal(fs.readFileSync(path.join(dataDir, 'backend.pid'), 'utf8'), '4242\n');
    assert.equal(fs.existsSync(path.join(dataDir, '.setup.lock')), false);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses a port held by another service', async () => {
    const dataDir = makeDataDir();
    trustBinary(dataDir);
    const spawned = [];
    await assert.rejects(
      ensureBackend({
        dataDir,
        platform: 'darwin',
        arch: 'arm64',
        fetchFn: async () => new Response('unauthorized', { status: 401 }),
        spawnFn: fakeSpawn(spawned)
      }),
      /already used by another service/
    );
    assert.equal(spawned.length, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('fetches the pinned release and does not launch or delete the old binary on a bad download', async () => {
    const dataDir = makeDataDir();
    const spawned = [];
    const urls = [];
    await assert.rejects(
      ensureBackend({
        dataDir,
        platform: 'darwin',
        arch: 'arm64',
        fetchFn: async url => {
          urls.push(String(url));
          if (String(url).includes('github.com')) return new Response('tampered', { status: 200 });
          throw new Error('ECONNREFUSED');
        },
        spawnFn: fakeSpawn(spawned)
      }),
      /SHA256 checksum mismatch/
    );
    assert.ok(urls.includes(pinnedBinary('darwin', 'arm64').url));
    assert.equal(fs.readFileSync(path.join(dataDir, 'bin', 'gemini-web2api-go'), 'utf8'), 'fake backend');
    assert.equal(spawned.length, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('localBackend is null until a backend is installed', () => {
    const dataDir = makeDataDir({ binary: null });
    assert.equal(localBackend({ dataDir, platform: 'darwin' }), null);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('kills the spawned child and cleans up backend.pid when startup times out', async () => {
    const dataDir = makeDataDir();
    trustBinary(dataDir);
    const signals = [];
    await assert.rejects(
      ensureBackend({
        dataDir,
        platform: 'darwin',
        arch: 'arm64',
        startTimeoutMs: 50,
        fetchFn: async () => { throw new Error('ECONNREFUSED'); },
        spawnFn: () => {
          const child = new EventEmitter();
          child.pid = 999999;
          child.kill = sig => { signals.push(sig); };
          child.unref = () => {};
          return child;
        }
      }),
      /did not start within/
    );
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(fs.existsSync(path.join(dataDir, 'backend.pid')), false);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('forwards proxy to installBackend and downloads through a local HTTP proxy', async () => {
    const dataDir = makeDataDir({ binary: null });
    const payload = Buffer.from('proxied backend binary');
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');
    const proxiedRequests = [];
    const proxyServer = http.createServer((req, res) => {
      proxiedRequests.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(payload);
    });
    await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyURL = `http://127.0.0.1:${proxyServer.address().port}`;
    try {
      await installBackend({
        dataDir,
        platform: 'darwin',
        arch: 'arm64',
        url: 'http://release.invalid/gemini-web2api-go',
        expectedHash,
        proxy: proxyURL
      });
      assert.equal(proxiedRequests.length, 1);
      assert.equal(proxiedRequests[0], 'http://release.invalid/gemini-web2api-go');
      assert.deepEqual(fs.readFileSync(path.join(dataDir, 'bin', 'gemini-web2api-go')), payload);
    } finally {
      await new Promise(resolve => proxyServer.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('27. One-click sign-in through the plugin', () => {
  let backendCapabilities = LOGIN_CAPABILITIES;
  let server;
  let dataDir;
  let previousDataDir;
  const accounts = new Map();
  let nextId = 1;
  // The backend's database, which the plugin reads the pool from: the fake backend keeps its
  // accounts there too.
  let db;
  const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const savedEnv = {};

  before(async () => {
    // Magpie's host has no proxy variables of its own (see egress in lib/usage.mjs).
    PROXY_ENV.forEach(k => { savedEnv[k] = process.env[k]; delete process.env[k]; });
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const send = (status, data) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (req.url === '/') return send(200, backendCapabilities);
        if (req.url === '/v1/models') {
          return req.headers.authorization === 'Bearer gw_test' ? send(200, { data: [] }) : send(401, { error: 'bad key' });
        }
        if (req.headers.authorization !== 'Bearer admin_test') return send(401, { error: 'bad admin token' });
        if (req.method === 'GET' && req.url === '/admin/api/proxies') {
          const items = db.prepare('SELECT id, name, url, enabled FROM proxies ORDER BY id').all()
            .map(p => ({ ...p, enabled: p.enabled === 1, fail_count: 0 }));
          return send(200, { items });
        }
        if (req.method === 'POST' && req.url === '/admin/api/proxies') {
          const parsed = JSON.parse(body);
          const id = nextId++;
          db.prepare('INSERT INTO proxies (id, name, url, enabled) VALUES (?, ?, ?, 1)').run(id, parsed.name, parsed.url);
          return send(200, { id });
        }
        if (req.method === 'POST' && req.url === '/admin/api/cookies') {
          const parsed = JSON.parse(body);
          const id = nextId++;
          const proxyId = Number.isInteger(parsed.proxy_id) ? parsed.proxy_id : 0;
          accounts.set(id, { cookie: parsed.cookie, proxyId, checkedProxyId: null });
          db.prepare(`INSERT INTO accounts (id, label, cookie, status, proxy_id) VALUES (?, 'Magpie', ?, 'enabled', ?)`)
            .run(id, parsed.cookie, proxyId);
          return send(200, { id });
        }
        const m = req.url.match(/^\/admin\/api\/cookies\/(\d+)(\/check)?$/);
        if (m && req.method === 'POST' && m[2]) {
          const entry = accounts.get(Number(m[1]));
          const cookie = entry?.cookie || '';
          if (entry) {
            const row = db.prepare('SELECT proxy_id FROM accounts WHERE id = ?').get(Number(m[1]));
            entry.checkedProxyId = row?.proxy_id ?? 0;
          }
          return send(200, cookie.includes('SID=good') ? { ok: true, detail: 'ok' } : { ok: false, detail: 'not signed in' });
        }
        if (m && req.method === 'DELETE') {
          accounts.delete(Number(m[1]));
          db.prepare('DELETE FROM accounts WHERE id = ?').run(Number(m[1]));
          return send(200, {});
        }
        send(404, { error: 'not found' });
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    dataDir = makeDataDir({ port: server.address().port });
    db = new DatabaseSync(path.join(dataDir, 'gemini.db'));
    db.exec(`CREATE TABLE proxies (id INTEGER PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER);
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, label TEXT, cookie TEXT, status TEXT, proxy_id INTEGER,
        last_used_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE requests (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, account_id INTEGER);`);
    previousDataDir = process.env.GEMINI_WEB_DATA_DIR;
    process.env.GEMINI_WEB_DATA_DIR = dataDir;
  });

  after(() => {
    server.close();
    db.close();
    PROXY_ENV.forEach(k => { if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; });
    if (previousDataDir === undefined) delete process.env.GEMINI_WEB_DATA_DIR;
    else process.env.GEMINI_WEB_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function oauthMethod() {
    const plugin = await GeminiWebPlugin({});
    const method = plugin.auth.methods[0];
    assert.equal(method.type, 'oauth');
    return method;
  }

  it('offers one-click setup first and keeps the custom-backend method', async () => {
    const plugin = await GeminiWebPlugin({});
    const types = ['oauth', 'api', 'oauth'];
    if (process.platform === 'darwin') types.push('oauth'); // the Task route, last (see task.test.mjs)
    assert.deepEqual(plugin.auth.methods.map(m => m.type), types);
  });

  it('blocks a reused live legacy backend before changing its pool, and permits login after its upgrade', async () => {
    const method = await oauthMethod();
    const before = nextId;
    backendCapabilities = { version: '4.22.0-magpie.1' };
    try {
      // authorize returns at once (see the first-download test); the check comes in the callback.
      const blocked = await method.authorize({ proxy: 'http://127.0.0.1:7890' });
      const result = await blocked.callback(SIGNED_IN);
      assert.equal(result.type, 'failed');
      assert.match(result.error, /请先升级/);
      assert.equal(nextId, before, 'no proxy or account may be added to the old backend');
    } finally { backendCapabilities = LOGIN_CAPABILITIES; }
    const pending = await method.authorize();
    assert.equal(pending.method, 'code');
  });

  it('rechecks capability if an old service replaces the backend while the cookie form is open', async () => {
    const pending = await (await oauthMethod()).authorize();
    const before = nextId;
    backendCapabilities = { version: '4.22.0-magpie.1' };
    try {
      const result = await pending.callback(SIGNED_IN);
      assert.equal(result.type, 'failed');
      assert.match(result.error, /请先升级/);
      assert.equal(nextId, before);
    } finally { backendCapabilities = LOGIN_CAPABILITIES; }
  });

  it('signs in with the local backend key after a working cookie is imported', async () => {
    const pending = await (await oauthMethod()).authorize();
    assert.equal(pending.method, 'code');
    assert.match(pending.url, /^https:\/\/gemini\.google\.com\//);
    assert.match(pending.instructions, /cookie/);

    // the Google email comes from the signed-in app page, answered here
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => url === 'https://gemini.google.com/app'
      ? Promise.resolve(new Response('{"oPEP7c":"setup@gmail.com"}'))
      : realFetch(url, init);
    let result;
    try {
      result = await pending.callback(`cookie: ${SIGNED_IN.replace('SID=v-SID', 'SID=good')}`);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(result, {
      type: 'success',
      key: 'gw_test',
      metadata: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, account: [...accounts.keys()][0], email: 'setup@gmail.com' }
    });
    assert.equal(accounts.size, 1);
  });

  it('signs in without the email while the new account has no known way out', async () => {
    // A pool with proxies: the backend binds the account to one on its first request.
    db.exec(`INSERT INTO proxies VALUES (1, 'p1', 'http://127.0.0.1:7890', 1)`);
    const pending = await (await oauthMethod()).authorize();
    const realFetch = globalThis.fetch;
    const google = [];
    globalThis.fetch = (url, init) => {
      if (String(url).startsWith('https://gemini.google.com/')) google.push(url);
      return realFetch(url, init);
    };
    let result;
    try {
      result = await pending.callback(SIGNED_IN.replace('SID=v-SID', 'SID=good-pooled'));
    } finally {
      globalThis.fetch = realFetch;
      db.exec('DELETE FROM proxies');
    }
    assert.equal(result.type, 'success');
    assert.equal(result.metadata.account, nextId - 1);
    assert.equal(result.metadata.email, undefined);
    assert.deepEqual(google, []);
  });

  it('fails without keeping the account when the cookie does not sign in', async () => {
    const before = accounts.size;
    const pending = await (await oauthMethod()).authorize();
    const result = await pending.callback(SIGNED_IN);
    assert.equal(result.type, 'failed');
    assert.match(result.error, /not signed in/);
    assert.equal(accounts.size, before);
  });

  it('signs in to an account already in the backend pool, one sign-in per Google account', async () => {
    // Only these accounts in the pool.
    db.exec(`UPDATE accounts SET status = 'disabled';
      INSERT INTO accounts (id, label, cookie, status, proxy_id) VALUES (41, 'Magpie', 'SID=pool-a', 'enabled', 0),
        (42, 'Magpie', 'SID=pool-b', 'enabled', 0), (43, 'Magpie', 'SID=pool-c', 'disabled', 0);`);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url !== 'https://gemini.google.com/app') return realFetch(url, init);
      return new Response(init.headers.Cookie === 'SID=pool-a' ? '{"oPEP7c":"pool-a@gmail.com"}' : '<html></html>');
    };
    try {
      const method = (await GeminiWebPlugin({})).auth.methods[2];
      assert.equal(method.prompts[0].key, 'account');
      const question = await method.ask({});
      assert.equal(question.type, 'select');
      assert.deepEqual(question.options.map(o => [o.label, o.value]), [['pool-a@gmail.com', '41'], ['#42', '42']]);
      assert.equal(await method.ask({ account: '41' }), null);

      const pending = await method.authorize({ account: '41' });
      assert.equal(pending.method, 'auto');
      assert.deepEqual(await pending.callback(), {
        type: 'success',
        key: 'gw_test',
        metadata: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, account: 41, email: 'pool-a@gmail.com' }
      });
      await assert.rejects(method.authorize({ account: '43' }), /没有启用的账号 #43/);
    } finally {
      globalThis.fetch = realFetch;
      db.exec(`DELETE FROM accounts WHERE id IN (41, 42, 43); UPDATE accounts SET status = 'enabled';`);
    }
  });

  it('fails with the missing cookie names before calling the backend', async () => {
    const before = nextId;
    const pending = await (await oauthMethod()).authorize();
    const result = await pending.callback('NID=1');
    assert.equal(result.type, 'failed');
    assert.match(result.error, /缺少 SID/);
    assert.equal(nextId, before);
  });

  it('shows the cookie steps while a first download runs, and fails in the callback if it does', { timeout: 5000 }, async () => {
    // Magpie gives authorize one minute, less than a first download can take.
    const fresh = makeDataDir({ binary: null });
    process.env.GEMINI_WEB_DATA_DIR = fresh;
    let finish;
    const download = new Promise(resolve => { finish = resolve; });
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => download;
    try {
      const pending = await (await oauthMethod()).authorize();
      assert.equal(pending.method, 'code');
      finish(new Response('', { status: 503 }));
      const result = await pending.callback(SIGNED_IN);
      assert.equal(result.type, 'failed');
      assert.match(result.error, /HTTP 503/);
    } finally {
      globalThis.fetch = realFetch;
      process.env.GEMINI_WEB_DATA_DIR = dataDir;
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('asks for an optional proxy up front, binds the new account to it before checking, and uses it even when another proxy is in the pool', async () => {
    const method = await oauthMethod();
    assert.equal(method.prompts[0].key, 'proxy');
    const question = method.ask({});
    assert.equal(question.key, 'proxy');
    assert.equal(question.validate(''), undefined);
    assert.equal(question.validate('http://127.0.0.1:7890'), undefined);
    assert.match(question.validate('bad-proxy'), /代理地址/);
    assert.equal(method.ask({ proxy: '' }), null);
    assert.equal(method.ask({ proxy: 'http://127.0.0.1:7890' }), null);

    // Pre-populate Proxy A in the pool so Proxy B is the second entry.
    db.exec(`INSERT INTO proxies VALUES (1, 'proxy-a', 'http://127.0.0.1:18080', 1)`);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => url === 'https://gemini.google.com/app'
      ? Promise.resolve(new Response('{"oPEP7c":"proxied@gmail.com"}'))
      : realFetch(url, init);
    try {
      // authorize returns at once; the proxy pool is set up in the callback.
      const pending = await method.authorize({ proxy: 'http://127.0.0.1:7890' });
      const result = await pending.callback(SIGNED_IN.replace('SID=v-SID', 'SID=good-proxied'));
      assert.equal(result.type, 'success');

      const rows = db.prepare('SELECT id, name, url, enabled FROM proxies ORDER BY id').all();
      assert.equal(rows.length, 2);
      const proxyB = rows[1];
      assert.equal(proxyB.name, 'Magpie');
      assert.equal(proxyB.url, 'http://127.0.0.1:7890');
      assert.equal(proxyB.enabled, 1);

      const acctId = result.metadata.account;
      assert.equal(accounts.get(acctId).checkedProxyId, proxyB.id, 'check must run with the account already bound to Proxy B');
      const acctRow = db.prepare('SELECT proxy_id FROM accounts WHERE id = ?').get(acctId);
      assert.equal(acctRow.proxy_id, proxyB.id);
    } finally {
      globalThis.fetch = realFetch;
      db.exec('DELETE FROM proxies');
    }
  });
});
