import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as backend from '../lib/backend.mjs';
import * as native from '../lib/studio-native.mjs';
import * as state from '../lib/studio-control-state.mjs';
import { initializeControl, watchApplication } from '../lib/studio-console.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-startup-test-'));
function cleanup(dataDir) {
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// 在隔离上下文执行实际模块，用依赖替身验证宿主顺序，不启动真实后端或桌面应用。
function isolatedModule(file, names, bindings) {
  const url = new URL(`../lib/${file}`, import.meta.url);
  const code = fs.readFileSync(url, 'utf8').replace(/^import .*;\r?$/gm, '')
    .replace(/^export default .*;\r?$/gm, '').replace(/^export /gm, '')
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  return vm.runInNewContext(`(async () => { ${code}\n;return {${names.join(',')}}; })()`, {
    fs, os, path, http, crypto, fileURLToPath, process, console, URL, AbortSignal, Buffer, setInterval, clearInterval, setTimeout,
    ...backend, ...native, ...state, ...bindings
  });
}

for (const mode of ['gui plugins', 'tray']) for (const paused of [false, true]) {
  it(`${mode} reattachment clears only an application-exit pause (manual=${paused})`, async () => {
    const dataDir = temp();
    try {
      initializeControl(dataDir, '');
      state.writeControlState(dataDir, paused ? { version: 1, paused: true } : { version: 1, paused: true, appStopped: true });
      const self = fileURLToPath(new URL('../lib/studio-console.mjs', import.meta.url));
      fs.writeFileSync(path.join(dataDir, 'console-server.json'), JSON.stringify({ port: 12345, token: 'a'.repeat(64), source: self }));
      const module = await isolatedModule('studio-console.mjs', ['attachApplication'], {
        process: { platform: 'win32', versions: { bun: 'fixture' }, ppid: 12345, argv: [], env: {} },
        execFile: (_file, _args, _options, callback) => callback(null, JSON.stringify({ ProcessId: 12345, Name: 'magpie-windows-amd64.exe', CommandLine: `"D:\\Magpie\\magpie-windows-amd64.exe" ${mode}` })),
        fetch: async () => ({ ok: true, json: async () => ({ kind: 'magpie-studio-console-v2', source: self }) }),
        spawn: () => assert.fail('must reuse console')
      });
      await module.attachApplication(dataDir);
      assert.equal(state.controlState(dataDir).paused, paused);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'console-app.json'))).pid, 12345);
    } finally { cleanup(dataDir); }
  });
}

for (const manual of [false, true]) {
  it(`desktop exit preserves pause reason (manual=${manual})`, async () => {
    const dataDir = temp();
    initializeControl(dataDir, '');
    state.writeControlState(dataDir, { version: 1, paused: manual });
    fs.writeFileSync(path.join(dataDir, 'console-app.json'), '{"pid":12345}');
    let finish;
    const stopped = new Promise(resolve => { finish = resolve; });
    const unwatch = watchApplication({ dataDir, interval: 5, busy: () => false, isAlive: () => false,
      stop: async () => ({ stopped: true }), close: finish, report: error => assert.fail(error) });
    const timeout = setTimeout(() => finish('timeout'), 1000);
    try {
      assert.notEqual(await stopped, 'timeout');
      assert.equal(state.controlState(dataDir).paused, true);
      assert.equal(!!state.controlState(dataDir).appStopped, !manual);
    } finally { clearTimeout(timeout); unwatch(); cleanup(dataDir); }
  });
}

for (const scenario of ['unpaused', 'manual', 'resumed', 'stopped-during-attach', 'attachment-failed', 'unconfigured']) {
  it(`plugin startup waits for attachment and respects pause: ${scenario}`, async () => {
    const dataDir = temp();
    initializeControl(dataDir, '');
    state.writeControlState(dataDir, { version: 1, paused: scenario === 'manual' || scenario === 'resumed', ...(scenario === 'resumed' ? { appStopped: true } : {}) });
    let release, reject;
    const attached = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    const starts = [], errors = [];
    try {
      const module = await isolatedModule('studio.mjs', ['AIStudioPlugin'], {
        studioDataDir: () => dataDir, initializeControl, attachApplication: () => attached,
        handleConsoleOpen: async () => {}, localStudio: () => scenario === 'unconfigured' ? null : { dataDir },
        ensureStudio: async options => { assert.equal(state.controlState(dataDir).paused, false); starts.push(options); },
        console: { error: message => errors.push(message) }
      });
      await module.AIStudioPlugin({}, { studio: { localConsole: true } });
      await settle();
      assert.equal(starts.length, 0, 'must wait for application attachment');
      if (scenario === 'resumed') state.writeControlState(dataDir, { version: 1, paused: false });
      if (scenario === 'stopped-during-attach') state.writeControlState(dataDir, { version: 1, paused: true });
      if (scenario === 'attachment-failed') reject(new Error('fixture attachment failed')); else release();
      await settle();
      assert.equal(starts.length, ['unpaused', 'resumed'].includes(scenario) ? 1 : 0);
      if (scenario === 'attachment-failed') assert.ok(errors.some(message => message.includes('fixture attachment failed')));
      else assert.deepEqual(errors, []);
    } finally { cleanup(dataDir); }
  });
}
