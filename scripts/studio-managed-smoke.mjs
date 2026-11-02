// Isolated real-binary check: no Google accounts, no generation or online update.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const packageRoot = args.find(arg => arg.startsWith('--package-root='))?.slice('--package-root='.length) || root;
const download = args.includes('--download');
const { installStudio, ensureStudio, stopStudio, studioAdmin, studioStatus, computeFileHash, STUDIO_VERSION } = await import(pathToFileURL(path.join(packageRoot, 'lib/studio-native.mjs')));
const release = JSON.parse(fs.readFileSync(path.join(packageRoot, 'lib/studio-release.json'), 'utf8'));
const key = `${process.platform}-${process.arch}`;
const pin = release.binaries[key];
assert.ok(pin, `Unsupported platform ${key}`);
const archivePath = download ? undefined : path.join(root, 'studio-build/release', pin.asset);
const source = download ? 'GitHub release' : 'local release artifact';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-managed-smoke-'));
let local;
try {
  local = await installStudio({ dataDir, ...(archivePath ? { archivePath } : {}) });
  const bin = path.join(dataDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
  assert.equal(computeFileHash(bin), pin.binarySha256);
  // A pre-0.2.17 ledger must survive the real process's first startup.
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'runtime', 'requests.db'));
  try {
    db.exec(`CREATE TABLE bodies (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, time INTEGER NOT NULL,
      request TEXT NOT NULL, request_size INTEGER NOT NULL, response TEXT NOT NULL, response_size INTEGER NOT NULL)`);
    db.prepare('INSERT INTO bodies (id,time,request,request_size,response,response_size) VALUES (?,?,?,?,?,?)')
      .run('legacy-smoke', 1234, '旧请求', 100, 'old response', 200);
  } finally { db.close(); }
  // Both values would be reset by upstream's legacy full-.env migration.
  fs.appendFileSync(path.join(dataDir, '.env'), 'FIRST_EVENT_HEDGE=off\nREQUEST_TIMEOUT=5m\n');
  await ensureStudio({ dataDir, managementOnly: true });
  const migratedBody = await studioAdmin(local, 'GET', '/api/requests/legacy-smoke/body');
  assert.equal(migratedBody.request, '旧请求');
  assert.equal(migratedBody.response, 'old response');
  assert.equal(migratedBody.request_size, 100);
  assert.equal(migratedBody.response_size, 200);
  const config = await studioAdmin(local, 'GET', '/api/config');
  assert.equal(config.first_event_hedge, 'off');
  assert.equal(config.request_timeout, '5m0s');
  // Generation's WAA runs in the service itself, on SpiderMonkey, with no copies of the models
  assert.equal(config.waa_backend, 'spidermonkey');
  assert.equal(config.search_model_aliases, false);
  // Save upstream defaults that differ from this plugin's defaults. They must stay explicit
  // through the backend's Save and the plugin's next config sync, not get silently re-seeded.
  const choices = {
    search_model_aliases: true, routing_strategy: 'round-robin', per_account_concurrency: 2,
    first_event_hedge: 'auto', first_event_hedge_models: 'gemini-3.8-flash',
    api_key_accounts: `${local.apiKey}:smoke@example.com`
  };
  const saved = await studioAdmin(local, 'PUT', '/api/config', {
    ...config, ...choices,
    // These fields belong to the plugin and must stay locked even if submitted by a client.
    listen_addr: '127.0.0.1:1', waa_backend: 'camoufox'
  });
  assert.equal(saved.listen_addr, config.listen_addr);
  assert.equal(saved.waa_backend, 'spidermonkey');
  assert.ok(saved.environment.includes('WAA_BACKEND'));
  for (const [key, value] of Object.entries(choices)) assert.equal(saved[key], value, key);
  const pidBefore = fs.readFileSync(path.join(dataDir, 'backend.pid'), 'utf8');
  const status = await studioAdmin(local, 'GET', '/api/status');
  assert.equal(status.version, STUDIO_VERSION);
  for (const query of ['', '?refresh=1']) {
    const update = await studioAdmin(local, 'GET', `/api/update${query}`);
    assert.equal(update.mode, 'managed');
    assert.equal(update.managed_by, 'magpie-gemini-web');
    assert.equal(update.available, false);
    assert.equal(update.updating, false);
    assert.equal(update.current, STUDIO_VERSION);
  }
  let updateHTTP;
  await assert.rejects(studioAdmin(local, 'POST', '/api/update', null, {
    fetchFn: async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).endsWith('/api/update')) updateHTTP = response.status;
      return response;
    }
  }), /magpie-gemini-web/);
  assert.equal(updateHTTP, 409);
  assert.equal(computeFileHash(bin), pin.binarySha256, 'update must not replace the binary');
  assert.equal(fs.readFileSync(path.join(dataDir, 'backend.pid'), 'utf8'), pidBefore, 'update must not restart');
  const html = await (await fetch(local.origin)).text();
  const entry = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(entry, 'admin page must load');
  const js = await (await fetch(new URL(entry, local.origin))).text();
  const versionPanel = /(?:\.\/|\/assets\/)?(VersionPanel-[\w-]+\.js)/.exec(js)?.[1];
  assert.ok(versionPanel, 'built admin version panel must exist');
  const panel = await (await fetch(`${local.origin}/assets/${versionPanel}`)).text();
  // Upstream's panel keeps its install button for other builds and shows a managed build's note
  // in its place; the refusal above is what keeps the binary
  assert.match(panel, /version\.managed/);
  assert.deepEqual(await stopStudio({ dataDir }), { stopped: true });
  assert.equal((await studioStatus({ dataDir })).status, 'stopped');
  await ensureStudio({ dataDir, managementOnly: true });
  assert.deepEqual(await studioAdmin(local, 'GET', '/api/requests/legacy-smoke/body'), migratedBody);
  const restarted = await studioAdmin(local, 'GET', '/api/config');
  for (const [key, value] of Object.entries(choices)) assert.equal(restarted[key], value, `${key} after restart`);
  assert.equal(restarted.request_timeout, '5m0s');
  assert.equal(restarted.waa_backend, 'spidermonkey');
  assert.deepEqual(await stopStudio({ dataDir }), { stopped: true });
  console.log(`PASS ${key}: ${STUDIO_VERSION} (${source}), legacy body migration/restart, saved defaults/hedge/models/key bindings across restart, locked plugin settings, SpiderMonkey WAA, managed status, update HTTP 409, unchanged executable/PID, managed UI, clean stop`);
} finally {
  let stopped = !local;
  if (local) stopped = (await stopStudio({ dataDir }).catch(() => ({ stopped: false }))).stopped;
  if (stopped) {
    const pkg = path.join(dataDir, 'package');
    if (fs.existsSync(pkg)) fs.chmodSync(pkg, 0o755);
    fs.rmSync(dataDir, { recursive: true, force: true });
  } else {
    console.error(`Could not confirm backend exit; preserved ${dataDir}`);
    process.exitCode = 1;
  }
}
