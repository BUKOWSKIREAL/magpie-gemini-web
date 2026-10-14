import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiWebPlugin } from '../index.mjs';
import {
  DEFAULT_BASE,
  normalizeBaseURL,
  settings,
  credentials,
  listModels,
  forward
} from '../lib/backend.mjs';

// The plugin starts the backend it manages in the data dir; keep tests away from the real one.
process.env.GEMINI_WEB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-gemini-web-test-'));

describe('1. URL normalization/root/subpath/HTTPS/local IPv6', () => {
  it('normalizes root path to /v1', () => {
    assert.equal(normalizeBaseURL('http://127.0.0.1:8083'), 'http://127.0.0.1:8083/v1');
    assert.equal(normalizeBaseURL('http://127.0.0.1:8083/'), 'http://127.0.0.1:8083/v1');
  });

  it('preserves existing /v1 and strips trailing slashes', () => {
    assert.equal(normalizeBaseURL('http://127.0.0.1:8083/v1'), 'http://127.0.0.1:8083/v1');
    assert.equal(normalizeBaseURL('http://127.0.0.1:8083/v1/'), 'http://127.0.0.1:8083/v1');
  });

  it('supports subpaths ending in /v1 on HTTPS', () => {
    assert.equal(normalizeBaseURL('https://gateway.example.com/proxy/v1'), 'https://gateway.example.com/proxy/v1');
    assert.equal(normalizeBaseURL('https://gateway.example.com/proxy/v1/'), 'https://gateway.example.com/proxy/v1');
  });

  it('supports local loopback IPv6 and localhost', () => {
    assert.equal(normalizeBaseURL('http://[::1]:8083'), 'http://[::1]:8083/v1');
    assert.equal(normalizeBaseURL('http://localhost:8083/'), 'http://localhost:8083/v1');
  });
});

describe('2. Reject remote HTTP, userinfo, query, fragment', () => {
  it('rejects remote HTTP', () => {
    assert.throws(() => normalizeBaseURL('http://remote-server.com/v1'), /HTTP only allowed for local loopback/);
  });

  it('rejects userinfo credentials in URL', () => {
    assert.throws(() => normalizeBaseURL('http://user:secret@127.0.0.1:8083/v1'), /credentials not allowed/);
  });

  it('rejects query parameters', () => {
    assert.throws(() => normalizeBaseURL('http://127.0.0.1:8083/v1?api_key=secret'), /query parameters not allowed/);
  });

  it('rejects URL fragments', () => {
    assert.throws(() => normalizeBaseURL('http://127.0.0.1:8083/v1#token'), /URL fragment not allowed/);
  });

  it('rejects invalid paths not ending in /v1', () => {
    assert.throws(() => normalizeBaseURL('http://127.0.0.1:8083/v2'), /path must end in \/v1/);
    assert.throws(() => normalizeBaseURL('http://127.0.0.1:8083/chat'), /path must end in \/v1/);
  });

  it('does not echo secret input in error message', () => {
    const sensitive = 'http://127.0.0.1:8083/v1?token=SUPER_SECRET_12345';
    try {
      normalizeBaseURL(sensitive);
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.message.includes('SUPER_SECRET_12345'), false);
    }
  });
});

describe('3. Invalid options validation', () => {
  it('accepts valid options and sets defaults', () => {
    const s = settings();
    assert.equal(s.baseURL, DEFAULT_BASE);
    assert.equal(s.allowTools, false);
    assert.equal(s.allowImages, false);
    assert.equal(s.contextLimit, 32768);
    assert.equal(s.outputLimit, 8192);
    assert.equal(s.requestTimeoutMs, 240000);
    assert.equal(s.modelTimeoutMs, 10000);
  });

  it('rejects unknown options to catch typos', () => {
    assert.throws(() => settings({ unknownOption: true }), /Unknown plugin option/);
  });

  it('rejects invalid option types', () => {
    assert.throws(() => settings({ allowTools: 'yes' }), /allowTools: must be a boolean/);
    assert.throws(() => settings({ allowImages: 'no' }), /allowImages: must be a boolean/);
    assert.throws(() => settings({ contextLimit: -10 }), /contextLimit: must be a positive integer/);
    assert.throws(() => settings({ outputLimit: 0 }), /outputLimit: must be a positive integer/);
    assert.throws(() => settings({ outputLimit: 50000, contextLimit: 32768 }), /outputLimit: cannot exceed contextLimit/);
    assert.throws(() => settings({ requestTimeoutMs: 'slow' }), /requestTimeoutMs: must be a positive integer/);
    assert.throws(() => settings({ modelTimeoutMs: -1 }), /modelTimeoutMs: must be a positive integer/);
  });
});

