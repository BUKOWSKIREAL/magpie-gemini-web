import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureStudio, ensureStudioConfig, installStudio, localStudio, binaryPath,
  readStudioEnv, computeFileHash, setupStep
} from '../lib/studio-native.mjs';
import { officialStudioAsset, resolveStudioRelease } from '../lib/studio-upstream.mjs';
import { officialArchive } from './helpers/studio-official.mjs';

const refused = () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); };
function running(url) {
  if (url.includes('/api/auth/login')) return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=fixture; Path=/' } });
  if (url.includes('/api/status')) return Response.json({ version: 'v99.1.0', running: true, ready: true, state: 'RUNNING', accounts: { total: 1, ready: 1 } });
  return Response.json({ object: 'list', data: [] });
}
function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-official-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir: path.join(root, 'data'), ...officialArchive(path.join(root, 'release'), options) };
}
function starter(f) {
  let started = false;
  const launches = [];
  return {
    launches,
    options: {
      dataDir: f.dataDir, preferredPort: 0, managementOnly: true,
      fetchFn: (url, init) => url.includes('github.com') ? f.fetchFn(url, init) : started ? running(url) : refused(),
      spawnFn: (file, args, options) => {
        started = true;
        launches.push({ file, args, ...options });
        return { on() {}, unref() {} };
      }
    }
  };
}

