import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiWebPlugin, AIStudioPlugin } from '../index.mjs';
import { studioSettings, listStudioModels, cooldownWindows, poolUsage, accountUsage, STUDIO_ID, STUDIO_BASE } from '../lib/studio.mjs';
import { forward } from '../lib/backend.mjs';
import { serviceEnv, saveStudioProxy, computeFileHash, PINNED_ARCHIVES, STUDIO_VERSION } from '../lib/studio-native.mjs';

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
    const savedEnv = process.env.AI_STUDIO_PROXY;
    try {
      delete process.env.AI_STUDIO_PROXY;
      assert.equal('PROXY' in serviceEnv(tempStudioDataDir, sampleConfig), false, 'Without studio.proxy the service takes the PROXY saved in .env');
      assert.equal('PROXY' in serviceEnv(tempStudioDataDir, sampleConfig, { proxy: '' }), false, 'An empty studio.proxy names none');
      assert.equal(serviceEnv(tempStudioDataDir, sampleConfig, { proxy: 'http://127.0.0.1:1082' }).PROXY, 'http://127.0.0.1:1082');
    } finally {
      if (savedEnv === undefined) delete process.env.AI_STUDIO_PROXY;
      else process.env.AI_STUDIO_PROXY = savedEnv;
    }

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

  it('Studio defaults to a 30-minute wait and still respects explicit timeouts', () => {
    assert.equal(studioSettings().requestTimeoutMs, 1800000);
    assert.equal(studioSettings({ requestTimeoutMs: 120000 }).requestTimeoutMs, 120000);
    assert.equal(studioSettings({ requestTimeoutMs: 120000, studio: { requestTimeoutMs: 600000 } }).requestTimeoutMs, 600000);
  });

  it('v0.2.13 Build assistant models are excluded without hiding ordinary chat models', async () => {
    const catalog = JSON.parse(fs.readFileSync(new URL('./fixtures/studio-catalog-v0.2.12.json', import.meta.url), 'utf8'));
    const base = catalog.data.find(m => m.id === 'gemini-4-argon');
    // Matches upstream assistantModelEntry: only chat/thinking capabilities survive.
    const assistant = { ...base, id: 'gemini-4-argon-build', channels: ['assistant'],
      capabilities: { assistant_route: true, chat_model: true, thinking: true, thinking_level: true } };
    serverResponses['/v1/models'] = { status: 200, body: JSON.stringify({ data: [base, assistant,
      { ...assistant, id: 'gemini-assistant-alias' },
      { ...base, id: 'gemini-legacy-build', capabilities: { chat_model: true } }
    ] }) };
    try {
      const models = await listStudioModels({ baseURL: serverURL, key: 'test-key' }, studioSettings());
      assert.deepEqual(Object.keys(models), ['gemini-4-argon']);
      assert.equal(models['gemini-4-argon'].capabilities.toolcall, true);
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

  it('stream interruption errors pass through without a successful finish or retry', async () => {
    const stream = 'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n' +
      'data: {"error":{"message":"upstream stream interrupted","type":"server_error"}}\n\n';
    let requests = 0;
    serverResponses['/v1/chat/completions'] = (_req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(stream);
    };
    try {
      const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
      const loader = await plugin.auth.loader(async () => ({ type: 'api', key: 'test-key', metadata: { mode: 'studio', baseURL: serverURL } }));
      const res = await loader.fetch(`${serverURL}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-4-argon', stream: true, messages: [{ role: 'user', content: 'test' }] })
      });
      assert.equal(await res.text(), stream);
      assert.equal(requests, 1);
    } finally {
      delete serverResponses['/v1/chat/completions'];
    }
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
        const pkg = path.join(tempStudioDataDir, 'package');
        if (fs.existsSync(pkg)) fs.chmodSync(pkg, 0o755);
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
      fs.chmodSync(path.join(tempStudioDataDir, 'package'), 0o755);
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
      // Before an account is signed in, only the sign-in can show the proxy the login window goes through
      serverResponses['/api/config'] = { status: 200, headers: jsonHeaders, body: JSON.stringify({ proxy: '', active_proxy: 'http://127.0.0.1:9393', service_restart_required: false }) };
      const failing = await oneClick.authorize();
      assert.match(failing.instructions, /Camoufox/);
      assert.match(failing.instructions, /每个账号一张卡片/);
      assert.match(failing.instructions, /\n本地服务的代理出口：http:\/\/127\.0\.0\.1:9393（自动检测：HTTPS_PROXY 环境变量或系统代理）$/);
      const failed = await failing.callback();
      assert.equal(failed.type, 'failed');
      assert.match(failed.error, /login window closed[^]*本地服务的代理出口：http:\/\/127\.0\.0\.1:9393/);
      delete serverResponses['/api/config'];

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
      // Each Google account is a sign-in of its own, named by its email
      assert.deepEqual(result.metadata, { mode: 'studio', managed: true, baseURL: serverURL, account: 'user@example.com', email: 'user@example.com' });

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

  const signInFor = account => ({ type: 'success', key: 'managed-key', metadata: { mode: 'studio', managed: true, baseURL: serverURL, account, email: account } });

  it('9d. one sign-in way asks nothing the first time, then offers a new account or a local one', async () => {
    const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
    assert.deepEqual(plugin.auth.methods.map(m => m.label), ['用 Google 账号登录（推荐）', '连接已有 AIStudio2API（地址 + API key）']);
    const google = plugin.auth.methods[0];

    // Nothing set up: no question, and asking installs nothing (authorize sets it up)
    assert.equal(await google.ask({}), null);
    assert.equal(fs.existsSync(path.join(tempStudioDataDir, 'package')), false, 'nothing may be installed');

    const setup = standInSetup('managed-key');
    try {
      serverResponses['/api/accounts'] = accountsResponse([POOL[2]]);
      assert.equal(await google.ask({}), null, 'no enabled account: straight to adding one');

      serverResponses['/api/accounts'] = accountsResponse(POOL);
      const question = await google.ask({});
      assert.deepEqual(question.options, [
        { label: '添加新的 Google 账号', value: '+new', hint: '打开登录窗口' },
        { label: 'a@example.com', value: 'a@example.com', hint: '可用' },
        { label: 'b@example.com', value: 'b@example.com', hint: '需要重新登录：会打开登录窗口' }
      ]);
      assert.equal(await google.ask({ account: 'a@example.com' }), null, 'answered: nothing more to ask');

      // An account that serves gets its card at once
      const ready = await google.authorize({ account: 'a@example.com' });
      assert.equal(ready.instructions, '');
      assert.deepEqual(await ready.callback(), signInFor('a@example.com'));

      // A new one opens the login window
      assert.match((await google.authorize({ account: '+new' })).instructions, /Camoufox/);
      await assert.rejects(google.authorize({ account: 'c@example.com' }), /没有启用的账号 c@example\.com/);
    } finally {
      delete serverResponses['/api/accounts'];
      setup.remove();
    }
  });

  it('9e. choosing an account that must sign in again opens the login window, and reports a login that failed', async () => {
    const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
    const google = plugin.auth.methods[0];
    const setup = standInSetup('managed-key');
    const loginURL = '/api/accounts/b%40example.com/login';
    try {
      serverResponses['/api/accounts'] = accountsResponse(POOL);
      const pending = await google.authorize({ account: 'b@example.com' });
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
      assert.deepEqual(result, signInFor('b@example.com'), 'the account signed in again keeps its own card');
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

  it('10b. an account\'s usage card shows its own cooldowns, or why it can\'t serve', async () => {
    const setup = standInSetup('managed-key');
    const authFor = account => ({ type: 'api', key: 'managed-key', metadata: signInFor(account).metadata });
    const until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    try {
      const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
      serverResponses['/api/accounts'] = accountsResponse(POOL);
      serverResponses['/api/cooldowns'] = {
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({ cooldowns: [
          { account_id: 'a@example.com', model_id: 'gemini-4-argon', until, reason: 'quota exhausted' },
          { account_id: 'b@example.com', model_id: 'gemini-3-flash', until }
        ] })
      };
      const a = await plugin.auth.usage(async () => authFor('a@example.com'));
      const [cooldown, admin] = a.windows;
      assert.deepEqual({ ...a, windows: [cooldown] }, { user: 'a@example.com', windows: [{ name: 'gemini-4-argon', used: 100, resetsAt: until, display: '冷却中：quota exhausted' }], signIn: 'kept' });
      // Below the account's own windows, where the service's admin page is (its proxy can't be read here)
      assert.equal(a.windows.length, 2);
      assert.equal(admin.name, '管理页');
      assert.ok(admin.display.startsWith(`${serverURL.replace(/\/v1$/, '')}（用户名 magpie，密码是 `) && admin.display.includes('config.json'));

      const b = await plugin.auth.usage(async () => authFor('b@example.com'));
      assert.match(b.error, /这个 Google 账号需要重新登录.*用 Google 账号登录（推荐）.*再选这个账号/);
      assert.equal(b.signIn, 'kept', 'signing the account in again fixes this card as it is');

      const gone = await plugin.auth.usage(async () => authFor('c@example.com'));
      assert.match(gone.error, /已经没有这个账号（c@example\.com）/);
    } finally {
      delete serverResponses['/api/accounts'];
      delete serverResponses['/api/cooldowns'];
      setup.remove();
    }
  });

  it('10b2. a 0.5.0 sign-in for the whole pool names the pool and shows its cooldowns', async () => {
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
      const pool = card.windows.filter(w => w.name !== '管理页');
      assert.deepEqual(pool, [{ name: 'gemini-4-argon', used: 100, resetsAt: until, display: '1/1 个账号冷却中：quota exhausted' }]);

      // The proxy the service goes out through, and why the one saved in the admin page isn't it yet
      serverResponses['/api/config'] = { status: 200, headers: jsonHeaders, body: JSON.stringify({ proxy: '', active_proxy: 'http://127.0.0.1:9393' }) };
      saveStudioProxy(tempStudioDataDir, 'socks5://127.0.0.1:7890');
      const proxied = await plugin.auth.usage(async () => managedAuth);
      const proxyWindow = proxied.windows.find(w => w.name === '代理出口');
      assert.match(proxyWindow.display, /^http:\/\/127\.0\.0\.1:9393（服务启动时的设置）；管理页设置的是 socks5:\/\/127\.0\.0\.1:7890，重启本地服务（.* stop.*，下一次请求会自动启动）后生效$/);
      delete serverResponses['/api/config'];

      // Cooldowns that can't be read leave the rest of the card
      serverResponses['/api/cooldowns'] = { status: 500, headers: jsonHeaders, body: '{}' };
      const partial = await plugin.auth.usage(async () => managedAuth);
      assert.equal(partial.error, undefined);
      assert.deepEqual(partial.windows.map(w => w.name), ['管理页']);

      // No account can serve until one signs in again: say how to fix it
      serverResponses['/api/accounts'] = accountsResponse([POOL[1]]);
      const expired = await plugin.auth.usage(async () => managedAuth);
      assert.match(expired.error, /1 个 Google 账号都需要重新登录.*用 Google 账号登录（推荐）/);
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
    // One account: its cooldowns alone, soonest back first; one with no model is all of them
    const mine = accountUsage(accounts[0], [
      { account_id: 'a', model_id: 'm1', until: at(20), reason: 'r1' },
      { account_id: 'b', model_id: 'm1', until: at(10) },
      { account_id: 'a', until: at(5), reason: 'x'.repeat(41) },
      { account_id: 'a', model_id: 'm2', until: at(-1) }
    ], now);
    assert.deepEqual(mine, { user: 'a@x', windows: [
      { name: '所有模型', used: 100, resetsAt: at(5), display: '冷却中' },
      { name: 'm1', used: 100, resetsAt: at(20), display: '冷却中：r1' }
    ] });
    assert.deepEqual(accountUsage({ id: 'u', state: 'unavailable', message: 'proxy down' }, [], now), { user: 'u', error: '这个 Google 账号暂时不可用：proxy down', windows: [] });

    const unavailable = poolUsage([{ id: 'u', label: 'u@x', state: 'unavailable' }], [], now);
    assert.equal(unavailable.user, 'u@x（1 个暂时不可用）');
    assert.match(unavailable.error, /暂时都不可用/);
  });
});