describe('4. Auth metadata precedence and key CRLF', () => {
  it('extracts trimmed key and default baseURL', () => {
    const creds = credentials({ type: 'api', key: '  gw_testkey123  ' }, settings());
    assert.equal(creds.key, 'gw_testkey123');
    assert.equal(creds.baseURL, DEFAULT_BASE);
  });

  it('metadata.baseURL takes precedence over opts.baseURL', () => {
    const opts = settings({ baseURL: 'http://127.0.0.1:9000/v1' });
    const creds = credentials({
      type: 'api',
      key: 'gw_key',
      metadata: { baseURL: 'https://proxy.example.com/v1' }
    }, opts);
    assert.equal(creds.baseURL, 'https://proxy.example.com/v1');
  });

  it('rejects CR or LF in API key', () => {
    assert.throws(() => credentials({ type: 'api', key: 'gw_key\r\n' }, settings()), /API key must not contain newline/);
    assert.throws(() => credentials({ type: 'api', key: 'gw_\nkey' }, settings()), /API key must not contain newline/);
  });

  it('rejects empty or missing API key', () => {
    assert.throws(() => credentials({ type: 'api', key: '   ' }, settings()), /API key must not be empty/);
    assert.throws(() => credentials({ type: 'api' }, settings()), /API key must be a string/);
  });
});

describe('5. Config preserves user override', () => {
  it('does not overwrite existing config.provider["gemini-web"]', async () => {
    const plugin = await GeminiWebPlugin({}, { baseURL: 'http://127.0.0.1:8083/v1' });
    const cfg = {
      provider: {
        'gemini-web': { name: 'Custom Name', api: 'http://custom:1234/v1', models: { custom: {} } }
      }
    };
    await plugin.config(cfg);
    assert.equal(cfg.provider['gemini-web'].name, 'Custom Name');
    assert.equal(cfg.provider['gemini-web'].api, 'http://custom:1234/v1');
  });
});

describe('6. Logged out loader returns {}', () => {
  it('returns empty object when getAuth returns null or non-api', async () => {
    const plugin = await GeminiWebPlugin({});
    const res1 = await plugin.auth.loader(async () => null);
    assert.deepEqual(res1, {});

    const res2 = await plugin.auth.loader(async () => ({ type: 'oauth' }));
    assert.deepEqual(res2, {});
  });
});

describe('7. API prompt default validation', () => {
  it('validates blank or valid URL and returns error string for invalid', async () => {
    const plugin = await GeminiWebPlugin({});
    const validate = plugin.auth.methods.find(m => m.type === 'api').prompts[0].validate;

    assert.equal(validate(''), undefined);
    assert.equal(validate('http://127.0.0.1:8083/v1'), undefined);
    assert.equal(validate('http://127.0.0.1:8083'), undefined);
    const err = validate('ftp://invalid');
    assert.equal(typeof err, 'string');
    assert.match(err, /protocol must be HTTP or HTTPS/);
  });

  it('authorize persists the resolved baseURL when the prompt is left blank', async () => {
    const plugin = await GeminiWebPlugin({}, { baseURL: 'http://127.0.0.1:9000' });
    const authorize = plugin.auth.methods.find(m => m.type === 'api').authorize;

    assert.deepEqual(await authorize({ baseURL: '' }), {
      type: 'success',
      metadata: { baseURL: 'http://127.0.0.1:9000/v1' }
    });
    assert.deepEqual(await authorize({}), {
      type: 'success',
      metadata: { baseURL: 'http://127.0.0.1:9000/v1' }
    });
    assert.deepEqual(await authorize({ baseURL: 'https://proxy.example.com/' }), {
      type: 'success',
      metadata: { baseURL: 'https://proxy.example.com/v1' }
    });
  });
});

