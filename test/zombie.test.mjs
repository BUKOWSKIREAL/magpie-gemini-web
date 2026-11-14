import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureStudio, ensureStudioConfig, localStudio, stopStudio, computeFileHash } from '../lib/studio-native.mjs';
import { processAlive, processExists, setProcRoot, zombie } from '../lib/proc.mjs';
import { STUDIO_VERSION, PINNED_ARCHIVES } from './helpers/studio-legacy.mjs';

// In a container without an init, an exited aistudio2api whose parent (the plugin host)
// ended is adopted by PID 1 and stays a zombie. kill(pid, 0) still succeeds on it; only
// /proc/<pid>/stat says it has exited (state Z). Here a live process stands in for it and
// a fake /proc tree says what the kernel says of a zombie.

const offlineFetch = async () => { throw Object.assign(new Error('offline fixture'), { code: 'ECONNREFUSED' }); };

function fakeStat(root, pid, state, comm = 'aistudio2api') {
  fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
  fs.writeFileSync(path.join(root, String(pid), 'stat'), `${pid} (${comm}) ${state} 1 ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0\n`);
}

async function freePort() {
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise(r => server.close(r));
  return port;
}

describe('a zombie AI Studio process has exited', () => {
  let root, procDir;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-gemini-zombie-'));
    procDir = path.join(root, 'proc');
  });
  afterEach(() => {
    setProcRoot();
    fs.rmSync(procDir, { recursive: true, force: true });
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the state after the last parenthesis of /proc/<pid>/stat', () => {
    setProcRoot(procDir);
    fakeStat(procDir, process.pid, 'Z');
    assert.equal(zombie(process.pid), true);
    assert.equal(processAlive(process.pid), false);
    assert.equal(processExists(process.pid), false);
    fakeStat(procDir, process.pid, 'X');
    assert.equal(processAlive(process.pid), false);
    fakeStat(procDir, process.pid, 'S', 'a) Z (b');
    assert.equal(zombie(process.pid), false);
    assert.equal(processAlive(process.pid), true);
    // No /proc entry (macOS, Windows, an unreadable tree) is not evidence of exit.
    fs.rmSync(procDir, { recursive: true, force: true });
    assert.equal(zombie(process.pid), false);
    assert.equal(processAlive(process.pid), true);
    assert.equal(processAlive(2 ** 22 + 12345), false);
  });

  it('stop and the next start treat it as gone', { skip: process.platform === 'win32' && 'no /proc or zombies on Windows' }, async () => {
    const dataDir = path.join(root, 'data dir');
    ensureStudioConfig(dataDir, '', { port: await freePort() });
    const pkg = path.join(dataDir, 'package');
    fs.mkdirSync(pkg);
    const bin = path.join(pkg, 'aistudio2api');
    fs.copyFileSync(process.execPath, bin, fs.constants.COPYFILE_FICLONE);
    fs.writeFileSync(path.join(dataDir, 'install-manifest.json'), JSON.stringify({
      version: STUDIO_VERSION.slice(1), platform: process.platform, arch: process.arch,
      archiveSha256: PINNED_ARCHIVES[`${process.platform}-${process.arch}`].sha256, binarySha256: computeFileHash(bin)
    }));
    const nodeLib = path.join(path.dirname(fs.realpathSync(process.execPath)), '..', 'lib');
    // Ignores SIGTERM, so only reading the zombie's state lets stop finish.
    const child = spawn(bin, ['-e', `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`], {
      env: { ...process.env, DYLD_LIBRARY_PATH: nodeLib, LD_LIBRARY_PATH: nodeLib },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const exited = new Promise(resolve => child.on('exit', resolve));
    try {
      await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
      const pidFile = path.join(dataDir, 'backend.pid');
      fs.writeFileSync(pidFile, `${child.pid}\n`);
      setProcRoot(procDir);
      fakeStat(procDir, child.pid, 'Z');

      const started = Date.now();
      assert.deepEqual(await stopStudio({ dataDir, fetchFn: offlineFetch }), { stopped: true });
      assert.ok(Date.now() - started < 4000, 'stop waited on a process that had exited');
      assert.equal(fs.existsSync(pidFile), false);

      fs.writeFileSync(pidFile, `${child.pid}\n`);
      let spawned = false;
      await assert.rejects(
        ensureStudio({ dataDir, fetchFn: offlineFetch, startTimeoutMs: 200, spawnFn: () => { spawned = true; throw new Error('spawn fixture'); } }),
        err => !/still be running or restarting/.test(err.message)
      );
      assert.equal(spawned, true, 'a new AI Studio was not started');
      assert.equal(localStudio({ dataDir }).port > 0, true);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });
});
