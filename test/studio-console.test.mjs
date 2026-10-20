import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { initializeControl, createConsole, openURL, handleConsoleOpen, watchApplication, ensureConsole } from '../lib/studio-console.mjs';
import { controlState, writeControlState } from '../lib/studio-control-state.mjs';
import { serviceEnv, readStudioEnv, saveStudioProxy, ensureStudio, studioProxy, ensureStudioConfig, PINNED_ARCHIVES, STUDIO_VERSION, computeFileHash } from '../lib/studio-native.mjs';
import { AIStudioPlugin } from '../lib/studio.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-console-test-'));
const cleanup = dataDir => { assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir())); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };

async function fixture(run, overrides = {}) {
  const dataDir = temp();
  initializeControl(dataDir, 'http://127.0.0.1:7890');
  let running = true;
  let active = 'http://127.0.0.1:9393';
  let stopFails = false;
  let startFails = false;
  const calls = [];
  const services = {
    local: () => ({ origin: 'http://127.0.0.1:2048', dataDir, adminPassword: 'never-return-this', apiKey: 'never-return-key' }),
    status: async () => ({ status: running ? 'running' : 'stopped', running, ready: running, accounts: { total: 2, ready: running ? 1 : 0, busy: 0 } }),
    proxy: async () => ({ active, source: active === readStudioEnv(dataDir).PROXY ? 'saved' : 'startup', pending: active === readStudioEnv(dataDir).PROXY ? null : 'restart' }),
    stop: async () => { calls.push('stop'); await delay(20); if (stopFails) return { stopped: false, reported: 'fixture refuses stop' }; running = false; return { stopped: true }; },
    start: async opts => { assert.equal(opts.allowPaused, true); assert.equal(controlState(dataDir).paused, true); calls.push('start'); await delay(20); if (startFails) throw new Error('fixture start failed'); running = true; active = readStudioEnv(dataDir).PROXY; },
    open: async url => { calls.push(['open', url]); },
    ...overrides
  };
  const consoleServer = createConsole({ dataDir, services });
  const origin = await consoleServer.listen();
  const headers = { Authorization: `Bearer ${consoleServer.token}` };
  const get = async () => (await fetch(`${origin}/api/state`, { headers })).json();
  const post = (action, body = {}) => fetch(`${origin}/api/${action}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const wait = async () => {
    for (let i = 0; i < 100; i++) { const state = await get(); if (state.operation?.state !== 'running') return state; await delay(10); }
    throw new Error('Operation did not finish');
  };
  try { await run({ dataDir, origin, headers, get, post, wait, calls, consoleServer, failStop: () => { stopFails = true; }, failStart: () => { startFails = true; } }); }
  finally { consoleServer.server.closeAllConnections(); await new Promise(resolve => consoleServer.server.close(resolve)); cleanup(dataDir); }
}

describe('local control console', () => {
  it('starts only one real detached console and shuts that console down without touching the backend', async () => {
    const dataDir = temp();
    try {
      initializeControl(dataDir, '');
      const [first, second] = await Promise.all([ensureConsole(dataDir), ensureConsole(dataDir)]);
      assert.equal(first.pid, second.pid);
      assert.notEqual(first.pid, process.pid);
      const headers = { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' };
      const result = await fetch(`${first.origin}/api/close`, { method: 'POST', headers, body: '{"confirm":true}' });
      assert.equal(result.status, 200);
      assert.equal(controlState(dataDir).paused, false);
      for (let i = 0; i < 100; i++) {
        try { process.kill(first.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
        await delay(20);
      }
    } catch (error) { console.error('Detached console test failure:', error); throw error; }
    finally { await delay(100); cleanup(dataDir); }
  });

  it('waits for an active operation before stopping on app exit, then leaves automatic starts paused', async () => {
    const dataDir = temp();
    initializeControl(dataDir, '');
    fs.writeFileSync(path.join(dataDir, 'console-app.json'), '{"pid":12345}');
    let alive = true, busy = false, stopped = 0, closed = 0;
    const errors = [];
    const unwatch = watchApplication({ dataDir, interval: 10, isAlive: () => alive, busy: () => busy,
      stop: async options => { assert.equal(options.waitForStart, true); assert.equal(controlState(dataDir).paused, true); stopped++; return { stopped: true }; },
      close: () => { closed++; }, report: error => errors.push(error) });
    try {
      await delay(30); assert.equal(stopped, 0);
      alive = false; busy = true; await delay(30); assert.equal(stopped, 0);
      busy = false; await delay(50); assert.equal(stopped, 1); assert.equal(closed, 1);
      assert.equal(controlState(dataDir).appStopped, true); assert.deepEqual(errors, []);
      await assert.rejects(() => ensureStudio({ dataDir }), /暂停/);
    } finally { unwatch(); cleanup(dataDir); }
  });

  it('keeps the console available and reports failure when exit cleanup cannot verify shutdown', async () => {
    const dataDir = temp();
    initializeControl(dataDir, '');
    fs.writeFileSync(path.join(dataDir, 'console-app.json'), '{"pid":12345}');
    const errors = [];
    const unwatch = watchApplication({ dataDir, interval: 10, isAlive: () => false, busy: () => false,
      stop: async () => ({ stopped: false, reported: 'fixture unverified process' }), close: () => assert.fail('must retain console'), report: error => errors.push(error) });
    try { await delay(50); assert.equal(errors.length, 1); assert.match(errors[0], /unverified/); }
    finally { unwatch(); cleanup(dataDir); }
  });

  it('rechecks pause immediately before spawning, even if a startup check was already in flight', async () => {
    const dataDir = temp();
    try {
      initializeControl(dataDir, 'http://localhost:7890');
      ensureStudioConfig(dataDir);
      const bin = path.join(dataDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
      fs.mkdirSync(path.dirname(bin)); fs.writeFileSync(bin, 'fixture never executed');
      const pin = PINNED_ARCHIVES[`${process.platform}-${process.arch}`];
      fs.writeFileSync(path.join(dataDir, 'install-manifest.json'), JSON.stringify({ version: STUDIO_VERSION.slice(1), platform: process.platform, arch: process.arch, archiveSha256: pin.sha256, binarySha256: computeFileHash(bin) }));
      let statusCalls = 0;
      const fetchFn = async url => {
        if (url.includes('/api/auth/login')) return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=t' } });
        if (url.includes('/api/status') && ++statusCalls === 3) writeControlState(dataDir, { version: 1, paused: true });
        throw Object.assign(new Error('fixture refused'), { code: 'ECONNREFUSED' });
      };
      await assert.rejects(() => ensureStudio({ dataDir, fetchFn, spawnFn: () => assert.fail('must not spawn') }), /暂停/);
      assert.equal(statusCalls, 3);
      writeControlState(dataDir, { version: 1, paused: false });
      let spawned = false;
      await ensureStudio({ dataDir, proxy: 'http://localhost:9393',
        fetchFn: async url => {
          if (url.includes('/api/auth/login')) return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=t' } });
          if (!spawned) throw Object.assign(new Error('fixture refused'), { code: 'ECONNREFUSED' });
          return Response.json({ version: STUDIO_VERSION, running: true, ready: true, accounts: { total: 0 } });
        },
        spawnFn: (_file, _args, options) => {
          assert.equal('PROXY' in options.env, false);
          for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) assert.equal(options.env[key], '');
          assert.equal(readStudioEnv(dataDir).PROXY, 'http://localhost:7890');
          spawned = true;
          return { on() {}, unref() {} };
        }
      });
      assert.equal(spawned, true);
    } finally { cleanup(dataDir); }
  });
  it('migrates once, backs up .env, and never rewrites a later user edit from stale options', () => {
    const dataDir = temp();
    try {
      fs.writeFileSync(path.join(dataDir, '.env'), 'PROXY=socks5://127.0.0.1:7890\nTEMPORARY_CHAT=false\n');
      initializeControl(dataDir, 'http://127.0.0.1:7890');
      assert.match(fs.readFileSync(path.join(dataDir, '.env.before-console'), 'utf8'), /socks5:/);
      saveStudioProxy(dataDir, 'socks5h://127.0.0.1:7890');
      initializeControl(dataDir, 'http://127.0.0.1:9393');
      assert.equal(readStudioEnv(dataDir).PROXY, 'socks5h://127.0.0.1:7890');
      assert.equal(readStudioEnv(dataDir).TEMPORARY_CHAT, 'false');
      assert.equal('PROXY' in serviceEnv(dataDir, { port: 2048, apiKey: 'test', adminUsername: 'test', adminPassword: 'test' }, { proxy: 'http://127.0.0.1:9393' }), false);
    } finally { cleanup(dataDir); }
  });

  it('reads real state without triggering start or leaking admin credentials', async () => fixture(async ({ get, calls }) => {
    const state = await get();
    assert.equal(state.backend.status, 'running');
    assert.equal(state.proxy.active, 'http://127.0.0.1:9393');
    assert.equal(state.proxy.pending, 'restart');
    assert.deepEqual(calls, []);
    assert.doesNotMatch(JSON.stringify(state), /never-return/);
  }));

  it('requires token, exact Host, valid Origin and JSON before any side effect', async () => fixture(async ({ origin, headers, calls }) => {
    assert.equal((await fetch(`${origin}/api/state`)).status, 401);
    assert.equal((await fetch(`${origin}/api/state`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/state`, { headers: { ...headers, Origin: 'null' } })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      http.get(`${origin}/api/state`, { headers: { ...headers, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(`${origin}/api/state`, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/start`, { method: 'POST', headers, body: '{}' })).status, 415);
    const response = await fetch(`${origin}/api/state`, { headers });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.deepEqual(calls, []);
  }));

  it('rejects arbitrary commands, unconfirmed interruption, malformed or oversized bodies', async () => fixture(async ({ origin, headers, post, calls }) => {
    assert.equal((await post('exec', { command: 'anything' })).status, 404);
    assert.equal((await post('stop')).status, 409);
    assert.equal((await post('save', { proxy: 'file:///bad' })).status, 400);
    assert.equal((await post('save', { proxy: 'socks5:' })).status, 400);
    assert.equal((await post('save', { proxy: 'http://localhost:7890\nINJECT=true' })).status, 400);
    assert.equal((await post('save', { proxy: 7890 })).status, 400);
    assert.equal((await post('save', { ignored: 'a'.repeat(8500) })).status, 413);
    assert.equal((await fetch(`${origin}/api/start`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '[]' })).status, 400);
    assert.deepEqual(calls, []);
  }));

  it('save changes only .env; apply stops, saves and starts in that order', async () => fixture(async ({ post, wait, dataDir, calls }) => {
    assert.equal((await post('save', { proxy: 'socks5://127.0.0.1:7890' })).status, 202);
    let state = await wait();
    assert.equal(state.proxy.pending, 'restart');
    assert.deepEqual(calls, []);
    assert.equal((await post('apply', { proxy: 'http://127.0.0.1:7891', confirm: true })).status, 202);
    state = await wait();
    assert.deepEqual(calls, ['stop', 'start']);
    assert.equal(readStudioEnv(dataDir).PROXY, 'http://127.0.0.1:7891');
    assert.equal(state.proxy.pending, null);
    assert.equal(state.paused, false);
    assert.equal(state.operation.state, 'done');
  }));

  it('rejects duplicate controls instead of queuing surprise restarts', async () => fixture(async ({ post, wait, calls }) => {
    assert.equal((await post('restart', { confirm: true })).status, 202);
    assert.equal((await post('restart', { confirm: true })).status, 409);
    await wait();
    assert.deepEqual(calls, ['stop', 'start']);
  }));

  it('retains saved settings and never starts when old process cannot be stopped', async () => fixture(async ({ post, wait, failStop, calls, dataDir }) => {
    failStop();
    await post('apply', { proxy: 'http://localhost:7777', confirm: true });
    const state = await wait();
    assert.equal(state.operation.state, 'failed');
    assert.match(state.operation.message, /fixture refuses stop/);
    assert.equal(readStudioEnv(dataDir).PROXY, 'http://127.0.0.1:7890');
    assert.equal(state.paused, true);
    assert.deepEqual(calls, ['stop']);
  }));

  it('failed start leaves service paused with the saved new proxy and an honest error', async () => fixture(async ({ post, wait, failStart, calls, dataDir }) => {
    failStart();
    await post('apply', { proxy: 'http://localhost:7777', confirm: true });
    const state = await wait();
    assert.equal(state.operation.state, 'failed');
    assert.equal(state.backend.status, 'stopped');
    assert.equal(state.paused, true);
    assert.equal(readStudioEnv(dataDir).PROXY, 'http://localhost:7777');
    assert.deepEqual(calls, ['stop', 'start']);
  }));

  it('stop persists pause; only explicit start restores automatic startup', async () => fixture(async ({ post, wait, dataDir, calls }) => {
    await post('stop', { confirm: true });
    let state = await wait();
    assert.equal(state.paused, true);
    assert.equal(state.backend.status, 'stopped');
    await assert.rejects(() => ensureStudio({ dataDir }), /暂停/);
    assert.deepEqual(calls, ['stop']);
    await post('start'); state = await wait();
    assert.equal(state.paused, false);
    assert.equal(state.backend.status, 'running');
  }));

  it('opens only the derived admin URL, not an address provided by the client', async () => fixture(async ({ post, wait, calls }) => {
    await post('admin', { url: 'https://evil.example' }); await wait();
    assert.deepEqual(calls, [['open', 'http://127.0.0.1:2048']]);
  }));

  it('does not send saved proxy passwords back to the browser', async () => fixture(async ({ dataDir, get }) => {
    const password = 'test-password-123';
    saveStudioProxy(dataDir, `http://user:${password}@localhost:7890`);
    const state = await get();
    assert.equal(state.savedProxy, null);
    assert.equal(state.containsPassword, true);
    assert.equal(JSON.stringify(state).includes(password), false);
  }));

  it('uses safe executable argv for opening loopback URLs', async () => {
    assert.throws(() => openURL('https://evil.example'));
    assert.throws(() => openURL('http://user:pass@127.0.0.1:2048'));
    await openURL('http://127.0.0.1:2048', 'win32', (file, args, options, callback) => {
      assert.equal(file, 'rundll32.exe'); assert.deepEqual(args, ['url.dll,FileProtocolHandler', 'http://127.0.0.1:2048/']);
      assert.equal(options.shell, undefined); assert.equal(options.windowsHide, true); callback();
    });
    await handleConsoleOpen({ id: 'not-an-id', at: Date.now() }, 'does-not-exist');
  });

  it('managed proxy reporting compares .env to the actual old runtime, not stale option priority', async () => {
    const dataDir = temp();
    try {
      initializeControl(dataDir, 'http://localhost:7890');
      const fetchFn = async url => url.includes('/api/auth/login') ? new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=test; Path=/' } }) : Response.json({ proxy: '', active_proxy: 'http://localhost:9393' });
      const state = await studioProxy({ dataDir, origin: 'http://localhost:2048', adminUsername: 'test', adminPassword: 'test' }, { fetchFn, proxy: 'http://localhost:5555', standalone: true });
      assert.equal(state.pending, 'restart');
      assert.equal(state.wanted, 'http://localhost:7890');
    } finally { cleanup(dataDir); }
  });

  it('paused plugin reload, models, usage, loader and managed fetch never start or send requests', async () => {
    const dataDir = temp();
    const original = process.env.AI_STUDIO_DATA_DIR;
    try {
      process.env.AI_STUDIO_DATA_DIR = dataDir;
      initializeControl(dataDir, ''); writeControlState(dataDir, { version: 1, paused: true });
      const plugin = await AIStudioPlugin({}, { studio: { localConsole: true } });
      const auth = { type: 'api', key: 'test', metadata: { managed: true, baseURL: 'http://127.0.0.1:1/v1' } };
      const models = { test: { name: 'test' } };
      assert.equal(await plugin.provider.models({ models }, { auth }), models);
      assert.match((await plugin.auth.usage(async () => auth)).error, /暂停/);
      const loader = await plugin.auth.loader(async () => auth);
      const response = await loader.fetch('http://127.0.0.1:1/v1/chat/completions', { method: 'POST', body: '{}' });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('X-Magpie-Sign-In'), 'kept');
      assert.match(await response.text(), /暂停/);
      fs.writeFileSync(path.join(dataDir, 'console-state.json'), 'broken');
      await assert.rejects(() => ensureStudio({ dataDir }), /损坏/);
    } finally {
      if (original === undefined) delete process.env.AI_STUDIO_DATA_DIR; else process.env.AI_STUDIO_DATA_DIR = original;
      cleanup(dataDir);
    }
  });
});