describe('8. Dynamic model list dedup/media exclusion/empty/malformed 401 expired vs 429/403 not expired', () => {
  let server;
  let serverPort;
  let serverHandler;

  before(async () => {
    server = http.createServer((req, res) => serverHandler(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('filters models, deduplicates, excludes media special models', async () => {
    serverHandler = (req, res) => {
      assert.equal(req.url, '/v1/models');
      assert.equal(req.headers['authorization'], 'Bearer test_key');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gemini-2.5-flash', object: 'model' },
          { id: 'gemini-2.5-flash', object: 'model' },
          { id: 'gemini-2.5-flash-image', object: 'model' },
          { id: 'gemini-canvas-pro', object: 'model' },
          { id: 'gemini-research-agent', object: 'model' },
          { id: 'gpt-4o', object: 'model' },
          { id: 'gemini-3.1-pro', object: 'model' }
        ]
      }));
    };

    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    const opts = settings();
    const models = await listModels(c, opts);

    assert.deepEqual(Object.keys(models), ['gemini-2.5-flash', 'gemini-3.1-pro']);
    assert.equal(models['gemini-2.5-flash'].id, 'gemini-2.5-flash');
    assert.equal(models['gemini-2.5-flash'].name, 'gemini-2.5-flash');
    assert.equal(models['gemini-2.5-flash'].cost.input, 0);
  });

  it('throws error when no usable Gemini models are returned', async () => {
    serverHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'gemini-video-preview' }]
      }));
    };

    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    await assert.rejects(
      async () => listModels(c, settings()),
      /No usable Gemini models found/
    );
  });

  it('throws error on malformed model response', async () => {
    serverHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'error', data: 'not an array' }));
    };

    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    await assert.rejects(
      async () => listModels(c, settings()),
      /expected data array/
    );
  });

  it('sets signIn=expired ONLY on HTTP 401', async () => {
    serverHandler = (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    };
    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    try {
      await listModels(c, settings());
      assert.fail('should reject');
    } catch (err) {
      assert.equal(err.status, 401);
      assert.equal(err.signIn, 'expired');
    }
  });

  it('does NOT set signIn=expired on HTTP 429 or 403', async () => {
    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };

    serverHandler = (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limited' }));
    };
    try {
      await listModels(c, settings());
      assert.fail('should reject');
    } catch (err) {
      assert.equal(err.status, 429);
      assert.equal(err.signIn, undefined);
    }

    serverHandler = (req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
    };
    try {
      await listModels(c, settings());
      assert.fail('should reject');
    } catch (err) {
      assert.equal(err.status, 403);
      assert.equal(err.signIn, undefined);
    }
  });
});

describe('9. Conservative tool+image caps toggled & OpenCode Model shape', () => {
  let server;
  let serverPort;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'gemini-2.5-flash', object: 'model' }]
      }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('reports conservative capabilities when tool and image flags disabled', async () => {
    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    const opts = settings({ allowTools: false, allowImages: false });
    const models = await listModels(c, opts);
    const m = models['gemini-2.5-flash'];

    assert.equal(m.capabilities.toolcall, false);
    assert.equal(m.capabilities.attachment, false);
    assert.deepEqual(m.capabilities.input, { text: true, image: false });
    assert.deepEqual(m.capabilities.output, { text: true });
    assert.equal(m.capabilities.reasoning, true);
    assert.equal(m.capabilities.temperature, false);
    assert.equal(m.status, 'active');
  });

  it('reports enabled capabilities when tool and image flags enabled', async () => {
    const c = { key: 'test_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    const opts = settings({ allowTools: true, allowImages: true });
    const models = await listModels(c, opts);
    const m = models['gemini-2.5-flash'];

    assert.equal(m.capabilities.toolcall, true);
    assert.equal(m.capabilities.attachment, true);
    assert.deepEqual(m.capabilities.input, { text: true, image: true });
    assert.deepEqual(m.capabilities.output, { text: true });
    assert.equal(m.capabilities.reasoning, true);
  });
});

