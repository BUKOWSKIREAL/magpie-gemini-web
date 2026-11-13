import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ensureStudioConfig, binaryPath, setStudioAutoUpdate } from '../lib/studio-native.mjs';
import { acquireStudioUse, holdStudioResponse, newerStudioRelease, updateStudioAutomatically, watchStudioUpdates } from '../lib/studio-updates.mjs';
import { officialArchive } from './helpers/studio-official.mjs';

let root, archive;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-automatic-tests-'));
  archive = officialArchive(path.join(root, 'archive'));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'));
  ensureStudioConfig(dataDir);
  const bin = binaryPath(dataDir);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, 'current executable', { mode: 0o755 });
  const f = {
    dataDir, bin, requests: [], tasks: [], updating: false,
    status: { version: 'v0.3.6', running: true, ready: false, state: 'RUNNING', active_requests: 0, accounts: { total: 0, busy: 0 }, camoufox: { ready: false, preparing: false } }
  };
  f.fetchFn = async (url, init) => {
    url = String(url);
    f.requests.push(url);
    if (url.includes('github.com')) {
      if (url.includes('/download/')) {
        await f.onDownload?.();
        if (f.corrupt) return new Response('corrupt download');
      }
      if (f.offline) throw new Error('offline');
      return archive.fetchFn(url, init);
    }
    const pathname = new URL(url).pathname;
    if (pathname === '/api/auth/login') return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=fixture; Path=/' } });
    if (pathname === '/api/status') return Response.json(f.status);
    if (pathname === '/api/accounts/tasks') return Response.json({ tasks: f.tasks });
    if (pathname === '/api/update') return Response.json({ updating: f.updating, current: f.status.version });
    assert.fail('A protected/deferred update must not stop or start the service: ' + pathname);
  };
  f.run = options => updateStudioAutomatically({ dataDir, fetchFn: f.fetchFn, ...options });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return f;
}

const releaseLookups = f => f.requests.filter(url => url.includes('api.github.com')).length;

