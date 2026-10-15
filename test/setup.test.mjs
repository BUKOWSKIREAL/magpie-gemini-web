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
import { ensureBackend, localBackend } from '../lib/native.mjs';
import { parseCookieInput, importCookie, REQUIRED_COOKIES } from '../lib/setup.mjs';

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
      calls.push({ path: new URL(url).pathname, method: init.method, auth: init.headers.Authorization, body: init.body });
      if (init.method === 'POST' && url.endsWith('/cookies')) return Response.json({ id: 7 });
      if (url.endsWith('/check')) return check();
      return Response.json({ ok: true });
    };
  }

  it('adds the account and checks it', async () => {
    const calls = [];
    const r = await importCookie(setup, SIGNED_IN, { fetchFn: adminFetch(() => Response.json({ ok: true, detail: 'fine' }), calls) });
    assert.deepEqual(r, { id: 7, detail: 'fine' });
    assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['POST /admin/api/cookies', 'POST /admin/api/cookies/7/check']);
    assert.equal(calls[0].auth, 'Bearer admin_test');
    assert.equal(JSON.parse(calls[0].body).cookie, SIGNED_IN);
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

  it('replaces an untrusted binary from the pinned release and fails closed on a bad download', async () => {
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
    assert.ok(urls.some(u => u.endsWith('/v4.22.0/gemini-web2api-go_v4.22.0_darwin_arm64')));
    assert.equal(fs.existsSync(path.join(dataDir, 'bin', 'gemini-web2api-go')), false);
    assert.equal(spawned.length, 0);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('localBackend is null until a backend is installed', () => {
    const dataDir = makeDataDir({ binary: null });
    assert.equal(localBackend({ dataDir, platform: 'darwin' }), null);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('27. One-click sign-in through the plugin', () => {
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
        if (req.url === '/v1/models') {
          return req.headers.authorization === 'Bearer gw_test' ? send(200, { data: [] }) : send(401, { error: 'bad key' });
        }
        if (req.headers.authorization !== 'Bearer admin_test') return send(401, { error: 'bad admin token' });
        if (req.method === 'POST' && req.url === '/admin/api/cookies') {
          const id = nextId++;
          accounts.set(id, JSON.parse(body).cookie);
          db.prepare(`INSERT INTO accounts (id, label, cookie, status, proxy_id) VALUES (?, 'Magpie', ?, 'enabled', 0)`)
            .run(id, JSON.parse(body).cookie);
          return send(200, { id });
        }
        const m = req.url.match(/^\/admin\/api\/cookies\/(\d+)(\/check)?$/);
        if (m && req.method === 'POST' && m[2]) {
          const cookie = accounts.get(Number(m[1])) || '';
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
    assert.deepEqual(plugin.auth.methods.map(m => m.type), ['oauth', 'api', 'oauth']);
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
});