describe('10. Per-account models isolation', () => {
  let server1, serverPort1;
  let server2, serverPort2;

  before(async () => {
    server1 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'gemini-2.5-flash' }]
      }));
    });
    await new Promise(resolve => server1.listen(0, '127.0.0.1', () => {
      serverPort1 = server1.address().port;
      resolve();
    }));

    server2 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'gemini-3.1-pro' }]
      }));
    });
    await new Promise(resolve => server2.listen(0, '127.0.0.1', () => {
      serverPort2 = server2.address().port;
      resolve();
    }));
  });

  after(async () => {
    await Promise.all([
      new Promise(resolve => server1.close(resolve)),
      new Promise(resolve => server2.close(resolve))
    ]);
  });

  it('sets m.api.url and discovers models without cross-account contamination', async () => {
    const account1 = { key: 'key1', baseURL: `http://127.0.0.1:${serverPort1}/v1` };
    const account2 = { key: 'key2', baseURL: `http://127.0.0.1:${serverPort2}/v1` };
    const opts = settings();

    const models1 = await listModels(account1, opts);
    const models2 = await listModels(account2, opts);

    assert.deepEqual(Object.keys(models1), ['gemini-2.5-flash']);
    assert.equal(models1['gemini-2.5-flash'].api.url, `http://127.0.0.1:${serverPort1}/v1`);

    assert.deepEqual(Object.keys(models2), ['gemini-3.1-pro']);
    assert.equal(models2['gemini-3.1-pro'].api.url, `http://127.0.0.1:${serverPort2}/v1`);

    // Plugin provider.models hook per-account check
    const plugin = await GeminiWebPlugin({}, opts);
    const reported1 = await plugin.provider.models({}, {
      auth: { type: 'api', key: 'key1', metadata: { baseURL: `http://127.0.0.1:${serverPort1}/v1` } }
    });
    const reported2 = await plugin.provider.models({}, {
      auth: { type: 'api', key: 'key2', metadata: { baseURL: `http://127.0.0.1:${serverPort2}/v1` } }
    });

    assert.deepEqual(Object.keys(reported1), ['gemini-2.5-flash']);
    assert.equal(reported1['gemini-2.5-flash'].api.url, `http://127.0.0.1:${serverPort1}/v1`);

    assert.deepEqual(Object.keys(reported2), ['gemini-3.1-pro']);
    assert.equal(reported2['gemini-3.1-pro'].api.url, `http://127.0.0.1:${serverPort2}/v1`);
  });
});