describe('Official AIStudio2API installation', () => {
  it('selects only the official CLI asset for each supported platform and checks its digest', () => {
    const targets = [
      ['darwin', 'x64', 'darwin-amd64.tar.gz'], ['darwin', 'arm64', 'darwin-arm64.tar.gz'],
      ['linux', 'x64', 'linux-amd64.tar.gz'], ['linux', 'arm64', 'linux-arm64.tar.gz'],
      ['win32', 'x64', 'windows-amd64.zip']
    ];
    const assets = [...targets.map(t => t[2]), 'darwin-universal.dmg', 'darwin-universal.zip', 'linux-amd64.AppImage'].map(target => ({
      name: `aistudio2api-v0.3.7-${target}`, digest: `sha256:${'a'.repeat(64)}`,
      browser_download_url: `https://github.com/Mag1cFall/AIStudio2API/releases/download/v0.3.7/aistudio2api-v0.3.7-${target}`
    }));
    const release = { tag_name: 'v0.3.7', assets };
    for (const [platform, arch, target] of targets) {
      const selected = officialStudioAsset(release, { platform, arch });
      assert.equal(selected.asset, `aistudio2api-v0.3.7-${target}`);
      assert.equal(selected.sha256, 'a'.repeat(64));
    }
    const options = { platform: 'darwin', arch: 'x64' };
    for (const bad of [
      { ...release, assets: [{ ...assets[0], digest: null }] },
      { ...release, assets: [{ ...assets[0], browser_download_url: 'https://example.com/run' }] },
      { ...release, assets: [assets[0], assets[0]] },
      { ...release, draft: true }, { ...release, prerelease: true }, { ...release, tag_name: '../../escape' }
    ]) assert.throws(() => officialStudioAsset(bad, options));
    assert.throws(() => officialStudioAsset(release, { ...options, version: 'v0.3.6' }), /unexpected/);
    assert.throws(() => officialStudioAsset(release, { platform: 'win32', arch: 'arm64' }), /No official/);
  });

  it('first startup downloads, verifies and launches once for concurrent login callers', async t => {
    const f = fixture(t), start = starter(f);
    const locals = await Promise.all(Array.from({ length: 3 }, () => ensureStudio(start.options)));
    assert.equal(start.launches.length, 1);
    assert.equal(f.requests.filter(r => r.url.endsWith('/latest')).length, 1);
    assert.equal(f.requests.filter(r => r.url.includes('/download/')).length, 1);
    assert.equal(fs.readFileSync(binaryPath(f.dataDir), 'utf8'), f.binary);
    const local = locals[0];
    for (const l of locals) assert.deepEqual(l, local);
    assert.equal(local.backendMode, 'local');
    assert.ok(local.apiKey.length >= 24 && local.adminPassword.length >= 24);
    assert.equal(start.launches[0].env.PROXY_API_KEY, local.apiKey);
    assert.equal(start.launches[0].env.ADMIN_PASSWORD, local.adminPassword);
    assert.equal(start.launches[0].env.AISTUDIO_AUTH_STATES, path.resolve(f.dataDir, 'auth'));
    assert.ok(start.launches[0].args.includes('-auth=' + path.resolve(f.dataDir, 'auth')));
    assert.equal(start.launches[0].cwd, f.dataDir);
    assert.equal(readStudioEnv(f.dataDir).FIRST_EVENT_HEDGE, undefined);
    assert.equal(readStudioEnv(f.dataDir).WAA_BACKEND, undefined);
    const record = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'install-manifest.json')));
    assert.equal(record.source, 'official');
    assert.equal(record.version, '0.3.7');
    assert.equal(record.archiveSha256, f.sha256);
    assert.equal(record.binarySha256, computeFileHash(binaryPath(f.dataDir)));
    assert.equal(setupStep(f.dataDir), null);
  });

  it('login during an explicit install waits for the same lock and reuses its executable', { timeout: 20000 }, async t => {
    const f = fixture(t), start = starter(f);
    let reached, release;
    const metadataStarted = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const install = installStudio({ dataDir: f.dataDir, preferredPort: 0, fetchFn: async (url, init) => {
      if (url.includes('api.github.com')) { reached(); await gate; }
      return f.fetchFn(url, init);
    } });
    await metadataStarted;
    const login = ensureStudio(start.options);
    release();
    await Promise.all([install, login]);
    assert.equal(start.launches.length, 1);
    assert.equal(f.requests.filter(r => r.url.includes('api.github.com')).length, 1);
    assert.equal(f.requests.filter(r => r.url.includes('/download/')).length, 1);
  });

  it('an explicit version selects that official tag and reuses a matching downloaded archive', async t => {
    const f = fixture(t, { version: 'v0.3.6' });
    fs.mkdirSync(f.dataDir);
    fs.copyFileSync(f.archive, path.join(f.dataDir, f.name));
    await installStudio({ dataDir: f.dataDir, preferredPort: 0, version: '0.3.6', fetchFn: f.fetchFn });
    assert.equal(f.requests[0].url, 'https://api.github.com/repos/Mag1cFall/AIStudio2API/releases/tags/v0.3.6');
    assert.equal(f.requests.filter(r => r.url.includes('/download/')).length, 0);
    await assert.rejects(resolveStudioRelease({ version: '../bad', fetchFn() { assert.fail('invalid tag must not be sent'); } }), /release tag/);
  });

  it('a failed first download is retryable and cannot launch unchecked bytes', async t => {
    const f = fixture(t), start = starter(f);
    const bad = async (url, init) => url.includes('/download/') ? new Response('corrupt download') : start.options.fetchFn(url, init);
    await assert.rejects(ensureStudio({ ...start.options, fetchFn: bad }), /SHA256 checksum mismatch/);
    assert.equal(start.launches.length, 0);
    assert.equal(fs.existsSync(binaryPath(f.dataDir)), false);
    assert.equal(fs.readdirSync(f.dataDir).some(n => n.startsWith('.install.')), false);
    await ensureStudio(start.options);
    assert.equal(start.launches.length, 1);
  });

  it('release lookup failure keeps installed files and never falls back to a bundled version', async t => {
    const f = fixture(t);
    ensureStudioConfig(f.dataDir, '', { port: 2048 });
    fs.mkdirSync(path.dirname(binaryPath(f.dataDir)));
    fs.writeFileSync(binaryPath(f.dataDir), 'previous user update');
    const config = fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8');
    await assert.rejects(installStudio({ dataDir: f.dataDir, fetchFn: url => {
      if (url.includes('api.github.com')) return Promise.resolve(new Response('', { status: 403 }));
      return refused();
    } }), /GitHub HTTP 403/);
    assert.equal(fs.readFileSync(binaryPath(f.dataDir), 'utf8'), 'previous user update');
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'config.json'), 'utf8'), config);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'install-manifest.json')), false);
  });

  it('an explicit official migration preserves legacy credentials, account data, settings and account-card metadata', async t => {
    const f = fixture(t);
    const config = ensureStudioConfig(f.dataDir, 'http://127.0.0.1:7890', { port: 23456 });
    fs.mkdirSync(path.dirname(binaryPath(f.dataDir)));
    fs.writeFileSync(binaryPath(f.dataDir), 'old magpie build', { mode: 0o755 });
    fs.writeFileSync(path.join(f.dataDir, 'auth', 'sentinel.json'), '{"account":"kept"}');
    fs.mkdirSync(path.join(f.dataDir, 'runtime'));
    fs.writeFileSync(path.join(f.dataDir, 'runtime', 'requests.db'), 'history fixture');
    fs.appendFileSync(path.join(f.dataDir, '.env'), 'REQUEST_TIMEOUT=45m\nNEW_UPSTREAM_OPTION="future # value"\n');
    const card = { managed: true, mode: 'studio', baseURL: localStudio({ dataDir: f.dataDir }).baseURL, apiKey: config.apiKey, accountId: 'kept@example.com' };
    const local = await installStudio({ dataDir: f.dataDir, fetchFn: f.fetchFn });
    assert.equal(local.apiKey, card.apiKey);
    assert.equal(local.baseURL, card.baseURL);
    assert.equal(local.adminPassword, config.adminPassword);
    assert.equal(local.adminUsername, config.adminUsername);
    assert.equal(local.port, config.port);
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'auth', 'sentinel.json'), 'utf8'), '{"account":"kept"}');
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'runtime', 'requests.db'), 'utf8'), 'history fixture');
    const settings = readStudioEnv(f.dataDir);
    assert.equal(settings.REQUEST_TIMEOUT, '45m');
    assert.equal(settings.NEW_UPSTREAM_OPTION, 'future # value');
    assert.equal(settings.PROXY, 'http://127.0.0.1:7890');
    assert.equal(fs.readFileSync(binaryPath(f.dataDir), 'utf8'), f.binary);
  });

  it('a listener appearing during download prevents the executable swap', async t => {
    const f = fixture(t);
    ensureStudioConfig(f.dataDir);
    fs.mkdirSync(path.dirname(binaryPath(f.dataDir)));
    fs.writeFileSync(binaryPath(f.dataDir), 'old executable');
    let listening = false;
    const fetchFn = (url, init) => {
      if (url.includes('github.com')) {
        if (url.includes('/download/')) listening = true;
        return f.fetchFn(url, init);
      }
      return listening ? Promise.resolve(new Response('', { status: 401 })) : refused();
    };
    await assert.rejects(installStudio({ dataDir: f.dataDir, fetchFn }), /already used by another service/);
    assert.equal(fs.readFileSync(binaryPath(f.dataDir), 'utf8'), 'old executable');
  });

  for (const authenticated of [true, false]) it(`checks an occupied saved port with a missing executable (${authenticated ? 'same credentials' : 'foreign listener'})`, async t => {
    const f = fixture(t);
    ensureStudioConfig(f.dataDir);
    const fetchFn = async url => {
      assert.ok(!url.includes('github.com'), 'reject before resolving or downloading a release');
      return authenticated ? running(url) : new Response('', { status: 401 });
    };
    await assert.rejects(installStudio({ dataDir: f.dataDir, fetchFn }), /while service is running|already used by another service/);
    assert.equal(fs.existsSync(binaryPath(f.dataDir)), false);
  });

  it('keeps a successful install when deleting the old backup fails partway through', async t => {
    const f = fixture(t);
    ensureStudioConfig(f.dataDir);
    fs.mkdirSync(path.dirname(binaryPath(f.dataDir)));
    fs.writeFileSync(binaryPath(f.dataDir), 'previous executable');
    const remove = fs.rmSync;
    let attempted = false;
    t.mock.method(fs, 'rmSync', (file, options) => {
      if (path.basename(String(file)).startsWith('.package.backup.')) {
        attempted = true;
        remove(path.join(file, path.basename(binaryPath(f.dataDir))), { force: true });
        throw Object.assign(new Error('partial backup cleanup failure'), { code: 'EPERM' });
      }
      return remove(file, options);
    });
    const local = await installStudio({ dataDir: f.dataDir, fetchFn: f.fetchFn });
    assert.ok(attempted);
    assert.equal(fs.readFileSync(local.binaryPath, 'utf8'), f.binary);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'install-manifest.json'))).binarySha256, computeFileHash(local.binaryPath));
  });

  it('rejects archive symlinks before extracting, even with matching release metadata', { skip: process.platform === 'win32' }, async t => {
    const f = fixture(t, { prepare: source => fs.symlinkSync('../outside', path.join(source, 'escape')) });
    await assert.rejects(installStudio({ dataDir: f.dataDir, fetchFn: f.fetchFn }), /Symlinks or special files/);
    assert.equal(fs.existsSync(binaryPath(f.dataDir)), false);
  });
});
