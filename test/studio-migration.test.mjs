import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureStudioConfig, readStudioEnv, saveStudioProxy, prepareStudioBrowser, verifyProcessIdentity, studioProcessPids } from '../lib/studio-native.mjs';
import { resolveStudioRelease, supportsOfficialStudio } from '../lib/studio-upstream.mjs';

function fixture(t, legacy = false, env = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-studio-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (legacy) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, port: 2048, apiKey: 'key', adminUsername: 'admin', adminPassword: 'password', extension: 'keep' }));
  fs.writeFileSync(path.join(dir, '.env'), '# upstream settings\n' + env);
  return dir;
}
const preserved = {
  SEARCH_MODEL_ALIASES: 'false', PER_ACCOUNT_CONCURRENCY: '1', WARM_WORKER_LIMIT: '1',
  MAX_ACTIVE_WORKERS: '1', WARM_STARTUP_CONCURRENCY: '1', ROUTING_STRATEGY: 'fill-first', REQUEST_TIMEOUT: '30m',
  INIT_TIMEOUT: '2m', FIRST_EVENT_HEDGE: 'off', NONSTREAM_KEEPALIVE: 'false'
};

it('fresh installations leave search, workers and generation defaults to upstream', t => {
  const dir = fixture(t);
  ensureStudioConfig(dir);
  const env = readStudioEnv(dir);
  for (const key of [...Object.keys(preserved), 'WAA_BACKEND', 'UPSTREAM_CHANNELS', 'BUILD_NATIVE_NONSTREAM']) assert.equal(env[key], undefined, key);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).defaultsPolicy, 'upstream');
});

it('legacy missing settings retain model-list, quota and routing behavior exactly once', t => {
  const dir = fixture(t, true, 'FUTURE_KEY="keep me"\n');
  const config = ensureStudioConfig(dir);
  const env = readStudioEnv(dir);
  for (const [key, value] of Object.entries(preserved)) assert.equal(env[key], value, key);
  assert.equal(config.apiKey, 'key');
  assert.equal(config.adminPassword, 'password');
  assert.equal(config.port, 2048);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).extension, 'keep');
  assert.equal(config.defaultsPolicy, 'legacy-migrated');
  // Official Save omits keys equal to its defaults. That is a later user choice.
  fs.writeFileSync(path.join(dir, '.env'), '# sparse official save\nFUTURE_KEY="keep me"\n');
  ensureStudioConfig(dir);
  saveStudioProxy(dir, '');
  for (const key of Object.keys(preserved)) assert.equal(readStudioEnv(dir)[key], undefined, key + ' must not be reseeded');
  assert.equal(readStudioEnv(dir).FUTURE_KEY, 'keep me');
});

it('legacy migration keeps explicit choices including empty settings and future keys', t => {
  const choices = { SEARCH_MODEL_ALIASES: 'true', PER_ACCOUNT_CONCURRENCY: '4', WARM_WORKER_LIMIT: '3', MAX_ACTIVE_WORKERS: '8', WARM_STARTUP_CONCURRENCY: '2', ROUTING_STRATEGY: 'round-robin', REQUEST_TIMEOUT: '45m', FIRST_EVENT_HEDGE: '', WAA_BACKEND: 'camoufox', FUTURE_KEY: 'on' };
  const dir = fixture(t, true, Object.entries(choices).map(([k,v]) => k + '=' + v).join('\n') + '\n');
  ensureStudioConfig(dir);
  for (const [key, value] of Object.entries(choices)) assert.equal(readStudioEnv(dir)[key], value, key);
});

it('unsupported automatic-install targets get actionable guidance before any network lookup', async () => {
  assert.equal(supportsOfficialStudio('win32', 'arm64'), false);
  await assert.rejects(resolveStudioRelease({ platform: 'win32', arch: 'arm64', fetchFn() { assert.fail('no network lookup'); } }), /Windows arm64.*x64/);
});

it('macOS discovery retains renamed/deleted images and launch argv without accepting a different path', () => {
  const bin = path.resolve(os.tmpdir(), 'instance with spaces/aistudio2api');
  const old = path.join(path.dirname(bin), '.aistudio2api.old');
  const run = (_cmd, args) => args.at(-1) === 'pid=,comm='
    ? '11 ' + bin + ' (deleted)\n12 ' + old + '\n13 /unrelated/aistudio2api\n14 aistudio2api\n'
    : '14 ' + bin + ' -open-ui=false\n15 /usr/bin/node -e referencing-' + bin + '\n';
  assert.deepEqual(studioProcessPids(bin, 'darwin', run), [11,12,14]);
  assert.equal(verifyProcessIdentity(12, bin, 'darwin', (_cmd,args) => args.at(-1) === 'comm=' ? old + ' (deleted)' : bin + ' -open-ui=false'), true);
  assert.equal(verifyProcessIdentity(13, bin, 'darwin', () => '/unrelated/aistudio2api'), false);
  assert.equal(verifyProcessIdentity(13, bin, 'darwin', (_cmd, args) => args.at(-1) === 'comm=' ? '/unrelated/aistudio2api' : bin + ' -open-ui=false'), false, 'absolute executable identity overrides a misleading argv0');
  assert.equal(verifyProcessIdentity(process.pid, bin, 'darwin', () => { throw new Error('inspection denied'); }), null);
});

it('browser preparation is independent of account login and the host sign-in budget', async () => {
  const routes = [];
  const local = { origin: 'http://127.0.0.1:1234', adminUsername: 'a', adminPassword: 'b' };
  let polls = 0;
  const fetchFn = async (url, init) => {
    routes.push([init.method, new URL(url).pathname]);
    if (url.endsWith('/api/auth/login')) return new Response('{}', { headers: { 'Set-Cookie': 'aistudio_admin=prepare-test' } });
    return Response.json({ camoufox: { ready: url.endsWith('/api/status') && ++polls === 2, preparing: true } });
  };
  assert.equal((await prepareStudioBrowser(local, { fetchFn, pollMs: 1 })).ready, true);
  assert.equal(routes.filter(r => r[1] === '/api/camoufox/download').length, 1);
  assert.ok(routes.every(r => !r[1].includes('/accounts') && r[0] !== 'DELETE'));
  await assert.rejects(prepareStudioBrowser(local, { fetchFn, deadline: Date.now() - 1 }), /still running/);
  assert.ok(routes.every(r => r[0] !== 'DELETE'), 'timeout must not cancel backend preparation');
});
