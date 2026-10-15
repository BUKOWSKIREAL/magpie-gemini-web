import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { boundedBytes, createForwarder, ensureService } from '../lib/runtime.mjs';
import { parseArgs, setup } from '../scripts/bridge.mjs';

const service = { baseURL: 'http://127.0.0.1:8084', apiKey: 'fixture-local-key' };

test('stream body over limit is cancelled before fetch, and blocked body abort completes', async () => {
  let cancelled = false, calls = 0;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; },
  });
  const forward = createForwarder(service, async () => { calls++; return new Response('{}'); });
  const result = await forward('/v1/chat/completions', { method: 'POST', body });
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error.code, 'request_too_large');
  assert.equal(cancelled, true);
  assert.equal(calls, 0);
  const controller = new AbortController();
  let stopped = false;
  const blocked = new ReadableStream({ cancel() { stopped = true; } });
  const pending = forward('/v1/chat/completions', { method: 'POST', body: blocked, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).status, 409);
  assert.equal(stopped, true);
  assert.equal(calls, 0);
});

test('bounded health-body reader stops at byte limit without waiting for EOF', async () => {
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(9000)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(boundedBytes(stream, 16384), { code: 'body_too_large' });
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test('runtime rejects unexpected options and CLI rejects malformed arguments before setup', async () => {
  await assert.rejects(ensureService({ pythonPath: '/bin/true' }), /Invalid bridge runtime options/);
  await assert.rejects(ensureService({ startupTimeoutMs: NaN }), /Invalid bridge runtime options/);
  for (const args of [[], ['start', 'extra'], ['start', '--data-dir'], ['start', '--port', '8084'],
    ['start', '--data-dir', '/tmp/a', '--data-dir', '/tmp/b']]) {
    assert.throws(() => parseArgs(args));
  }
  let executions = 0;
  await assert.rejects(setup({ 'port': 'oops' }, { execFileSync: () => executions++ }));
  assert.equal(executions, 0);
});

test('setup preserves existing configuration without invoking subprocesses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-setup-preserve-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{}', { mode: 0o600 });
    let executions = 0;
    const flags = Object.fromEntries(['auth-file','task-headers','tool-headers','task-template','turn-template'].map(k => [k, '/tmp/fixture']));
    await assert.rejects(setup({ ...flags, 'data-dir': dir }, { execFileSync: () => executions++ }), /Configuration already exists/);
    assert.equal(executions, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{}');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
