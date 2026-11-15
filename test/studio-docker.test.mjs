import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AIStudioPlugin, GeminiWebPlugin } from '../index.mjs';
import { isContainerEnv, isLoopbackProxy, dockerProxyHint } from '../lib/proc.mjs';
import { binaryPath as webBinaryPath } from '../lib/native.mjs';
import {
  STUDIO_REQUIRED_COOKIES,
  normalizeStudioProxy,
  parseStudioCookieInput,
  studioImportCookie,
  ensureStudio
} from '../lib/studio-native.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_COOKIE = '__Secure-1PSID=psid123; SAPISID=sapi123; __Secure-1PAPISID=p1_123; __Secure-3PAPISID=p3_123';

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runScriptWithStdin(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, args, { cwd: REPO_ROOT }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function makeFakeStudioServer({
  onImport,
  taskState = 'done',
  taskError = '',
  importStatus = 202,
  accounts = [{ id: 'docker-user@gmail.com', label: 'docker-user@gmail.com', state: 'ready', enabled: true }]
} = {}) {
  let nextTaskSeq = 1;
  const tasks = new Map();
  const deletedTasks = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const send = (status, data, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/api/auth/login' && req.method === 'POST') {
        return send(200, { ok: true }, { 'Set-Cookie': 'aistudio_admin=session123; Path=/' });
      }
      if (req.url === '/api/status' && req.method === 'GET') {
        return send(200, {
          version: '0.3.9',
          state: 'RUNNING',
          running: true,
          ready: true,
          accounts: { total: accounts.length, ready: accounts.length, busy: 0, cooldown: 0, auth_required: 0 }
        });
      }
      if (req.url === '/api/accounts/import/cookies' && req.method === 'POST') {
        const parsed = body ? JSON.parse(body) : {};
        onImport?.(parsed);
        if (importStatus !== 202) {
          return send(importStatus, { message: `HTTP ${importStatus}` });
        }
        const id = `task-${nextTaskSeq++}`;
        const firstLabel = accounts[0]?.label || 'docker-user@gmail.com';
        tasks.set(id, {
          id,
          kind: 'cookies',
          polls: 0,
          finalState: taskState,
          items: [{ label: firstLabel, state: taskState === 'failed' ? 'failed' : 'done', ...(taskError ? { error: taskError } : {}) }]
        });
        return send(202, { task: { id, kind: 'cookies', state: 'running', items: [] } });
      }
      if (req.url === '/api/accounts/tasks' && req.method === 'GET') {
        const list = [];
        for (const t of tasks.values()) {
          t.polls++;
          const state = t.polls >= 2 ? t.finalState : 'running';
          list.push({ id: t.id, kind: t.kind, state, items: state === 'running' ? [] : t.items });
        }
        return send(200, { tasks: list });
      }
      if (req.url?.startsWith('/api/accounts/tasks/') && req.method === 'DELETE') {
        const id = decodeURIComponent(req.url.slice('/api/accounts/tasks/'.length));
        deletedTasks.push(id);
        tasks.delete(id);
        return send(200, { ok: true });
      }
      if (req.url === '/api/accounts' && req.method === 'GET') {
        return send(200, { accounts });
      }
      if (req.url === '/api/settings/proxy' && req.method === 'GET') {
        return send(200, { proxy: '' });
      }
      send(404, { error: 'not found' });
    });
  });

  return {
    deletedTasks,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return {
        port,
        origin: `http://127.0.0.1:${port}`,
        baseURL: `http://127.0.0.1:${port}/v1`,
        adminUsername: 'magpie',
        adminPassword: 'pw',
        apiKey: 'studio_test_key'
      };
    },
    close() {
      server.closeAllConnections?.();
      return new Promise(resolve => server.close(resolve));
    }
  };
}

function makeFakeWebServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/') {
      return res.end(JSON.stringify({ version: '4.28.0-magpie.1', capabilities: { account_proxy_binding: true } }));
    }
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [] }));
    }
    res.end(JSON.stringify({ ok: true }));
  });
  return {
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise(resolve => server.close(resolve));
    }
  };
}