describe('11-21. Forwarding, security stripping, tool/image validation, and streaming', () => {
  let server;
  let serverPort;
  let serverHandler;

  before(async () => {
    server = http.createServer((req, res) => serverHandler(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('11. Request input+init honored', async () => {
    serverHandler = (req, res) => {
      assert.equal(req.headers['accept'], 'application/json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    // Construct actual Request with initial headers, then pass init override
    const initialReq = new Request(`${baseURL}/models`, {
      method: 'GET',
      headers: { 'Accept': 'text/plain' }
    });

    const res = await forward(initialReq, {
      headers: { 'Accept': 'application/json' }
    }, getAuth, opts);
    assert.equal(res.status, 200);
  });

  it('12. Exact body preservation', async () => {
    const rawPayload = JSON.stringify({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello world' }],
      temperature: 0.7,
      stream: true
    });

    let receivedBody = '';
    serverHandler = async (req, res) => {
      for await (const chunk of req) receivedBody += chunk;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1' }));
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawPayload
    }, getAuth, opts);

    assert.equal(receivedBody, rawPayload);
  });

  it('13. Fresh auth per call', async () => {
    let callCount = 0;
    const keysUsed = [];
    serverHandler = (req, res) => {
      keysUsed.push(req.headers['authorization']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => {
      callCount++;
      return { type: 'api', key: `key_call_${callCount}`, metadata: { baseURL } };
    };
    const opts = settings({ baseURL });

    await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);

    assert.deepEqual(keysUsed, ['Bearer key_call_1', 'Bearer key_call_2']);
  });

  it('14. Caller auth+cookie stripped', async () => {
    let capturedHeaders;
    serverHandler = (req, res) => {
      capturedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'backend_key', metadata: { baseURL } });
    const opts = settings({ baseURL });

    await forward(`${baseURL}/models`, {
      method: 'GET',
      headers: {
        'Cookie': 'user_session=secret; GoogleCookie=secret',
        'Authorization': 'Bearer caller_secret_token',
        'x-api-key': 'caller_api_key',
        'anthropic-version': '2023-06-01',
        'x-magpie-key': 'internal_key',
        'Accept': 'application/json'
      }
    }, getAuth, opts);

    assert.equal(capturedHeaders['authorization'], 'Bearer backend_key');
    assert.equal(capturedHeaders['cookie'], undefined);
    assert.equal(capturedHeaders['x-api-key'], undefined);
    assert.equal(capturedHeaders['anthropic-version'], undefined);
    assert.equal(capturedHeaders['x-magpie-key'], undefined);
  });

  it('15. Foreign endpoint and redirect target never receive auth', async () => {
    let serverHit = false;
    serverHandler = () => { serverHit = true; };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'secret_key', metadata: { baseURL } });
    const opts = settings({ baseURL });

    // Cross-origin / foreign URL
    const res = await forward('https://evil.attacker.com/v1/models', { method: 'GET' }, getAuth, opts);
    assert.equal(res.status, 404);
    assert.equal(serverHit, false);

    // Redirect attempt from backend
    serverHandler = (req, res) => {
      res.writeHead(302, { 'Location': 'https://evil.attacker.com/leak' });
      res.end();
    };
    const resRedirect = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    assert.equal(resRedirect.status, 502);
  });

  it('16. Upstream 401/429 status, retry-after preserved, and content-encoding stripped', async () => {
    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    // 401 adds X-Magpie-Sign-In: expired
    serverHandler = (req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    };
    const res401 = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    assert.equal(res401.status, 401);
    assert.equal(res401.headers.get('x-magpie-sign-in'), 'expired');

    // 429 preserves Retry-After
    serverHandler = (req, res) => {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '120'
      });
      res.end(JSON.stringify({ error: 'rate limited' }));
    };
    const res429 = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    assert.equal(res429.status, 429);
    assert.equal(res429.headers.get('retry-after'), '120');

    // Gzip compressed upstream response: decoded body readable and headers deleted
    serverHandler = (req, res) => {
      const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify({ status: 'ok', compressed: true })));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': gzipped.length.toString()
      });
      res.end(gzipped);
    };

    const resGzip = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, opts);
    assert.equal(resGzip.status, 200);
    assert.equal(resGzip.headers.get('content-encoding'), null);
    assert.equal(resGzip.headers.get('content-length'), null);
    const parsedGzip = await resGzip.json();
    assert.deepEqual(parsedGzip, { status: 'ok', compressed: true });
  });

  it('17. Tools disabled failure returns 400 without fetch vs opt-in pass', async () => {
    let fetched = false;
    serverHandler = (req, res) => {
      fetched = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });

    // allowTools: false -> reject with 400
    const optsDisabled = settings({ baseURL, allowTools: false });
    const resDisabled = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }]
      })
    }, getAuth, optsDisabled);

    assert.equal(resDisabled.status, 400);
    assert.equal(fetched, false);
    const jsonErr = await resDisabled.json();
    assert.match(jsonErr.error.message, /Experimental tools are disabled; set allowTools: true/);

    // allowTools: true -> passes
    const optsEnabled = settings({ baseURL, allowTools: true });
    const resEnabled = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }]
      })
    }, getAuth, optsEnabled);

    assert.equal(resEnabled.status, 200);
    assert.equal(fetched, true);
  });

  it('18. Images disabled returns 400 without fetch vs opt-in pass & media narrowness', async () => {
    let fetched = false;
    serverHandler = (req, res) => {
      fetched = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });

    // allowImages: false -> reject image_url
    const optsDisabled = settings({ baseURL, allowImages: false });
    const resDisabled = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
          ]
        }]
      })
    }, getAuth, optsDisabled);

    assert.equal(resDisabled.status, 400);
    assert.equal(fetched, false);
    const jsonErr = await resDisabled.json();
    assert.match(jsonErr.error.message, /Image input is disabled; set allowImages: true/);

    // allowImages: true -> passes with valid image_url
    const optsEnabled = settings({ baseURL, allowImages: true });
    const resEnabled = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
          ]
        }]
      })
    }, getAuth, optsEnabled);

    assert.equal(resEnabled.status, 200);
    assert.equal(fetched, true);

    // Media narrowness: reject unsupported types even when allowImages is true
    fetched = false;
    const resAudio = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: 'abc' } }]
        }]
      })
    }, getAuth, optsEnabled);
    assert.equal(resAudio.status, 400);
    assert.equal(fetched, false);
    const audioErr = await resAudio.json();
    assert.match(audioErr.error.message, /Unsupported content type/);

    // Reject malformed image_url (missing url or empty string)
    const resBadImage = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: '   ' } }]
        }]
      })
    }, getAuth, optsEnabled);
    assert.equal(resBadImage.status, 400);
    const badImgErr = await resBadImage.json();
    assert.match(badImgErr.error.message, /Image content must contain an image_url URL/);

    // Reject malformed text part (text property not string)
    const resBadText = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 12345 }]
        }]
      })
    }, getAuth, optsEnabled);
    assert.equal(resBadText.status, 400);
    const badTextErr = await resBadText.json();
    assert.match(badTextErr.error.message, /Text content must contain a text string/);
  });

  it('19. SSE first chunk available before upstream closes + model not rewritten + DONE unchanged', async () => {
    let closeServerRes;
    serverHandler = (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('data: {"id":"chatcmpl-1","model":"gemini-2.5-flash","choices":[{"delta":{"content":"Hello"}}]}\n\n');
      closeServerRes = () => {
        res.write('data: [DONE]\n\n');
        res.end();
      };
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    const res = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    }, getAuth, opts);

    assert.equal(res.status, 200);
    const reader = res.body.getReader();

    // First chunk can be read BEFORE upstream closes
    const firstChunk = await reader.read();
    const text1 = new TextDecoder().decode(firstChunk.value);
    assert.match(text1, /gemini-2.5-flash/);
    assert.match(text1, /Hello/);

    // Now close upstream
    closeServerRes();
    const secondChunk = await reader.read();
    const text2 = new TextDecoder().decode(secondChunk.value);
    assert.match(text2, /\[DONE\]/);
  });

  it('20. Caller abort closes upstream', async () => {
    let clientCloseResolve;
    const clientClosePromise = new Promise(resolve => {
      clientCloseResolve = resolve;
    });

    serverHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: chunk1\n\n');
      res.on('close', () => {
        clientCloseResolve();
      });
    };

    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });
    const opts = settings({ baseURL });

    const controller = new AbortController();
    const res = await forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal
    }, getAuth, opts);

    const reader = res.body.getReader();
    const firstChunk = await reader.read();
    assert.ok(firstChunk.value);

    // Abort from caller
    controller.abort();

    try {
      await reader.read();
    } catch {}

    const closed = await Promise.race([
      clientClosePromise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 2000))
    ]);
    assert.equal(closed, true, 'Upstream server connection should close upon caller abort');
  });

  it('21. Finite timeout with 502/504', async () => {
    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const getAuth = async () => ({ type: 'api', key: 'key_123', metadata: { baseURL } });

    // Timeout (504)
    serverHandler = () => {
      // intentionally hang
    };
    const optsTimeout = settings({ baseURL, requestTimeoutMs: 50 });
    const res504 = await forward(`${baseURL}/models`, { method: 'GET' }, getAuth, optsTimeout);
    assert.equal(res504.status, 504);
    const body504 = await res504.json();
    assert.equal(body504.error.code, 'gateway_timeout');

    // Connection refused (502)
    const unreachableBase = 'http://127.0.0.1:54321/v1';
    const opts502 = settings({ baseURL: unreachableBase });
    const res502 = await forward(`${unreachableBase}/models`, { method: 'GET' }, async () => ({
      type: 'api',
      key: 'key',
      metadata: { baseURL: unreachableBase }
    }), opts502);
    assert.equal(res502.status, 502);
    const body502 = await res502.json();
    assert.equal(body502.error.code, 'bad_gateway');
  });
});

