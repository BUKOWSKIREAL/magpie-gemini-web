import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../index.mjs';
import { createForwarder, ensurePrivateDataDir, ensureService, loadLocalConfig } from '../lib/runtime.mjs';
import { setup } from '../scripts/bridge.mjs';

test('config hook preserves existing overrides and registers gemini-task-argon', async () => {
  const hooks = await plugin.server({}, {});
  const config = {
    provider: {
      'gemini-native-task': {
        customField: 'preserved',
      },
    },
  };
  hooks.config(config);

  const provider = config.provider['gemini-native-task'];
  assert.equal(provider.customField, 'preserved');
  assert.equal(provider.npm, '@ai-sdk/openai-compatible');
  assert.equal(provider.name, 'Gemini Native Task');
  assert.deepEqual(Object.keys(provider.models), ['gemini-task-argon']);
  assert.equal(provider.models['gemini-task-argon'].limit.context, 65536);
  assert.equal(provider.models['gemini-task-argon'].limit.output, 8192);
  assert.equal(provider.models['gemini-task-argon'].tool_call, true);
});

test('provider.models hook returns only gemini-task-argon preserving resolved metadata', async () => {
  const hooks = await plugin.server({}, {});
  assert.equal(hooks.provider.id, 'gemini-native-task');
  const models = hooks.provider.models({
    id: 'gemini-native-task',
    models: {
      'gemini-task-argon': { customProp: 'kept', name: 'Custom Name' },
      'other-model': { shouldBeDropped: true },
    },
  });
  assert.deepEqual(Object.keys(models), ['gemini-task-argon']);
  assert.equal(models['gemini-task-argon'].customProp, 'kept');
  assert.equal(models['gemini-task-argon'].name, 'Custom Name');
  assert.equal(models['gemini-task-argon'].capabilities.toolcall, true);
});

test('chat.headers hook mutates output.headers for gemini-native-task including suffixed IDs', async () => {
  const hooks = await plugin.server({}, {});

  // 1. Direct match
  const out1 = {};
  await hooks['chat.headers']({
    model: { providerID: 'gemini-native-task' },
    sessionID: 'sess_123',
  }, out1);
  assert.deepEqual(out1.headers, { 'X-Gemini-Session': 'sess_123' });

  // 2. Suffixed model providerID with provider.info.id = ID
  const out2 = {};
  await hooks['chat.headers']({
    model: { providerID: 'gemini-native-task_suffix' },
    provider: { info: { id: 'gemini-native-task' } },
    sessionID: 'sess_suffix',
  }, out2);
  assert.deepEqual(out2.headers, { 'X-Gemini-Session': 'sess_suffix' });

  // 3. Other provider ignored
  const out3 = {};
  await hooks['chat.headers']({
    model: { providerID: 'openai' },
    provider: { info: { id: 'openai' } },
    sessionID: 'sess_other',
  }, out3);
  assert.equal(out3.headers, undefined);

  // 4. Missing sessionID leaves output untouched
  const out4 = {};
  await hooks['chat.headers']({
    model: { providerID: 'gemini-native-task' },
  }, out4);
  assert.equal(out4.headers, undefined);
});

