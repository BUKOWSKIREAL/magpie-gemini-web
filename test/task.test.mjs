import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { GeminiWebPlugin } from '../index.mjs';
import { taskSupported, taskMethod, TASK_MODEL } from '../lib/task.mjs';

describe('29. The experimental macOS Task route', () => {
  const KEY = 'task_key_0123456789abcdef';
  let server, dataDir, previous, seen;

  before(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, session: req.headers['x-gemini-session'] });
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/health') return res.end(JSON.stringify({ service: 'gemini-native-task', instance_id: 'inst_1' }));
      res.end('{"ok":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-task-'));
    fs.chmodSync(dataDir, 0o700);
    previous = process.env.GEMINI_NATIVE_TASK_DATA_DIR;
    process.env.GEMINI_NATIVE_TASK_DATA_DIR = dataDir;
  });

  after(() => {
    server.close();
    if (previous === undefined) delete process.env.GEMINI_NATIVE_TASK_DATA_DIR;
    else process.env.GEMINI_NATIVE_TASK_DATA_DIR = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function writeConfig() {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      version: 1, api_key: KEY, instance_id: 'inst_1', subject_sha256: 'a'.repeat(64), port: server.address().port
    }), { mode: 0o600 });
  }

  it('is offered on macOS only, after the Web methods', async () => {
    assert.equal(taskSupported('darwin'), true);
    assert.equal(taskSupported('win32'), false);
    assert.equal(taskSupported('linux'), false);
    const methods = (await GeminiWebPlugin({})).auth.methods;
    assert.equal(methods.includes(taskMethod), taskSupported());
    if (taskSupported()) assert.equal(methods.at(-1), taskMethod);
    assert.match(taskMethod.label, /实验性/);
    assert.doesNotMatch(taskMethod.label, /推荐/);
  });

  it('says how to set the bridge up when it has no configuration', async () => {
    await assert.rejects(taskMethod.authorize(), /还没有配置本机 Task 服务.*bridge\.mjs" setup/);
  });

  it('signs in to the bridge and routes models, requests, usage and session headers to it', async () => {
    writeConfig();
    const signIn = await (await taskMethod.authorize()).callback();
    assert.equal(signIn.type, 'success');
    assert.equal(signIn.key, KEY);
    assert.equal(signIn.metadata.mode, 'task');
    assert.equal(signIn.metadata.baseURL, `http://127.0.0.1:${server.address().port}/v1`);

    const auth = { type: 'api', key: signIn.key, metadata: signIn.metadata };
    const plugin = await GeminiWebPlugin({});

    const models = await plugin.provider.models({ models: {} }, { auth });
    assert.deepEqual(Object.keys(models), [TASK_MODEL]);
    assert.equal(models[TASK_MODEL].capabilities.toolcall, true);
    assert.equal(models[TASK_MODEL].providerID, 'gemini-web');

    const loaded = await plugin.auth.loader(async () => auth);
    assert.equal(loaded.baseURL, signIn.metadata.baseURL);
    const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
      method: 'POST', headers: { 'X-Gemini-Session': 'sess_1' }, body: '{}'
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen.at(-1), { url: '/v1/chat/completions', auth: `Bearer ${KEY}`, session: 'sess_1' });

    const card = await plugin.auth.usage(async () => auth);
    assert.match(card.error, /Task/);
    assert.equal(card.signIn, 'kept');

    await assert.rejects(plugin.auth.loader(async () => ({ ...auth, key: 'another_key_0123456789' })), /重新登录/);

    const out = {};
    await plugin['chat.headers']({ model: { providerID: 'gemini-web' }, sessionID: 'sess_2' }, out);
    assert.deepEqual(out.headers, { 'X-Gemini-Session': 'sess_2' });
    const other = {};
    await plugin['chat.headers']({ model: { providerID: 'openai' }, sessionID: 'sess_3' }, other);
    assert.equal(other.headers, undefined);
  });
});
