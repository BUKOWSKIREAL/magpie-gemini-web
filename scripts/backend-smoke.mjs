#!/usr/bin/env node
// Exercise installation and real process startup using an isolated, credential-free data dir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const packageRoot = args.find(arg => arg.startsWith('--package-root='))?.slice('--package-root='.length) || root;
const download = args.includes('--download');
const { ensureBackend, installBackend, computeFileHash, pinnedBinary } = await import(pathToFileURL(path.join(packageRoot, 'lib/native.mjs')));
const { importCookie, REQUIRED_COOKIES } = await import(pathToFileURL(path.join(packageRoot, 'lib/setup.mjs')));
const release = JSON.parse(fs.readFileSync(path.join(packageRoot, 'lib/backend-release.json'), 'utf8'));
const pin = pinnedBinary();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-release-smoke-'));
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
// Hold proxy connections open without replying so smoke verifies that a blackholed
// tokenizer download times out quickly and falls back to chars/4 instead of hanging startup.
const heldSockets = new Set();
const offlineProxy = net.createServer(socket => {
  heldSockets.add(socket);
  socket.on('close', () => heldSockets.delete(socket));
  socket.on('error', () => {});
});
await new Promise(resolve => offlineProxy.listen(0, '127.0.0.1', resolve));
const proxy = `http://127.0.0.1:${offlineProxy.address().port}`;
let child, exited, spawnCount = 0, log = '';

try {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port,
    log_requests: false, gemini_bl_auto: false, multi_turn: false, temporary_chat: true }), { mode: 0o600 });
  const localAsset = path.join(root, 'backend-build/release', release.binaries[`${process.platform}-${process.arch}`].asset);
  const fetchFn = async (url, init) => {
    if (!download && url === pin.url) return new Response(fs.readFileSync(localAsset));
    return fetch(url, init);
  };
  const setup = await ensureBackend({ dataDir: dir, fetchFn,
    spawnFn: (file, argv, options) => {
      spawnCount++;
      const env = { ...options.env, TIKTOKEN_CACHE_DIR: path.join(dir, 'tokenizer'),
        HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
      delete env.SQL_DSN;
      child = spawn(file, argv, { ...options, env, cwd: dir, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', bytes => { log += bytes; });
      child.stderr.on('data', bytes => { log += bytes; });
      exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
      return child;
    }
  });
  const installed = path.join(dir, 'bin', process.platform === 'win32' ? 'gemini-web2api-go.exe' : 'gemini-web2api-go');
  assert.equal(computeFileHash(installed), pin.sha256);
  const health = await (await fetch(`${setup.origin}/`)).json();
  assert.equal(health.version, release.version);
  assert.equal(health.capabilities?.account_proxy_binding, true);
  assert.equal((await fetch(`${setup.baseURL}/models`)).status, 401);
  const modelsResponse = await fetch(`${setup.baseURL}/models`, { headers: { Authorization: `Bearer ${setup.apiKey}` } });
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert.ok(models.data.length > 0);
  assert.ok(models.data.every(model => model.id.startsWith('gemini-')));
  const secrets = fs.readFileSync(path.join(dir, 'secrets.json'));
  await installBackend({ dataDir: dir, fetchFn: async () => { throw new Error('Verified binary must be reused'); } });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'secrets.json')), secrets);
  await ensureBackend({ dataDir: dir, fetchFn, spawnFn: () => { throw new Error('Running backend must be reused'); } });
  assert.equal(spawnCount, 1);

  // Verify with two local proxies that specifying Proxy B binds the account to Proxy B before
  // checking the cookie, so the very first check hits Proxy B and never Proxy A.
  let proxyAHits = 0, proxyBHits = 0;
  const proxyServerA = net.createServer(socket => { proxyAHits++; socket.destroy(); });
  const proxyServerB = net.createServer(socket => { proxyBHits++; socket.destroy(); });
  await new Promise(resolve => proxyServerA.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxyServerB.listen(0, '127.0.0.1', resolve));
  try {
    const proxyA = `http://127.0.0.1:${proxyServerA.address().port}`;
    const proxyB = `http://127.0.0.1:${proxyServerB.address().port}`;
    const addProxyRes = await fetch(`${setup.origin}/admin/api/proxies`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${setup.adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'proxy-a', url: proxyA, weight: 1 })
    });
    assert.equal(addProxyRes.status, 200);
    const cookie = REQUIRED_COOKIES.map(n => `${n}=v-${n}`).join('; ');
    await assert.rejects(importCookie(setup, cookie, { proxy: proxyB }));
    assert.equal(proxyAHits, 0, 'first cookie check must not go through existing Proxy A');
    assert.equal(proxyBHits, 1, 'first cookie check must go through chosen Proxy B');
  } finally {
    await new Promise(resolve => proxyServerA.close(resolve));
    await new Promise(resolve => proxyServerB.close(resolve));
  }
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, version: health.version,
    sha256: pin.sha256, source: download ? 'GitHub release' : 'local release artifact',
    install: 'passed', startup: 'passed', auth: 'passed', proxyBind: 'passed', models: models.data.length, reuse: 'passed' }));
} catch (error) {
  console.error(log);
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([exited, pause(5000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  for (const socket of heldSockets) socket.destroy();
  await new Promise(resolve => offlineProxy.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
