import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiWebPlugin, AIStudioPlugin } from '../index.mjs';
import { studioSettings, listStudioModels, cooldownWindows, poolUsage, accountUsage, accountQuestion, signInProgress, STUDIO_ID, STUDIO_BASE } from '../lib/studio.mjs';
import { forward, settings, UNREACHABLE_HEADER } from '../lib/backend.mjs';
import { serviceEnv, saveStudioProxy, computeFileHash, PINNED_ARCHIVES, STUDIO_VERSION, CAMOUFOX_VERSION, ensureStudio } from '../lib/studio-native.mjs';

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

    // Image input is on for AI Studio unless turned off, for both providers or for it alone;
    // Gemini Web keeps it off by default
    assert.equal(studioSettings().allowImages, true);
    assert.equal(studioSettings({ allowImages: false }).allowImages, false);
    assert.equal(studioSettings({ studio: { allowImages: false } }).allowImages, false);
    assert.equal(studioSettings({ allowImages: false, studio: { allowImages: true } }).allowImages, true);
    assert.equal(settings().allowImages, false);

    assert.equal(studioSettings().imageModels, true, 'Image models are listed by default');
    assert.equal(studioSettings({ studio: { imageModels: false } }).imageModels, false);
    assert.throws(() => studioSettings({ studio: { imageModels: 'no' } }), /studio\.imageModels: must be a boolean/);

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

  it('3b. real v0.2.12 catalog yields the text chat models and image models the account can call', async () => {
    // AIStudio2API v0.2.12 /v1/models, captured 2026-10-17; opaque capability_code_* flags removed.
    const catalog = JSON.parse(fs.readFileSync(new URL('./fixtures/studio-catalog-v0.2.12.json', import.meta.url), 'utf8'));
    const c = { baseURL: serverURL, key: 'test-key' };
    const opts = studioSettings();
    const textIds = [
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
    ];
    const imageIds = [
      'gemini-2.5-flash-image',
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite-image',
      'gemini-nano-banana-2.1'
    ];

    serverResponses['/v1/models'] = { status: 200, body: JSON.stringify(catalog) };
    try {
      const models = await listStudioModels(c, opts);
      assert.deepEqual(Object.keys(models).sort(), [...textIds, ...imageIds].sort());
      // Marked chat_model but made for images (aspect_ratio, interactions_api)
      assert.equal(models['gemini-omni-1.1-flash'], undefined);
      assert.equal(models['gemini-omni-flash-preview'], undefined);
      for (const id of textIds) {
        const model = models[id];
        assert.equal(model.capabilities.toolcall, true, `${model.id} declares function calling`);
        assert.deepEqual(model.variants, { minimal: {}, low: {}, medium: {}, high: {} });
        assert.deepEqual(model.capabilities.output, { text: true, image: false });
        assert.equal(model.capabilities.input.image, true, `${model.id} reads a chat's images by default (media_resolution)`);
        assert.equal(model.capabilities.attachment, true);
        assert.equal(model.api.npm, '@ai-sdk/openai-compatible');
      }
      // An image model draws, on Gemini's API, where Magpie draws with a plugin's Gemini image
      // model, and takes images to edit or draw from without allowImages
      for (const id of imageIds) {
        const model = models[id];
        assert.equal(model.api.npm, '@ai-sdk/google');
        assert.equal(model.api.url, serverURL);
        assert.deepEqual(model.capabilities.output, { text: true, image: true });
        assert.equal(model.capabilities.input.image, true);
        assert.equal(model.capabilities.attachment, true);
        assert.equal(model.capabilities.toolcall, false);
      }
      const banana = models['gemini-3.1-flash-image'];
      assert.equal(banana.name, 'Nano Banana 2');
      assert.equal(banana.limit.context, 65536);
      assert.deepEqual(banana.variants, { minimal: {}, low: {}, medium: {}, high: {} });
      assert.deepEqual(models['gemini-3-pro-image'].variants, {});

      // Turned off, only the text models are listed
      const textOnly = await listStudioModels(c, studioSettings({ studio: { imageModels: false } }));
      assert.deepEqual(Object.keys(textOnly).sort(), textIds);

      // Image input turned off, for both providers or for AI Studio alone: the text models take
      // no images, while an image model still takes them to edit or draw from
      for (const off of [{ allowImages: false }, { studio: { allowImages: false } }]) {
        const noImages = await listStudioModels(c, studioSettings(off));
        for (const id of textIds) {
          assert.equal(noImages[id].capabilities.input.image, false, `${id} with ${JSON.stringify(off)}`);
          assert.equal(noImages[id].capabilities.attachment, false);
        }
        for (const id of imageIds) assert.equal(noImages[id].capabilities.input.image, true);
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
      assert.equal(Object.keys(await listStudioModels(c, opts)).length, 15);
    } finally {
      delete serverResponses['/v1/models'];
    }
  });

  it('uses v0.2.17 model thinking levels and keeps the older catalog fallback', async () => {
    const catalog = JSON.parse(fs.readFileSync(new URL('./fixtures/studio-catalog-v0.2.12.json', import.meta.url), 'utf8'));
    const base = catalog.data.find(m => m.id === 'gemini-4-argon');
    serverResponses['/v1/models'] = { status: 200, body: JSON.stringify({ data: [
      { ...base, id: 'gemini-two-levels', thinking_levels: ['low', 'high'] },
      { ...base, id: 'gemini-no-levels', thinking_levels: [] },
      { ...base, id: 'gemini-invalid-levels', thinking_levels: ['high', '__proto__', null, 'high'] },
      base
    ] }) };
    try {
      const models = await listStudioModels({ baseURL: serverURL, key: 'test-key' }, studioSettings());
      assert.deepEqual(models['gemini-two-levels'].variants, { low: {}, high: {} });
      assert.deepEqual(models['gemini-no-levels'].variants, {});
      assert.deepEqual(models['gemini-invalid-levels'].variants, { high: {} });
      assert.deepEqual(models[base.id].variants, { minimal: {}, low: {}, medium: {}, high: {} });
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

  it('a chat\'s images reach the service by default, and are refused once image input is off', async () => {
    serverResponses['/v1/chat/completions'] = { status: 200, body: JSON.stringify({
      id: 'c_img', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'left=red, right=blue' }, finish_reason: 'stop' }]
    }) };
    const auth = { type: 'api', key: 'test-key', metadata: { mode: 'studio', baseURL: serverURL } };
    const chat = {
      model: 'gemini-3.5-flash-lite',
      stream: false,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'What color is each half?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n' } }
      ] }]
    };
    const ask = async options => {
      const plugin = await AIStudioPlugin({}, options);
      const loader = await plugin.auth.loader(async () => auth);
      return loader.fetch(`${serverURL}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chat)
      });
    };
    try {
      let res = await ask({ studio: { baseURL: serverURL } });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).choices[0].message.content, 'left=red, right=blue');
      assert.equal(serverRequests[serverRequests.length - 1].url, '/v1/chat/completions');
      assert.deepEqual(JSON.parse(serverRequests[serverRequests.length - 1].body).messages, chat.messages);

      const sent = serverRequests.length;
      for (const off of [{ allowImages: false, studio: { baseURL: serverURL } }, { studio: { baseURL: serverURL, allowImages: false } }]) {
        res = await ask(off);
        assert.equal(res.status, 400);
        assert.match((await res.json()).error.message, /Image input is turned off/);
      }
      assert.equal(serverRequests.length, sent, 'nothing refused reached the service');
    } finally {
      delete serverResponses['/v1/chat/completions'];
    }
  });

  it('an image model draws on Gemini\'s API at the service\'s /v1beta, its prompt\'s aspect ratio asked as imageConfig', async () => {
    const sse = 'data: {"candidates":[{"content":{"role":"model","parts":[{"inlineData":{"mimeType":"image/png","data":"aW1n"}}]},"finishReason":"STOP","index":0}]}\n\n';
    const streamPath = model => `/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    const unaryPath = '/v1beta/models/gemini-3.1-flash-image:generateContent';
    const image = (id, aspects) => ({
      id, object: 'model', supported_generation_methods: ['generateContent'],
      capabilities: { chat_model: true, image_route: true, aspect_ratio: true },
      ...(aspects ? { capability_options: { image_aspect_ratios: aspects } } : {})
    });
    const catalog = { data: [
      { id: 'gemini-4-argon', object: 'model', supported_generation_methods: ['generateContent'], capabilities: { chat_model: true, function_declarations: true } },
      // As v0.2.17 lists Nano Banana 2's: the usual ten, and four long ones
      image('gemini-3.1-flash-image', ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9', '4:1', '1:4', '8:1', '1:8']),
      // One whose entry lists none, which the service takes the usual ten for
      image('gemini-2.5-flash-image')
    ] };
    for (const model of ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-4-argon']) {
      serverResponses[streamPath(model)] = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse);
      };
    }
    serverResponses[unaryPath] = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"candidates":[]}');
    };
    serverResponses['/v1/models'] = { status: 200, body: JSON.stringify(catalog) };
    const auth = { type: 'api', key: 'test-key', metadata: { mode: 'studio', baseURL: serverURL } };
    const last = () => serverRequests[serverRequests.length - 1];
    // As Magpie asks a plugin's Gemini image model to draw: its prompt, a size's aspect ratio on a
    // line after it, an edit's picture, and images asked for beside text
    const drawing = (prompt, generationConfig = { responseModalities: ['TEXT', 'IMAGE'] }) => ({
      contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: 'cmVm' } }] }],
      generationConfig
    });
    try {
      // Magpie lists the models before it draws with one
      await listStudioModels({ baseURL: serverURL, key: 'test-key' }, studioSettings());
      const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
      const loader = await plugin.auth.loader(async () => auth);
      const draw = (body, path = '/models/gemini-3.1-flash-image:streamGenerateContent?alt=sse', method = 'POST', via = loader) =>
        via.fetch(`${serverURL}${path}`, {
          method, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'test-key' }, body: body && JSON.stringify(body)
        });
      const askedRatio = () => JSON.parse(last().body).generationConfig.imageConfig?.aspectRatio;

      let res = await draw(drawing('a magpie\n\nAspect ratio: 16:9. Transparent background.'));
      assert.equal(res.status, 200);
      assert.equal(await res.text(), sse);
      assert.equal(last().url, streamPath('gemini-3.1-flash-image'));
      assert.equal(last().headers.authorization, 'Bearer test-key');
      assert.deepEqual(JSON.parse(last().body), drawing('a magpie Transparent background.', {
        responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' }
      }));

      // A ratio the model takes is asked as it is, the long ones too
      for (const ratio of ['1:4', '1:8', '4:1', '8:1', '21:9']) {
        await draw(drawing(`a magpie\n\nAspect ratio: ${ratio}.`));
        assert.equal(askedRatio(), ratio);
        assert.equal(JSON.parse(last().body).contents[0].parts[0].text, 'a magpie');
      }
      // One it doesn't, as the nearest it does
      await draw(drawing('a magpie\n\nAspect ratio: 2:1.'));
      assert.equal(askedRatio(), '16:9');
      // A model whose entry lists none takes the usual ten
      await draw(drawing('a magpie\n\nAspect ratio: 4:1.'), '/models/gemini-2.5-flash-image:streamGenerateContent?alt=sse');
      assert.equal(last().url, streamPath('gemini-2.5-flash-image'));
      assert.equal(askedRatio(), '21:9');

      // One asked for already, or a prompt without the line, goes on as it came
      const asked = drawing('a magpie\n\nAspect ratio: 16:9.', { imageConfig: { aspectRatio: '1:1' } });
      await draw(asked);
      assert.deepEqual(JSON.parse(last().body), asked);
      await draw(drawing('a magpie'));
      assert.deepEqual(JSON.parse(last().body), drawing('a magpie'));

      res = await draw(drawing('a magpie'), '/models/gemini-3.1-flash-image:generateContent');
      assert.equal(res.status, 200);
      assert.equal(last().url, unaryPath);

      // The service refusing the key, as v0.2.18 says so on Gemini's API, asks for a sign-in again.
      // Google's own 403 is about the account, and goes on as it came, as any other error does.
      const unary = serverResponses[unaryPath];
      const geminiError = (code, status, message, details) => ({ error: { code, message, status, ...(details && { details }) } });
      const invalidKey = geminiError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.',
        [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }]);
      for (const [status, body] of [
        [400, invalidKey],
        // A streamGenerateContent without alt=sse has it in an array
        [400, [invalidKey]],
        [403, geminiError(403, 'PERMISSION_DENIED', "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.")]
      ]) {
        serverResponses[unaryPath] = { status, body: JSON.stringify(body) };
        res = await draw(drawing('a magpie'), '/models/gemini-3.1-flash-image:generateContent');
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('X-Magpie-Sign-In'), 'expired');
      }
      for (const [status, body] of [
        [403, JSON.stringify(geminiError(403, 'PERMISSION_DENIED', 'The caller does not have permission'))],
        [400, JSON.stringify(geminiError(400, 'INVALID_ARGUMENT', 'Unsupported aspect ratio'))],
        [400, 'not json']
      ]) {
        serverResponses[unaryPath] = { status, body };
        res = await draw(drawing('a magpie'), '/models/gemini-3.1-flash-image:generateContent');
        assert.equal(res.status, status);
        assert.equal(res.headers.get('X-Magpie-Sign-In'), null);
        assert.equal(await res.text(), body);
      }
      serverResponses[unaryPath] = unary;

      // Tools go on only as allowTools lets them, as on chat completions
      const withTools = { ...drawing('a magpie'), tools: [{ functionDeclarations: [{ name: 'probe', parameters: { type: 'object' } }] }] };
      await draw(withTools);
      assert.deepEqual(JSON.parse(last().body).tools, withTools.tools);

      const before = serverRequests.length;
      const noTools = await AIStudioPlugin({}, { studio: { baseURL: serverURL, allowTools: false } });
      const noToolsLoader = await noTools.auth.loader(async () => auth);
      res = await draw(withTools, undefined, 'POST', noToolsLoader);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /Tool calls are turned off/);
      res = await draw(withTools, '/models/gemini-4-argon:generateContent', 'POST', noToolsLoader);
      assert.equal(res.status, 400);

      // A text model is asked on chat completions, where allowImages holds
      res = await draw(drawing('a magpie'), '/models/gemini-4-argon:streamGenerateContent?alt=sse');
      assert.equal(res.status, 400);
      assert.match((await res.json()).error.message, /gemini-4-argon isn't one of AI Studio's image models/);
      res = await draw(drawing('a magpie'), '/models/gemini-unknown:generateContent');
      assert.equal(res.status, 400);

      assert.equal((await draw(undefined, '/models/gemini-3.1-flash-image:streamGenerateContent?alt=sse', 'GET')).status, 400);
      assert.equal((await draw(drawing('a magpie'), '/models/gemini-3.1-flash-image:streamGenerateContent?key=leak')).status, 400);
      assert.equal((await draw(drawing('a magpie'), '/models/gemini-3.1-flash-image:countTokens')).status, 404);
      // No images API: Magpie draws with these models on Gemini's API only
      assert.equal((await draw({ prompt: 'a magpie' }, '/images/generations')).status, 404);

      // Turned off, as for Gemini Web, there is no Gemini API
      const off = await AIStudioPlugin({}, { studio: { baseURL: serverURL, imageModels: false } });
      const offLoader = await off.auth.loader(async () => auth);
      assert.equal((await draw(drawing('a magpie'), '/models/gemini-3.1-flash-image:generateContent', 'POST', offLoader)).status, 404);
      const web = await forward(`${serverURL}/models/gemini-3.1-flash-image:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(drawing('a magpie'))
      }, async () => ({ type: 'api', key: 'test-key', metadata: { baseURL: serverURL } }), settings({ baseURL: serverURL }));
      assert.equal(web.status, 404);
      assert.deepEqual(serverRequests.slice(before).filter(r => r.url.startsWith('/v1beta/')), [], 'nothing refused reached the service');

      // A list grown old that can't be had again: the last one still holds, for the ratios a model
      // takes and for which models draw
      serverResponses['/v1/models'] = { status: 503, body: 'restarting' };
      const now = Date.now;
      Date.now = () => now() + 11 * 60 * 1000;
      try {
        const listed = serverRequests.filter(r => r.url === '/v1/models').length;
        res = await draw(drawing('a magpie\n\nAspect ratio: 1:4.'));
        assert.equal(res.status, 200);
        assert.equal(askedRatio(), '1:4');
        assert.equal(serverRequests.filter(r => r.url === '/v1/models').length, listed + 1, 'the old list was asked for again');
        const sent = serverRequests.length;
        res = await draw(drawing('a magpie'), '/models/gemini-4-argon:streamGenerateContent?alt=sse');
        assert.equal(res.status, 400);
        assert.match((await res.json()).error.message, /gemini-4-argon isn't one of AI Studio's image models/);
        assert.deepEqual(serverRequests.slice(sent).filter(r => r.url.startsWith('/v1beta/')), []);
      } finally {
        Date.now = now;
      }

      // With no list at all, what a model is isn't known: nothing goes on to the service
      const unlisted = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
      const unlistedLoader = await unlisted.auth.loader(async () => ({ ...auth, key: 'unlisted-key' }));
      const sent = serverRequests.length;
      res = await draw(drawing('a magpie\n\nAspect ratio: 1:4.'), undefined, 'POST', unlistedLoader);
      assert.equal(res.status, 503);
      assert.match((await res.json()).error.message, /Can't tell whether gemini-3\.1-flash-image is one of AI Studio's image models: .*HTTP 503/);
      serverResponses['/v1/models'] = { status: 401, body: 'bad key' };
      res = await draw(drawing('a magpie'), undefined, 'POST', unlistedLoader);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('X-Magpie-Sign-In'), 'expired');
      assert.deepEqual(serverRequests.slice(sent).filter(r => r.url.startsWith('/v1beta/')), []);

      // An unreachable service is answered as one, for a managed one to be started again
      const closed = http.createServer();
      await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
      const goneURL = `http://127.0.0.1:${closed.address().port}/v1`;
      await new Promise(resolve => closed.close(resolve));
      const gone = await AIStudioPlugin({}, { studio: { baseURL: goneURL } });
      const goneLoader = await gone.auth.loader(async () => ({ ...auth, metadata: { mode: 'studio', baseURL: goneURL } }));
      res = await goneLoader.fetch(`${goneURL}/models/gemini-3.1-flash-image:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(drawing('a magpie'))
      });
      assert.equal(res.status, 502);
      assert.equal(res.headers.get(UNREACHABLE_HEADER), 'unreachable');
    } finally {
      for (const model of ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-4-argon']) delete serverResponses[streamPath(model)];
      delete serverResponses[unaryPath];
      delete serverResponses['/v1/models'];
    }
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
  // fakeCamoufox puts where the service would have downloaded Camoufox an executable of its name
  // (and the version the service pins in its application.ini)
  const fakeCamoufox = () => {
    const exe = { win32: 'camoufox.exe', linux: 'camoufox-bin', darwin: path.join('Camoufox.app', 'Contents', 'MacOS', 'camoufox') }[process.platform];
    const file = path.join(tempStudioDataDir, 'runtime', 'camoufox', exe);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.writeFileSync(path.join(path.dirname(file), 'application.ini'), `[App]\nVersion=${CAMOUFOX_VERSION}\n`);
  };

  it('9c. one-click sign-in reports a failed login, and returns once the account is saved', async () => {
    const setup = standInSetup('managed-key');
    try {
      const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
      const oneClick = plugin.auth.methods[0];
      assert.match(oneClick.label, /（推荐）/);

      serverResponses['/api/accounts'] = { status: 500, headers: jsonHeaders, body: JSON.stringify({ error: { message: 'login window closed' } }) };
      // Before an account is signed in, only the sign-in can show the proxy the login window goes through
      serverResponses['/api/config'] = { status: 200, headers: jsonHeaders, body: JSON.stringify({ proxy: '', active_proxy: 'http://127.0.0.1:9393', service_restart_required: false }) };
      // Camoufox not downloaded yet: the sign-in opens a page that shows how that goes
      const failing = await oneClick.authorize();
      assert.match(failing.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
      assert.match(failing.instructions, /^下载和登录的进度显示在刚打开的浏览器页面里[^\n]*\n第一次登录要先下载登录用的浏览器 Camoufox/, 'a running service needs no setup line');
      assert.match(failing.instructions, /每个账号一张卡片/);
      assert.match(failing.instructions, /\n本地服务的代理出口：http:\/\/127\.0\.0\.1:9393（自动检测：系统代理设置）$/);
      assert.match(await (await fetch(failing.url)).text(), /<title>Google AI Studio 登录进度<\/title>/);
      const failed = await failing.callback();
      assert.equal(failed.type, 'failed');
      assert.match(failed.error, /login window closed[^]*本地服务的代理出口：http:\/\/127\.0\.0\.1:9393/);
      const shown = await (await fetch(`${failing.url}/status`)).json();
      assert.deepEqual(shown.steps.map(s => s.state), ['done', 'failed', 'pending'], 'it failed while Camoufox was missing');
      assert.equal(shown.error, failed.error);
      delete serverResponses['/api/config'];

      // With Camoufox there, a running service has nothing to wait for: no page
      fakeCamoufox();

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
      assert.equal(pending.url, '');
      assert.match(pending.instructions, /^第一次登录要先下载登录用的浏览器 Camoufox/);
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
      delete serverResponses['/api/config'];
      fs.rmSync(path.join(tempStudioDataDir, 'runtime'), { recursive: true, force: true });
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

    // Nor does the sign-in before its instructions show: the download waits in the callback
    const first = await google.authorize({});
    assert.match(first.instructions, /^本地 AI Studio 服务还没启动[^\n]*约 40 MB[^\n]*studio\.proxy[^\n]*\n下载和登录的进度显示在[^]*Camoufox/);
    assert.equal(fs.existsSync(path.join(tempStudioDataDir, 'package')), false, 'authorize may not install');
    const shown = await (await fetch(`${first.url}/status`)).json();
    assert.deepEqual(shown.steps.map(s => [s.state, s.detail ?? '']), [['active', '正在检查'], ['pending', ''], ['pending', '']]);

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

  it('9f. the account question doesn\'t wait out a long start, which the new account\'s page shows', async () => {
    const plugin = await AIStudioPlugin({}, { studio: { baseURL: serverURL } });
    const setup = standInSetup('managed-key');
    const configPath = path.join(tempStudioDataDir, 'config.json');
    const lockPath = path.join(tempStudioDataDir, '.setup.lock');
    try {
      // Nothing answers on its port, and another start (this process, alive) holds the setup lock
      const closed = http.createServer();
      await new Promise(r => closed.listen(0, '127.0.0.1', r));
      const { port } = closed.address();
      await new Promise(r => closed.close(r));
      fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), port }) + '\n', { mode: 0o600 });
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}\nanother\n`);

      const asked = Date.now();
      assert.equal(await accountQuestion({}, 200), null, 'no list of accounts: straight to a new one');
      assert.ok(Date.now() - asked < 5000);

      // whose sign-in shows the start still under way on its page
      const signIn = await plugin.auth.methods[0].authorize({});
      assert.match(signIn.instructions, /^本地 AI Studio 服务还没启动/);
      const shown = await (await fetch(`${signIn.url}/status`)).json();
      assert.deepEqual(shown.steps.map(s => s.state), ['active', 'pending', 'pending']);
    } finally {
      fs.rmSync(lockPath, { force: true });
      // The start that waited goes on (and fails: the stand-in exits at once) before the next test
      await ensureStudio({ managementOnly: true }).catch(() => {});
      for (const name of ['backend.log', 'backend.pid', 'backend.launch.json']) fs.rmSync(path.join(tempStudioDataDir, name), { force: true });
      setup.remove();
    }
  });

  it('9g. a progress page keeps how its sign-in ended, whatever ends after', async () => {
    const late = await signInProgress(false);
    const status = async () => (await fetch(`${late.url}/status`)).json();
    late.end('Google 登录没有完成：超过了 Magpie 等登录的 10 分钟。');
    // The setup it gave up on finishes, and so does the login after it
    late.login();
    late.end();
    const shown = await status();
    assert.equal(shown.done, false);
    assert.match(shown.error, /10 分钟/);
    assert.deepEqual(shown.steps.map(s => s.state), ['failed', 'pending', 'pending']);
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
