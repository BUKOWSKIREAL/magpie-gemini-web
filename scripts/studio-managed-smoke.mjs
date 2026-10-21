// Isolated real-binary check: no Google accounts, no generation or online update.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installStudio, ensureStudio, stopStudio, studioAdmin, studioStatus, computeFileHash, STUDIO_VERSION } from '../lib/studio-native.mjs';
import release from '../lib/studio-release.json' with { type: 'json' };

const root = fileURLToPath(new URL('..', import.meta.url));
const key = `${process.platform}-${process.arch}`;
const pin = release.binaries[key];
assert.ok(pin, `Unsupported platform ${key}`);
const archivePath = path.join(root, 'studio-build/release', pin.asset);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-managed-smoke-'));
let local;
try {
  local = await installStudio({ dataDir, archivePath });
  const bin = path.join(dataDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
  assert.equal(computeFileHash(bin), pin.binarySha256);
  await ensureStudio({ dataDir, managementOnly: true });
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
  console.log(`PASS ${key}: ${STUDIO_VERSION}, managed status, update HTTP 409, unchanged executable/PID, managed UI, clean stop`);
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