describe('Container detection and proxy helpers', () => {
  it('detects containers via env overrides, container vars, and linux sentinel files', () => {
    assert.equal(isContainerEnv({ env: { DOCKER_CONTAINER: '1' }, platform: 'darwin' }), true);
    assert.equal(isContainerEnv({ env: { DOCKER_CONTAINER: 'true' }, platform: 'win32' }), true);
    assert.equal(isContainerEnv({ env: { DOCKER_CONTAINER: '0' }, platform: 'linux', existsSync: () => true }), false);
    assert.equal(isContainerEnv({ env: { container: 'docker' }, platform: 'linux', existsSync: () => false }), true);
    assert.equal(isContainerEnv({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, platform: 'linux', existsSync: () => false }), true);
    assert.equal(
      isContainerEnv({ env: {}, platform: 'linux', existsSync: p => p === '/.dockerenv', readFileSync: () => '' }),
      true
    );
    assert.equal(
      isContainerEnv({
        env: {},
        platform: 'linux',
        existsSync: () => false,
        readFileSync: () => '0::/system.slice/docker-12345.scope\n'
      }),
      true
    );
    assert.equal(
      isContainerEnv({
        env: {},
        platform: 'linux',
        existsSync: () => false,
        readFileSync: () => '0::/user.slice/user-1000.slice\n'
      }),
      false
    );
  });

  it('detects loopback proxies and generates Docker proxy guidance only when needed', () => {
    assert.equal(isLoopbackProxy('http://127.0.0.1:7890'), true);
    assert.equal(isLoopbackProxy('http://localhost:7890'), true);
    assert.equal(isLoopbackProxy('socks5://[::1]:1080'), true);
    assert.equal(isLoopbackProxy('http://host.docker.internal:7890'), false);
    assert.equal(isLoopbackProxy(''), false);

    assert.equal(dockerProxyHint('http://127.0.0.1:7890', { container: false }), '');
    assert.equal(dockerProxyHint('http://host.docker.internal:7890', { container: true }), '');
    assert.match(dockerProxyHint('http://127.0.0.1:7890', { container: true }), /host\.docker\.internal/);
  });
});