describe('22. Reasoning effort maps onto the backend -thinking twin', () => {
  let server;
  let serverPort;
  let modelIds;
  let modelsStatus;
  let modelsCalls;
  let chatModels;

  before(async () => {
    server = http.createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        modelsCalls++;
        res.writeHead(modelsStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: modelIds.map(id => ({ id, object: 'model' })) }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      chatModels.push(JSON.parse(raw).model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    }));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  const reset = () => {
    modelIds = ['gemini-4-argon', 'gemini-4-argon-thinking', 'gemini-3.6-flash', 'gemini-3.6-flash-thinking', 'gemini-canvas', 'gemini-solo'];
    modelsStatus = 200;
    modelsCalls = 0;
    chatModels = [];
  };

  const send = (key, body) => {
    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    return forward(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body })
    }, async () => ({ type: 'api', key, metadata: { baseURL } }), settings({ baseURL }));
  };

  it('declares low/high variants only on base models that have a -thinking twin', async () => {
    reset();
    const c = { key: 'variants_key', baseURL: `http://127.0.0.1:${serverPort}/v1` };
    const models = await listModels(c, settings({ baseURL: c.baseURL }));

    assert.deepEqual(models['gemini-4-argon'].variants, { low: {}, high: {} });
    assert.deepEqual(models['gemini-3.6-flash'].variants, { low: {}, high: {} });
    assert.deepEqual(models['gemini-4-argon-thinking'].variants, {});
    assert.deepEqual(models['gemini-solo'].variants, {});
    assert.equal(models['gemini-canvas'], undefined);
  });

  it('routes high and other non-low efforts to the twin, low/none/absent to the base', async () => {
    reset();
    const cases = [
      [{ model: 'gemini-4-argon', reasoning_effort: 'high' }, 'gemini-4-argon-thinking'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'medium' }, 'gemini-4-argon-thinking'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'xhigh' }, 'gemini-4-argon-thinking'],
      [{ model: 'gemini-3.6-flash', reasoning_effort: 'high' }, 'gemini-3.6-flash-thinking'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'low' }, 'gemini-4-argon'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'minimal' }, 'gemini-4-argon'],
      [{ model: 'gemini-4-argon', reasoning_effort: 'none' }, 'gemini-4-argon'],
      [{ model: 'gemini-4-argon' }, 'gemini-4-argon'],
      [{ model: 'gemini-4-argon-thinking', reasoning_effort: 'low' }, 'gemini-4-argon-thinking'],
      [{ model: 'gemini-solo', reasoning_effort: 'high' }, 'gemini-solo']
    ];
    for (const [body] of cases) {
      const res = await send('route_key', body);
      assert.equal(res.status, 200);
    }
    assert.deepEqual(chatModels, cases.map(([, want]) => want));
    assert.equal(modelsCalls, 1, 'model list fetched once and cached');
  });

  it('keeps the exact body when no twin applies', async () => {
    reset();
    const baseURL = `http://127.0.0.1:${serverPort}/v1`;
    const raw = '{"model":"gemini-4-argon","reasoning_effort":"low","messages":[{"role":"user","content":"hi"}]}';
    let received;
    const original = server.listeners('request')[0];
    server.removeAllListeners('request');
    server.on('request', async (req, res) => {
      received = '';
      for await (const chunk of req) received += chunk;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    try {
      await forward(`${baseURL}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw },
        async () => ({ type: 'api', key: 'exact_key', metadata: { baseURL } }), settings({ baseURL }));
    } finally {
      server.removeAllListeners('request');
      server.on('request', original);
    }
    assert.equal(received, raw);
  });

  it('sends the request unchanged when the model list cannot be fetched', async () => {
    reset();
    modelsStatus = 500;
    const res = await send('broken_models_key', { model: 'gemini-4-argon', reasoning_effort: 'high' });
    assert.equal(res.status, 200);
    assert.deepEqual(chatModels, ['gemini-4-argon']);
  });
});