test('auth authorize and loader lifecycle with key validation and /v1 URL on ephemeral port', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-auth-test-'));
  fs.chmodSync(tmpDir, 0o700);

  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.headers.authorization === 'Bearer test_key_0123456789abcdef') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'gemini-native-task', instance_id: 'inst_auth_test', active_tasks: 0 }));
    } else {
      res.writeHead(401);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ephemeralPort = server.address().port;

  const config = {
    version: 1,
    api_key: 'test_key_0123456789abcdef',
    instance_id: 'inst_auth_test',
    auth_file: '/tmp/auth',
    binary: '/tmp/Gemini',
    subject_sha256: 'a'.repeat(64),
    account_label: 'Acc',
    port: ephemeralPort,
  };
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });

  try {
    const hooks = await plugin.server({}, { dataDir: tmpDir });
    const authMethod = hooks.auth.methods[0];
    assert.equal(authMethod.type, 'oauth');

    const authRes = await authMethod.authorize();
    const creds = await authRes.callback();
    assert.equal(creds.type, 'success');
    assert.equal(creds.key, config.api_key);
    assert.equal(creds.accountId, `native:${config.instance_id}`);
    assert.equal(creds.metadata.baseURL, `http://127.0.0.1:${ephemeralPort}/v1`);

    const loaderRes = await hooks.auth.loader(async () => ({
      type: 'api',
      key: config.api_key,
      metadata: { dataDir: tmpDir },
    }));
    assert.equal(loaderRes.baseURL, `http://127.0.0.1:${ephemeralPort}/v1`);
    assert.equal(loaderRes.apiKey, config.api_key);

    await assert.rejects(
      async () => hooks.auth.loader(async () => ({ type: 'oauth', key: config.api_key })),
      { message: /Connect the local Native Task service first/ }
    );

    await assert.rejects(
      async () => hooks.auth.loader(async () => ({ type: 'api', key: 'wrong_key_1234567890' })),
      (err) => err.signIn === 'expired'
    );
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createForwarder forwards real POST Request body, removes stale headers, handles abort and single fetch call', async () => {
  let receivedBody = '';
  let receivedHeaders = null;

  const server = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const serviceInfo = {
    baseURL: `http://127.0.0.1:${port}`,
    apiKey: 'my_secret_key_12345',
    instance_id: 'inst_1',
    dataDir: '/tmp',
  };

  try {
    const forwarder = createForwarder(serviceInfo);

    const postPayload = JSON.stringify({ model: 'gemini-task-argon', messages: [{ role: 'user', content: 'hello' }] });
    const reqObj = new Request(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gemini-Session': 'session_real_test',
        'Transfer-Encoding': 'chunked',
        'Content-Length': '999',
      },
      body: postPayload,
    });

    const res = await forwarder(reqObj);
    assert.equal(res.status, 200);
    assert.equal(receivedBody, postPayload);
    assert.equal(receivedHeaders['authorization'], 'Bearer my_secret_key_12345');
    assert.equal(receivedHeaders['x-gemini-session'], 'session_real_test');
    assert.equal(receivedHeaders['transfer-encoding'], undefined);

    // Abort propagation
    const controller = new AbortController();
    controller.abort();
    const abortReq = new Request(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postPayload,
      signal: controller.signal,
    });
    const abortRes = await forwarder(abortReq);
    assert.equal(abortRes.status, 409);
    assert.equal(abortRes.headers.get('X-Magpie-Sign-In'), 'kept');
    const abortData = await abortRes.json();
    assert.equal(abortData.error.code, 'bridge_network_error');

    // Network connection failure invokes fetch exactly once
    let fetchCalls = 0;
    const failingFetch = async () => {
      fetchCalls++;
      throw new Error('Connection refused');
    };
    const onceForwarder = createForwarder(serviceInfo, failingFetch);
    const errRes = await onceForwarder('http://127.0.0.1:1/v1/chat/completions', { method: 'POST' });
    assert.equal(errRes.status, 409);
    assert.equal(fetchCalls, 1);
  } finally {
    server.close();
  }
});