describe('AI Studio proxy & cookie input normalization', () => {
  it('normalizes proxy URLs for AIStudio2API', () => {
    assert.equal(normalizeStudioProxy(''), '');
    assert.equal(normalizeStudioProxy('  http://host.docker.internal:7890/  '), 'http://host.docker.internal:7890');
    assert.equal(normalizeStudioProxy('socks5h://127.0.0.1:1080/'), 'socks5://127.0.0.1:1080');
    assert.throws(() => normalizeStudioProxy('http://127.0.0.1:7890/path'), /path/i);
    assert.throws(() => normalizeStudioProxy('http://127.0.0.1:7890?a=1'), /query/i);
  });

  it('parses wrapped headers, JSON exports, DevTools tables, Netscape cookies.txt, and key-value maps', () => {
    assert.equal(parseStudioCookieInput(`Cookie: ${SAMPLE_COOKIE}`), SAMPLE_COOKIE);

    const wrapped = `__Secure-1PSID=psid123;\nSAPISID=sapi123;\n__Secure-1PAPISID=p1_123;\n__Secure-3PAPISID=p3_123`;
    assert.equal(parseStudioCookieInput(wrapped), SAMPLE_COOKIE);

    const jsonArray = JSON.stringify([
      { name: '__Secure-1PSID', value: 'psid123' },
      { name: '__Host-GAPS', value: 'gaps1' },
      { name: 'SAPISID', value: 'sapi123', domain: '.google.com' },
      { name: '__Secure-1PAPISID', value: 'p1_123', domain: 'aistudio.google.com' },
      { name: '__Secure-3PAPISID', value: 'p3_123', domain: '.google.com' },
      { name: 'OTHER', value: 'dropme', domain: 'example.com' }
    ]);
    const normalizedArray = JSON.parse(parseStudioCookieInput(jsonArray));
    assert.equal(normalizedArray.find(c => c.name === '__Secure-1PSID').domain, '.google.com');
    assert.equal(normalizedArray.find(c => c.name === '__Host-GAPS').domain, 'aistudio.google.com');
    assert.equal(normalizedArray.some(c => c.name === 'OTHER'), false);

    const storageState = JSON.stringify({
      cookies: [
        { name: '__Secure-1PSID', value: 'psid123', domain: '.google.com' },
        { name: 'SAPISID', value: 'sapi123', domain: '.google.com' },
        { name: '__Secure-1PAPISID', value: 'p1_123', domain: '.google.com' },
        { name: '__Secure-3PAPISID', value: 'p3_123', domain: '.google.com' }
      ],
      origins: []
    });
    assert.equal(JSON.parse(parseStudioCookieInput(storageState)).cookies.length, 4);

    const devtoolsTable = [
      '__Secure-1PSID\tpsid123\t.google.com\t/\tSession',
      'SAPISID\tsapi123\t.google.com\t/\tSession',
      '__Secure-1PAPISID\tp1_123\taistudio.google.com\t/\tSession',
      '__Secure-3PAPISID\tp3_123\t.google.com\t/\tSession',
      'THIRD_PARTY\txyz\tevilgoogle.com\t/\tSession'
    ].join('\n');
    assert.equal(parseStudioCookieInput(devtoolsTable), SAMPLE_COOKIE);

    const netscape = [
      '# Netscape HTTP Cookie File',
      '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1900000000\t__Secure-1PSID\tpsid123',
      '.google.com\tTRUE\t/\tFALSE\t1900000000\tSAPISID\tsapi123',
      'aistudio.google.com\tFALSE\t/\tTRUE\t1900000000\t__Secure-1PAPISID\tp1_123',
      '.google.com\tTRUE\t/\tTRUE\t1900000000\t__Secure-3PAPISID\tp3_123',
      '.example.com\tTRUE\t/\tTRUE\t1900000000\tIGNORED\tval'
    ].join('\n');
    const normalizedNetscape = parseStudioCookieInput(netscape);
    assert.match(normalizedNetscape, /^\.google\.com\tTRUE\t\/\tTRUE\t1900000000\t__Secure-1PSID\tpsid123/m);
    assert.doesNotMatch(normalizedNetscape, /example\.com/);

    assert.equal(
      parseStudioCookieInput(JSON.stringify({
        '__Secure-1PSID': 'psid123',
        SAPISID: 'sapi123',
        '__Secure-1PAPISID': 'p1_123',
        '__Secure-3PAPISID': 'p3_123'
      })),
      SAMPLE_COOKIE
    );

    assert.throws(() => parseStudioCookieInput('SAPISID=onlyone'), new RegExp(STUDIO_REQUIRED_COOKIES[0]));
    assert.throws(() => parseStudioCookieInput('{broken'), /JSON/);
  });
});