describe('Automatic official backend updates', () => {
  it('advances stable releases without downgrading newer, prerelease or unknown installations', () => {
    for (const [latest, installed, expected] of [
      ['v0.3.7', 'v0.3.6', true], ['v0.3.7', '0.3.7', false],
      ['v0.3.7', 'v0.4.0', false], ['v0.3.7', 'v0.4.0-beta.1', false],
      ['v0.3.7', 'v0.3.7-magpie.1', true], ['v0.3.7', 'v0.3.7-beta.1', true],
      ['v0.3.7-beta.1', 'v0.3.6', false], ['v0.3.7', 'development', false],
      ['v2.0.0', 'v1.99.99+local', true], ['v0.3.7', 'v01.3.6', false]
    ]) assert.equal(newerStudioRelease(latest, installed), expected, installed + ' -> ' + latest);
  });

  for (const [name, change] of [
    ['active generation', f => { f.status.active_requests = 1; }],
    ['browser preparation', f => { f.status.camoufox.preparing = true; }],
    ['legacy browser downloads', f => { f.status.camoufox = { ready: false, download: { received: 20, total: 20 } }; }],
    ['Google sign-in', f => { f.tasks = [{ state: 'running' }]; }],
    ['a concurrent official update', f => { f.updating = true; }],
    ['unknown request counters', f => { delete f.status.active_requests; }],
    ['unknown task states', f => { f.tasks = [{ state: 'new-upstream-state' }]; }]
  ]) it('defers for ' + name, async t => {
    const f = fixture(t);
    change(f);
    assert.equal((await f.run()).state, 'busy');
    assert.equal(releaseLookups(f), 0);
    assert.equal(fs.readFileSync(f.bin, 'utf8'), 'current executable');
  });

  it('keeps explicit manual policy and custom programs out of automatic installation', async t => {
    const f = fixture(t);
    await setStudioAutoUpdate(false, { dataDir: f.dataDir });
    assert.equal((await f.run({ force: true })).state, 'disabled');
    await setStudioAutoUpdate(true, { dataDir: f.dataDir });
    const configPath = path.join(f.dataDir, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, backend: { mode: 'user', binaryPath: path.join(root, 'owned-program') } }));
    assert.equal((await f.run({ force: true })).state, 'disabled');
    assert.equal(f.requests.length, 0);
  });

  it('observes enabling automatic updates in a host started with manual policy', async t => {
    const f = fixture(t);
    f.status.version = 'v0.3.7';
    await setStudioAutoUpdate(false, { dataDir: f.dataDir });
    watchStudioUpdates({ dataDir: f.dataDir, fetchFn: f.fetchFn });
    assert.equal(f.requests.length, 0);
    await setStudioAutoUpdate(true, { dataDir: f.dataDir });
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(path.join(f.dataDir, 'automatic-update.json')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(releaseLookups(f), 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'automatic-update.json'))).version, 'v0.3.7');
  });

  it('accepts the older ready/download schema after all account tasks finish', async t => {
    const f = fixture(t);
    f.status.version = 'v0.3.7';
    f.status.camoufox = { ready: false };
    f.tasks = [{ state: 'done' }];
    assert.equal((await f.run()).state, 'current');
    assert.equal(releaseLookups(f), 1);
  });

  it('caches a successful latest-version check instead of requesting every minute', async t => {
    const f = fixture(t);
    f.status.version = 'v0.3.7';
    assert.equal((await f.run()).state, 'current');
    assert.equal((await f.run()).state, 'current');
    assert.equal(releaseLookups(f), 1);
    assert.ok(!f.requests.some(url => url.includes('/download/')));
  });

  it('leaves a manually installed newer executable unchanged', async t => {
    const f = fixture(t);
    f.status.version = 'v1.0.0';
    assert.equal((await f.run()).state, 'current');
    assert.equal(fs.readFileSync(f.bin, 'utf8'), 'current executable');
    assert.ok(!f.requests.some(url => url.includes('/download/')));
  });

  for (const cause of ['offline', 'corrupt']) it('keeps the old service and backs off after ' + cause, async t => {
    const f = fixture(t);
    f[cause] = true;
    assert.equal((await f.run()).state, 'failed');
    const requests = f.requests.length;
    assert.equal((await f.run()).state, 'waiting');
    assert.equal(f.requests.length, requests);
    assert.equal(fs.readFileSync(f.bin, 'utf8'), 'current executable');
    assert.equal(fs.readdirSync(f.dataDir).some(n => n.startsWith('.automatic-update.') && n.endsWith('.lock')), false);
  });

  it('rechecks activity after downloading and retains the verified archive for retry', async t => {
    const f = fixture(t);
    let release;
    f.onDownload = async () => { release = await acquireStudioUse({ dataDir: f.dataDir }); };
    try {
      assert.equal((await f.run()).state, 'busy');
      assert.equal(fs.readFileSync(f.bin, 'utf8'), 'current executable');
      assert.ok(fs.existsSync(path.join(f.dataDir, archive.name)));
      assert.equal(fs.readdirSync(f.dataDir).some(n => n.startsWith('.automatic-update.') && n.endsWith('.lock')), false);
    } finally { release?.(); }
  });

  it('holds streamed responses until their bodies finish or are cancelled', async t => {
    const f = fixture(t);
    f.status.version = 'v0.3.7';
    let source, cancelled = false;
    const release = await acquireStudioUse({ dataDir: f.dataDir });
    const response = holdStudioResponse(new Response(new ReadableStream({
      start(controller) { source = controller; controller.enqueue(new TextEncoder().encode('first chunk')); },
      cancel() { cancelled = true; }
    })), release);
    const reader = response.body.getReader();
    await reader.read();
    assert.equal((await f.run()).state, 'busy', 'response headers do not release a stream');
    await reader.cancel();
    assert.equal(cancelled, true);
    assert.equal((await f.run()).state, 'current');
    const completed = holdStudioResponse(new Response('finished'), await acquireStudioUse({ dataDir: f.dataDir }));
    assert.equal(await completed.text(), 'finished');
    assert.equal(fs.readdirSync(f.dataDir).filter(n => n.startsWith('.studio-use.')).length, 0);
  });

  it('releases a stream lease when its caller aborts before reading the body', async t => {
    const f = fixture(t), controller = new AbortController();
    const response = holdStudioResponse(new Response(new ReadableStream()), await acquireStudioUse({ dataDir: f.dataDir }), controller.signal);
    controller.abort();
    await response.body.cancel();
    assert.equal(fs.readdirSync(f.dataDir).filter(n => n.startsWith('.studio-use.')).length, 0);
  });

  it('waits for maintenance and removes a record whose PID was reused', async t => {
    const f = fixture(t);
    const release = await acquireStudioUse({ dataDir: f.dataDir });
    const name = fs.readdirSync(f.dataDir).find(n => n.startsWith('.studio-use.'));
    const owner = JSON.parse(fs.readFileSync(path.join(f.dataDir, name)));
    release();
    const gate = path.join(f.dataDir, '.automatic-update.lock');
    fs.writeFileSync(gate, JSON.stringify(owner));
    await assert.rejects(acquireStudioUse({ dataDir: f.dataDir, timeoutMs: 30 }), /finishing an automatic update/);
    fs.writeFileSync(gate, JSON.stringify({ ...owner, started: 'not this process birth' }));
    (await acquireStudioUse({ dataDir: f.dataDir }))();
    assert.equal(fs.existsSync(gate), false);
  });

  it('keeps a successor gate created while another host reclaims an exited owner', async t => {
    const f = fixture(t);
    const stale = path.join(f.dataDir, '.automatic-update.exited.lock');
    const successor = path.join(f.dataDir, '.automatic-update.successor.lock');
    fs.writeFileSync(stale, JSON.stringify({ pid: process.pid, started: 'previous process birth' }));
    const read = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(file, ...args) {
      const contents = read.call(this, file, ...args);
      if (file === stale && ++reads === 2) {
        fs.rmSync(stale);
        fs.writeFileSync(successor, JSON.stringify({ pid: process.pid }));
      }
      return contents;
    };
    try {
      await assert.rejects(acquireStudioUse({ dataDir: f.dataDir, timeoutMs: 30 }), /finishing an automatic update/);
      assert.ok(fs.existsSync(successor));
      assert.equal(fs.readdirSync(f.dataDir).some(n => n.startsWith('.studio-use.')), false);
    } finally { fs.readFileSync = read; }
  });

  it('respects another plugin host and removes its abandoned leases after exit', { timeout: 30000 }, async t => {
    const f = fixture(t);
    f.status.version = 'v0.3.7';
    const script = path.join(f.dataDir, 'holder.mjs');
    fs.writeFileSync(script, `import { acquireStudioUse } from ${JSON.stringify(new URL('../lib/studio-updates.mjs', import.meta.url).href)};\nawait acquireStudioUse({ dataDir: process.argv[2] });\nconsole.log('held');\nsetInterval(() => {}, 1000);\n`);
    const child = spawn(process.execPath, [script, f.dataDir], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const exit = once(child, 'exit');
    try {
      const [ready] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) });
      assert.match(String(ready), /held/);
      assert.equal((await f.run()).state, 'busy');
    } finally { child.kill(); await exit; }
    assert.equal((await f.run()).state, 'current');
    assert.equal(fs.readdirSync(f.dataDir).filter(n => n.startsWith('.studio-use.')).length, 0);
  });
});