test('ensureService refuses 401, HTML, wrong-instance, timeout, and oversized health responses with zero spawn', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-probe-failures-'));
  fs.chmodSync(tmpDir, 0o700);

  let currentHandler = (req, res) => res.end();
  const server = http.createServer((req, res) => currentHandler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const cfg = {
    version: 1, api_key: 'test_key_0123456789abcdef', instance_id: 'inst_probe_test', auth_file: '/tmp/a', binary: '/tmp/b',
    subject_sha256: 'a'.repeat(64), account_label: 'Acc', port,
  };
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg), { mode: 0o600 });

  let spawnCalls = 0;
  const mockSpawn = () => {
    spawnCalls++;
    return { unref() {}, on() {} };
  };

  try {
    // 1. 401 response => zero spawn
    currentHandler = (req, res) => { res.writeHead(401); res.end('Unauthorized'); };
    await assert.rejects(
      async () => ensureService({ dataDir: tmpDir }, { spawn: mockSpawn }),
      { message: /unexpected status 401/ }
    );
    assert.equal(spawnCalls, 0);

    // 2. HTML response => zero spawn
    currentHandler = (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!DOCTYPE html><html>Not JSON</html>'); };
    await assert.rejects(
      async () => ensureService({ dataDir: tmpDir }, { spawn: mockSpawn }),
      { message: /not valid JSON/ }
    );
    assert.equal(spawnCalls, 0);

    // 3. Wrong instance => zero spawn
    currentHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'gemini-native-task', instance_id: 'wrong_instance' }));
    };
    await assert.rejects(
      async () => ensureService({ dataDir: tmpDir }, { spawn: mockSpawn }),
      { message: /mismatching instance ID/ }
    );
    assert.equal(spawnCalls, 0);

    // 4. Oversized response (> 16 KiB) => zero spawn
    currentHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'gemini-native-task', padding: 'x'.repeat(20000) }));
    };
    await assert.rejects(
      async () => ensureService({ dataDir: tmpDir }, { spawn: mockSpawn }),
      { message: /exceeds 16KiB limit/ }
    );
    assert.equal(spawnCalls, 0);

    // 5. Timeout response => zero spawn
    currentHandler = (req, res) => { /* never responds */ };
    await assert.rejects(
      async () => ensureService({ dataDir: tmpDir }, { spawn: mockSpawn, probeTimeoutMs: 50 }),
      { message: /timed out/ }
    );
    assert.equal(spawnCalls, 0);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ensureService absent->spawn->healthy gives exactly 1 spawn for same-dir and different dirs give different keys', async () => {
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-coalesce1-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-coalesce2-'));
  fs.chmodSync(dir1, 0o700);
  fs.chmodSync(dir2, 0o700);

  const cfg1 = {
    version: 1, api_key: 'key1_0123456789abcdef', instance_id: 'inst1', auth_file: '/tmp/a', binary: '/tmp/b',
    subject_sha256: '1'.repeat(64), account_label: 'Acc1', port: 19881,
  };
  const cfg2 = {
    version: 1, api_key: 'key2_0123456789abcdef', instance_id: 'inst2', auth_file: '/tmp/a', binary: '/tmp/b',
    subject_sha256: '2'.repeat(64), account_label: 'Acc2', port: 19882,
  };
  fs.writeFileSync(path.join(dir1, 'config.json'), JSON.stringify(cfg1), { mode: 0o600 });
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify(cfg2), { mode: 0o600 });

  let spawns1 = 0;
  let spawns2 = 0;
  const mockSpawn = (py, args, opts) => {
    if (opts.env.PYTHONPATH && args.includes(fs.realpathSync(dir1))) {
      spawns1++;
    } else {
      spawns2++;
    }
    return { unref() {}, on() {} };
  };

  let probeCount1 = 0;
  const mockProbe = async (url, key, inst) => {
    if (inst === 'inst1') {
      probeCount1++;
      if (probeCount1 < 2) return null; // absent initially
      return { service: 'gemini-native-task', instance_id: 'inst1' };
    }
    if (inst === 'inst2') {
      return { service: 'gemini-native-task', instance_id: 'inst2' };
    }
    return null;
  };

  try {
    // Concurrent same-dir absent -> spawn -> healthy gives exactly 1 spawn
    const [res1a, res1b] = await Promise.all([
      ensureService({ dataDir: dir1, startupTimeoutMs: 3000 }, { probeHealth: mockProbe, spawn: mockSpawn }),
      ensureService({ dataDir: dir1, startupTimeoutMs: 3000 }, { probeHealth: mockProbe, spawn: mockSpawn }),
    ]);
    assert.equal(res1a.apiKey, cfg1.api_key);
    assert.equal(res1b.apiKey, cfg1.api_key);
    assert.equal(spawns1, 1);

    // Different dir gives different key
    const res2 = await ensureService({ dataDir: dir2, startupTimeoutMs: 3000 }, { probeHealth: mockProbe, spawn: mockSpawn });
    assert.equal(res2.apiKey, cfg2.api_key);
    assert.notEqual(res1a.apiKey, res2.apiKey);
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('setup creates initially absent child directory with 0700 verified inside FIRST exec stub', async () => {
  const parentTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-parent-'));
  fs.chmodSync(parentTmp, 0o700);

  const absentChildDir = path.join(parentTmp, 'child_data_dir');
  assert.equal(fs.existsSync(absentChildDir), false);

  let verifiedModeInFirstExec = null;
  let execCalls = [];

  const mockExec = (bin, args) => {
    if (execCalls.length === 0) {
      assert.equal(fs.existsSync(absentChildDir), true);
      const st = fs.statSync(absentChildDir);
      verifiedModeInFirstExec = st.mode & 0o777;
    }
    execCalls.push({ bin, args });
    return Buffer.from(JSON.stringify({ configured: true }));
  };

  const flags = {
    'data-dir': absentChildDir,
    'auth-file': '/tmp/auth.bin',
    'task-headers': '/tmp/th.json',
    'tool-headers': '/tmp/tlh.json',
    'task-template': '/tmp/tt.bin',
    'turn-template': '/tmp/tnt.bin',
  };

  await setup(flags, { execFileSync: mockExec });
  assert.equal(verifiedModeInFirstExec, 0o700);
  assert.equal(execCalls.length >= 2, true);

  fs.rmSync(parentTmp, { recursive: true, force: true });
});
