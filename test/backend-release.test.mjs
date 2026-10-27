import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { backendChannel, binaryPath, ensureBackend, installBackend, pinnedBinary,
  PINNED_BINARIES, UPSTREAM_BINARIES } from '../lib/native.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-release-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, 'bin'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 8083, multi_turn: true }));
  fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_fixture', adminToken: 'fixture_admin' }));
  fs.writeFileSync(path.join(dataDir, 'gemini.db'), 'existing account database');
  return dataDir;
}
function pinFixture(t, pins, bytes) {
  const previous = pins['darwin-arm64'];
  pins['darwin-arm64'] = { ...previous, sha256: hash(bytes) };
  t.after(() => { pins['darwin-arm64'] = previous; });
}

it('ships pinned optimized and rollback downloads for all six supported targets', () => {
  const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
  assert.deepEqual(Object.keys(PINNED_BINARIES).sort(), targets);
  for (const key of targets) {
    const [platform, arch] = key.split('-');
    const optimized = pinnedBinary(platform, arch);
    const upstream = pinnedBinary(platform, arch, 'upstream');
    assert.match(optimized.url, /^https:\/\/github\.com\/BUKOWSKIREAL\/magpie-gemini-web\/releases\/download\/backend-v4\.26\.0-magpie\.1\//);
    assert.match(optimized.sha256, /^[a-f0-9]{64}$/);
    assert.match(upstream.url, /^https:\/\/github\.com\/zexadev\/gemini-web2api-go\/releases\/download\/v4\.26\.0\//);
    assert.notEqual(optimized.sha256, upstream.sha256);
    assert.equal(optimized.url.endsWith('.exe'), platform === 'win32');
  }
  assert.throws(() => pinnedBinary('linux', 'mips'), /No gemini-web2api-go/);
  assert.throws(() => pinnedBinary('linux', 'x64', 'unknown'), /Invalid backend channel/);
});

it('upgrades a stopped upstream backend to the optimized release without changing account data', async t => {
  const dataDir = fixture(t);
  const old = Buffer.from('upstream fixture');
  const next = Buffer.from('optimized fixture');
  pinFixture(t, UPSTREAM_BINARIES, old);
  pinFixture(t, PINNED_BINARIES, next);
  const bin = binaryPath(dataDir, 'darwin');
  fs.writeFileSync(bin, old);
  const calls = [];
  let spawned = false;
  await ensureBackend({ dataDir, platform: 'darwin', arch: 'arm64',
    fetchFn: async url => {
      calls.push(url);
      if (url === pinnedBinary('darwin', 'arm64').url) return new Response(next);
      if (!spawned) throw new Error('ECONNREFUSED');
      return Response.json({ data: [] });
    },
    spawnFn: () => { spawned = true; return { pid: 1234, on() {}, unref() {} }; }
  });
  assert.deepEqual(fs.readFileSync(bin), next);
  assert.ok(spawned);
  assert.ok(calls.includes(pinnedBinary('darwin', 'arm64').url));
  assert.equal(backendChannel(dataDir), 'optimized');
  assert.equal(fs.readFileSync(path.join(dataDir, 'gemini.db'), 'utf8'), 'existing account database');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'))).multi_turn, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'))).apiKey, 'gw_fixture');
});

it('persists an explicit upstream rollback across automatic starts and can switch back', async t => {
  const dataDir = fixture(t);
  const upstream = Buffer.from('upstream fixture');
  const optimized = Buffer.from('optimized fixture');
  pinFixture(t, UPSTREAM_BINARIES, upstream);
  pinFixture(t, PINNED_BINARIES, optimized);
  await installBackend({ dataDir, platform: 'darwin', arch: 'arm64', channel: 'upstream',
    fetchFn: async url => {
      assert.equal(url, pinnedBinary('darwin', 'arm64', 'upstream').url);
      return new Response(upstream);
    }
  });
  assert.equal(backendChannel(dataDir), 'upstream');
  let spawned = false;
  await ensureBackend({ dataDir, platform: 'darwin', arch: 'arm64',
    fetchFn: async url => {
      assert.ok(url.startsWith('http://127.0.0.1:8083/'), 'rollback must not redownload the default build');
      if (!spawned) throw new Error('ECONNREFUSED');
      return Response.json({ data: [] });
    },
    spawnFn: () => { spawned = true; return { pid: 1234, on() {}, unref() {} }; }
  });
  assert.ok(spawned);
  await installBackend({ dataDir, platform: 'darwin', arch: 'arm64', fetchFn: async () => new Response(optimized) });
  assert.equal(backendChannel(dataDir), 'optimized');
  assert.deepEqual(fs.readFileSync(binaryPath(dataDir, 'darwin')), optimized);
});

it('a failed upgrade keeps the previous binary, channel, config, secrets and database', async t => {
  const dataDir = fixture(t);
  const bin = binaryPath(dataDir, 'darwin');
  fs.writeFileSync(bin, 'previous binary');
  fs.writeFileSync(path.join(dataDir, 'backend-channel.json'), JSON.stringify({ channel: 'upstream' }));
  const paths = [bin, ...['backend-channel.json', 'config.json', 'secrets.json', 'gemini.db'].map(name => path.join(dataDir, name))];
  const before = paths.map(file => fs.readFileSync(file));
  for (const response of [() => new Response('offline', { status: 503 }), () => new Response('corrupt binary')]) {
    await assert.rejects(installBackend({ dataDir, platform: 'darwin', arch: 'arm64', fetchFn: async () => response() }), /HTTP 503|SHA256 checksum mismatch/);
    for (let i = 0; i < paths.length; i++) assert.deepEqual(fs.readFileSync(paths[i]), before[i]);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'bin')), ['gemini-web2api-go']);
  }
});