describe('studioImportCookie & Docker headless login flows', () => {
  const savedEnv = {};
  const ENV_KEYS = ['DOCKER_CONTAINER', 'AI_STUDIO_DATA_DIR', 'GEMINI_WEB_DATA_DIR'];
  let tempDirs = [];

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs = [];
  });

  it('studioImportCookie polls task to completion, cleans up task, and maps errors', async () => {
    const importedBodies = [];
    const server = makeFakeStudioServer({
      onImport: body => importedBodies.push(body)
    });
    const local = await server.start();
    try {
      const account = await studioImportCookie(local, SAMPLE_COOKIE, {
        authuser: '2',
        proxy: 'socks5h://host.docker.internal:1080/',
        pollMs: 10
      });
      assert.equal(account.id, 'docker-user@gmail.com');
      assert.deepEqual(importedBodies, [{
        items: [{ email: '', cookies: SAMPLE_COOKIE, cdp: '', auth_user: 2 }],
        proxy: 'socks5://host.docker.internal:1080',
        locale: '',
        timezone: ''
      }]);
      assert.deepEqual(server.deletedTasks, ['task-1']);
    } finally {
      await server.close();
    }

    const failServer = makeFakeStudioServer({ taskState: 'failed', taskError: 'cookie expired' });
    const failLocal = await failServer.start();
    try {
      await assert.rejects(
        studioImportCookie(failLocal, SAMPLE_COOKIE, { pollMs: 10 }),
        /cookie expired/
      );
      assert.deepEqual(failServer.deletedTasks, ['task-1']);
    } finally {
      await failServer.close();
    }

    const oldServer = makeFakeStudioServer({ importStatus: 404 });
    const oldLocal = await oldServer.start();
    try {
      await assert.rejects(
        studioImportCookie(oldLocal, SAMPLE_COOKIE),
        /不支持 Cookie 导入接口/
      );
    } finally {
      await oldServer.close();
    }
  });

  it('AIStudioPlugin prioritizes Cookie login in containers, warns on 127.0.0.1 proxy, and completes sign-in', async () => {
    const studioDir = createTempDir('magpie-studio-docker-');
    tempDirs.push(studioDir);
    process.env.AI_STUDIO_DATA_DIR = studioDir;

    const imported = [];
    const server = makeFakeStudioServer({ onImport: body => imported.push(body) });
    const local = await server.start();
    fs.writeFileSync(path.join(studioDir, 'config.json'), JSON.stringify({
      version: 1,
      autoUpdate: false,
      port: local.port,
      apiKey: local.apiKey,
      adminUsername: local.adminUsername,
      adminPassword: local.adminPassword,
      backend: { mode: 'user', binaryPath: process.execPath }
    }) + '\n', { mode: 0o600 });

    try {
      process.env.DOCKER_CONTAINER = '0';
      const desktopPlugin = await AIStudioPlugin({}, { studio: { baseURL: local.baseURL } });
      assert.equal(desktopPlugin.auth.methods[0].label, '添加账号并连接（推荐）');
      assert.equal(desktopPlugin.auth.methods[2].label, '通过粘贴 Cookie 登录（无头 / 远程环境适用）');

      process.env.DOCKER_CONTAINER = '1';
      const dockerPlugin = await AIStudioPlugin({}, { studio: { baseURL: local.baseURL } });
      assert.equal(dockerPlugin.auth.methods[0].label, '粘贴 Cookie 无头登录（Docker / 远程服务器推荐）');
      assert.match(dockerPlugin.auth.methods[1].label, /127\.0\.0\.1/);

      const cookieMethod = dockerPlugin.auth.methods[0];
      const q1 = await cookieMethod.ask({});
      assert.equal(q1.key, 'proxy');
      assert.equal(q1.placeholder, 'http://host.docker.internal:7890');
      const q2 = await cookieMethod.ask({ proxy: 'http://127.0.0.1:7890' });
      assert.equal(q2.key, 'authuser');
      assert.equal(await cookieMethod.ask({ proxy: 'http://127.0.0.1:7890', authuser: '1' }), null);

      const pendingWarn = await cookieMethod.authorize({ proxy: 'http://127.0.0.1:7890', authuser: '1' });
      assert.equal(pendingWarn.method, 'code');
      assert.equal(pendingWarn.url, 'https://aistudio.google.com/u/1/prompts/new_chat');
      assert.match(pendingWarn.instructions, /host\.docker\.internal/);

      const badRes = await pendingWarn.callback('SAPISID=incomplete');
      assert.equal(badRes.type, 'failed');
      assert.match(badRes.error, /Cookie 导入没有完成/);
      assert.match(badRes.error, /host\.docker\.internal/);

      const pendingOk = await cookieMethod.authorize({ proxy: 'http://host.docker.internal:7890', authuser: '2' });
      const okRes = await pendingOk.callback(SAMPLE_COOKIE);
      assert.equal(okRes.type, 'success');
      assert.equal(okRes.key, local.apiKey);
      assert.equal(okRes.metadata.account, 'docker-user@gmail.com');
      assert.equal(okRes.metadata.email, 'docker-user@gmail.com');
      assert.equal(imported.at(-1).proxy, 'http://host.docker.internal:7890');
      assert.equal(imported.at(-1).items[0].auth_user, 2);
    } finally {
      await ensureStudio({ dataDir: studioDir }).catch(() => {});
      await server.close();
    }
  });

  it('GeminiWebPlugin surfaces Docker proxy hints for loopback proxies inside containers', async () => {
    process.env.DOCKER_CONTAINER = '1';
    const webDir = createTempDir('magpie-web-docker-');
    tempDirs.push(webDir);
    process.env.GEMINI_WEB_DATA_DIR = webDir;

    const webServer = makeFakeWebServer();
    const port = await webServer.start();
    const bin = webBinaryPath(webDir);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, 'fake backend', { mode: 0o700 });
    fs.writeFileSync(path.join(webDir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port }));
    fs.writeFileSync(path.join(webDir, 'secrets.json'), JSON.stringify({ apiKey: 'gw_test', adminToken: 'admin_test' }));

    try {
      const plugin = await GeminiWebPlugin({});
      const method = plugin.auth.methods[0];
      const q1 = await method.ask({});
      assert.equal(q1.placeholder, 'http://host.docker.internal:7890');

      const pending = await method.authorize({ proxy: 'http://127.0.0.1:7890', authuser: '0' });
      assert.match(pending.instructions, /host\.docker\.internal/);

      const failed = await pending.callback('SAPISID=incomplete');
      assert.equal(failed.type, 'failed');
      assert.match(failed.error, /host\.docker\.internal/);
    } finally {
      await webServer.close();
    }
  });

  it('scripts/studio.mjs import-cookie imports cookies from file and stdin against running service', async () => {
    const studioDir = createTempDir('magpie-studio-cli-docker-');
    tempDirs.push(studioDir);

    const imported = [];
    const server = makeFakeStudioServer({ onImport: body => imported.push(body) });
    const local = await server.start();
    fs.writeFileSync(path.join(studioDir, 'config.json'), JSON.stringify({
      version: 1,
      autoUpdate: false,
      port: local.port,
      apiKey: local.apiKey,
      adminUsername: local.adminUsername,
      adminPassword: local.adminPassword,
      backend: { mode: 'user', binaryPath: process.execPath }
    }) + '\n', { mode: 0o600 });

    const cookieFile = path.join(studioDir, 'cookie.txt');
    fs.writeFileSync(cookieFile, SAMPLE_COOKIE);

    try {
      const { stdout: fileOut } = await execFileAsync(
        process.execPath,
        [
          path.join(REPO_ROOT, 'scripts', 'studio.mjs'),
          'import-cookie',
          cookieFile,
          '--data-dir',
          studioDir,
          '--authuser',
          '3',
          '--proxy',
          'http://host.docker.internal:7890'
        ],
        { cwd: REPO_ROOT }
      );
      assert.match(fileOut, /Cookie import completed successfully/);
      assert.match(fileOut, /Account: docker-user@gmail\.com/);

      const { stdout: stdinOut } = await runScriptWithStdin(
        [
          path.join(REPO_ROOT, 'scripts', 'studio.mjs'),
          'import-cookie',
          '-',
          '--data-dir',
          studioDir,
          '--authuser',
          '1',
          '--proxy',
          'socks5h://host.docker.internal:1080'
        ],
        SAMPLE_COOKIE
      );
      assert.match(stdinOut, /Cookie import completed successfully/);
      assert.match(stdinOut, /Account: docker-user@gmail\.com/);

      assert.equal(imported.length, 2);
      assert.equal(imported[0].items[0].auth_user, 3);
      assert.equal(imported[0].proxy, 'http://host.docker.internal:7890');
      assert.equal(imported[1].items[0].auth_user, 1);
      assert.equal(imported[1].proxy, 'socks5://host.docker.internal:1080');
    } finally {
      await server.close();
    }
  });
});
