import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiWebPlugin, AIStudioPlugin } from '../index.mjs';
import { studioSettings, listStudioModels, cooldownWindows, poolUsage, STUDIO_ID, STUDIO_BASE } from '../lib/studio.mjs';
import { forward } from '../lib/backend.mjs';
import { generateEnv, computeFileHash, PINNED_ARCHIVES, STUDIO_VERSION } from '../lib/studio-native.mjs';

describe('AI Studio Plugin & Models Unit Tests', () => {
  let mockServer;
  let serverPort;
  let serverURL;
  let serverRequests = [];
  let serverResponses = {};
  let tempStudioDataDir;
  let tempWebDataDir;
  let origStudioDataDir;
  let origWebDataDir;

  before(async () => {
    origStudioDataDir = process.env.AI_STUDIO_DATA_DIR;
    origWebDataDir = process.env.GEMINI_WEB_DATA_DIR;
    tempStudioDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-data-test-'));
    tempWebDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-web-data-test-'));
    process.env.AI_STUDIO_DATA_DIR = tempStudioDataDir;
    process.env.GEMINI_WEB_DATA_DIR = tempWebDataDir;
    mockServer = http.createServer((req, res) => {
      let reqBody = '';
      req.on('data', chunk => { reqBody += chunk; });
      req.on('end', () => {
        const url = req.url;
        serverRequests.push({ method: req.method, url, headers: req.headers, body: reqBody });

        if (serverResponses[url]) {
          const resp = serverResponses[url];
          if (typeof resp === 'function') {
            resp(req, res, reqBody);
          } else {
            res.writeHead(resp.status || 200, resp.headers || { 'Content-Type': 'application/json' });
            res.end(resp.body || '');
          }
          return;
        }

        // Management API of the stand-in for the managed service (see standInSetup)
        if (url === '/api/auth/login') {
          res.writeHead(200, { 'Set-Cookie': 'aistudio_admin=stand-in; Path=/', 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        if (url === '/api/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            version: STUDIO_VERSION,
            state: 'RUNNING',
            running: true,
            ready: true,
            accounts: { total: 1, ready: 1, busy: 0, cooldown: 0, auth_required: 0 }
          }));
          return;
        }

        if (url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'gemini-4-argon',
                object: 'model',
                name: 'Gemini 4 Argon',
                supported_generation_methods: ['generateContent', 'countTokens'],
                input_token_limit: 1048576,
                output_token_limit: 32768,
                capabilities: {
                  chat_model: true,
                  thinking_level: true,
                  function_declarations: true,
                  media_resolution: true
                }
              },
              {
                id: 'gemini-2.5-flash-tts',
                object: 'model',
                name: 'Gemini TTS',
                supported_generation_methods: ['generateContent'],
                capabilities: { chat_model: true }
              },
              {
                id: 'gemini-live-model',
                object: 'model',
                supported_generation_methods: ['generateContent'],
                capabilities: { chat_model: true }
              },
              {
                id: 'gemini-nano-banana-pro',
                object: 'model',
                supported_generation_methods: ['generateContent'],
                capabilities: { chat_model: true }
              },
              {
                id: 'gemini-nonthinking',
                object: 'model',
                name: 'Gemini Non-Thinking',
                supported_generation_methods: ['generateContent'],
                input_token_limit: 500000,
                output_token_limit: 4000,
                capabilities: {
                  chat_model: true,
                  thinking: false,
                  thinking_level: false,
                  function_declarations: false
                }
              }
            ]
          }));
          return;
        }

        if (url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl_test',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK [cite: 1]' }, finish_reason: 'stop' }]
          }));
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise(resolve => mockServer.listen(0, '127.0.0.1', () => {
      serverPort = mockServer.address().port;
      serverURL = `http://127.0.0.1:${serverPort}/v1`;
      resolve();
    }));
  });

  after(async () => {
    if (mockServer) {
      await new Promise(resolve => mockServer.close(resolve));
    }
    if (tempStudioDataDir) fs.rmSync(tempStudioDataDir, { recursive: true, force: true });
    if (tempWebDataDir) fs.rmSync(tempWebDataDir, { recursive: true, force: true });
    if (origStudioDataDir !== undefined) process.env.AI_STUDIO_DATA_DIR = origStudioDataDir;
    else delete process.env.AI_STUDIO_DATA_DIR;
    if (origWebDataDir !== undefined) process.env.GEMINI_WEB_DATA_DIR = origWebDataDir;
    else delete process.env.GEMINI_WEB_DATA_DIR;
  });

  it('1. exported functions register both providers without overwriting Web', async () => {
    const web = await GeminiWebPlugin();
    const studio = await AIStudioPlugin();
    const cfg = { provider: {} };

    await web.config(cfg);
    assert.ok(cfg.provider['gemini-web']);
    assert.equal(cfg.provider['gemini-web'].name, 'Gemini Web');

    await studio.config(cfg);
    assert.ok(cfg.provider['gemini-web'], 'Web provider must still be present');
    assert.ok(cfg.provider[STUDIO_ID], 'Studio provider must be present');
    assert.equal(cfg.provider[STUDIO_ID].name, 'Google AI Studio');
    assert.equal(cfg.provider[STUDIO_ID].api, STUDIO_BASE);

    const custom = await AIStudioPlugin({}, { studio: { baseURL: 'http://127.0.0.1:2049/v1' } });
    const customCfg = {};
    await custom.config(customCfg);
    assert.equal(customCfg.provider[STUDIO_ID].api, 'http://127.0.0.1:2049/v1', 'studio.baseURL is the provider default');
  });

  it('2. root Web baseURL/limits do not leak into Studio, while studio nested options apply', () => {
    assert.equal(studioSettings().proxy, undefined, 'Unspecified proxy must be undefined');
    assert.equal(studioSettings({ studio: { proxy: '' } }).proxy, '', 'Explicit empty proxy must be empty string');

    const sampleConfig = { port: 2048, apiKey: 'k', adminUsername: 'u', adminPassword: 'p', proxy: 'http://127.0.0.1:9999' };
    const envGenerated = generateEnv(tempStudioDataDir, sampleConfig);
    assert.ok(envGenerated.includes('PROXY=http://127.0.0.1:9999'), 'Config proxy must remain in generateEnv when options.proxy is undefined');

    const rootOptions = {
      baseURL: 'http://127.0.0.1:8083/v1',
      contextLimit: 500000,
      outputLimit: 4096,
      stripCitations: true,
      allowTools: false,
      allowImages: true,
      requestTimeoutMs: 120000,
      modelTimeoutMs: 5000
    };

    const studioOpts = studioSettings(rootOptions);
    assert.equal(studioOpts.baseURL, STUDIO_BASE, 'Root baseURL must not leak into Studio');
    assert.equal(studioOpts.explicitContextLimit, null, 'Root contextLimit must not leak into Studio');
    assert.equal(studioOpts.explicitOutputLimit, null, 'Root outputLimit must not leak into Studio');
    assert.equal(studioOpts.stripCitations, false, 'Studio stripCitations must always be false');
    assert.equal(studioOpts.nativeThinking, true, 'Studio nativeThinking must be true');
    assert.equal(studioOpts.allowTools, false, 'allowTools should be inherited');
    assert.equal(studioOpts.allowImages, true, 'allowImages should be inherited');
    assert.equal(studioOpts.requestTimeoutMs, 120000);
    assert.equal(studioOpts.modelTimeoutMs, 5000);

    const withNested = studioSettings({
      ...rootOptions,
      studio: {
        baseURL: 'http://127.0.0.1:2049/v1',
        contextLimit: 600000,
        outputLimit: 16384,
        allowTools: true,
        proxy: 'http://127.0.0.1:1082'
      }
    });
    assert.equal(withNested.baseURL, 'http://127.0.0.1:2049/v1');
    assert.equal(withNested.explicitContextLimit, 600000);
    assert.equal(withNested.explicitOutputLimit, 16384);
    assert.equal(withNested.allowTools, true);
    assert.equal(withNested.proxy, 'http://127.0.0.1:1082');

    assert.throws(() => studioSettings({ studio: { stripCitations: true } }), /cannot be stripped/);
    assert.throws(() => studioSettings({ studio: { outputLimit: 10000, contextLimit: 5000 } }), /cannot exceed contextLimit/);
    assert.throws(() => studioSettings({ studio: { unknownKey: true } }), /Unknown studio option/);
  });

  it('3. models allow Argon with correct limits and variants, excludes specialist models', async () => {
    const c = { baseURL: serverURL, key: 'test-key' };
    const opts = studioSettings();
    const models = await listStudioModels(c, opts);

    assert.ok(models['gemini-4-argon']);
    const argon = models['gemini-4-argon'];
    assert.equal(argon.limit.context, 1048576);
    assert.equal(argon.limit.output, 32768);
    assert.deepEqual(argon.variants, { minimal: {}, low: {}, medium: {}, high: {} });
    assert.equal(argon.capabilities.toolcall, true);
    assert.equal(argon.capabilities.reasoning, true);
    assert.equal(argon.capabilities.temperature, true);
    assert.equal(argon.providerID, STUDIO_ID);

    // Specialists must be excluded
    assert.equal(models['gemini-2.5-flash-tts'], undefined);
    assert.equal(models['gemini-live-model'], undefined);
    assert.equal(models['gemini-nano-banana-pro'], undefined);

    // Non-thinking model has no variants and toolcall disabled when function_declarations is false
    assert.ok(models['gemini-nonthinking']);
    const nonthinking = models['gemini-nonthinking'];
    assert.deepEqual(nonthinking.variants, {});
    assert.equal(nonthinking.capabilities.toolcall, false);
    assert.equal(nonthinking.capabilities.reasoning, false);
  });

  it('3b. real v0.2.12 catalog yields only text chat models the account can call', async () => {
    // AIStudio2API v0.2.12 /v1/models, captured 2026-10-17; opaque capability_code_* flags removed.
    const catalog = JSON.parse(fs.readFileSync(new URL('./fixtures/studio-catalog-v0.2.12.json', import.meta.url), 'utf8'));
    const c = { baseURL: serverURL, key: 'test-key' };
    const opts = studioSettings();

    serverResponses['/v1/models'] = { status: 200, body: JSON.stringify(catalog) };
    try {
      const models = await listStudioModels(c, opts);
      assert.deepEqual(Object.keys(models).sort(), [
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite',
        'gemini-3.1-pro-preview',
        'gemini-3.5-flash-lite',
        'gemini-3.6-flash',
        'gemini-3.8-flash',
        'gemini-4-argon',
        'gemini-flash-latest',
        'gemini-flash-lite-latest',
        'gemini-pro-latest'
      ]);
      // Marked chat_model but made for images (aspect_ratio, interactions_api)
      assert.equal(models['gemini-omni-1.1-flash'], undefined);
      assert.equal(models['gemini-omni-flash-preview'], undefined);
      for (const model of Object.values(models)) {
        assert.equal(model.capabilities.toolcall, true, `${model.id} declares function calling`);
        assert.deepEqual(model.variants, { minimal: {}, low: {}, medium: {}, high: {} });
      }

      // A model no account's subscription covers is listed without channels (or with none)
      const argon = catalog.data.find(m => m.id === 'gemini-4-argon');
      const uncovered = {
        ...catalog,
        data: [
          ...catalog.data,
          { ...argon, id: 'gemini-4-ultra-only', channels: undefined },
          { ...argon, id: 'gemini-4-no-channel', channels: [] }
        ]
      };
      serverResponses['/v1/models'] = { status: 200, body: JSON.stringify(uncovered) };
      const covered = await listStudioModels(c, opts);
      assert.ok(covered['gemini-4-argon']);
      assert.equal(covered['gemini-4-ultra-only'], undefined);
      assert.equal(covered['gemini-4-no-channel'], undefined);

      // A backend that lists no channels at all keeps its models
      const noChannels = { ...catalog, data: catalog.data.map(({ channels, ...m }) => m) };
      serverResponses['/v1/models'] = { status: 200, body: JSON.stringify(noChannels) };
      assert.equal(Object.keys(await listStudioModels(c, opts)).length, 10);
    } finally {
      delete serverResponses['/v1/models'];
    }
  });

  it('4. explicit ceilings override only Studio output limit', async () => {
    const c = { baseURL: serverURL, key: 'test-key' };
    const opts = studioSettings({ studio: { outputLimit: 8192 } });
    const models = await listStudioModels(c, opts);
    assert.equal(models['gemini-4-argon'].limit.output, 8192);
    assert.equal(models['gemini-4-argon'].limit.context, 1048576);
  });

  it('5. model 401 expiry/error and malformed catalog rejected', async () => {
    const c = { baseURL: serverURL, key: 'test-key' };
    const opts = studioSettings();

    serverResponses['/v1/models'] = { status: 401, body: JSON.stringify({ error: 'unauthorized' }) };
    try {
      await listStudioModels(c, opts);
      assert.fail('should throw');
    } catch (err) {
      assert.equal(err.status, 401);
      assert.equal(err.signIn, 'expired');
    }

    serverResponses['/v1/models'] = { status: 500, body: 'Internal Error' };
    try {
      await listStudioModels(c, opts);
      assert.fail('should throw');
    } catch (err) {
      assert.equal(err.status, 500);
      assert.equal(err.signIn, undefined);
    }

    serverResponses['/v1/models'] = { status: 200, body: JSON.stringify({ data: 'not an array' }) };
    await assert.rejects(() => listStudioModels(c, opts), /expected data array/);

    serverResponses['/v1/models'] = { status: 200, body: JSON.stringify({ data: [] }) };
    await assert.rejects(() => listStudioModels(c, opts), /No usable Gemini models found/);

    delete serverResponses['/v1/models'];
  });

  it('6. forwarding preserves literal [cite: 1] and extra_content.google.thought_signature in SSE and JSON', async () => {
    const toolCall = {
      id: 'call_test',
      type: 'function',
      function: { name: 'probe', arguments: '{"test":"[cite: 1]"}' },
      extra_content: { google: { thought_signature: 'sig_fixture' } }
    };

    serverResponses['/v1/chat/completions'] = (req, res) => {
      const body = JSON.parse(serverRequests[serverRequests.length - 1].body);
      if (body.stream) {
        const chunk1 = { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Echo [cite: 1] ', tool_calls: [toolCall] } }] };
        const chunk2 = { id: 'c2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'c_json',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Literal [cite: 1]', tool_calls: [toolCall] }, finish_reason: 'stop' }]
        }));
      }
    };

    const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
    const auth = { type: 'api', key: 'test-key', metadata: { mode: 'studio', baseURL: serverURL } };
    const loader = await plugin.auth.loader(async () => auth);

    // Test SSE
    const reqSSE = {
      model: 'gemini-4-argon',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }]
    };
    const resSSE = await loader.fetch(`${serverURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqSSE)
    });
    assert.equal(resSSE.status, 200);
    const textSSE = await resSSE.text();
    assert.ok(textSSE.includes('[cite: 1]'), 'Citation marker must be preserved');
    assert.ok(textSSE.includes('sig_fixture'), 'Thought signature must be preserved');

    // Test JSON
    const reqJSON = {
      model: 'gemini-4-argon',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    };
    const resJSON = await loader.fetch(`${serverURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqJSON)
    });
    assert.equal(resJSON.status, 200);
    const bodyJSON = await resJSON.json();
    assert.equal(bodyJSON.choices[0].message.content, 'Literal [cite: 1]');
    assert.deepEqual(bodyJSON.choices[0].message.tool_calls[0].extra_content, toolCall.extra_content);

    delete serverResponses['/v1/chat/completions'];
  });

  it('7. medium reasoning does not fetch thinking twins or rewrite model ID', async () => {
    let receivedModel = null;
    serverResponses['/v1/chat/completions'] = (req, res, bodyStr) => {
      const parsed = JSON.parse(bodyStr);
      receivedModel = parsed.model;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp1', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    };

    const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
    const auth = { type: 'api', key: 'test-key', metadata: { mode: 'studio', baseURL: serverURL } };
    const loader = await plugin.auth.loader(async () => auth);

    await loader.fetch(`${serverURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-4-argon',
        reasoning_effort: 'medium',
        messages: [{ role: 'user', content: 'test' }]
      })
    });

    assert.equal(receivedModel, 'gemini-4-argon', 'Model name must not be rewritten to thinking twin');
    delete serverResponses['/v1/chat/completions'];
  });

  it('8. AbortSignal aborts stalled request and subsequent independent call succeeds', async () => {
    let unblockStall;
    const stallPromise = new Promise(resolve => { unblockStall = resolve; });
    serverResponses['/v1/chat/completions'] = async (req, res) => {
      await stallPromise;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
    };

    const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
    const auth = { type: 'api', key: 'test-key', metadata: { mode: 'studio', baseURL: serverURL } };
    const loader = await plugin.auth.loader(async () => auth);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(async () => {
      await loader.fetch(`${serverURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'stall' }] }),
        signal: controller.signal
      });
    });

    unblockStall();

    serverResponses['/v1/chat/completions'] = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fast' } }] }));
    };

    const nextRes = await loader.fetch(`${serverURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'next' }] })
    });
    assert.equal(nextRes.status, 200);
    const json = await nextRes.json();
    assert.equal(json.choices[0].message.content, 'fast');

    delete serverResponses['/v1/chat/completions'];
  });

  // standInSetup makes the data dir hold a managed setup whose service is the mock server, so a
  // managed sign-in finds it up and nothing is downloaded or started. It returns a cleanup.
  function standInSetup(apiKey) {
    const configPath = path.join(tempStudioDataDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1, port: serverPort, apiKey, adminUsername: 'magpie', adminPassword: 'stand-in-pw', proxy: ''
    }) + '\n', { mode: 0o600 });
    const bin = path.join(tempStudioDataDir, 'package', process.platform === 'win32' ? 'aistudio2api.exe' : 'aistudio2api');
    fs.mkdirSync(path.dirname(bin), { recursive: true, mode: 0o700 });
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(tempStudioDataDir, 'install-manifest.json'), JSON.stringify({
      version: STUDIO_VERSION.slice(1),
      platform: process.platform,
      arch: process.arch,
      archiveSha256: PINNED_ARCHIVES[`${process.platform}-${process.arch}`].sha256,
      binarySha256: computeFileHash(bin)
    }) + '\n', { mode: 0o600 });
    return {
      setKey(key) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        fs.writeFileSync(configPath, JSON.stringify({ ...config, apiKey: key }) + '\n', { mode: 0o600 });
      },
      remove() {
        for (const name of ['config.json', 'install-manifest.json', '.env', 'package', 'auth']) {
          fs.rmSync(path.join(tempStudioDataDir, name), { recursive: true, force: true });
        }
      }
    };
  }

  it('9. managed auth mismatched key/URL refuses, external does not start managed', async () => {
    const setup = standInSetup('managed-key');
    try {
      const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });

      // Managed auth with mismatched key: the service is up, and its key is another
      const badManagedAuth = {
        type: 'api',
        key: 'wrong-key',
        metadata: { mode: 'studio', managed: true, baseURL: serverURL }
      };
      await assert.rejects(plugin.auth.loader(async () => badManagedAuth), err => err.signIn === 'expired');

      // Managed auth that matches the local setup loads
      const managedAuth = {
        type: 'api',
        key: 'managed-key',
        metadata: { mode: 'studio', managed: true, baseURL: serverURL }
      };
      const loader = await plugin.auth.loader(async () => managedAuth);
      assert.equal(loader.apiKey, 'managed-key');
      assert.equal(loader.baseURL, serverURL);

      // The local key changes under a loaded sign-in: requests answer 401 with the expired
      // sign-in marker instead of throwing
      setup.setKey('rotated-key');
      const res = await loader.fetch(`${serverURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('x-magpie-sign-in'), 'expired');

      // External auth does not enforce localStudio matching
      const externalAuth = {
        type: 'api',
        key: 'ext-key',
        metadata: { mode: 'studio', managed: false, baseURL: serverURL }
      };
      const extLoader = await plugin.auth.loader(async () => externalAuth);
      assert.equal(extLoader.baseURL, serverURL);
      assert.equal(extLoader.apiKey, 'ext-key');
    } finally {
      setup.remove();
    }
  });

  it('9b. a managed sign-in whose install went missing is not marked expired before the service is back', async () => {
    const setup = standInSetup('managed-key');
    try {
      const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
      const managedAuth = {
        type: 'api',
        key: 'managed-key',
        metadata: { mode: 'studio', managed: true, baseURL: serverURL }
      };
      const loader = await plugin.auth.loader(async () => managedAuth);

      // The binary disappears (as mid-reinstall) while the service still answers: the request
      // goes through instead of reporting an expired sign-in
      fs.rmSync(path.join(tempStudioDataDir, 'package'), { recursive: true, force: true });
      const res = await loader.fetch(`${serverURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-4-argon', messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.equal(res.status, 200);

      const usage = await plugin.auth.usage(async () => managedAuth);
      assert.equal(usage.signIn, 'kept', 'a missing install is not a stale sign-in');
    } finally {
      setup.remove();
    }
  });

  const jsonHeaders = { 'Content-Type': 'application/json' };

  it('9c. one-click sign-in reports a failed login, and returns once the account is saved', async () => {
    const setup = standInSetup('managed-key');
    try {
      const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
      const oneClick = plugin.auth.methods[0];
      assert.match(oneClick.label, /（推荐）/);

      serverResponses['/api/accounts'] = { status: 500, headers: jsonHeaders, body: JSON.stringify({ error: { message: 'login window closed' } }) };
      const failing = await oneClick.authorize();
      assert.match(failing.instructions, /Camoufox/);
      assert.match(failing.instructions, /添加更多 Google 账号/);
      const failed = await failing.callback();
      assert.equal(failed.type, 'failed');
      assert.match(failed.error, /login window closed/);

      // Saved while generation is still launching: the sign-in doesn't wait for it
      let launching = true;
      serverResponses['/api/status'] = (req, res) => {
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify(launching
          ? { version: STUDIO_VERSION, state: 'LAUNCHING', running: false, ready: false, accounts: { total: 1, ready: 0, busy: 0, cooldown: 0, auth_required: 0 } }
          : { version: STUDIO_VERSION, state: 'RUNNING', running: true, ready: true, accounts: { total: 1, ready: 1, busy: 0, cooldown: 0, auth_required: 0 } }));
      };
      serverResponses['/api/accounts'] = {
        status: 201,
        headers: jsonHeaders,
        body: JSON.stringify({ account: { id: 'user@example.com', label: 'user@example.com', enabled: true, state: 'ready' } })
      };
      const pending = await oneClick.authorize();
      const result = await Promise.race([pending.callback(), new Promise(r => setTimeout(() => r('waited'), 2000))]);
      assert.notEqual(result, 'waited', 'the sign-in must not wait for generation to launch');
      assert.equal(result.type, 'success');
      assert.equal(result.key, 'managed-key');
      // One sign-in for the whole pool: no account or email, so adding another account keeps the one card
      assert.deepEqual(result.metadata, { mode: 'studio', managed: true, baseURL: serverURL });

      // Let the start the sign-in left running see generation come up
      launching = false;
      await new Promise(r => setTimeout(r, 400));
    } finally {
      delete serverResponses['/api/accounts'];
      delete serverResponses['/api/status'];
      setup.remove();
    }
  });

  const POOL = [
    { id: 'a@example.com', label: 'a@example.com', enabled: true, state: 'ready', models: ['gemini-4-argon', 'gemini-3-flash'] },
    { id: 'b@example.com', label: 'b@example.com', enabled: true, state: 'auth_required', message: 'refresh token revoked' },
    { id: 'c@example.com', label: 'c@example.com', enabled: false, state: 'disabled' }
  ];
  const accountsResponse = accounts => ({ status: 200, headers: jsonHeaders, body: JSON.stringify({ accounts }) });

  it('9d. using the existing service needs a local setup with an account, and signs in to the pool', async () => {
    const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
    const existing = plugin.auth.methods[1];
    assert.equal(existing.label, '使用本机已有的 AI Studio 服务');
    assert.equal(existing.prompts, undefined, 'there is no account to choose: the service picks one');

    // Nothing set up: say so instead of installing one
    await assert.rejects(existing.authorize({}), /还没有本地 Google AI Studio 服务/);
    assert.equal(fs.existsSync(path.join(tempStudioDataDir, 'package')), false, 'nothing may be installed');

    const setup = standInSetup('managed-key');
    try {
      serverResponses['/api/accounts'] = accountsResponse([POOL[2]]);
      await assert.rejects(existing.authorize({}), /没有启用的 Google 账号/);

      serverResponses['/api/accounts'] = accountsResponse(POOL);
      const pending = await existing.authorize({});
      const result = await pending.callback();
      assert.deepEqual(result, { type: 'success', key: 'managed-key', metadata: { mode: 'studio', managed: true, baseURL: serverURL } });
    } finally {
      delete serverResponses['/api/accounts'];
      setup.remove();
    }
  });

  it('9e. signing an expired account in again lists only those, and reports a login that failed', async () => {
    const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
    const relogin = plugin.auth.methods[2];
    assert.equal(relogin.label, '重新登录失效的 AI Studio 账号');
    await assert.rejects(relogin.ask({}), /还没有本地 Google AI Studio 服务/);

    const setup = standInSetup('managed-key');
    const loginURL = '/api/accounts/b%40example.com/login';
    try {
      serverResponses['/api/accounts'] = accountsResponse([POOL[0]]);
      await assert.rejects(relogin.ask({}), /没有需要重新登录的账号/);

      serverResponses['/api/accounts'] = accountsResponse(POOL);
      const question = await relogin.ask({});
      assert.deepEqual(question.options, [{ label: 'b@example.com', value: 'b@example.com', hint: 'refresh token revoked' }]);
      await assert.rejects(relogin.authorize({ account: 'a@example.com' }), /不需要重新登录/);

      const pending = await relogin.authorize({ account: 'b@example.com' });
      assert.match(pending.instructions, /Camoufox/);

      serverResponses[loginURL] = { status: 500, headers: jsonHeaders, body: JSON.stringify({ error: { message: 'login window closed' } }) };
      const failed = await pending.callback();
      assert.equal(failed.type, 'failed');
      assert.match(failed.error, /b@example\.com 没有重新登录：.*login window closed/);

      serverResponses[loginURL] = { status: 200, headers: jsonHeaders, body: JSON.stringify({ account: { ...POOL[1], state: 'auth_required', message: 'still revoked' } }) };
      const stillExpired = await pending.callback();
      assert.equal(stillExpired.type, 'failed');
      assert.match(stillExpired.error, /still revoked/);

      serverResponses[loginURL] = { status: 200, headers: jsonHeaders, body: JSON.stringify({ account: { ...POOL[1], state: 'ready', message: '' } }) };
      const before = serverRequests.length;
      const result = await pending.callback();
      assert.deepEqual(result, { type: 'success', key: 'managed-key', metadata: { mode: 'studio', managed: true, baseURL: serverURL } });
      assert.ok(serverRequests.slice(before).some(r => r.method === 'POST' && r.url === loginURL));
      await new Promise(r => setTimeout(r, 300));
    } finally {
      delete serverResponses['/api/accounts'];
      delete serverResponses[loginURL];
      setup.remove();
    }
  });

  it('10. usage never calls Web usage and external usage returns unavailable', async () => {
    const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });

    const extAuth = {
      type: 'api',
      key: 'ext-key',
      metadata: { mode: 'studio', managed: false, baseURL: serverURL }
    };
    const extUsage = await plugin.auth.usage(async () => extAuth);
    assert.deepEqual(extUsage.windows, []);
    assert.equal(extUsage.signIn, 'kept');
    assert.ok(extUsage.error.includes('外部服务不提供管理接口') || extUsage.error.includes('读不到'));

    const loggedOutUsage = await plugin.auth.usage(async () => null);
    assert.deepEqual(loggedOutUsage.windows, []);
    assert.ok(loggedOutUsage.error.includes('还没有登录'));
  });

  it('10b. the managed usage card names the pool and shows cooldowns, not a status line as an error', async () => {
    const setup = standInSetup('managed-key');
    const managedAuth = { type: 'api', key: 'managed-key', metadata: { mode: 'studio', managed: true, baseURL: serverURL } };
    const until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    try {
      const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
      serverResponses['/api/accounts'] = accountsResponse(POOL);
      serverResponses['/api/cooldowns'] = {
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({ cooldowns: [{ account_id: 'a@example.com', account_label: 'a@example.com', model_id: 'gemini-4-argon', until, reason: 'quota exhausted' }] })
      };
      const card = await plugin.auth.usage(async () => managedAuth);
      assert.equal(card.error, undefined, 'a pool that serves is no error');
      assert.equal(card.signIn, 'kept');
      assert.equal(card.user, 'a@example.com +1（1 个需要重新登录）', 'the disabled account is left out');
      assert.deepEqual(card.windows, [{ name: 'gemini-4-argon', used: 100, resetsAt: until, display: '1/1 个账号冷却中：quota exhausted' }]);

      // Cooldowns that can't be read leave the rest of the card
      serverResponses['/api/cooldowns'] = { status: 500, headers: jsonHeaders, body: '{}' };
      const partial = await plugin.auth.usage(async () => managedAuth);
      assert.equal(partial.error, undefined);
      assert.deepEqual(partial.windows, []);

      // No account can serve until one signs in again: say how to fix it
      serverResponses['/api/accounts'] = accountsResponse([POOL[1]]);
      const expired = await plugin.auth.usage(async () => managedAuth);
      assert.match(expired.error, /1 个 Google 账号都需要重新登录.*重新登录失效的 AI Studio 账号/);
      assert.equal(expired.signIn, 'kept', 'signing the account in again fixes this card as it is');

      // The service isn't running: it starts on the next request
      const closed = http.createServer();
      await new Promise(r => closed.listen(0, '127.0.0.1', r));
      const closedPort = closed.address().port;
      await new Promise(r => closed.close(r));
      const configPath = path.join(tempStudioDataDir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, port: closedPort }) + '\n', { mode: 0o600 });
      const downAuth = { ...managedAuth, metadata: { ...managedAuth.metadata, baseURL: `http://127.0.0.1:${closedPort}/v1` } };
      const down = await plugin.auth.usage(async () => downAuth);
      assert.match(down.error, /没有在运行，下一次请求时会自动启动/);
    } finally {
      delete serverResponses['/api/accounts'];
      delete serverResponses['/api/cooldowns'];
      setup.remove();
    }
  });

  it('10c. cooldown windows: one a model, as full as its share of accounts cooling, soonest back first', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const at = minutes => new Date(now + minutes * 60000).toISOString();
    const accounts = [
      { id: 'a', label: 'a@x', state: 'cooldown', models: ['m1', 'm2'] },
      { id: 'b', label: 'b@x', state: 'ready', models: ['m1'] },
      { id: 'c', label: 'c@x', state: 'auth_required', models: ['m1', 'm2'] }
    ];
    const windows = cooldownWindows([
      { account_id: 'a', model_id: 'm1', until: at(20), reason: 'r1' },
      { account_id: 'b', model_id: 'm1', until: at(10), reason: 'r2' },
      { account_id: 'a', model_id: 'm2', until: at(5), reason: 'x'.repeat(41) },
      { account_id: 'b', model_id: 'm2', until: at(-1) },
      { account_id: 'b', until: at(30) },
      { account_id: 'a', model_id: 'm3', until: 'not a time' }
    ], accounts, now);
    assert.deepEqual(windows, [
      // only a serves m2 (c must sign in again); b's cooldown ended; a reason too long is left out.
      // As full as m1, it is back sooner, so it comes first
      { name: 'm2', used: 100, resetsAt: at(5), display: '1/1 个账号冷却中' },
      // both accounts serving m1 cool down: none can serve it until the first is back; two reasons say neither
      { name: 'm1', used: 100, resetsAt: at(10), display: '2/2 个账号冷却中' },
      // a cooldown with no model is the account's: of the two that serve
      { name: '所有模型', used: 50, resetsAt: at(30), display: '1/2 个账号冷却中' }
    ]);

    assert.deepEqual(poolUsage([{ id: 'solo', state: 'ready' }], [], now), { user: 'solo', windows: [] });
    assert.match(poolUsage([], [], now).error, /还没有 Google 账号/);
    const unavailable = poolUsage([{ id: 'u', label: 'u@x', state: 'unavailable' }], [], now);
    assert.equal(unavailable.user, 'u@x（1 个暂时不可用）');
    assert.match(unavailable.error, /暂时都不可用/);
  });
});
